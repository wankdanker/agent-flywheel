// main() end to end with a fake tracker and a fake agent engine (a stand-in runTicket that
// either throws or hands a recorded outcome to the real applyOutcome, the way the real one
// does once query() ends). The invariant under test: once `working` is set, every handled
// path leaves the issue `review` or `blocked`, with the right exit code and one comment.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { RESUME_HINT, REVIEW_HINT } from "../src/dispatch.ts";
import { PublishRejected } from "../src/publish.ts";
import { ConfigError, detectTracker, EXIT_SKIPPED, MAX_CHAINED_RUNS_LIMIT, MAX_TURNS_LIMIT, main, parseMaxBudgetUsd, parseMaxChainedRuns, parseMaxTurns, sanitizeError, type RunDeps } from "../src/run.ts";
import type { Comment, Ticket, TicketState, Tracker } from "../src/tracker.ts";
import { applyOutcome, type AgentOutcome, type Outcome, type SessionEnd, type WorkerConfig } from "../src/worker.ts";

const CLONE_URL = "https://github.com/acme/widgets.git";

type Fail = { comment?: number; setState?: Partial<Record<TicketState, number>>; createSubIssue?: boolean };

// `fail.comment: n` makes the first n comment() calls throw; same for setState per state.
function fakeTracker(fail: Fail = {}, comments: Comment[] = []) {
  const failures = { comment: fail.comment ?? 0, setState: { ...fail.setState } };
  const t = {
    platform: "github" as const,
    comments: [] as string[],
    states: [] as TicketState[],
    // Reflects what the issue's label actually is right now, i.e. only successful writes.
    label: undefined as TicketState | undefined,
    async repo() {
      return { cloneUrl: CLONE_URL, webUrl: "https://github.com/acme/widgets", defaultBranch: "main" };
    },
    async getTicket(): Promise<Ticket> {
      return {
        number: 7, url: "https://github.com/acme/widgets/issues/7", title: "Add pagination", body: "Please.",
        author: "maintainer", trust: "trusted", labels: ["agent"], comments,
      };
    },
    async comment(text: string) {
      if (failures.comment > 0) {
        failures.comment--;
        throw new Error("GitHub POST /issues/7/comments: 502 bad gateway");
      }
      t.comments.push(text);
    },
    async setState(state: TicketState) {
      if ((failures.setState[state] ?? 0) > 0) {
        failures.setState[state]!--;
        throw new Error(`GitHub PUT /issues/7/labels: 500 couldn't set ${state}`);
      }
      t.states.push(state);
      t.label = state;
    },
    async createSubIssue() {
      if (fail.createSubIssue) throw new Error("GitHub POST /issues: 403");
      return { number: 8, url: "https://github.com/acme/widgets/issues/8" };
    },
    async ensureBranch() {
      return true;
    },
    async openReview() {
      return { url: "https://x/pull/1", created: true };
    },
    async dispatchRelay() {
      throw new Error("main() never relays");
    },
  };
  return t satisfies Tracker;
}

// A fake agent engine: records `recorded` (as if the model called that tool), or throws.
const engine = (behavior: AgentOutcome | undefined | Error, end?: SessionEnd) => async (t: Ticket, cfg: WorkerConfig): Promise<Outcome> => {
  if (behavior instanceof Error) throw behavior;
  return applyOutcome(t, cfg, behavior, end);
};

const env = {
  ANTHROPIC_API_KEY: "sk-ant-api03-supersecretvalue",
  GH_TOKEN: "ghs_realforgetoken123456",
  AGENT_REPO_ALLOWLIST: "acme/widgets",
  WORK_DIR: tmpdir(),
  MAX_TURNS: "10",
};

// A publisher for a branch with nothing committed over the base: a crash there has nothing to save.
const nothingCommitted: Partial<RunDeps> = { publisher: () => ({ pushBranch: () => ({ pushed: false, head: "base000", commits: 0 }) }) };

let proxyClosed = 0;
function deps(tracker: Tracker, runTicket: RunDeps["runTicket"], over: Partial<RunDeps> = {}): RunDeps {
  return {
    env,
    tracker,
    runTicket,
    prepareRepo: () => {},
    originUrl: () => CLONE_URL,
    startModelProxy: async () => ({ url: "http://127.0.0.1:1", requestCount: () => 0, close: async () => void proxyClosed++ }),
    publisher: () => ({ pushBranch: () => ({ pushed: true, head: "abc123", commits: 1 }) }),
    ...over,
  };
}

// Silences the (intentionally noisy) CI log output for a test; returns what was logged.
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

test("success: one summary comment, review label, exit 0", async () => {
  const tracker = fakeTracker();
  const { result } = await quietly(() => main(deps(tracker, engine({ status: "ready_for_review", summary: "Done." }))));
  assert.equal(result, 0);
  assert.deepEqual(tracker.states, ["working", "review"]);
  assert.equal(tracker.comments.length, 1);
  assert.match(tracker.comments[0]!, /Done\.[\s\S]*https:\/\/x\/pull\/1/);
});

test("clarification: one question, blocked, exit 10", async () => {
  const tracker = fakeTracker();
  const { result } = await quietly(() => main(deps(tracker, engine({ status: "blocked", question: "Cursor or offset?" }))));
  assert.equal(result, 10);
  assert.deepEqual(tracker.states, ["working", "blocked"]);
  assert.deepEqual(tracker.comments, [`Cursor or offset?\n\n${RESUME_HINT}`]);
});

test("split: sub-issues opened, blocked, exit 10", async () => {
  const tracker = fakeTracker();
  const split: AgentOutcome = { status: "split", summary: "Too big.", subtasks: [{ title: "a", body: "a" }, { title: "b", body: "b" }] };
  const { result } = await quietly(() => main(deps(tracker, engine(split))));
  assert.equal(result, 10);
  assert.equal(tracker.label, "blocked");
  assert.equal(tracker.comments.length, 1);
});

test("report_failure: one explanation, blocked, exit 1", async () => {
  const tracker = fakeTracker();
  const { result } = await quietly(() => main(deps(tracker, engine({ status: "failed", summary: "Can't be done." }))));
  assert.equal(result, 1);
  assert.deepEqual(tracker.states, ["working", "blocked"]);
  assert.deepEqual(tracker.comments, [`Can't be done.\n\n${RESUME_HINT}`]);
});

test("agent stopped with no outcome recorded (not the turn limit): one blocked message, exit 1", async () => {
  const tracker = fakeTracker();
  const { result } = await quietly(() => main(deps(tracker, engine(undefined), nothingCommitted)));
  assert.equal(result, 1);
  assert.deepEqual(tracker.states, ["working", "blocked"]);
  assert.equal(tracker.comments.length, 1);
  assert.match(tracker.comments[0]!, /stopped before finishing/);
});

test("checkpoint recorded: done/next comment, blocked, exit 20", async () => {
  const tracker = fakeTracker();
  const { result } = await quietly(() =>
    main(deps(tracker, engine({ status: "checkpoint", summary: "Added the gauge.", nextSteps: "Write the tests." }))));
  assert.equal(result, 20);
  assert.deepEqual(tracker.states, ["working", "blocked"]);
  assert.equal(tracker.comments.length, 1);
  assert.match(tracker.comments[0]!, /Added the gauge\.[\s\S]*Write the tests\./);
  assert.match(tracker.comments[0]!, /agent\/issue-7/);
});

test("ran out of turns with no outcome recorded: implicit checkpoint, exit 20 rather than a crash", async () => {
  const tracker = fakeTracker();
  const { result } = await quietly(() => main(deps(tracker, engine(undefined, { maxTurnsHit: true }))));
  assert.equal(result, 20);
  assert.deepEqual(tracker.states, ["working", "blocked"]);
  assert.equal(tracker.comments.length, 1);
  assert.match(tracker.comments[0]!, /used all \d+ turns/);
});

test("model API exception: working -> blocked, one sanitized comment, exit 1, full error in the log", async () => {
  const tracker = fakeTracker();
  const err = new Error(
    `400 {"type":"error","error":{"message":"Your credit balance is too low"}} x-api-key: ${env.ANTHROPIC_API_KEY} via https://u:${env.GH_TOKEN}@github.com\nstack line with more detail`,
  );
  proxyClosed = 0;
  const { result, logs } = await quietly(() => main(deps(tracker, engine(err), nothingCommitted)));
  assert.equal(result, 1);
  assert.deepEqual(tracker.states, ["working", "blocked"]);
  assert.equal(proxyClosed, 1);
  assert.equal(tracker.comments.length, 1);
  const c = tracker.comments[0]!;
  assert.match(c, /credit balance is too low/);
  assert.doesNotMatch(c, /supersecretvalue|realforgetoken|stack line/);
  assert.match(logs, /stack line with more detail/); // the CI log keeps everything
});

// #48: a run that committed work and then died on the model API still gets that work pushed.
test("model API exception after commits: branch published, blocked with a comment saying so, exit 1", async () => {
  const tracker = fakeTracker();
  let pushes = 0;
  const publisher: RunDeps["publisher"] = () => ({ pushBranch: () => (pushes++, { pushed: true, head: "abc123", commits: 2 }) });
  const err = new Error(`429 rate_limit_error x-api-key: ${env.ANTHROPIC_API_KEY}`);
  const { result, logs } = await quietly(() => main(deps(tracker, engine(err), { publisher })));
  assert.equal(result, 1);
  assert.equal(pushes, 1);
  assert.deepEqual(tracker.states, ["working", "blocked"]);
  assert.equal(tracker.comments.length, 1);
  assert.match(tracker.comments[0]!, /stopped by an error[\s\S]*429 rate_limit_error[\s\S]*committed work is on branch `agent\/issue-7`/);
  assert.doesNotMatch(tracker.comments[0]!, /supersecretvalue/);
  assert.match(logs, /publishing what it committed/);
});

test("stopped without an outcome after commits: branch published, blocked, exit 1", async () => {
  const tracker = fakeTracker();
  const { result } = await quietly(() => main(deps(tracker, engine(undefined))));
  assert.equal(result, 1);
  assert.deepEqual(tracker.states, ["working", "blocked"]);
  assert.equal(tracker.comments.length, 1);
  assert.match(tracker.comments[0]!, /stopped without recording an outcome[\s\S]*committed work is on branch `agent\/issue-7`/);
});

test("crash with commits the publisher rejects: nothing pushed, blocked with the reasons, exit 1", async () => {
  const tracker = fakeTracker();
  const publisher: RunDeps["publisher"] = () => ({ pushBranch: () => { throw new PublishRejected(["adds .gitmodules"]); } });
  const { result } = await quietly(() => main(deps(tracker, engine(new Error("429")), { publisher })));
  assert.equal(result, 1);
  assert.deepEqual(tracker.states, ["working", "blocked"]);
  assert.equal(tracker.comments.length, 1);
  assert.match(tracker.comments[0]!, /refused to push[\s\S]*adds \.gitmodules/);
});

test("exception before the agent even starts (clone fails) still ends blocked", async () => {
  const tracker = fakeTracker();
  const { result } = await quietly(() =>
    main(deps(tracker, engine(undefined), { prepareRepo: () => { throw new Error("git clone failed: timeout"); } })),
  );
  assert.equal(result, 1);
  assert.equal(tracker.label, "blocked");
  assert.match(tracker.comments[0]!, /git clone failed/);
});

test("cached work dir outside the allowlist after `working`: blocked, exit 2", async () => {
  const tracker = fakeTracker();
  const { result } = await quietly(() =>
    main(deps(tracker, engine(undefined), { originUrl: () => "https://github.com/evil/other.git" })),
  );
  assert.equal(result, 2);
  assert.equal(tracker.label, "blocked");
});

test("summary comment fails: label still goes to review, worker result logged, exit 1", async () => {
  const tracker = fakeTracker({ comment: 1 });
  const { result, logs } = await quietly(() =>
    main(deps(tracker, engine({ status: "ready_for_review", summary: "Done." }))),
  );
  assert.equal(result, 1);
  assert.equal(tracker.label, "review");
  assert.match(logs, /reached ready_for_review: https:\/\/x\/pull\/1/);
  assert.match(logs, /502 bad gateway/);
});

test("question comment fails: still blocked, exit 1, the question survives in the log", async () => {
  const tracker = fakeTracker({ comment: 1 });
  const { result, logs } = await quietly(() => main(deps(tracker, engine({ status: "blocked", question: "Cursor or offset?" }))));
  assert.equal(result, 1);
  assert.equal(tracker.label, "blocked");
  assert.match(logs, /reached blocked: Cursor or offset\?/);
});

test("review label update fails: falls back to blocked with an explanation, exit 1", async () => {
  const tracker = fakeTracker({ setState: { review: 1 } });
  const { result, logs } = await quietly(() =>
    main(deps(tracker, engine({ status: "ready_for_review", summary: "Done." }))),
  );
  assert.equal(result, 1);
  assert.deepEqual(tracker.states, ["working", "blocked"]);
  assert.equal(tracker.comments.length, 2); // the summary, then why it's blocked
  assert.match(tracker.comments[1]!, /reached `ready_for_review`/);
  assert.match(logs, /couldn't set review/);
});

test("every label update fails: nonzero exit, actionable log, original error preserved", async () => {
  const tracker = fakeTracker({ setState: { review: 1, blocked: 5 } });
  const { result, logs } = await quietly(() =>
    main(deps(tracker, engine({ status: "ready_for_review", summary: "Done." }))),
  );
  assert.equal(result, 1);
  assert.equal(tracker.label, "working");
  assert.match(logs, /couldn't set review/); // the original failure
  assert.match(logs, /couldn't set #7 to blocked: it may still be labeled agent\/working/);
});

test("fallback comment also fails: label still moves to blocked, original error still logged", async () => {
  const tracker = fakeTracker({ comment: 5 });
  const { result, logs } = await quietly(() => main(deps(tracker, engine(new Error("model API: 529 overloaded")), nothingCommitted)));
  assert.equal(result, 1);
  assert.equal(tracker.label, "blocked");
  assert.match(logs, /529 overloaded/);
  assert.match(logs, /couldn't post the failure comment/);
});

test("setting working itself fails: still tries blocked, exit 1", async () => {
  const tracker = fakeTracker({ setState: { working: 1 } });
  let ran = false;
  const { result } = await quietly(() => main(deps(tracker, async () => { ran = true; throw new Error("unreachable"); })));
  assert.equal(result, 1);
  assert.equal(ran, false);
  assert.equal(tracker.label, "blocked");
});

test("a retry doesn't repeat a completion comment already at the end of the thread", async () => {
  const prior: Comment = { author: "bot", trust: "trusted", fromBot: true, text: `Done.\n\nReview: https://x/pull/1\n\n${REVIEW_HINT}`, at: "2026-01-01T00:00:00Z" };
  const tracker = fakeTracker({}, [prior]);
  const { result } = await quietly(() => main(deps(tracker, engine({ status: "ready_for_review", summary: "Done." }))));
  assert.equal(result, 0);
  assert.deepEqual(tracker.comments, []);
  assert.equal(tracker.label, "review");
});

test("invalid MAX_TURNS: exit 2 before the issue is touched", async () => {
  for (const MAX_TURNS of ["abc", "0", "-3", "1.5", "1e2", "501", "100000"]) {
    const tracker = fakeTracker();
    const { result } = await quietly(() => main({ ...deps(tracker, engine(undefined)), env: { ...env, MAX_TURNS } }));
    assert.equal(result, 2, MAX_TURNS);
    assert.deepEqual(tracker.states, []);
  }
  assert.equal(parseMaxTurns(undefined), 120);
  assert.equal(parseMaxTurns("40"), 40);
  assert.equal(parseMaxTurns(String(MAX_TURNS_LIMIT)), MAX_TURNS_LIMIT);
});

test("invalid MAX_BUDGET_USD or MAX_CHAINED_RUNS: exit 2 before the issue is touched", async () => {
  for (const extra of [
    { MAX_BUDGET_USD: "abc" }, { MAX_BUDGET_USD: "0" }, { MAX_BUDGET_USD: "-1" }, { MAX_BUDGET_USD: "$5" }, { MAX_BUDGET_USD: "1e3" },
    { MAX_CHAINED_RUNS: "-1" }, { MAX_CHAINED_RUNS: "two" }, { MAX_CHAINED_RUNS: "1.5" }, { MAX_CHAINED_RUNS: String(MAX_CHAINED_RUNS_LIMIT + 1) },
  ]) {
    const tracker = fakeTracker();
    const { result } = await quietly(() => main({ ...deps(tracker, engine(undefined)), env: { ...env, ...extra } }));
    assert.equal(result, 2, JSON.stringify(extra));
    assert.deepEqual(tracker.states, []);
  }
  assert.equal(parseMaxBudgetUsd(undefined), undefined);
  assert.equal(parseMaxBudgetUsd(""), undefined);
  assert.equal(parseMaxBudgetUsd("5"), 5);
  assert.equal(parseMaxBudgetUsd("2.50"), 2.5);
  assert.equal(parseMaxChainedRuns(undefined), 3);
  assert.equal(parseMaxChainedRuns("0"), 0);
  assert.equal(parseMaxChainedRuns("5"), 5);
});

test("MAX_BUDGET_USD reaches the session config", async () => {
  const tracker = fakeTracker();
  let seen: number | undefined;
  const d = deps(tracker, engine({ status: "ready_for_review", summary: "ok" }));
  const runTicket = d.runTicket!;
  d.runTicket = async (t, cfg) => ((seen = cfg.maxBudgetUsd), runTicket(t, cfg));
  const { result } = await quietly(() => main({ ...d, env: { ...env, MAX_BUDGET_USD: "4.25" } }));
  assert.equal(result, 0);
  assert.equal(seen, 4.25);
});

test("hit MAX_BUDGET_USD: a checkpoint (20) with commits, blocked (10) without; never left on working", async () => {
  const withWork = fakeTracker();
  const a = await quietly(() => main(deps(withWork, engine(undefined, { maxTurnsHit: false, budgetHit: true }))));
  assert.equal(a.result, 20);
  assert.deepEqual(withWork.states, ["working", "blocked"]);
  assert.match(withWork.comments.join("\n"), /MAX_BUDGET_USD[\s\S]*published to branch/);
  const noWork = fakeTracker();
  const b = await quietly(() => main(deps(noWork, engine(undefined, { maxTurnsHit: false, budgetHit: true }), nothingCommitted)));
  assert.equal(b.result, 10);
  assert.deepEqual(noWork.states, ["working", "blocked"]);
  assert.match(noWork.comments.join("\n"), /MAX_BUDGET_USD[\s\S]*hadn't committed anything/);
});

// The prepare step's re-check of AGENT_TRIGGER against the issue's live labels (src/dispatch.ts).
function withLabels(labels: string[]) {
  const tracker = fakeTracker();
  const get = tracker.getTicket;
  tracker.getTicket = async () => ({ ...(await get()), labels });
  return tracker;
}

test("a reply-triggered run whose issue is no longer blocked is skipped before anything is touched", async () => {
  for (const labels of [["agent", "agent/review"], ["agent", "agent/working"], ["agent"], ["agent/blocked"]]) {
    const tracker = withLabels(labels);
    let ran = false;
    const { result, logs } = await quietly(() => main({ ...deps(tracker, async () => ((ran = true), { kind: "blocked", detail: "" })), env: { ...env, AGENT_TRIGGER: "comment" } }));
    assert.equal(result, EXIT_SKIPPED, labels.join());
    assert.equal(ran, false);
    assert.deepEqual(tracker.states, []);
    assert.deepEqual(tracker.comments, []);
    assert.match(logs, /\[trigger\] #7 comment: skipping/);
  }
});

test("a trigger that still applies runs: a reply on blocked, a command, a label, a manual run", async () => {
  for (const [labels, extra] of [
    [["agent", "agent/blocked"], { AGENT_TRIGGER: "comment" }],
    [["agent", "agent/review"], { AGENT_TRIGGER: "comment", AGENT_COMMENT: "/agent continue\nrework the docs" }],
    [["agent", "agent/review"], { AGENT_TRIGGER: "command" }],
    [["agent"], { AGENT_TRIGGER: "label" }],
    [["agent/review"], {}],
    [["agent/review"], { AGENT_TRIGGER: "manual" }],
  ] as const) {
    const tracker = withLabels([...labels]);
    const { result } = await quietly(() => main({ ...deps(tracker, engine({ status: "ready_for_review", summary: "Done." })), env: { ...env, ...extra } }));
    assert.equal(result, 0, JSON.stringify([labels, extra]));
    assert.equal(tracker.label, "review");
  }
});

test("an unknown AGENT_TRIGGER is a config error", async () => {
  const tracker = fakeTracker();
  const { result } = await quietly(() => main({ ...deps(tracker, engine(undefined)), env: { ...env, AGENT_TRIGGER: "whenever" } }));
  assert.equal(result, 2);
  assert.deepEqual(tracker.states, []);
});

test("missing model credential: exit 2 before the issue is touched", async () => {
  const tracker = fakeTracker();
  const { ANTHROPIC_API_KEY: _, ...rest } = env;
  const { result } = await quietly(() => main({ ...deps(tracker, engine(undefined)), env: rest }));
  assert.equal(result, 2);
  assert.deepEqual(tracker.states, []);
});

test("sanitizeError scrubs secret env values, token shapes, auth headers and URL userinfo; keeps one short line", () => {
  const s = sanitizeError(
    new Error(
      "boom Authorization: Bearer abcdefghijklmnop glpat-AbC123xyz ghp_0123456789abcdef " +
        "https://oauth2:hunter2hunter2@gitlab.example/x.git MY_VALUE=s3cr3tvalue!\nsecond line",
    ),
    { SOME_API_KEY: "s3cr3tvalue!", PATH: "/usr/bin" },
  );
  assert.doesNotMatch(s, /abcdefghijklmnop|AbC123xyz|0123456789abcdef|hunter2|s3cr3tvalue|second line/);
  assert.match(s, /^Error: boom/);
  assert.ok(sanitizeError(new Error("x".repeat(5000))).length < 400);
});

test("detectTracker: a malformed AGENT_BOT_ID is a config error, not a silently unpinned identity", () => {
  const env = { AGENT_PLATFORM: "github", ISSUE: "1", GH_TOKEN: "x", GITHUB_REPOSITORY: "o/r" };
  assert.equal(detectTracker({ ...env, AGENT_BOT_ID: "41898282" }).platform, "github");
  assert.throws(() => detectTracker({ ...env, AGENT_BOT_ID: "github-actions[bot]" }), (e) => e instanceof ConfigError && /AGENT_BOT_ID/.test(e.message));
});
