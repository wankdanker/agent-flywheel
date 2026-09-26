// The whole of one run, as an importable function: bin/run-ticket.ts is just
// `process.exit(await main())`. Everything that can touch the issue's labels lives here so
// the one invariant we care about is checkable in tests with a fake tracker and a fake
// agent engine: once we've set `agent/working`, every handled path ends with a terminal
// label (`agent/review` or `agent/blocked`), never `agent/working`.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { isAllowedRepo, parseAllowlist } from "./allowlist.ts";
import { originUrl as realOriginUrl, prepareRepo as realPrepareRepo, type Credential } from "./clone.ts";
import { githubTracker } from "./github.ts";
import { gitlabTracker } from "./gitlab.ts";
import { credentialFromEnv, sandboxEnv, startModelProxy as realStartModelProxy } from "./model-proxy.ts";
import type { Ticket, TicketState, Tracker } from "./tracker.ts";
import { branchFor, runTicket as realRunTicket, settle, SettlementError, type Outcome } from "./worker.ts";

// split behaves like blocked for CI's purposes: not a failure, nothing merged yet, the
// issue is left `blocked` for a human or a sub-issue's own run to pick back up.
// checkpoint (20) is a graceful pause at the turn limit, work pushed to the branch; also a
// success for CI, and distinct from 10 so CI can later auto-relay it to a new run.
export const EXIT_CODES: Record<Outcome["kind"], number> = { ready_for_review: 0, blocked: 10, split: 10, checkpoint: 20, incomplete: 1, failed: 1 };

// Bad or missing configuration: exit 2, and (when it's found before we set `working`)
// without touching the issue at all.
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export type RunDeps = {
  env?: NodeJS.ProcessEnv;
  // Seams for tests; each defaults to the real implementation.
  tracker?: Tracker;
  prepareRepo?: typeof realPrepareRepo;
  originUrl?: typeof realOriginUrl;
  startModelProxy?: (...a: Parameters<typeof realStartModelProxy>) => Promise<{ url: string; requestCount(): number; close(): Promise<void> }>;
  runTicket?: typeof realRunTicket;
};

export const DEFAULT_PLUGIN_DIR = "/opt/agent/agent/plugin";

const req = (env: NodeJS.ProcessEnv, k: string): string => {
  const v = env[k];
  if (!v) throw new ConfigError(`missing env ${k}`);
  return v;
};

export function parseMaxTurns(raw: string | undefined): number {
  if (raw === undefined || raw === "") return 120;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new ConfigError(`MAX_TURNS must be a positive integer, got ${JSON.stringify(raw)}`);
  return n;
}

const optionalNumber = (env: NodeJS.ProcessEnv, k: string) => (env[k] ? Number(env[k]) : undefined);

// CI and `docker --env-file` hand us unset optional vars as "", which would read as set.
// Both entry points (bin/run-ticket.ts, bin/smoke.ts) call this first, on process.env.
export function stripEmptyEnv(env: NodeJS.ProcessEnv): void {
  for (const [k, v] of Object.entries(env)) if (v === "") delete env[k];
}

export function requireModelCredential(env: NodeJS.ProcessEnv): void {
  if (!env.ANTHROPIC_API_KEY && !env.CLAUDE_CODE_OAUTH_TOKEN) throw new ConfigError("missing env ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN");
}

// The agent subprocess (and anything its Bash tool spawns) never sees the real
// ANTHROPIC_API_KEY/CLAUDE_CODE_OAUTH_TOKEN: this trusted process reads it once here and
// hands it only to a loopback-only proxy, then launches the agent with a placeholder key
// and ANTHROPIC_BASE_URL pointed at that proxy (sandboxEnv). See src/model-proxy.ts and the
// README's "Model credential exposure" section for what this does and doesn't eliminate.
// Shared with src/smoke.ts, so the image's pre-`:latest` smoke test runs this exact path.
export function startProxyFromEnv(env: NodeJS.ProcessEnv, startModelProxy: NonNullable<RunDeps["startModelProxy"]> = realStartModelProxy) {
  return startModelProxy(credentialFromEnv(env), {
    maxRequests: optionalNumber(env, "MODEL_PROXY_MAX_REQUESTS"),
    maxLifetimeMs: optionalNumber(env, "MODEL_PROXY_MAX_LIFETIME_MS"),
    requestTimeoutMs: optionalNumber(env, "MODEL_PROXY_REQUEST_TIMEOUT_MS"),
  });
}

function detectTracker(env: NodeJS.ProcessEnv): Tracker {
  const platform = env.AGENT_PLATFORM || (env.GITLAB_CI ? "gitlab" : env.GITHUB_ACTIONS ? "github" : "");
  const issue = Number(req(env, "ISSUE"));
  if (platform === "github") {
    return githubTracker({ token: req(env, "GH_TOKEN"), repo: req(env, "GITHUB_REPOSITORY"), issue, apiUrl: env.GITHUB_API_URL });
  }
  if (platform === "gitlab") {
    return gitlabTracker({
      token: req(env, "AGENT_GITLAB_TOKEN"),
      apiUrl: env.CI_API_V4_URL || `https://${req(env, "CI_SERVER_HOST")}/api/v4`,
      project: env.CI_PROJECT_ID || req(env, "CI_PROJECT_PATH"),
      issue,
    });
  }
  throw new ConfigError("can't tell the platform; set AGENT_PLATFORM to github or gitlab");
}

// The only credential a `git` subprocess we spawn ever sees; never written to git config,
// so it can't be read back out of it once prepareRepo() returns. See src/clone.ts.
function credentialFor(platform: Tracker["platform"], env: NodeJS.ProcessEnv): Credential {
  return platform === "github"
    ? { username: "x-access-token", token: req(env, "GH_TOKEN") }
    : { username: "oauth2", token: req(env, "AGENT_GITLAB_TOKEN") };
}

// What an error may say on the issue. The full error (stack, raw API response) only ever
// goes to the CI log; the issue gets its first line, capped, with anything that looks
// like a credential scrubbed: every secret-named env value we were handed, plus the usual
// token shapes, auth headers and userinfo in URLs.
const SECRET_ENV_NAME = /TOKEN|KEY|SECRET|PASSWORD|PASSWD|AUTH|COOKIE|CREDENTIAL/i;
const SECRET_PATTERNS: [RegExp, string][] = [
  [/\b(bearer|basic|token)\s+[\w.~+/=-]{8,}/gi, "$1 [redacted]"],
  [/\b(authorization|x-api-key|private-token|cookie)(["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, "$1$2[redacted]"],
  [/\b(sk-ant-|ghp_|gho_|ghs_|ghu_|ghr_|github_pat_|glpat-|gldt-|glrt-)[\w-]+/g, "[redacted]"],
  [/\/\/[^/\s:@]+:[^/\s@]+@/g, "//[redacted]@"],
];
const MAX_ISSUE_ERROR_LENGTH = 300;

export function sanitizeError(err: unknown, env: NodeJS.ProcessEnv = {}): string {
  let s = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  s = s.split("\n")[0]!.trim();
  for (const [k, v] of Object.entries(env)) {
    if (v && v.length >= 8 && SECRET_ENV_NAME.test(k)) s = s.split(v).join("[redacted]");
  }
  for (const [re, sub] of SECRET_PATTERNS) s = s.replace(re, sub);
  if (s.length > MAX_ISSUE_ERROR_LENGTH) s = `${s.slice(0, MAX_ISSUE_ERROR_LENGTH)}…`;
  return s.replace(/`/g, "'");
}

// Wraps the real tracker to (a) remember the last label we successfully applied, which is
// how main() knows whether a terminal state actually landed, and (b) never post the same
// comment twice: not within this run, and not as a repeat of the bot comments already
// sitting at the end of the thread (a retry after a run whose comment posted but whose
// label update failed).
export function guardTracker(tracker: Tracker, ticket: Ticket) {
  let state: TicketState | undefined;
  const posted = new Set<string>();
  for (const c of [...ticket.comments].reverse()) {
    if (!c.fromBot) break;
    posted.add(c.text.trim());
  }
  const guarded: Tracker = {
    platform: tracker.platform,
    repo: () => tracker.repo(),
    getTicket: () => tracker.getTicket(),
    createSubIssue: (input) => tracker.createSubIssue(input),
    async comment(text) {
      const key = text.trim();
      if (posted.has(key)) {
        console.log("[tracker] skipping comment identical to one already posted");
        return;
      }
      await tracker.comment(text);
      posted.add(key);
    },
    async setState(s) {
      await tracker.setState(s);
      state = s;
    },
  };
  return { tracker: guarded, state: () => state };
}

const isTerminal = (s: TicketState | undefined) => s === "review" || s === "blocked";

export async function main(deps: RunDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const prepareRepo = deps.prepareRepo ?? realPrepareRepo;
  const originUrl = deps.originUrl ?? realOriginUrl;
  const startModelProxy = deps.startModelProxy ?? realStartModelProxy;
  const runTicket = deps.runTicket ?? realRunTicket;

  // Everything that can be wrong with our config is checked before we touch the issue.
  let tracker: Tracker, maxTurns: number;
  try {
    requireModelCredential(env);
    maxTurns = parseMaxTurns(env.MAX_TURNS);
    tracker = deps.tracker ?? detectTracker(env);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      return 2;
    }
    throw err;
  }

  const [ticket, repo] = await Promise.all([tracker.getTicket(), tracker.repo()]);
  console.log(`[ticket] #${ticket.number} ${ticket.title}, ${ticket.comments.length} comments`);

  // Refuse before granting any credential or running `git clone` at all: an issue's title,
  // body, or comments never get a say in which repo we touch (see README's Trust model for
  // the parallel rule about what the *model* is allowed to read as instructions).
  const allowlist = parseAllowlist(env);
  if (!isAllowedRepo(repo.cloneUrl, allowlist)) {
    console.error(
      `refusing to clone ${repo.cloneUrl}: not in the repo allowlist (${allowlist.join(", ") || "<empty>"}). ` +
        `Set AGENT_REPO_ALLOWLIST to a comma-separated list of owner/repo to allow it.`,
    );
    return 2;
  }

  const guard = guardTracker(tracker, ticket);

  // From here on, whatever happens, we owe the issue a terminal label.
  let code: number;
  let failure: unknown;
  try {
    await guard.tracker.setState("working");
    code = await work();
  } catch (err) {
    failure = err;
    code = err instanceof ConfigError ? 2 : 1;
    console.error(`[error] run failed on #${ticket.number}:`, err);
    if (err instanceof SettlementError) {
      // Don't let the tracker failure hide what the agent actually got done.
      console.error(`[outcome] the agent had reached ${err.outcome.kind}: ${err.outcome.detail}`);
      for (const c of err.causes) console.error("[error] cause:", c);
    }
  }

  if (!isTerminal(guard.state())) {
    await fallBackToBlocked(guard.tracker, ticket, failure, env);
    if (code === 0) code = 1; // a "success" whose label never landed isn't one
  } else if (failure) {
    console.error(`[error] #${ticket.number} is labeled ${guard.state()}, but the run above failed; see the error for what's missing.`);
  }
  return code;

  async function work(): Promise<number> {
    // Namespaced per issue: if WORK_DIR is cached/persisted across runs (so a failed
    // run doesn't lose its clone), two issues sharing that cache must not collide.
    const workDir = join(env.WORK_DIR ?? "/work", `issue-${ticket.number}`);
    mkdirSync(workDir, { recursive: true });

    // Cloning happens here, before the agent's own (permission-bypassed) shell ever starts, so
    // it never needs or sees forge credentials to get the repo it's meant to work on.
    prepareRepo({
      cloneUrl: repo.cloneUrl,
      workDir,
      branch: branchFor(ticket),
      defaultBranch: repo.defaultBranch,
      credential: credentialFor(tracker.platform, env),
    });

    // A cached work dir from a previous run could in principle predate today's allowlist;
    // re-check what's actually on disk, not just what we asked to clone.
    if (!isAllowedRepo(originUrl(workDir), allowlist)) {
      throw new ConfigError(`refusing to continue: ${workDir} is a clone of a repo outside the allowlist.`);
    }

    // The real model credential goes only to a loopback proxy; see startProxyFromEnv.
    const proxy = await startProxyFromEnv(env, startModelProxy);

    let outcome: Outcome;
    try {
      outcome = await runTicket(ticket, {
        tracker: guard.tracker,
        repo,
        workDir,
        pluginDir: env.PLUGIN_DIR ?? DEFAULT_PLUGIN_DIR,
        model: env.CLAUDE_MODEL,
        maxTurns,
        env: sandboxEnv(env, proxy.url),
      });
    } finally {
      console.log(`[model-proxy] forwarded ${proxy.requestCount()} request(s)`);
      // Logged, not thrown: a failed close must not mask the run's own result or error.
      await proxy.close().catch((err) => console.error("[cleanup] model proxy close failed:", err));
    }

    if (outcome.kind === "incomplete") {
      outcome = await settle(outcome, [
        () => guard.tracker.comment(`I stopped before finishing. Reply here to have me continue from branch \`${branchFor(ticket)}\`.`),
        () => guard.tracker.setState("blocked"),
      ]);
    }
    console.log(`[outcome] ${outcome.kind}: ${outcome.detail}`);
    return EXIT_CODES[outcome.kind];
  }
}

// Best effort, and each step on its own: a failing comment mustn't stop the label update,
// and neither failure may replace the original error (already logged by the caller).
async function fallBackToBlocked(tracker: Tracker, ticket: Ticket, failure: unknown, env: NodeJS.ProcessEnv) {
  const reached = failure instanceof SettlementError ? `I'd reached \`${failure.outcome.kind}\`, but couldn't record it on the issue. ` : "";
  const text =
    `${reached}I hit an error and stopped, so I've marked this issue blocked rather than leave it \`agent/working\`.\n\n` +
    `> ${failure === undefined ? "the run ended without setting a final state" : sanitizeError(failure, env)}\n\n` +
    `Full diagnostics are in the CI job log. Reply here to have me retry from branch \`${branchFor(ticket)}\`.`;
  try {
    await tracker.comment(text);
  } catch (err) {
    console.error(`[cleanup] couldn't post the failure comment on #${ticket.number}:`, err);
  }
  try {
    await tracker.setState("blocked");
  } catch (err) {
    console.error(
      `[cleanup] couldn't set #${ticket.number} to blocked: it may still be labeled agent/working with no run active. ` +
        `Swap that label for agent/blocked by hand, or reply on the issue to start a new run.`,
      err,
    );
  }
}
