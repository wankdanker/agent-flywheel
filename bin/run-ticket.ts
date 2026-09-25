// CLI: work one issue, configured entirely by env. Exit codes let whatever
// invokes us (CI, a human) branch on the outcome.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { githubTracker } from "../src/github.ts";
import { gitlabTracker } from "../src/gitlab.ts";
import { credentialFromEnv, sandboxEnv, startModelProxy } from "../src/model-proxy.ts";
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

const tracker = detectTracker();
const [ticket, repo] = await Promise.all([tracker.getTicket(), tracker.repo()]);
console.log(`[ticket] #${ticket.number} ${ticket.title}, ${ticket.comments.length} comments`);
await tracker.setState("working");

// Namespaced per issue: if WORK_DIR is cached/persisted across runs (so a failed
// run doesn't lose its clone), two issues sharing that cache must not collide.
const workDir = join(process.env.WORK_DIR ?? "/work", `issue-${ticket.number}`);
mkdirSync(workDir, { recursive: true });

// The agent subprocess (and anything its Bash tool spawns) never sees the real
// ANTHROPIC_API_KEY/CLAUDE_CODE_OAUTH_TOKEN: this trusted process reads it once here and
// hands it only to a loopback-only proxy, then launches the agent with a placeholder key
// and ANTHROPIC_BASE_URL pointed at that proxy. See src/model-proxy.ts and the README's
// "Model credential exposure" section for what this does and doesn't eliminate.
const proxy = await startModelProxy(credentialFromEnv(process.env), {
  maxRequests: process.env.MODEL_PROXY_MAX_REQUESTS ? Number(process.env.MODEL_PROXY_MAX_REQUESTS) : undefined,
  maxLifetimeMs: process.env.MODEL_PROXY_MAX_LIFETIME_MS ? Number(process.env.MODEL_PROXY_MAX_LIFETIME_MS) : undefined,
  requestTimeoutMs: process.env.MODEL_PROXY_REQUEST_TIMEOUT_MS ? Number(process.env.MODEL_PROXY_REQUEST_TIMEOUT_MS) : undefined,
});

let outcome;
try {
  outcome = await runTicket(ticket, {
    tracker,
    repo,
    workDir,
    pluginDir: process.env.PLUGIN_DIR ?? "/opt/agent/agent/plugin",
    model: process.env.CLAUDE_MODEL,
    maxTurns: Number(process.env.MAX_TURNS ?? 120),
    env: sandboxEnv(process.env, proxy.url),
  });
} finally {
  console.log(`[model-proxy] forwarded ${proxy.requestCount()} request(s)`);
  await proxy.close();
}

if (outcome.kind === "incomplete") {
  await tracker.comment(`I stopped before finishing (turn limit or error). Reply here to have me continue from branch \`${branchFor(ticket)}\`.`);
  await tracker.setState("blocked");
}
console.log(`[outcome] ${outcome.kind}: ${outcome.detail}`);
// split behaves like blocked for CI's purposes: not a failure, nothing merged yet, the
// issue is left `blocked` for a human or a sub-issue's own run to pick back up.
process.exit({ ready_for_review: 0, blocked: 10, split: 10, incomplete: 1, failed: 1 }[outcome.kind]);
