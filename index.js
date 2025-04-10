#!/usr/bin/env node
"use strict";

const prompt = require("prompt");

if (process.argv.length < 5) {
  console.error("Usage:");
  console.error(
    'GITHUB_TOKEN=*** npx mass-merge <organization(s)> <"commit message"> <author> [--ignore-checks]'
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
  try {
    await octokit.request(
      "PUT /repos/{owner}/{repo}/pulls/{pullNumber}/merge",
      {
        owner,
        repo,
        pullNumber,
        merge_method: "squash",
      }
    );
    console.log("and merged");
  } catch (error) {
    console.error(`NOT MERGED ❗️ (${error.status} ${error.message})`);
  }
}

function extractUrlParts(url) {
  const match = url.match(/\/repos\/([^\/]+)\/([^\/]+)\/issues\/([^\/]+)/);
  return {
    org: match[1],
    repo: match[2],
    id: match[3],
  };
}

async function retry(func, triesLeft = 3) {
  try {
    return await func();
  } catch (error) {
    triesLeft--;

    if (triesLeft > 0) {
      await sleep(2000);
      return retry(func, triesLeft);
    } else {
      throw error;
    }
  }
}

async function getCheckStatus(pr) {
  const { org, repo, id } = extractUrlParts(pr.url);

  const detail = await octokit.request(`GET /repos/${org}/${repo}/pulls/${id}`);
  const sha = detail.data.head.sha;

  const checks = await octokit.request(
    `GET /repos/${org}/${repo}/commits/${sha}/check-runs`
  );

  const runs = checks.data.check_runs;

  if (runs.length < 1) {
    return "missing";
  } else if (
    runs.every((r) => ["success", "neutral", "skipped"].includes(r.conclusion))
  ) {
    return "success";
  } else if (runs.some((r) => r.status === "queued")) {
    return "queued";
  } else if (runs.some((r) => r.status === "in_progress")) {
    return "in_progress";
  } else {
    return "failed";
  }
}

function constructQuery(owners, title, author, restrictToRepos) {
  const parts = [
    "is:open",
    "is:pr",
    "archived:false",
    "draft:false",
    "comments:0",
    `author:${author}`,
    "in:title",
    `"${title}"`,
  ];

  if (restrictToRepos.length === 0) {
    const orgs = owners.map((owner) => `org:${owner}`);
    parts.push(`(${orgs.join(" OR ")})`);
  } else {
    for (const repo of restrictToRepos) {
      parts.push(`repo:${repo}`);
    }
  }

  return parts.join(" ");
}

async function listAll(ownersString, title, author, restrictToRepos) {
  let page = 1;
  const prs = new Map();
  const owners = ownersString.split(",");
  const query = constructQuery(owners, title, author, restrictToRepos);

  // 10 pages is a safety net, in case numbers don't add up, so we don't loop forever
  while (page < 10) {
    const response = await octokit.request("GET /search/issues", {
      q: query,
      advanced_search: true,
      sort: "created",
      order: "asc",
      per_page: 100,
      page,
    });

    for (const pr of response.data.items) {
      prs.set(pr.id, pr);
    }

    page++;

    if (prs.size >= response.data.total_count) {
      break;
    }

    await sleep(1000);
  }

  return [...prs.values()];
}

async function run(
  orgs,
  title,
  author,
  restrictToRepos,
  { ignoreChecks = false } = {}
) {
  if (author === "dependabot") {
    author = "app/dependabot";
  }

  const prs = await listAll(orgs, title, author, restrictToRepos);
  console.log(`Found ${prs.length} PRs`);
  const toMerge = [];

  const maxTitleLength = prs.reduce((max, pr) => {
    return Math.max(max, pr.title.length);
  }, 0);

  for (const pr of prs) {
    const { org, repo, id } = extractUrlParts(pr.url);
    const humanURL = `https://github.com/${org}/${repo}/pull/${id}`;

    const status = await retry(() => getCheckStatus(pr));

    if (status === "success") {
      console.log(`✅ ${pr.title.padEnd(maxTitleLength)} ${humanURL}`);
      toMerge.push(pr);
    } else if (["queued", "in_progress"].includes(status)) {
      console.log(`❓ ${pr.title.padEnd(maxTitleLength)} ${humanURL}`);
    } else if (status === "missing") {
      console.log(`🤔 ${pr.title.padEnd(maxTitleLength)} ${humanURL}`);
    } else {
      console.log(`❌ ${pr.title.padEnd(maxTitleLength)} ${humanURL}`);
    }

    if (ignoreChecks && status !== "success") {
      toMerge.push(pr);
    }
  }

  console.log(`Checked ${prs.length} PRs - ${toMerge.length} ready to merge`);

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
    const regex = new RegExp(`\/repos\/([^\/]+)\/([^\/]+)\/`);
    const [, org, repo] = pr.url.match(regex);
    process.stdout.write(`${repo}#${pr.number} `);

    // Safety checks
    if (pr.user.login.toLowerCase() !== requiredUserLogin.toLowerCase()) {
      console.log(
        `invalid PR author: "${pr.user.login.toLowerCase()}" expected: "${requiredUserLogin.toLowerCase()}"`
      );
      continue;
    }

    if (!pr.title.toLowerCase().includes(title.toLowerCase())) {
      console.log(`invalid PR title: "${pr.title}" expected: "${title}"`);
      continue;
    }

    await sleep(2000);
    await retry(() => approve(org, repo, pr.number));
    await retry(() => merge(org, repo, pr.number));

    processed++;
  }

  return {
    processed,
    total: prs.length,
  };
}

let ignoreChecks = false;
const i = process.argv.findIndex(
  (arg) => arg === "--ignore-checks" || arg === "-f"
);

if (i >= 0) {
  ignoreChecks = true;
  process.argv.splice(i, 1);
}

let restrictToRepos = [];
if (process.argv.length > 5 && !process.argv[5].startsWith("-")) {
  restrictToRepos = process.argv[5].split(",");
}

run(process.argv[2], process.argv[3], process.argv[4], restrictToRepos, {
  ignoreChecks,
})
  .then(({ processed, total }) => {
    console.log(`\nDone (${processed}/${total})`);
  })
  .catch((e) => console.error(e));
