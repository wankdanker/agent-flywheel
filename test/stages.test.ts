// The split run (src/stages.ts): prepare → agent → publish as three separate calls sharing only
// a work dir, the way three CI jobs share it. A fake tracker stands in for the forge and a fake
// runSession for the model; the handoff files and their validation are real.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handoffDirFor, MAX_TEXT } from "../src/handoff.ts";
import type { RunDeps } from "../src/run.ts";
import { agentStage, forgeCredentialLeaks, prepareStage, publishStage } from "../src/stages.ts";
import { STATE_LABELS, type Comment, type Ticket, type TicketState, type Tracker } from "../src/tracker.ts";
import type { AgentOutcome } from "../src/worker.ts";

const CLONE_URL = "https://github.com/acme/widgets.git";

function fakeTracker(over: Partial<Ticket> = {}) {
  const t = {
    platform: "github" as const,
    comments: [] as string[],
    states: [] as TicketState[],
    label: undefined as TicketState | undefined,
    reviews: 0,
    async repo() {
      return { cloneUrl: CLONE_URL, webUrl: "https://github.com/acme/widgets", defaultBranch: "main" };
    },
    async getTicket(): Promise<Ticket> {
      return {
        number: 7, url: "https://github.com/acme/widgets/issues/7", title: "Add pagination", body: "Please.",
        author: "maintainer", trust: "trusted", comments: [] as Comment[], ...over,
        labels: ["agent", ...(t.label ? [STATE_LABELS[t.label]] : [])],
      };
    },
    async comment(text: string) {
      t.comments.push(text);
    },
    async setState(state: TicketState) {
      t.states.push(state);
      t.label = state;
    },
    async createSubIssue() {
      return { number: 8, url: "https://github.com/acme/widgets/issues/8" };
    },
    async openReview() {
      t.reviews++;
      return { url: "https://github.com/acme/widgets/pull/1", created: true };
    },
  };
  return t satisfies Tracker;
}

// Each stage gets only its own job's credential, as in CI.
function envs() {
  const root = mkdtempSync(join(tmpdir(), "stages-"));
  const home = join(root, "home");
  mkdirSync(home);
  const common = { WORK_DIR: join(root, "work"), ISSUE: "7", AGENT_REPO_ALLOWLIST: "acme/widgets", MAX_TURNS: "10", HOME: home, PATH: process.env.PATH };
  return {
    workDir: join(root, "work", "issue-7"),
    prepare: { ...common, GH_TOKEN: "ghs_forgetoken1234567890" },
    agent: { ...common, ANTHROPIC_API_KEY: "sk-ant-api03-modelkey1234567890" },
    publish: { ...common, GH_TOKEN: "ghs_forgetoken1234567890" },
  };
}

type Calls = { prepared: number; sessions: number; pushes: number };

function deps(tracker: Tracker, calls: Calls, recorded: AgentOutcome | undefined | Error, maxTurnsHit = false): RunDeps {
  return {
    tracker,
    prepareRepo: (o) => {
      calls.prepared++;
      mkdirSync(o.workDir, { recursive: true });
    },
    originUrl: () => CLONE_URL,
    startModelProxy: async () => ({ url: "http://127.0.0.1:1", requestCount: () => 0, close: async () => {} }),
    runSession: async (_t, cfg) => {
      calls.sessions++;
      for (const k of ["GH_TOKEN", "AGENT_GH_TOKEN", "AGENT_GITLAB_TOKEN"]) assert.equal(cfg.env?.[k], undefined, `${k} reached the session`);
      if (recorded instanceof Error) throw recorded;
      return { recorded, end: { maxTurnsHit } };
    },
    publisher: () => ({
      pushBranch: () => {
        calls.pushes++;
        return { pushed: true, head: "abc123", commits: 1 };
      },
    }),
  };
}

async function quietly<T>(fn: () => Promise<T>): Promise<{ result: T; logs: string }> {
  const orig = { log: console.log, error: console.error };
  const lines: string[] = [];
  const capture = (...a: unknown[]) => void lines.push(a.map((x) => (x instanceof Error ? x.stack : String(x))).join(" "));
  console.log = capture;
  console.error = capture;
  try {
    return { result: await fn(), logs: lines.join("\n") };
  } finally {
    Object.assign(console, orig);
  }
}

async function runAll(tracker: ReturnType<typeof fakeTracker>, recorded: AgentOutcome | undefined | Error, maxTurnsHit = false) {
  const e = envs();
  const calls: Calls = { prepared: 0, sessions: 0, pushes: 0 };
  const d = deps(tracker, calls, recorded, maxTurnsHit);
  const codes = await quietly(async () => [
    await prepareStage({ ...d, env: e.prepare }),
    await agentStage({ ...d, env: e.agent }),
    await publishStage({ ...d, env: e.publish }),
  ]);
  return { codes: codes.result, logs: codes.logs, calls, e };
}

test("split run: prepare → agent → publish pushes, opens the PR and ends on review", async () => {
  const tracker = fakeTracker();
  const { codes, calls } = await runAll(tracker, { status: "ready_for_review", summary: "Done." });
  assert.deepEqual(codes, [0, 0, 0]);
  assert.deepEqual(calls, { prepared: 1, sessions: 1, pushes: 1 });
  assert.deepEqual(tracker.states, ["working", "review"]);
  assert.equal(tracker.reviews, 1);
  assert.match(tracker.comments[0]!, /Done\.[\s\S]*pull\/1/);
});

test("split run: exit codes come from the publish stage (question → 10, checkpoint → 20, out of turns → 20)", async () => {
  assert.equal((await runAll(fakeTracker(), { status: "blocked", question: "Which one?" })).codes[2], 10);
  const cp = await runAll(fakeTracker(), { status: "checkpoint", summary: "half", nextSteps: "rest" });
  assert.equal(cp.codes[2], 20);
  assert.equal(cp.calls.pushes, 1);
  assert.equal((await runAll(fakeTracker(), undefined, true)).codes[2], 20);
});

test("split run: agent stage recording nothing → publish comments and blocks (incomplete)", async () => {
  const tracker = fakeTracker();
  const { codes } = await runAll(tracker, undefined);
  assert.deepEqual(codes, [0, 0, 1]);
  assert.deepEqual(tracker.states, ["working", "blocked"]);
  assert.match(tracker.comments[0]!, /stopped before finishing/);
});

test("split run: agent session crashing → no outcome.json, publish falls back to blocked", async () => {
  const tracker = fakeTracker();
  const { codes } = await runAll(tracker, new Error("model API 529"));
  assert.deepEqual(codes, [0, 1, 1]);
  assert.deepEqual(tracker.states, ["working", "blocked"]);
  assert.match(tracker.comments[0]!, /HandoffError: the agent stage left no outcome\.json/);
});

test("prepare: an untrusted issue with no trusted directive is blocked before cloning; agent and publish then do nothing", async () => {
  const tracker = fakeTracker({ trust: "untrusted", author: "stranger" });
  const { codes, calls } = await runAll(tracker, { status: "ready_for_review", summary: "x" });
  assert.deepEqual(codes, [10, 0, 0]);
  assert.deepEqual(calls, { prepared: 0, sessions: 0, pushes: 0 });
  assert.deepEqual(tracker.states, ["working", "blocked"]);
  assert.equal(tracker.comments.length, 1);
});

test("prepare: a clone failure settles the issue as blocked and leaves nothing for the agent", async () => {
  const tracker = fakeTracker();
  const e = envs();
  const calls: Calls = { prepared: 0, sessions: 0, pushes: 0 };
  const d = { ...deps(tracker, calls, undefined), prepareRepo: () => { throw new Error("git clone failed"); } };
  const { result } = await quietly(async () => [await prepareStage({ ...d, env: e.prepare }), await agentStage({ ...d, env: e.agent })]);
  assert.deepEqual(result, [1, 0]);
  assert.equal(calls.sessions, 0);
  assert.deepEqual(tracker.states, ["working", "blocked"]);
});

test("each stage refuses the other side's credential (exit 2) before touching the issue or the model", async () => {
  const e = envs();
  const tracker = fakeTracker();
  const calls: Calls = { prepared: 0, sessions: 0, pushes: 0 };
  const d = deps(tracker, calls, { status: "ready_for_review", summary: "x" });
  const both = { ANTHROPIC_API_KEY: "sk-ant-api03-modelkey1234567890", GH_TOKEN: "ghs_forgetoken1234567890" };
  const { result } = await quietly(async () => [
    await prepareStage({ ...d, env: { ...e.prepare, ...both } }),
    await agentStage({ ...d, env: { ...e.agent, ...both } }),
    await agentStage({ ...d, env: { ...e.agent, AGENT_GITLAB_TOKEN: "glpat-xxxxxxxxxxxxxxxx" } }),
    await publishStage({ ...d, env: { ...e.publish, CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-xxxxxxxxxxxx" } }),
  ]);
  assert.deepEqual(result, [2, 2, 2, 2]);
  assert.deepEqual(calls, { prepared: 0, sessions: 0, pushes: 0 });
  assert.deepEqual(tracker.states, []);
});

test("publish: does nothing when the issue isn't agent/working", async () => {
  const tracker = fakeTracker();
  const e = envs();
  const calls: Calls = { prepared: 0, sessions: 0, pushes: 0 };
  const { result } = await quietly(() => publishStage({ ...deps(tracker, calls, undefined), env: e.publish }));
  assert.equal(result, 0);
  assert.deepEqual(tracker.states, []);
  assert.equal(calls.pushes, 0);
});

// Runs publish against an outcome.json the agent (hostile) wrote by hand.
async function publishWith(write: (handoff: string) => void) {
  const tracker = fakeTracker();
  tracker.label = "working";
  const e = envs();
  const handoff = handoffDirFor(e.workDir);
  mkdirSync(handoff, { recursive: true });
  write(handoff);
  const calls: Calls = { prepared: 0, sessions: 0, pushes: 0 };
  const { result } = await quietly(() => publishStage({ ...deps(tracker, calls, undefined), env: e.publish }));
  return { code: result, tracker, calls };
}

const valid = { version: 1, issue: 7, recorded: { status: "ready_for_review", summary: "ok" }, maxTurnsHit: false };

test("publish: a valid hand-written outcome.json is applied", async () => {
  const { code, tracker, calls } = await publishWith((h) => writeFileSync(join(h, "outcome.json"), JSON.stringify(valid)));
  assert.equal(code, 0);
  assert.equal(calls.pushes, 1);
  assert.deepEqual(tracker.states, ["review"]);
});

for (const [name, write, expect] of [
  ["a symlink (e.g. to /proc/self/environ)", (h: string) => {
    const secret = join(h, "..", "secret.json");
    writeFileSync(secret, JSON.stringify({ ...valid, recorded: { status: "failed", summary: "LEAKED-SECRET" } }));
    symlinkSync(secret, join(h, "outcome.json"));
  }, /symlink/],
  ["not JSON", (h: string) => writeFileSync(join(h, "outcome.json"), "LEAKED-SECRET"), /isn't valid JSON/],
  ["an unknown status", (h: string) => writeFileSync(join(h, "outcome.json"), JSON.stringify({ ...valid, recorded: { status: "LEAKED-SECRET", summary: "x" } })), /recorded\.status/],
  ["an extra field", (h: string) => writeFileSync(join(h, "outcome.json"), JSON.stringify({ ...valid, prUrl: "https://evil.example/LEAKED-SECRET" })), /unrecognized_keys/],
  ["an over-long summary", (h: string) => writeFileSync(join(h, "outcome.json"), JSON.stringify({ ...valid, recorded: { status: "failed", summary: "x".repeat(MAX_TEXT + 1) } })), /too_big/],
  ["another issue's number", (h: string) => writeFileSync(join(h, "outcome.json"), JSON.stringify({ ...valid, issue: 8 })), /for issue 8/],
  ["a directory", (h: string) => mkdirSync(join(h, "outcome.json")), /regular file/],
] as const) {
  test(`publish: an outcome.json that is ${name} is refused, the issue blocked, nothing pushed or leaked`, async () => {
    const { code, tracker, calls } = await publishWith(write);
    assert.equal(code, 1);
    assert.equal(calls.pushes, 0);
    assert.deepEqual(tracker.states, ["blocked"]);
    assert.match(tracker.comments[0]!, expect);
    assert.doesNotMatch(tracker.comments[0]!, /LEAKED-SECRET/);
  });
}

const git = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });

test("forgeCredentialLeaks: finds tokens in env, credential files and git config, and nothing in a clean clone", () => {
  const root = mkdtempSync(join(tmpdir(), "leaks-"));
  const home = join(root, "home");
  const repo = join(root, "repo");
  mkdirSync(home);
  git(root, "init", "-q", repo);
  git(repo, "remote", "add", "origin", CLONE_URL);
  const env = { PATH: process.env.PATH, HOME: home };
  assert.deepEqual(forgeCredentialLeaks(env, repo), []);

  assert.deepEqual(forgeCredentialLeaks({ ...env, GH_TOKEN: "x", CI_JOB_TOKEN: "y" }, repo), ["env GH_TOKEN", "env CI_JOB_TOKEN"]);

  writeFileSync(join(home, ".git-credentials"), "https://x:ghs_abc@github.com\n");
  git(repo, "config", "http.https://github.com/.extraheader", "AUTHORIZATION: basic eDpnaHNfYWJj");
  git(repo, "config", "credential.helper", "store");
  git(repo, "remote", "set-url", "origin", "https://x-access-token:ghs_abc@github.com/acme/widgets.git");
  git(repo, "config", "url.https://oauth2:glpat-abc@gitlab.com/.insteadOf", "https://gitlab.com/");
  const leaks = forgeCredentialLeaks(env, repo);
  assert.ok(leaks.includes("file ~/.git-credentials"), leaks.join());
  for (const k of ["extraheader", "credential.helper", "remote.origin.url", "insteadof"]) {
    assert.ok(leaks.some((l) => l.startsWith("git config (local)") && l.includes(k)), `${k} not found in ${leaks.join()}`);
  }
  assert.ok(leaks.every((l) => !/ghs_abc|glpat-abc|eDpnaHNfYWJj/.test(l)), "never reports the value");
  assert.ok(existsSync(repo));
});
