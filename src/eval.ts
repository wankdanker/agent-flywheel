// `npm run eval:live` (bin/eval-live.ts): the opt-in live evaluation. Runs a small, documented
// subset of the scenario fixtures (test/fixtures/<name>/ that have a `repo/` dir to work in)
// through the real SDK and the real model, the same session path an issue run takes (the model
// proxy, sandboxEnv, runSession's tools and hooks), and writes a JSON report to compare versions
// by. It never touches a tracker or pushes: each fixture gets a throwaway local git repo with no
// remote, the session's forge-free env, and only its recorded outcome is read back.
//
// It spends real money, so it refuses to start without an explicit model credential, and refuses
// in a pull/merge request pipeline outright; no CI job runs it (test/ci-config.test.ts checks).
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_UPSTREAM, sandboxEnv } from "./model-proxy.ts";
import { ConfigError, parseMaxBudgetUsd, parseMaxTurns, requireModelCredential, startProxyFromEnv, type RunDeps } from "./run.ts";
import type { CodePlatform, Comment, Ticket } from "./tracker.ts";
import type { Trust } from "./trust.ts";
import { branchFor, runSession as realRunSession, type AgentOutcome, type SessionEnd, type SessionStats } from "./worker.ts";

export const EVAL_REPORT_VERSION = 1;
const ROOT = resolve(import.meta.dirname, "..");
export const DEFAULT_FIXTURES_DIR = join(ROOT, "test", "fixtures");
// Per fixture. Low on purpose: these are small tasks, and a regression that loops shouldn't cost much.
export const DEFAULT_EVAL_MAX_TURNS = "25";
export const DEFAULT_EVAL_MAX_BUDGET_USD = "1";

// The parts of a fixture's scenario.json/expected.json this reads (see test/fixtures/README.md).
type SeedComment = { author: string; trust?: Trust; bot?: boolean; text: string; at: string };
export type EvalFixture = {
  name: string;
  platform: CodePlatform;
  issue: { number: number; title: string; body: string; author: string; trust: Trust; labels: string[]; comments?: SeedComment[]; defaultBranch?: string };
  expectedOutcome: string;
  repoDir: string;
};

export type EvalResult = {
  fixture: string;
  expectedOutcome: string;
  outcome: string;
  pass: boolean;
  durationMs: number;
  turns: number | null;
  costUsd: number | null;
  models: SessionStats["models"];
  proxyRequests: number;
  commits: number;
  changedFiles: string[];
  error?: string;
};

export type EvalReport = {
  version: number;
  startedAt: string;
  finishedAt: string;
  agentFlywheel: { commit: string | null; sdk: string | null };
  provider: { name: "anthropic"; upstream: string; credential: "api-key" | "oauth" };
  model: string;
  limits: { maxTurns: number; maxBudgetUsd: number | undefined };
  results: EvalResult[];
  summary: { passed: number; total: number; costUsd: number; durationMs: number };
};

export type EvalDeps = {
  env?: NodeJS.ProcessEnv;
  fixturesDir?: string;
  runSession?: typeof realRunSession;
  startModelProxy?: RunDeps["startModelProxy"];
  now?: () => number;
};

// A pull/merge request pipeline runs code (and fixtures) someone outside the project may have
// written; the live eval never runs there, whatever credential the job happens to have.
export function inPullRequestPipeline(env: NodeJS.ProcessEnv): boolean {
  return ["pull_request", "pull_request_target"].includes(env.GITHUB_EVENT_NAME ?? "") ||
    Boolean(env.CI_MERGE_REQUEST_IID) || env.CI_PIPELINE_SOURCE === "merge_request_event";
}

// The live set: every fixture with a `repo/` to work in, or just EVAL_FIXTURES (comma-separated).
export function loadEvalFixtures(dir: string, only?: string): EvalFixture[] {
  const all = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, "repo")))
    .map((d): EvalFixture => {
      const scenario = JSON.parse(readFileSync(join(dir, d.name, "scenario.json"), "utf8"));
      const expected = JSON.parse(readFileSync(join(dir, d.name, "expected.json"), "utf8"));
      return { name: d.name, platform: scenario.platform, issue: scenario.issue, expectedOutcome: expected.outcome, repoDir: join(dir, d.name, "repo") };
    });
  if (!only) return all;
  const wanted = only.split(",").map((s) => s.trim()).filter(Boolean);
  const missing = wanted.filter((w) => !all.some((f) => f.name === w));
  if (missing.length) throw new ConfigError(`EVAL_FIXTURES names ${missing.join(", ")}, which isn't a fixture with a repo/ dir in ${dir}`);
  return all.filter((f) => wanted.includes(f.name));
}

export function ticketFor(f: EvalFixture): Ticket {
  const comments: Comment[] = (f.issue.comments ?? []).map((c) => ({
    author: c.bot ? "agent-flywheel" : c.author,
    trust: c.bot ? "trusted" : (c.trust ?? "untrusted"),
    fromBot: Boolean(c.bot),
    text: c.text,
    at: c.at,
  }));
  const host = f.platform === "github" ? "https://github.com/acme/widgets/issues" : "https://gitlab.example/acme/widgets/-/issues";
  return {
    number: f.issue.number, url: `${host}/${f.issue.number}`, title: f.issue.title, body: f.issue.body,
    author: f.issue.author, trust: f.issue.trust, labels: f.issue.labels, comments,
  };
}

function git(cwd: string, args: string[]) {
  const res = spawnSync("git", args, {
    cwd, encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: cwd, GIT_AUTHOR_NAME: "eval", GIT_AUTHOR_EMAIL: "eval@localhost", GIT_COMMITTER_NAME: "eval", GIT_COMMITTER_EMAIL: "eval@localhost" },
  });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
  return res.stdout.trim();
}

// The fixture's repo/ as a fresh local repo on the issue's branch, with no remote to push to.
export function seedRepo(f: EvalFixture, root: string): { workDir: string; base: string } {
  const workDir = join(root, `issue-${f.issue.number}`);
  const base = f.issue.defaultBranch ?? "main";
  cpSync(f.repoDir, workDir, { recursive: true });
  git(workDir, ["init", "-q", "-b", base]);
  git(workDir, ["add", "-A"]);
  git(workDir, ["commit", "-q", "-m", "fixture"]);
  git(workDir, ["checkout", "-q", "-b", branchFor(ticketFor(f))]);
  return { workDir, base };
}

// What the session amounts to, in the same terms as an issue run's `[outcome]`.
export function outcomeOf(recorded: AgentOutcome | undefined, end: SessionEnd): string {
  if (recorded) return recorded.status;
  return end.maxTurnsHit || end.budgetHit ? "checkpoint" : "incomplete";
}

export async function runEval(deps: EvalDeps = {}): Promise<{ code: number; report?: EvalReport; path?: string }> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const runSession = deps.runSession ?? realRunSession;
  let fixtures: EvalFixture[], maxTurns: number, maxBudgetUsd: number | undefined;
  try {
    if (inPullRequestPipeline(env)) throw new ConfigError("refusing to run the live eval in a pull/merge request pipeline");
    requireModelCredential(env);
    maxTurns = parseMaxTurns(env.EVAL_MAX_TURNS || DEFAULT_EVAL_MAX_TURNS);
    maxBudgetUsd = parseMaxBudgetUsd(env.EVAL_MAX_BUDGET_USD || DEFAULT_EVAL_MAX_BUDGET_USD);
    fixtures = loadEvalFixtures(deps.fixturesDir ?? DEFAULT_FIXTURES_DIR, env.EVAL_FIXTURES);
    if (!fixtures.length) throw new ConfigError("no live-eval fixtures (test/fixtures/<name>/repo/) found");
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`[eval] ${err.message}`);
      return { code: 2 };
    }
    throw err;
  }

  const model = env.EVAL_MODEL || env.CLAUDE_MODEL;
  const startedAt = now();
  const root = mkdtempSync(join(tmpdir(), "eval-live-"));
  const results: EvalResult[] = [];
  for (const f of fixtures) {
    const t0 = now();
    const ticket = ticketFor(f);
    const { workDir, base } = seedRepo(f, root);
    const proxy = await startProxyFromEnv(env, deps.startModelProxy);
    let recorded: AgentOutcome | undefined;
    let end: SessionEnd = { maxTurnsHit: false };
    let error: string | undefined;
    console.log(`[eval] ${f.name}: running (expect ${f.expectedOutcome})`);
    try {
      ({ recorded, end } = await runSession(ticket, {
        platform: f.platform,
        repo: { cloneUrl: `file://${workDir}`, webUrl: "", defaultBranch: base },
        workDir,
        pluginDir: env.PLUGIN_DIR ?? join(ROOT, "agent", "plugin"),
        model,
        maxTurns,
        maxBudgetUsd,
        env: sandboxEnv(env, proxy.url),
      }));
    } catch (err) {
      error = err instanceof Error ? `${err.name}: ${err.message}`.split("\n")[0] : String(err);
    } finally {
      await proxy.close().catch(() => {});
    }
    const outcome = error ? "error" : outcomeOf(recorded, end);
    const changed = git(workDir, ["status", "--porcelain"]).split("\n").filter(Boolean).map((l) => l.slice(3));
    const committed = git(workDir, ["diff", "--name-only", `${base}..HEAD`]).split("\n").filter(Boolean);
    const result: EvalResult = {
      fixture: f.name,
      expectedOutcome: f.expectedOutcome,
      outcome,
      pass: outcome === f.expectedOutcome,
      durationMs: now() - t0,
      turns: end.stats?.turns ?? null,
      costUsd: end.stats?.costUsd ?? null,
      models: end.stats?.models ?? {},
      proxyRequests: proxy.requestCount(),
      commits: Number(git(workDir, ["rev-list", "--count", `${base}..HEAD`])),
      changedFiles: [...new Set([...committed, ...changed])].sort(),
      ...(error ? { error } : {}),
    };
    console.log(`[eval] ${f.name}: ${result.pass ? "PASS" : "FAIL"} ${outcome} turns=${result.turns} cost=$${(result.costUsd ?? 0).toFixed(4)}`);
    results.push(result);
  }

  const finishedAt = now();
  const report: EvalReport = {
    version: EVAL_REPORT_VERSION,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    agentFlywheel: { commit: headOf(ROOT), sdk: sdkVersion() },
    provider: { name: "anthropic", upstream: DEFAULT_UPSTREAM, credential: env.ANTHROPIC_API_KEY ? "api-key" : "oauth" },
    model: model || "(SDK default)",
    limits: { maxTurns, maxBudgetUsd },
    results,
    summary: {
      passed: results.filter((r) => r.pass).length,
      total: results.length,
      costUsd: results.reduce((a, r) => a + (r.costUsd ?? 0), 0),
      durationMs: finishedAt - startedAt,
    },
  };
  const path = resolve(env.EVAL_REPORT || join("eval-reports", `eval-${report.startedAt.replace(/[:.]/g, "-")}.json`));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`[eval] ${report.summary.passed}/${report.summary.total} passed, $${report.summary.costUsd.toFixed(4)}; report: ${path}`);
  return { code: report.summary.passed === report.summary.total ? 0 : 1, report, path };
}

function headOf(dir: string): string | null {
  const res = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" });
  return res.status === 0 ? res.stdout.trim() : null;
}

function sdkVersion(): string | null {
  try {
    return JSON.parse(readFileSync(join(ROOT, "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json"), "utf8")).version;
  } catch {
    return null;
  }
}
