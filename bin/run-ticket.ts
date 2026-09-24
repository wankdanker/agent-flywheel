// CLI: work one issue, configured entirely by env. Exit codes let whatever
// invokes us (CI, a human) branch on the outcome.
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

const tracker = detectTracker();
const [ticket, repo] = await Promise.all([tracker.getTicket(), tracker.repo()]);
console.log(`[ticket] #${ticket.number} ${ticket.title}, ${ticket.comments.length} comments`);
await tracker.setState("working");

const outcome = await runTicket(ticket, {
  tracker,
  repo,
  workDir: process.env.WORK_DIR ?? "/work",
  pluginDir: process.env.PLUGIN_DIR ?? "/opt/agent/agent/plugin",
  model: process.env.CLAUDE_MODEL,
  maxTurns: Number(process.env.MAX_TURNS ?? 80),
});

if (outcome.kind === "incomplete") {
  await tracker.comment(`I stopped before finishing (turn limit or error). Reply here to have me continue from branch \`${branchFor(ticket)}\`.`);
  await tracker.setState("blocked");
}
console.log(`[outcome] ${outcome.kind}: ${outcome.detail}`);
process.exit({ done: 0, asked: 10, incomplete: 1 }[outcome.kind]);
