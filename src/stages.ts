// src/run.ts's main() split into three stages, each run in its own CI job/container so that
// the forge token and the model credential are never in the same execution environment:
//   prepare  (forge token, no model credential): fetch the issue, set `agent/working`, clone and
//            check out the branch, write prepared.json for the agent stage.
//   agent    (model credential, no forge token): run the agent's session on the work dir and
//            write what it recorded to outcome.json. Never talks to the tracker.
//   publish  (forge token, no model credential): re-fetch the issue from the forge, read
//            outcome.json and the work dir as data (src/handoff.ts, src/publish.ts), and apply
//            the outcome: push, open the PR/MR, comment, label.
// CI carries the work dir (clone + handoff files) from job to job. Each stage refuses to start
// (exit 2) if it's handed the credential it isn't supposed to have. bin/run-ticket.ts picks the
// stage from `--stage`; without it, main() runs all three in one process.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isAllowedRepo } from "./allowlist.ts";
import { originUrl as realOriginUrl, prepareRepo as realPrepareRepo } from "./clone.ts";
import { clearOutcome, readOutcome, readPrepared, resetHandoff, writeOutcome, writePrepared } from "./handoff.ts";
import { FORGE_TOKEN_VARS, sandboxEnv, startModelProxy as realStartModelProxy } from "./model-proxy.ts";
import { gitPublisher } from "./publish.ts";
import {
  ConfigError, configExit, credentialFor, DEFAULT_PLUGIN_DIR, detectTracker, EXIT_CODES, fetchAllowedTicket, guarded,
  guardTracker, parseMaxTurns, requireModelCredential, settleIncomplete, startProxyFromEnv, workDirFor, type RunDeps,
} from "./run.ts";
import { STATE_LABELS, type Tracker } from "./tracker.ts";
import { applyOutcome, blockForDirective, branchFor, needsDirective, runSession as realRunSession, type AgentOutcome, type SessionEnd } from "./worker.ts";

export const STAGES = ["prepare", "agent", "publish"] as const;
export type Stage = (typeof STAGES)[number];

export const MODEL_CREDENTIAL_VARS = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"];

// The prepare and publish stages hold the forge token; they must not also hold the model's.
export function refuseModelCredential(env: NodeJS.ProcessEnv, stage: Stage) {
  const found = MODEL_CREDENTIAL_VARS.filter((k) => env[k]);
  if (found.length) throw new ConfigError(`the ${stage} stage must not have a model credential, but got ${found.join(", ")}; pass it only to --stage agent`);
}

// Where a forge credential could reach the agent stage: its env, the usual credential files, and
// git config (credential helpers, auth headers, a token in a remote or rewritten URL). Returns
// where it found one, never the value. Also the check README's "Credential separation" points at.
export function forgeCredentialLeaks(env: NodeJS.ProcessEnv, workDir: string, home = env.HOME ?? homedir()): string[] {
  const leaks = FORGE_TOKEN_VARS.filter((k) => env[k]).map((k) => `env ${k}`);
  for (const f of [".git-credentials", ".netrc", "_netrc", ".config/gh/hosts.yml", ".config/git/credentials"]) {
    if (existsSync(join(home, f))) leaks.push(`file ~/${f}`);
  }
  // Every scope git would read in the work dir (system, global, local). No match exits 1.
  const res = spawnSync("git", ["config", "--show-scope", "--get-regexp", "^(credential\\..*|http\\..*extraheader|remote\\..*\\.(push)?url|url\\..*)$"], {
    cwd: existsSync(workDir) ? workDir : undefined,
    env: { PATH: env.PATH, HOME: home },
    encoding: "utf8",
  });
  for (const line of (res.stdout ?? "").split("\n").filter(Boolean)) {
    const [scope, entry = ""] = line.split("\t");
    const [key = "", ...rest] = entry.split(" ");
    const value = rest.join(" ");
    const userinfo = /\/\/[^/@\s]*:[^/@\s]+@/.test(value) || /\/\/[^/@\s]*:[^/@\s]+@/.test(key);
    if (/^credential\./i.test(key) || /extraheader$/i.test(key) || userinfo) {
      leaks.push(`git config (${scope}) ${key.replace(/\/\/[^/@\s]*@/g, "//[redacted]@")}`);
    }
  }
  return leaks;
}

function parseIssue(env: NodeJS.ProcessEnv): number {
  const n = Number(env.ISSUE);
  if (!env.ISSUE || !Number.isInteger(n) || n < 1) throw new ConfigError(`ISSUE must be a positive integer, got ${JSON.stringify(env.ISSUE ?? "")}`);
  return n;
}

export async function prepareStage(deps: RunDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const prepareRepo = deps.prepareRepo ?? realPrepareRepo;
  const originUrl = deps.originUrl ?? realOriginUrl;

  let tracker: Tracker;
  try {
    refuseModelCredential(env, "prepare");
    tracker = deps.tracker ?? detectTracker(env);
  } catch (err) {
    return configExit(err);
  }
  const allowed = await fetchAllowedTicket(tracker, env);
  if (!allowed) return 2;
  const { ticket, repo, allowlist } = allowed;
  const guard = guardTracker(tracker, ticket);

  // Success leaves the issue on `working` for the publish stage to settle; a failure here
  // settles it right away, and leaves no prepared.json, so the agent stage has nothing to do.
  return guarded(guard, ticket, env, async () => {
    await guard.tracker.setState("working");
    const workDir = workDirFor(env, ticket.number);
    mkdirSync(workDir, { recursive: true });
    resetHandoff(workDir);

    // Same check runTicket makes in the combined run, before anything is cloned.
    if (needsDirective(ticket)) return EXIT_CODES[(await blockForDirective(ticket, guard.tracker)).kind];

    const target = { cloneUrl: repo.cloneUrl, workDir, branch: branchFor(ticket), defaultBranch: repo.defaultBranch };
    prepareRepo({ ...target, credential: credentialFor(tracker.platform, env) });
    if (!isAllowedRepo(originUrl(workDir), allowlist)) {
      throw new ConfigError(`refusing to continue: ${workDir} is a clone of a repo outside the allowlist.`);
    }
    writePrepared(workDir, { platform: tracker.platform, ticket, repo });
    console.log(`[prepare] ${workDir} is on ${branchFor(ticket)}; ready for the agent stage`);
    return 0;
  }, { mustSettle: false });
}

// No tracker here at all: whatever goes wrong, the publish stage finds no outcome.json and
// settles the issue as blocked.
export async function agentStage(deps: RunDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const startModelProxy = deps.startModelProxy ?? realStartModelProxy;
  const runSession = deps.runSession ?? realRunSession;

  let maxTurns: number, issue: number;
  try {
    requireModelCredential(env);
    maxTurns = parseMaxTurns(env.MAX_TURNS);
    issue = parseIssue(env);
  } catch (err) {
    return configExit(err);
  }
  const workDir = workDirFor(env, issue);
  const leaks = forgeCredentialLeaks(env, workDir);
  if (leaks.length) {
    console.error(`refusing to run the agent stage with a forge credential in reach: ${leaks.join(", ")}`);
    return 2;
  }

  clearOutcome(workDir);
  const prepared = readPrepared(workDir);
  if (!prepared) {
    console.log(`[agent] nothing prepared for #${issue} (the prepare stage settled it, or didn't run); nothing to do`);
    return 0;
  }

  const proxy = await startProxyFromEnv(env, startModelProxy);
  let result: { recorded: AgentOutcome | undefined; end: SessionEnd };
  try {
    result = await runSession(prepared.ticket, {
      platform: prepared.platform,
      repo: prepared.repo,
      workDir,
      pluginDir: env.PLUGIN_DIR ?? DEFAULT_PLUGIN_DIR,
      model: env.CLAUDE_MODEL,
      maxTurns,
      env: sandboxEnv(env, proxy.url),
    });
  } catch (err) {
    console.error(`[error] agent session failed on #${issue} before recording an outcome:`, err);
    return 1;
  } finally {
    console.log(`[model-proxy] forwarded ${proxy.requestCount()} request(s)`);
    await proxy.close().catch((err) => console.error("[cleanup] model proxy close failed:", err));
  }

  writeOutcome(workDir, { issue, recorded: result.recorded ?? null, maxTurnsHit: result.end.maxTurnsHit });
  console.log(`[agent] recorded ${result.recorded?.status ?? "no outcome"}${result.end.maxTurnsHit ? " (out of turns)" : ""}; the publish stage applies it`);
  return 0;
}

export async function publishStage(deps: RunDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const createPublisher = deps.publisher ?? gitPublisher;

  let tracker: Tracker, maxTurns: number;
  try {
    refuseModelCredential(env, "publish");
    maxTurns = parseMaxTurns(env.MAX_TURNS);
    tracker = deps.tracker ?? detectTracker(env);
  } catch (err) {
    return configExit(err);
  }
  // The issue, its title and the branch name come from the forge, never from the work dir.
  const allowed = await fetchAllowedTicket(tracker, env);
  if (!allowed) return 2;
  const { ticket, repo } = allowed;
  // The forge's label, which the agent can't touch, is what says there's anything to settle.
  if (!ticket.labels.includes(STATE_LABELS.working)) {
    console.log(`[publish] #${ticket.number} isn't ${STATE_LABELS.working}: an earlier stage already settled it (or never started); nothing to publish`);
    return 0;
  }
  const guard = guardTracker(tracker, ticket);

  return guarded(guard, ticket, env, async () => {
    const workDir = workDirFor(env, ticket.number);
    const handed = readOutcome(workDir, ticket.number);
    const target = { cloneUrl: repo.cloneUrl, workDir, branch: branchFor(ticket), defaultBranch: repo.defaultBranch };
    let outcome = await applyOutcome(ticket, {
      tracker: guard.tracker,
      repo,
      workDir,
      pluginDir: env.PLUGIN_DIR ?? DEFAULT_PLUGIN_DIR,
      maxTurns,
      publisher: createPublisher({ ...target, credential: credentialFor(tracker.platform, env) }),
    }, handed.recorded ?? undefined, { maxTurnsHit: handed.maxTurnsHit });
    outcome = await settleIncomplete(outcome, guard.tracker, ticket);
    console.log(`[outcome] ${outcome.kind}: ${outcome.detail}`);
    return EXIT_CODES[outcome.kind];
  }, { mustSettle: true });
}

export const STAGE_MAINS: Record<Stage, (deps?: RunDeps) => Promise<number>> = { prepare: prepareStage, agent: agentStage, publish: publishStage };
