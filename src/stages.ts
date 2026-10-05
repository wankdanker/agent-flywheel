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
import { parseAllowlist, repoIdentifier } from "./allowlist.ts";
import { baseBranchFor } from "./chain.ts";
import { originUrl as realOriginUrl, prepareRepo as realPrepareRepo } from "./clone.ts";
import { chainedRuns, chainMarker, CONTINUE_COMMAND, RESUME_HINT, type Trigger } from "./dispatch.ts";
import { clearOutcome, HandoffError, readOutcome, readPrepared, resetHandoff, writeOutcome, writePrepared } from "./handoff.ts";
import { FORGE_TOKEN_VARS, sandboxEnv, startModelProxy as realStartModelProxy } from "./model-proxy.ts";
import { gitPublisher } from "./publish.ts";
import {
  checkOrigin, ConfigError, configExit, credentialFor, DEFAULT_PLUGIN_DIR, detectTracker, EXIT_CODES, EXIT_SKIPPED, fetchAllowedTicket, guarded,
  guardTracker, parseMaxBudgetUsd, parseMaxChainedRuns, parseMaxTurns, parseTrigger, publishAfterCrash, refuseInvalidTarget, requireModelCredential, settleIncomplete, startProxyFromEnv, triggerStillApplies,
  workDirFor, type RunDeps,
} from "./run.ts";
import { codePlatformOf, STATE_LABELS, type Ticket, type Tracker } from "./tracker.ts";
import {
  applyOutcome, blockForDirective, branchFor, needsDirective, runSession as realRunSession, type AgentOutcome, type Outcome, type SessionEnd,
  type WorkerConfig,
} from "./worker.ts";

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

  let hub: Tracker, trigger: Trigger | undefined, maxChained: number;
  try {
    refuseModelCredential(env, "prepare");
    trigger = parseTrigger(env);
    maxChained = parseMaxChainedRuns(env.MAX_CHAINED_RUNS);
    parseAllowlist(env); // a malformed entry is a ConfigError here, before the issue is read
    hub = deps.tracker ?? detectTracker(env);
  } catch (err) {
    return configExit(err);
  }
  const allowed = await fetchAllowedTicket(hub, env);
  if (!allowed) return 2;
  const { ticket, tracker } = allowed;
  // Before `working`: a skipped run leaves the issue exactly as it was.
  if (!triggerStillApplies(ticket, trigger, env, maxChained)) return EXIT_SKIPPED;
  if (allowed.invalidTarget !== undefined) return refuseInvalidTarget(tracker, ticket, env, allowed.invalidTarget);
  const { repo, allowlist } = allowed;
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

    const target = { cloneUrl: repo.cloneUrl, workDir, branch: branchFor(ticket), defaultBranch: baseBranchFor(ticket, repo.defaultBranch) };
    prepareRepo({ ...target, credential: credentialFor(codePlatformOf(tracker), env) });
    checkOrigin(originUrl(workDir), repo, allowlist, workDir);
    writePrepared(workDir, { platform: codePlatformOf(tracker), ticket, repo });
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

  // A Notion ticket's work dir is keyed by NOTION_PAGE_ID (workDirFor), and its number comes from
  // prepared.json, which the prepare stage wrote from the ticket itself.
  const notion = env.AGENT_PLATFORM === "notion";
  let maxTurns: number, maxBudgetUsd: number | undefined, issue: number, workDir: string;
  try {
    requireModelCredential(env);
    maxTurns = parseMaxTurns(env.MAX_TURNS);
    maxBudgetUsd = parseMaxBudgetUsd(env.MAX_BUDGET_USD);
    issue = notion ? 0 : parseIssue(env);
    workDir = workDirFor(env, issue);
  } catch (err) {
    return configExit(err);
  }
  const leaks = forgeCredentialLeaks(env, workDir);
  if (leaks.length) {
    console.error(`refusing to run the agent stage with a forge credential in reach: ${leaks.join(", ")}`);
    return 2;
  }

  clearOutcome(workDir);
  const prepared = readPrepared(workDir);
  if (!prepared) {
    console.log(`[agent] nothing prepared for ${notion ? env.NOTION_PAGE_ID : `#${issue}`} (the prepare stage settled it, or didn't run); nothing to do`);
    return 0;
  }
  if (notion) issue = prepared.ticket.number;

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
      maxBudgetUsd,
      env: sandboxEnv(env, proxy.url),
    });
  } catch (err) {
    console.error(`[error] agent session failed on #${issue} before recording an outcome:`, err);
    return 1;
  } finally {
    console.log(`[model-proxy] forwarded ${proxy.requestCount()} request(s)`);
    await proxy.close().catch((err) => console.error("[cleanup] model proxy close failed:", err));
  }

  const budgetHit = result.end.budgetHit ?? false;
  writeOutcome(workDir, { issue, recorded: result.recorded ?? null, maxTurnsHit: result.end.maxTurnsHit, budgetHit });
  const why = result.end.maxTurnsHit ? " (out of turns)" : budgetHit ? " (hit MAX_BUDGET_USD)" : "";
  console.log(`[agent] recorded ${result.recorded?.status ?? "no outcome"}${why}; the publish stage applies it`);
  return 0;
}

export async function publishStage(deps: RunDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const createPublisher = deps.publisher ?? gitPublisher;

  let hub: Tracker, maxTurns: number, maxChained: number;
  try {
    refuseModelCredential(env, "publish");
    maxTurns = parseMaxTurns(env.MAX_TURNS);
    maxChained = parseMaxChainedRuns(env.MAX_CHAINED_RUNS);
    parseAllowlist(env); // a malformed entry is a ConfigError here, before the issue is read
    hub = deps.tracker ?? detectTracker(env);
  } catch (err) {
    return configExit(err);
  }
  // The issue, its title, the branch name and the (target) repo come from the forge, never from
  // the work dir.
  const allowed = await fetchAllowedTicket(hub, env);
  if (!allowed) return 2;
  const { ticket, tracker } = allowed;
  // The forge's label, which the agent can't touch, is what says there's anything to settle.
  if (!ticket.labels.includes(STATE_LABELS.working)) {
    console.log(`[publish] #${ticket.number} isn't ${STATE_LABELS.working}: an earlier stage already settled it (or never started); nothing to publish`);
    return 0;
  }
  if (allowed.invalidTarget !== undefined) return refuseInvalidTarget(tracker, ticket, env, allowed.invalidTarget);
  const { repo } = allowed;
  const guard = guardTracker(tracker, ticket);

  return guarded(guard, ticket, env, async () => {
    const workDir = workDirFor(env, ticket.number);
    // A `Target:` header edited since the prepare stage would otherwise push this clone's branch
    // into a different repo than the one it came from.
    const prepared = readPrepared(workDir);
    if (prepared && repoIdentifier(prepared.repo.cloneUrl) !== repoIdentifier(repo.cloneUrl)) {
      throw new ConfigError(
        `refusing to publish: ${workDir} was prepared for ${repoIdentifier(prepared.repo.cloneUrl)}, but this issue now works in ` +
          `${repoIdentifier(repo.cloneUrl)} (was its Target: header edited mid-run?). Nothing was pushed.`,
      );
    }
    const target = { cloneUrl: repo.cloneUrl, workDir, branch: branchFor(ticket), defaultBranch: baseBranchFor(ticket, repo.defaultBranch) };
    const cfg: WorkerConfig = {
      tracker: guard.tracker,
      repo,
      workDir,
      pluginDir: env.PLUGIN_DIR ?? DEFAULT_PLUGIN_DIR,
      maxTurns,
      publisher: createPublisher({ ...target, credential: credentialFor(codePlatformOf(tracker), env) }),
    };
    let outcome: Outcome;
    try {
      const handed = readOutcome(workDir, ticket.number);
      outcome = await applyOutcome(ticket, cfg, handed.recorded ?? undefined, { maxTurnsHit: handed.maxTurnsHit, budgetHit: handed.budgetHit });
    } catch (err) {
      // No (usable) outcome.json: the agent stage crashed, or was killed. If the work dir made it
      // here, publish what the agent committed anyway, same as the combined run does.
      if (!(err instanceof HandoffError) || !existsSync(join(workDir, ".git"))) throw err;
      outcome = await publishAfterCrash(ticket, cfg, err, env);
    }
    outcome = await settleIncomplete(outcome, guard.tracker, ticket);
    console.log(`[outcome] ${outcome.kind}: ${outcome.detail}`);
    if (outcome.kind === "checkpoint") await relayCheckpoint(ticket, guard.tracker, maxChained);
    return EXIT_CODES[outcome.kind];
  }, { mustSettle: true });
}

export const relayComment = (t: Ticket, n: number, max: number) =>
  `Continuing from branch \`${branchFor(t)}\` on my own: this is chained run ${n} of at most ${max} ` +
  `(\`MAX_CHAINED_RUNS\`) before I stop for a maintainer. A comment from a maintainer resets the count.\n\n${chainMarker(n)}`;

export const chainLimitComment = (t: Ticket, runs: number, max: number) =>
  `I've already continued ${runs} time(s) in a row on my own, which is the limit (\`MAX_CHAINED_RUNS\`=${max}), so I'm not ` +
  `starting another run by myself. Please review branch \`${branchFor(t)}\` and its \`git log\`, then comment ` +
  `\`${CONTINUE_COMMAND}\` (with any directions on the lines after it) to have me keep going.\n\n${RESUME_HINT}`;

// The auto-relay after a checkpoint (the issue is already `blocked`, the work pushed): start the
// next run ourselves, with AGENT_TRIGGER=relay, unless MAX_CHAINED_RUNS of them have already run
// in a row since a trusted human last commented (0 turns relaying off). The announcement goes up
// before the dispatch, since it's what the relay's prepare stage re-checks (recheckTrigger). Never
// throws: the checkpoint itself has landed, and a relay that didn't start just leaves the issue
// blocked, waiting on a human like any other checkpoint.
export async function relayCheckpoint(ticket: Ticket, tracker: Tracker, max: number): Promise<void> {
  if (max === 0) return;
  const runs = chainedRuns(ticket.comments);
  try {
    if (runs >= max) {
      console.log(`[relay] #${ticket.number} has had ${runs} chained run(s) in a row (MAX_CHAINED_RUNS=${max}); waiting on a maintainer`);
      await tracker.comment(chainLimitComment(ticket, runs, max));
      return;
    }
    await tracker.comment(relayComment(ticket, runs + 1, max));
    await tracker.dispatchRelay();
    console.log(`[relay] #${ticket.number}: dispatched chained run ${runs + 1} of at most ${max}`);
  } catch (err) {
    console.error(`[relay] couldn't start the next run on #${ticket.number}; it stays blocked for a maintainer:`, err);
  }
}

export const STAGE_MAINS: Record<Stage, (deps?: RunDeps) => Promise<number>> = { prepare: prepareStage, agent: agentStage, publish: publishStage };
