// `npm run eval:live` (src/eval.ts) without the live part: its refusals, its fixture set, and the
// report it writes, with a fake session standing in for the model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_FIXTURES_DIR, inPullRequestPipeline, loadEvalFixtures, runEval, type EvalDeps } from "../src/eval.ts";
import type { SessionConfig } from "../src/worker.ts";

const LIVE_SET = ["clarification-required", "malicious-comment", "simple-change"];
const KEY = "sk-ant-api03-evaltestkey1234567890";

async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const orig = { log: console.log, error: console.error };
  console.log = console.error = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, orig);
  }
}

const git = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" }).stdout.trim();

function fakes(sessions: { name: number; cfg: SessionConfig }[]): EvalDeps {
  let requests = 0;
  return {
    startModelProxy: async () => ({ url: "http://127.0.0.1:9", requestCount: () => requests, close: async () => {} }),
    runSession: async (t, cfg) => {
      sessions.push({ name: t.number, cfg });
      requests = 2;
      const stats = { turns: 4, costUsd: 0.05, durationMs: 1000, models: { "claude-test": { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUsd: 0.05 } } };
      if (t.title.includes("--version")) {
        writeFileSync(join(cfg.workDir, "cli.js"), "// --version\n");
        spawnSync("git", ["-c", "user.name=a", "-c", "user.email=a@b", "commit", "-qam", "add --version"], { cwd: cfg.workDir });
        return { recorded: { status: "ready_for_review", summary: "done" }, end: { maxTurnsHit: false, stats } };
      }
      if (t.title.includes("export")) return { recorded: { status: "blocked", question: "CSV or PDF?" }, end: { maxTurnsHit: false, stats } };
      return { recorded: undefined, end: { maxTurnsHit: false, stats } }; // gave up on the typo: a FAIL
    },
  };
}

test("eval:live refuses without an explicit model credential, before running anything", async () => {
  const sessions: any[] = [];
  const r = await quietly(() => runEval({ ...fakes(sessions), env: { PATH: process.env.PATH } }));
  assert.equal(r.code, 2);
  assert.equal(sessions.length, 0);
});

test("eval:live refuses in any pull/merge request pipeline, credential or not", async () => {
  for (const extra of [
    { GITHUB_EVENT_NAME: "pull_request" }, { GITHUB_EVENT_NAME: "pull_request_target" },
    { CI_MERGE_REQUEST_IID: "12" }, { CI_PIPELINE_SOURCE: "merge_request_event" },
  ]) {
    assert.equal(inPullRequestPipeline(extra), true, JSON.stringify(extra));
    const sessions: any[] = [];
    const r = await quietly(() => runEval({ ...fakes(sessions), env: { ANTHROPIC_API_KEY: KEY, ...extra } }));
    assert.equal(r.code, 2, JSON.stringify(extra));
    assert.equal(sessions.length, 0);
  }
  assert.equal(inPullRequestPipeline({ GITHUB_EVENT_NAME: "workflow_dispatch" }), false);
});

test("the live set is the fixtures with a repo/ dir; EVAL_FIXTURES narrows it, and an unknown name is a config error", async () => {
  assert.deepEqual(loadEvalFixtures(DEFAULT_FIXTURES_DIR).map((f) => f.name).sort(), LIVE_SET);
  assert.deepEqual(loadEvalFixtures(DEFAULT_FIXTURES_DIR, "simple-change").map((f) => f.name), ["simple-change"]);
  const r = await quietly(() => runEval({ ...fakes([]), env: { ANTHROPIC_API_KEY: KEY, EVAL_FIXTURES: "provider-error" } }));
  assert.equal(r.code, 2, "provider-error has no repo/ to run the model in");
});

test("eval:live runs each fixture in a local repo with no remote and a sandboxed env, and writes a comparable report", async () => {
  const sessions: { name: number; cfg: SessionConfig }[] = [];
  const reportPath = join(mkdtempSync(join(tmpdir(), "eval-report-")), "report.json");
  const env = { ANTHROPIC_API_KEY: KEY, GH_TOKEN: "ghs_shouldnotreachthesession00", EVAL_MODEL: "claude-test", EVAL_REPORT: reportPath, PATH: process.env.PATH };
  const r = await quietly(() => runEval({ ...fakes(sessions), env }));

  assert.equal(r.code, 1, "malicious-comment's fake session recorded nothing, so not every fixture passed");
  assert.equal(sessions.length, 3);
  for (const { cfg } of sessions) {
    assert.equal(cfg.env?.GH_TOKEN, undefined, "no forge token in the session");
    assert.notEqual(cfg.env?.ANTHROPIC_API_KEY, KEY, "the real key stays behind the proxy");
    assert.equal(cfg.env?.ANTHROPIC_BASE_URL, "http://127.0.0.1:9");
    assert.equal(cfg.model, "claude-test");
    assert.equal(git(cfg.workDir, "remote"), "", "nothing to push to");
    assert.match(git(cfg.workDir, "branch", "--show-current"), /^agent\/issue-\d+$/);
  }

  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  assert.deepEqual(r.report, report, "the file is the report runEval returned");
  assert.equal(report.version, 1);
  assert.equal(report.model, "claude-test");
  assert.deepEqual(report.provider, { name: "anthropic", upstream: "https://api.anthropic.com", credential: "api-key" });
  assert.ok(!JSON.stringify(report).includes(KEY), "the report never holds the credential");
  const by = Object.fromEntries(report.results.map((x: any) => [x.fixture, x]));
  assert.deepEqual(
    { outcome: by["simple-change"].outcome, pass: by["simple-change"].pass, commits: by["simple-change"].commits, files: by["simple-change"].changedFiles },
    { outcome: "ready_for_review", pass: true, commits: 1, files: ["cli.js"] },
  );
  assert.deepEqual([by["clarification-required"].outcome, by["clarification-required"].pass], ["blocked", true]);
  assert.deepEqual([by["malicious-comment"].outcome, by["malicious-comment"].pass], ["incomplete", false]);
  for (const x of report.results) {
    assert.equal(x.turns, 4);
    assert.equal(x.costUsd, 0.05);
    assert.equal(x.proxyRequests, 2);
    assert.ok(x.models["claude-test"]);
    assert.equal(typeof x.durationMs, "number");
  }
  assert.deepEqual({ passed: report.summary.passed, total: report.summary.total }, { passed: 2, total: 3 });
  assert.ok(Math.abs(report.summary.costUsd - 0.15) < 1e-9);
});
