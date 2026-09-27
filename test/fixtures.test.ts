// Every scenario under test/fixtures/<name>/ (scenario.json in, expected.json out), run end to
// end through main() or the three CI stages with the fake forge and fake agent engine in
// test/support/. See test/fixtures/README.md for the format. No network, Docker or credentials.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadFixtures, runScenario } from "./support/scenario.ts";

// The scenarios the suite promises to cover (issue #17); more may be added freely.
const REQUIRED = [
  "simple-change", "clarification-required", "resume-existing-branch", "malicious-comment",
  "long-thread", "provider-error", "budget-hit", "relay-cap",
];

const fixtures = loadFixtures();

test("every required scenario fixture exists", () => {
  const names = fixtures.map((f) => f.name);
  for (const r of REQUIRED) assert.ok(names.includes(r), `missing test/fixtures/${r}/`);
});

for (const { name, scenario, expected } of fixtures) {
  test(`fixture ${name}: ${scenario.description}`, async (t) => {
    const r = await runScenario(t, scenario);
    const why = `\n--- run log ---\n${r.logs}`;

    assert.deepEqual(r.codes, expected.exitCodes, `exit codes${why}`);
    assert.equal(r.outcome, expected.outcome, `outcome${why}`);
    assert.deepEqual([...r.forge.labels].sort(), [...expected.labels].sort(), `labels${why}`);

    // The trusted input: what the model was shown, or that it never ran at all.
    if (expected.prompt === null) {
      assert.equal(r.prompt, undefined, "the model must not have been started");
    } else {
      assert.ok(r.prompt, `the model was never started${why}`);
      for (const s of expected.prompt.includes) assert.ok(r.prompt.includes(s), `prompt should include ${JSON.stringify(s)}`);
      for (const s of expected.prompt.excludes) assert.ok(!r.prompt.includes(s), `prompt must not include ${JSON.stringify(s)}`);
    }
    assert.deepEqual(r.toolErrors, expected.toolErrors ?? [], "rejected tool calls");

    // Every clone, push and PR/MR is on the one branch for this issue, from/into the expected base.
    assert.equal(r.cloned.length, expected.clones ?? 1, "clones");
    for (const c of [...r.cloned, ...r.pushes]) assert.deepEqual(c, { branch: expected.branch, defaultBranch: expected.base });
    for (const rv of r.forge.reviews) assert.deepEqual([rv.branch, rv.base], [expected.branch, expected.base]);
    assert.equal(r.pushes.length, expected.pushes, "publisher pushes");
    assert.equal(r.forge.reviews.length, expected.reviews, "PRs/MRs opened");
    assert.equal(r.forge.relays.length, expected.relays, "relays dispatched");
    for (const relay of r.forge.relays) assert.deepEqual(relay, { ref: expected.base, issue: String(scenario.issue.number), trigger: "relay" });

    // Our comments on the issue, as the forge stored them, in order.
    const seeded = (scenario.issue.comments ?? []).filter((c) => c.bot).length;
    const posted = r.forge.botComments().slice(seeded);
    assert.equal(posted.length, expected.comments.length, `comments posted:\n${posted.join("\n---\n")}`);
    expected.comments.forEach((re, i) => assert.match(posted[i]!, new RegExp(re), `comment ${i}`));
    for (const s of expected.commentsExclude ?? []) assert.ok(!posted.some((c) => c.includes(s)), `a comment leaked ${JSON.stringify(s)}`);
  });
}
