// End-to-end coverage of the prepare/agent/publish pipeline #12 describes, through
// however much of it actually exists in this repo today. There is currently one
// pipeline function (`runTicket` in src/worker.ts) and no separate allowlist,
// structured-outcome layer, or privileged publisher to test against -- see the
// README's "Threat model" section for the honest current-vs-target picture. The two
// scenarios below that need those pieces are left as `test.todo`s rather than faked.
//
// Mocks the SDK the same way test/worker.test.ts mocks the Tracker: we stand in for
// the model by intercepting `createSdkMcpServer` (to capture the real tool handlers
// worker.ts builds) and `query` (to "call" them directly, in place of a live model
// turn), so these tests exercise the actual ask_question/finish/split_into_subtasks
// code, not a re-implementation of it. Requires --experimental-test-module-mocks
// (see package.json's test script) and, since worker.ts is already linked to the real
// SDK module by the time a later test's mock is installed, a cache-busting query
// string on each dynamic import so every test gets its own fresh module graph.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import type { Comment, Ticket, Tracker } from "../src/tracker.ts";
import { branchFor } from "../src/worker.ts";

const sdk = await import("@anthropic-ai/claude-agent-sdk");

type ToolCall = { name: string; input: Record<string, unknown> };

// Scripts a fake agent turn that calls the given tools, in order, against worker.ts's
// real MCP tool handlers, then ends the turn. Caller must call `.restore()` (a fresh
// mock.module() call fails if the previous one is still installed) and re-import
// worker.ts through a cache-busted specifier so it picks up this mock.
function mockAgentTurn(calls: ToolCall[]) {
  let tools: any[] = [];
  const mocked = mock.module("@anthropic-ai/claude-agent-sdk", {
    cache: false,
    namedExports: {
      ...sdk,
      createSdkMcpServer: (opts: any) => {
        tools = opts.tools;
        return { type: "sdk", name: opts.name, instance: {} };
      },
      query: (params: any) => {
        async function* run() {
          for await (const _ of params.prompt) break; // drain the single-prompt generator
          for (const call of calls) {
            const t = tools.find((x) => x.name === call.name);
            if (!t) throw new Error(`no such tool: ${call.name}`);
            await t.handler(call.input, {});
          }
          yield { type: "result", subtype: "success", num_turns: calls.length, total_cost_usd: 0 };
        }
        return run();
      },
    },
  });
  return mocked;
}

const importWorker = () => import(`../src/worker.ts?${Math.random()}`);

function fakeTracker(): Tracker & { comments: string[]; states: string[] } {
  const t: any = {
    platform: "github",
    comments: [] as string[],
    states: [] as string[],
    async repo() {
      return { cloneUrl: "https://example.test/repo.git", webUrl: "https://example.test/repo", defaultBranch: "main" };
    },
    async getTicket(): Promise<Ticket> {
      throw new Error("not used in these tests");
    },
    async comment(text: string) {
      t.comments.push(text);
    },
    async setState(state: string) {
      t.states.push(state);
    },
    async createSubIssue() {
      throw new Error("not used in these tests");
    },
  };
  return t;
}

const ticket = (over: Partial<Ticket> = {}): Ticket => ({
  number: 77,
  url: "https://example.test/issues/77",
  title: "Add pagination",
  body: "Please add pagination to the list endpoint.",
  author: "maintainer",
  trust: "trusted",
  labels: ["agent"],
  comments: [] as Comment[],
  ...over,
});

test("successful publication: agent reports ready_for_review -> issue commented with the PR URL and set to review", async () => {
  const mocked = mockAgentTurn([
    { name: "finish", input: { summary: "Implemented pagination and added tests.", mr_url: "https://example.test/repo/pull/1" } },
  ]);
  const { runTicket } = await importWorker();
  const tracker = fakeTracker();

  const outcome = await runTicket(ticket(), {
    tracker, repo: await tracker.repo(), workDir: "/tmp/work", pluginDir: "/tmp/plugin", maxTurns: 10,
  });

  assert.equal(outcome.kind, "ready_for_review");
  assert.deepEqual(tracker.states, ["review"]);
  assert.equal(tracker.comments.length, 1);
  assert.match(tracker.comments[0]!, /Implemented pagination/);
  assert.match(tracker.comments[0]!, /https:\/\/example\.test\/repo\/pull\/1/);
  mocked.restore();
});

test("blocked work: agent asks a question -> comment posted, label set to blocked", async () => {
  const mocked = mockAgentTurn([{ name: "ask_question", input: { question: "Should pagination be cursor- or offset-based?" } }]);
  const { runTicket } = await importWorker();
  const tracker = fakeTracker();

  const outcome = await runTicket(ticket(), {
    tracker, repo: await tracker.repo(), workDir: "/tmp/work", pluginDir: "/tmp/plugin", maxTurns: 10,
  });

  assert.equal(outcome.kind, "blocked");
  assert.deepEqual(tracker.states, ["blocked"]);
  assert.equal(tracker.comments.length, 1);
  assert.match(tracker.comments[0]!, /cursor- or offset-based/);
  mocked.restore();
});

test("blocked work: an untrusted-authored issue with no trusted directive short-circuits before the agent runs, without touching the SDK", async () => {
  // No mockAgentTurn/query mock at all here: this path must never reach query().
  const { runTicket } = await importWorker();
  const tracker = fakeTracker();
  const t = ticket({
    trust: "untrusted",
    author: "outside-reporter",
    comments: [{ author: "outside-reporter", trust: "untrusted", fromBot: false, text: "please add pagination", at: "2026-01-01T00:00:00Z" }],
  });

  const outcome = await runTicket(t, {
    tracker, repo: await tracker.repo(), workDir: "/tmp/work", pluginDir: "/tmp/plugin", maxTurns: 10,
  });

  assert.equal(outcome.kind, "blocked");
  assert.deepEqual(tracker.states, ["blocked"]);
});

test("repeated runs target the same branch and each republication updates (not duplicates) the review state", async () => {
  // What "idempotent" means in this repo's actual code today: runTicket doesn't mint a
  // new branch name per run (branchFor is a pure function of the issue number), and
  // running it twice doesn't error or diverge state. The PR/MR-level dedup itself (`gh
  // pr view ... || gh pr create`, plain `git push` reusing an existing MR) happens
  // inside agent/plugin/skills/github-pr and gitlab-mr -- prose the agent's own shell
  // commands follow, not code in this repo we can assert against here.
  const t = ticket();
  assert.equal(branchFor(t), `agent/issue-${t.number}`);

  for (const run of [1, 2]) {
    const mocked = mockAgentTurn([
      { name: "finish", input: { summary: `run ${run}`, mr_url: "https://example.test/repo/pull/1" } },
    ]);
    const { runTicket, branchFor: branchForRun } = await importWorker();
    const tracker = fakeTracker();

    const outcome = await runTicket(t, {
      tracker, repo: await tracker.repo(), workDir: "/tmp/work", pluginDir: "/tmp/plugin", maxTurns: 10,
    });

    assert.equal(outcome.kind, "ready_for_review");
    assert.deepEqual(tracker.states, ["review"]);
    assert.equal(branchForRun(t), "agent/issue-77");
    mocked.restore();
  }
});

test.todo(
  "invalid patch (submodule / path-escape / credential-file change) is rejected by the publisher, nothing pushed -- " +
  "there is no privileged publisher or patch-validation step in this repo yet; the agent sandbox pushes and opens " +
  "the PR/MR itself via plain `git`/`gh` commands (agent/plugin/skills/github-pr, gitlab-mr SKILL.md), with nothing " +
  "in between checking the diff. See agent-flywheel#26.",
);

test.todo(
  "attempted cross-repository access is rejected by the allowlist -- there is no repository allowlist in this repo " +
  "yet; buildPrompt (src/worker.ts) tells the agent \"Work here unless the issue names another repo\" with no " +
  "enforcement behind it, so a trusted directive naming another repository is not currently blocked. " +
  "See agent-flywheel#23.",
);
