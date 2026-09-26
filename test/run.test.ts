// main() end to end with a fake tracker and a fake agent engine (a stand-in runTicket that
// either throws or hands a recorded outcome to the real applyOutcome, the way the real one
// does once query() ends). The invariant under test: once `working` is set, every handled
// path leaves the issue `review` or `blocked`, with the right exit code and one comment.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { main, parseMaxTurns, sanitizeError, type RunDeps } from "../src/run.ts";
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
    async openReview() {
      return { url: "https://x/pull/1", created: true };
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
  assert.deepEqual(tracker.comments, ["Cursor or offset?"]);
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
  assert.deepEqual(tracker.comments, ["Can't be done."]);
});

test("agent stopped with no outcome recorded (not the turn limit): one blocked message, exit 1", async () => {
  const tracker = fakeTracker();
  const { result } = await quietly(() => main(deps(tracker, engine(undefined))));
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
  const { result, logs } = await quietly(() => main(deps(tracker, engine(err))));
  assert.equal(result, 1);
  assert.deepEqual(tracker.states, ["working", "blocked"]);
  assert.equal(proxyClosed, 1);
  assert.equal(tracker.comments.length, 1);
  const c = tracker.comments[0]!;
  assert.match(c, /credit balance is too low/);
  assert.doesNotMatch(c, /supersecretvalue|realforgetoken|stack line/);
  assert.match(logs, /stack line with more detail/); // the CI log keeps everything
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
  const { result, logs } = await quietly(() => main(deps(tracker, engine(new Error("model API: 529 overloaded")))));
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
  const prior: Comment = { author: "bot", trust: "trusted", fromBot: true, text: "Done.\n\nReview: https://x/pull/1", at: "2026-01-01T00:00:00Z" };
  const tracker = fakeTracker({}, [prior]);
  const { result } = await quietly(() => main(deps(tracker, engine({ status: "ready_for_review", summary: "Done." }))));
  assert.equal(result, 0);
  assert.deepEqual(tracker.comments, []);
  assert.equal(tracker.label, "review");
});

test("invalid MAX_TURNS: exit 2 before the issue is touched", async () => {
  for (const MAX_TURNS of ["abc", "0", "-3", "1.5"]) {
    const tracker = fakeTracker();
    const { result } = await quietly(() => main({ ...deps(tracker, engine(undefined)), env: { ...env, MAX_TURNS } }));
    assert.equal(result, 2, MAX_TURNS);
    assert.deepEqual(tracker.states, []);
  }
  assert.equal(parseMaxTurns(undefined), 120);
  assert.equal(parseMaxTurns("40"), 40);
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
