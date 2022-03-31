#!/usr/bin/env node
"use strict";

const prompt = require("prompt");

if (process.argv.length < 5) {
  console.error("Usage:");
  console.error(
    'GITHUB_TOKEN=*** npx mass-merge <organization> <"commit message"> <author> [--ignore-checks]'
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

function extractUrlParts(url) {
  const match = url.match(/\/repos\/([^\/]+)\/([^\/]+)\/issues\/([^\/]+)/);
  return {
    owner: match[1],
    repo: match[2],
    id: match[3],
  };
}

async function getCheckStatus(pr) {
  const { owner, repo, id } = extractUrlParts(pr.url);

  const detail = await octokit.request(
    `GET /repos/${owner}/${repo}/pulls/${id}`
  );
  const sha = detail.data.head.sha;

  const checks = await octokit.request(
    `GET /repos/${owner}/${repo}/commits/${sha}/check-runs`
  );

  const runs = checks.data.check_runs;

  if (runs.length < 1) {
    return "missing";
  } else if (runs.every((r) => r.conclusion === "success")) {
    return "success";
  } else if (runs.some((r) => r.status === "queued")) {
    return "queued";
  } else if (runs.some((r) => r.status === "in_progress")) {
    return "in_progress";
  } else {
    return "failed";
  }
}

async function listAll(owner, title, author, { ignoreChecks = false } = {}) {
  const query = [
    "is:open",
    "is:pr",
    "archived:false",
    "draft:false",
    "comments:0",
    `org:${owner}`,
    `author:${author}`,
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

  const toMerge = [];

  for (const pr of response.data.items) {
    const { repo, id } = extractUrlParts(pr.url);
    const humanURL = `https://github.com/${owner}/${repo}/pull/${id}`;

    if (ignoreChecks) {
      console.log(humanURL);
      toMerge.push(pr);
      continue;
    }

    const status = await getCheckStatus(pr);

    if (status === "success") {
      console.log(`✅ ${humanURL}`);
      toMerge.push(pr);
    } else if (["queued", "in_progress"].includes(status)) {
      console.log(`❓ ${humanURL}`);
    } else {
      console.log(`❌ ${humanURL}`);
    }
  }

  console.log(
    `Checked ${response.data.total_count} PRs - ${toMerge.length} ready to merge`
  );

  if (toMerge.length > 0) {
    prompt.start();

    console.log("\n");
    const { confirm } = await prompt.get([
      {
        name: "confirm",
        description: `Are you sure you want to proceed with the mass merge of ${toMerge.length} PRs? (Y/N)`,
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
  const requiredUserLogin =
    author === "app/dependabot" ? "dependabot[bot]" : author;

  for (const pr of toMerge) {
    const regex = new RegExp(`\/repos\/${owner}\/([^\/]+)\/`);
    const repo = pr.url.match(regex)[1];
    process.stdout.write(`${repo}#${pr.number} `);

    // Safety checks
    if (pr.user.login !== requiredUserLogin) {
      console.log(
        `invalid PR author: "${pr.user.login}" expected: "${requiredUserLogin}"`
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

let ignoreChecks = false;
const i = process.argv.indexOf("--ignore-checks");
if (i >= 0) {
  ignoreChecks = true;
  process.argv.splice(i, 1);
}

listAll(process.argv[2], process.argv[3], process.argv[4], { ignoreChecks })
  .then(({ processed, total }) => {
    console.log(`\nDone (${processed}/${total})`);
  })
  .catch((e) => console.error(e));
