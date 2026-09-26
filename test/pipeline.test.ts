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
function mockAgentTurn(calls: ToolCall[], throwAtEnd?: Error) {
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
          // e.g. the model API or the CLI subprocess failing mid-session (spend limit, crash).
          if (throwAtEnd) throw throwAtEnd;
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

test("SDK throws after the agent already called finish: the recorded outcome is still applied", async () => {
  const mocked = mockAgentTurn(
    [{ name: "finish", input: { summary: "Done.", mr_url: "https://example.test/repo/pull/2" } }],
    new Error("Claude Code process exited with code 1"),
  );
  const { runTicket } = await importWorker();
  const tracker = fakeTracker();
  const origError = console.error;
  console.error = () => {};
  try {
    const outcome = await runTicket(ticket(), {
      tracker, repo: await tracker.repo(), workDir: "/tmp/work", pluginDir: "/tmp/plugin", maxTurns: 10,
    });
    assert.equal(outcome.kind, "ready_for_review");
    assert.deepEqual(tracker.states, ["review"]);
  } finally {
    console.error = origError;
    mocked.restore();
  }
});

test("SDK throws before any outcome is recorded: runTicket rethrows for main() to handle, tracker untouched", async () => {
  const mocked = mockAgentTurn([], new Error("400 credit balance is too low"));
  const { runTicket } = await importWorker();
  const tracker = fakeTracker();
  try {
    await assert.rejects(
      runTicket(ticket(), { tracker, repo: await tracker.repo(), workDir: "/tmp/work", pluginDir: "/tmp/plugin", maxTurns: 10 }),
      /credit balance/,
    );
    assert.deepEqual(tracker.states, []);
  } finally {
    mocked.restore();
  }
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

// Like mockAgentTurn, but scripts whole assistant turns and runs worker.ts's real
// PreToolUse/PostToolUse hooks around every tool call, the way the SDK would: each turn is
// yielded as an assistant message, then each of its tool calls goes through PreToolUse
// (a deny skips the tool) and, if it ran, PostToolUse. Records what the model would see.
type Seen = { tool: string; denied?: string; context?: string };
function mockHookedTurns(turns: ToolCall[][], endSubtype: "success" | "error_max_turns" = "success") {
  let tools: any[] = [];
  const seen: Seen[] = [];
  const runHooks = async (matchers: any[] | undefined, input: any, id: string) => {
    const outs = [];
    for (const m of matchers ?? []) for (const h of m.hooks) outs.push(await h(input, id, { signal: new AbortController().signal }));
    return outs;
  };
  const mocked = mock.module("@anthropic-ai/claude-agent-sdk", {
    cache: false,
    namedExports: {
      ...sdk,
      createSdkMcpServer: (opts: any) => {
        tools = opts.tools;
        return { type: "sdk", name: opts.name, instance: {} };
      },
      query: (params: any) => {
        const hooks = params.options.hooks;
        async function* run() {
          for await (const _ of params.prompt) break;
          let n = 0;
          for (const [i, calls] of turns.entries()) {
            const blocks = calls.map((c, j) => ({ type: "tool_use", id: `tu_${i}_${j}`, name: c.name, input: c.input }));
            yield { type: "assistant", parent_tool_use_id: null, message: { id: `msg_${i}`, content: blocks } };
            for (const [j, call] of calls.entries()) {
              const id = `tu_${i}_${j}`;
              const base = { session_id: "s", transcript_path: "/t", cwd: "/tmp/work", tool_name: call.name, tool_input: call.input, tool_use_id: id };
              const pre = await runHooks(hooks?.PreToolUse, { ...base, hook_event_name: "PreToolUse" }, id);
              const deny = pre.find((o: any) => o.hookSpecificOutput?.permissionDecision === "deny");
              if (deny) {
                seen.push({ tool: call.name, denied: deny.hookSpecificOutput.permissionDecisionReason });
                continue;
              }
              const mcp = call.name.replace(/^mcp__ticket__/, "");
              const t = tools.find((x) => x.name === mcp);
              if (call.name.startsWith("mcp__ticket__") && t) await t.handler(call.input, {});
              const post = await runHooks(hooks?.PostToolUse, { ...base, hook_event_name: "PostToolUse", tool_response: "ok" }, id);
              seen.push({ tool: call.name, context: post.map((o: any) => o.hookSpecificOutput?.additionalContext).join("") });
            }
            n++;
          }
          yield { type: "result", subtype: endSubtype, num_turns: n, total_cost_usd: 0 };
        }
        return run();
      },
    },
  });
  return { mocked, seen };
}

test("turn gauge: every tool result carries [Turn X/Y | Z turns remaining]", async () => {
  const { mocked, seen } = mockHookedTurns([
    [{ name: "Read", input: { file_path: "/tmp/work/README.md" } }, { name: "Bash", input: { command: "npm test" } }],
    [{ name: "Edit", input: { file_path: "/tmp/work/a.ts" } }],
    [{ name: "mcp__ticket__finish", input: { summary: "Done.", mr_url: "https://example.test/repo/pull/3" } }],
  ]);
  const { runTicket } = await importWorker();
  const tracker = fakeTracker();
  try {
    const outcome = await runTicket(ticket(), {
      tracker, repo: await tracker.repo(), workDir: "/tmp/work", pluginDir: "/tmp/plugin", maxTurns: 10,
    });
    assert.equal(outcome.kind, "ready_for_review");
    assert.deepEqual(seen.map((s) => s.context), [
      "[Turn 1/10 | 9 turns remaining]",
      "[Turn 1/10 | 9 turns remaining]",
      "[Turn 2/10 | 8 turns remaining]",
      "[Turn 3/10 | 7 turns remaining]",
    ]);
  } finally {
    mocked.restore();
  }
});

test("interceptor: at 2 turns remaining, edits are denied with checkpoint instructions; git and checkpoint go through", async () => {
  const { mocked, seen } = mockHookedTurns([
    [{ name: "Edit", input: { file_path: "/tmp/work/a.ts" } }],
    [{ name: "Edit", input: { file_path: "/tmp/work/b.ts" } }, { name: "Bash", input: { command: "npm test" } }],
    [{ name: "Bash", input: { command: "git add -A && git commit -m 'gauge done; tests next' && git push -u origin HEAD" } }],
    [{ name: "mcp__ticket__checkpoint", input: { summary: "Gauge done.", next_steps: "Write tests." } }],
  ]);
  const { runTicket } = await importWorker();
  const tracker = fakeTracker();
  try {
    const outcome = await runTicket(ticket(), {
      tracker, repo: await tracker.repo(), workDir: "/tmp/work", pluginDir: "/tmp/plugin", maxTurns: 4,
    });
    assert.equal(outcome.kind, "checkpoint");
    assert.equal(seen[0]!.denied, undefined); // turn 1 of 4: 3 remaining
    for (const s of seen.slice(1, 3)) {
      assert.match(s.denied ?? "", /Stop editing now/);
      assert.match(s.denied ?? "", /agent\/issue-77/);
      assert.match(s.denied ?? "", /credential\.helper=.*GH_TOKEN/);
      assert.match(s.denied ?? "", /`checkpoint` tool/);
    }
    assert.equal(seen[3]!.denied, undefined);
    assert.equal(seen[3]!.context, "[Turn 3/4 | 1 turns remaining]");
    assert.equal(seen[4]!.denied, undefined);
    assert.deepEqual(tracker.states, ["blocked"]);
    assert.match(tracker.comments[0]!, /Gauge done\.[\s\S]*Write tests\./);
  } finally {
    mocked.restore();
  }
});

test("running out of turns without a checkpoint is an implicit checkpoint, not incomplete", async () => {
  const { mocked } = mockHookedTurns([[{ name: "Edit", input: { file_path: "/tmp/work/a.ts" } }]], "error_max_turns");
  const { runTicket } = await importWorker();
  const tracker = fakeTracker();
  try {
    const outcome = await runTicket(ticket(), {
      tracker, repo: await tracker.repo(), workDir: "/tmp/work", pluginDir: "/tmp/plugin", maxTurns: 1,
    });
    assert.equal(outcome.kind, "checkpoint");
    assert.deepEqual(tracker.states, ["blocked"]);
    assert.match(tracker.comments[0]!, /used all 1 turns/);
  } finally {
    mocked.restore();
  }
});

test("checkpoint maps to exit code 20, distinct from blocked (10) and incomplete (1)", async () => {
  const { EXIT_CODES } = await import("../src/run.ts");
  assert.equal(EXIT_CODES.checkpoint, 20);
  assert.equal(EXIT_CODES.blocked, 10);
  assert.equal(EXIT_CODES.incomplete, 1);
});

test("allowedWhenOutOfTurns: only git commands and the ticket tools", async () => {
  const { allowedWhenOutOfTurns } = await importWorker();
  assert.equal(allowedWhenOutOfTurns("Bash", { command: "git status" }), true);
  assert.equal(allowedWhenOutOfTurns("Bash", { command: "cd /work/issue-77 && git commit -am wip" }), true);
  assert.equal(allowedWhenOutOfTurns("Bash", { command: "git -c credential.helper='!f() { echo x; }; f' push -u origin HEAD" }), true);
  assert.equal(allowedWhenOutOfTurns("mcp__ticket__checkpoint", {}), true);
  assert.equal(allowedWhenOutOfTurns("Bash", { command: "npm test" }), false);
  assert.equal(allowedWhenOutOfTurns("Bash", { command: "gitk" }), false);
  assert.equal(allowedWhenOutOfTurns("Edit", { file_path: "a.ts" }), false);
  assert.equal(allowedWhenOutOfTurns("Write", {}), false);
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
