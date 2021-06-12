#!/usr/bin/env node
"use strict";

const prompt = require("prompt");

if (process.argv.length < 4) {
  console.error("Usage:");
  console.error(
    'GITHUB_TOKEN=*** npx mass-merge [organization] ["commit message"]'
  );
  process.exit(1);
}

const token = process.env["GITHUB_TOKEN"];

if (!token) {
  console.error("GITHUB_TOKEN environment variable required!");
  console.error(
    "Create a personal access token at https://github.com/settings/tokens/new?scopes=repo"
  );
  process.exit(1);
}

const { Octokit } = require("@octokit/core");
const octokit = new Octokit({ auth: token });

function sleep(ms) {
  // eslint-disable-next-line no-restricted-globals
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function approve(owner, repo, pullNumber) {
  await octokit.request(
    "POST /repos/{owner}/{repo}/pulls/{pullNumber}/reviews",
    {
      owner,
      repo,
      pullNumber,
      event: "APPROVE",
    }
  );
  process.stdout.write("approved ");
}

async function merge(owner, repo, pullNumber) {
  await octokit.request("PUT /repos/{owner}/{repo}/pulls/{pullNumber}/merge", {
    owner,
    repo,
    pullNumber,
    merge_method: "squash",
  });
  console.log("and merged");
}

async function listAll(owner, title) {
  const query = [
    "is:open",
    "is:pr",
    "archived:false",
    "draft:false",
    // "status:success", doesn't work
    "comments:0",
    `org:${owner}`,
    "author:app/dependabot",
    "in:title",
    `"${title}"`,
  ].join(" ");

  const response = await octokit.request("GET /search/issues", {
    q: query,
    sort: "created",
    order: "asc",
    per_page: 100,
    page: 0,
  });

  for (const pr of response.data.items) {
    console.log(pr.url);
  }

  console.log(
    `Total count: ${response.data.total_count} (${response.data.items.length})`
  );

  if (response.data.total_count > 0) {
    prompt.start();

    console.log("\n");
    const { confirm } = await prompt.get([
      {
        name: "confirm",
        description:
          "Are you sure you want to proceed with the mass merge? (Y/N)",
      },
    ]);

    if (
      !confirm ||
      (confirm.toLowerCase() !== "n" && confirm.toLowerCase() !== "y")
    ) {
      console.log("Please answer Y or N.");
      process.exit(1);
    }

    if (confirm.toLowerCase() === "n") {
      console.log("Exiting...");
      process.exit(1);
    }
  }

  let processed = 0;

  for (const pr of response.data.items) {
    const regex = new RegExp(`\/repos\/${owner}\/([^\/]+)\/`);
    const repo = pr.url.match(regex)[1];
    process.stdout.write(`${repo}#${pr.number} `);

    // Safety checks
    if (pr.user.login !== "dependabot[bot]") {
      console.log(
        `invalid PR author: "${pr.user.login}" expected: "dependabot[bot]"`
      );
      continue;
    }

    if (!pr.title.endsWith(title)) {
      console.log(`invalid PR title: "${pr.title}" expected: "${title}"`);
      continue;
    }

    await sleep(2000);
    await approve(owner, repo, pr.number);
    await merge(owner, repo, pr.number);

    processed++;
  }

  return {
    processed,
    total: response.data.items.length,
  };
}

listAll(process.argv[2], process.argv[3])
  .then(({ processed, total }) => {
    console.log(`\nDone (${processed}/${total})`);
  })
  .catch((e) => console.error(e));
