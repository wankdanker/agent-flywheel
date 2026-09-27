// A split's sub-issue, end to end on GitHub (issue #56): the parent's run opens the chain with
// our forge token, so each child is authored by the token's bot account, which GitHub reports as
// `type: "Bot"` with author_association NONE (an app installation token or GITHUB_TOKEN). The
// child's own run then reads it back and prepares it; it must be recognized as ours by identity,
// not by association, and only ours: another bot's identical issue stays untrusted.
// The real stages and githubTracker, over the fake forge; the SDK is faked by scenario.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BOT, FakeForge, GITHUB_BOT_ID, type Seed } from "./support/fake-forge.ts";
import { runScenario, type Scenario } from "./support/scenario.ts";

const PARENT = 60;

const parent: Seed = {
  number: PARENT, title: "Widgets v2", body: "Rewrite the widgets API in two steps.", author: "maintainer", trust: "trusted", labels: ["agent"],
};

const split = {
  tool: "split_into_subtasks",
  input: {
    summary: "Two separable changes.",
    subtasks: [
      { title: "Widgets v2: storage", body: "Add the v2 storage layer." },
      { title: "Widgets v2: API", body: "Expose the v2 API on top of the storage layer." },
    ],
  },
};

const finish = { tool: "finish", input: { summary: "Storage layer added." } };

// Runs the parent's split through the real stages, then the first child's run on a forge that
// holds that child exactly as the parent's run created it.
async function splitThenRunChild(t: any, env: Record<string, string>, child?: (s: Seed) => Seed) {
  const parentRun = await runScenario(t, { description: "", platform: "github", mode: "stages", issue: parent, env, engine: { calls: [split] } } satisfies Scenario);
  assert.deepEqual(parentRun.codes, [0, 0, 10], parentRun.logs);
  const [first, second] = parentRun.forge.created;
  assert.ok(first && second, "the split created two sub-issues");
  assert.ok(first.labels.includes("agent") && second.labels.includes("agent/queued"));
  assert.equal(first.subIssueOf, PARENT);
  assert.equal(parentRun.forge.branches.has(`agent/issue-${PARENT}`), true, "the integration branch was created");

  const seed = parentRun.forge.childSeed(first.number);
  const forge = new FakeForge("github", child ? child(seed) : seed);
  const run = await runScenario(t, { description: "", platform: "github", mode: "stages", issue: forge.seed, env, engine: { calls: [finish] } } satisfies Scenario, forge);
  return { first, run };
}

for (const [how, env] of [
  ["discovered from the token (GraphQL viewer)", {}],
  ["configured (AGENT_BOT_ID)", { AGENT_BOT_ID: String(GITHUB_BOT_ID) }],
] as const) {
  test(`chain child authored by our own bot (association NONE), identity ${how}: its header and task are trusted and it runs on the integration branch`, async (t) => {
    const { first, run } = await splitThenRunChild(t, env);
    const why = `\n--- run log ---\n${run.logs}`;
    assert.equal(run.forge.seed.author, BOT.github);
    assert.deepEqual(run.codes, [0, 0, 0], why);
    assert.equal(run.outcome, "ready_for_review", why);
    assert.ok(run.prompt?.includes("Add the v2 storage layer."), "the child's body is the task");
    assert.ok(run.prompt?.includes(`agent/issue-${PARENT}`), "the prompt names the integration branch");
    assert.deepEqual(run.cloned, [{ branch: `agent/issue-${first.number}`, defaultBranch: `agent/issue-${PARENT}` }]);
    assert.deepEqual(run.pushes, [{ branch: `agent/issue-${first.number}`, defaultBranch: `agent/issue-${PARENT}` }]);
    assert.deepEqual(run.forge.reviews.map((r) => [r.branch, r.base]), [[`agent/issue-${first.number}`, `agent/issue-${PARENT}`]]);
    assert.ok(run.forge.labels.includes("agent/review"));
  });
}

test("an identical chain child authored by a different bot (association NONE) stays untrusted: blocked before cloning, the model never runs", async (t) => {
  const { run } = await splitThenRunChild(t, {}, (s) => ({ ...s, author: "other-app[bot]" }));
  assert.deepEqual(run.codes, [10, 0, 0], run.logs);
  assert.equal(run.prompt, undefined);
  assert.equal(run.cloned.length, 0);
  assert.equal(run.pushes.length, 0);
  assert.ok(run.forge.labels.includes("agent/blocked"));
});

test("PAT-backed: a chain child authored by the PAT's trusted user is trusted by association, as before", async (t) => {
  const { first, run } = await splitThenRunChild(t, {}, (s) => ({ ...s, author: "maintainer", authorType: "User", trust: "trusted" }));
  assert.deepEqual(run.codes, [0, 0, 0], run.logs);
  assert.deepEqual(run.cloned, [{ branch: `agent/issue-${first.number}`, defaultBranch: `agent/issue-${PARENT}` }]);
});
