// CLI: work one issue, configured entirely by env. Exit codes let whatever
// invokes us (CI, a human) branch on the outcome.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { isAllowedRepo, parseAllowlist } from "../src/allowlist.ts";
import { originUrl, prepareRepo, type Credential } from "../src/clone.ts";
import { githubTracker } from "../src/github.ts";
import { gitlabTracker } from "../src/gitlab.ts";
import { need, type Tracker } from "../src/tracker.ts";
import { branchFor, runTicket } from "../src/worker.ts";

// CI and `docker --env-file` hand us unset optional vars as "", which would read as set.
for (const [k, v] of Object.entries(process.env)) if (v === "") delete process.env[k];

if (!process.env.ANTHROPIC_API_KEY && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
  console.error("missing env ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN");
  process.exit(2);
}

function detectTracker(): Tracker {
  const platform = process.env.AGENT_PLATFORM || (process.env.GITLAB_CI ? "gitlab" : process.env.GITHUB_ACTIONS ? "github" : "");
  const issue = Number(need("ISSUE"));
  if (platform === "github") {
    return githubTracker({ token: need("GH_TOKEN"), repo: need("GITHUB_REPOSITORY"), issue, apiUrl: process.env.GITHUB_API_URL });
  }
  if (platform === "gitlab") {
    return gitlabTracker({
      token: need("AGENT_GITLAB_TOKEN"),
      apiUrl: process.env.CI_API_V4_URL || `https://${need("CI_SERVER_HOST")}/api/v4`,
      project: process.env.CI_PROJECT_ID || need("CI_PROJECT_PATH"),
      issue,
    });
  }
  console.error("can't tell the platform; set AGENT_PLATFORM to github or gitlab");
  process.exit(2);
}

// The only credential a `git` subprocess we spawn ever sees; never written to git config,
// so it can't be read back out of it once prepareRepo() returns. See src/clone.ts.
function credentialFor(platform: Tracker["platform"]): Credential {
  return platform === "github"
    ? { username: "x-access-token", token: need("GH_TOKEN") }
    : { username: "oauth2", token: need("AGENT_GITLAB_TOKEN") };
}

const tracker = detectTracker();
const [ticket, repo] = await Promise.all([tracker.getTicket(), tracker.repo()]);
console.log(`[ticket] #${ticket.number} ${ticket.title}, ${ticket.comments.length} comments`);

// Refuse before granting any credential or running `git clone` at all: an issue's title,
// body, or comments never get a say in which repo we touch (see README's Trust model for
// the parallel rule about what the *model* is allowed to read as instructions).
const allowlist = parseAllowlist(process.env);
if (!isAllowedRepo(repo.cloneUrl, allowlist)) {
  console.error(
    `refusing to clone ${repo.cloneUrl}: not in the repo allowlist (${allowlist.join(", ") || "<empty>"}). ` +
      `Set AGENT_REPO_ALLOWLIST to a comma-separated list of owner/repo to allow it.`,
  );
  process.exit(2);
}

await tracker.setState("working");

// Namespaced per issue: if WORK_DIR is cached/persisted across runs (so a failed
// run doesn't lose its clone), two issues sharing that cache must not collide.
const workDir = join(process.env.WORK_DIR ?? "/work", `issue-${ticket.number}`);
mkdirSync(workDir, { recursive: true });

// Cloning happens here, before the agent's own (permission-bypassed) shell ever starts, so
// it never needs or sees forge credentials to get the repo it's meant to work on.
prepareRepo({
  cloneUrl: repo.cloneUrl,
  workDir,
  branch: branchFor(ticket),
  defaultBranch: repo.defaultBranch,
  credential: credentialFor(tracker.platform),
});

// A cached work dir from a previous run could in principle predate today's allowlist;
// re-check what's actually on disk, not just what we asked to clone.
if (!isAllowedRepo(originUrl(workDir), allowlist)) {
  console.error(`refusing to continue: ${workDir} is a clone of a repo outside the allowlist.`);
  process.exit(2);
}

const outcome = await runTicket(ticket, {
  tracker,
  repo,
  workDir,
  pluginDir: process.env.PLUGIN_DIR ?? "/opt/agent/agent/plugin",
  model: process.env.CLAUDE_MODEL,
  maxTurns: Number(process.env.MAX_TURNS ?? 120),
});

if (outcome.kind === "incomplete") {
  await tracker.comment(`I stopped before finishing (turn limit or error). Reply here to have me continue from branch \`${branchFor(ticket)}\`.`);
  await tracker.setState("blocked");
}
console.log(`[outcome] ${outcome.kind}: ${outcome.detail}`);
// split behaves like blocked for CI's purposes: not a failure, nothing merged yet, the
// issue is left `blocked` for a human or a sub-issue's own run to pick back up.
process.exit({ ready_for_review: 0, blocked: 10, split: 10, incomplete: 1, failed: 1 }[outcome.kind]);
