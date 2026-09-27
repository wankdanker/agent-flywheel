// Worker lifecycle cases the fixtures don't cover: the forge failing while a run settles, and
// the retry after it. Both runs share one in-memory forge (so the retry sees the first run's
// comments and labels, marker and all, exactly as the real adapter reads them back) and one
// work dir. Runs on both platforms, combined main() and the CI stages.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeForge, type Platform } from "./support/fake-forge.ts";
import { runScenario, type Scenario } from "./support/scenario.ts";

const scenario = (platform: Platform, mode: Scenario["mode"], over: Partial<Scenario> = {}): Scenario => ({
  description: "", platform, mode,
  issue: { number: 5, title: "Add pagination", body: "Please.", author: "maintainer", trust: "trusted", labels: ["agent"] },
  engine: { calls: [{ tool: "finish", input: { summary: "Paginated /widgets." } }] },
  ...over,
});

// The label add (GitHub POST /labels) / PUT (GitLab) that sets a state; the first one is `working`.
const labelWrite = (p: Platform) => (p === "github" ? { method: "POST", path: "/issues/5/labels$" } : { method: "PUT", path: "/issues/5$" });
const commentPost = { method: "POST", path: "/issues/5/(comments|notes)$" };

for (const platform of ["github", "gitlab"] as const) {
  for (const mode of ["main", "stages"] as const) {
    const final = (codes: number[]) => codes.at(-1);

    test(`[${platform} ${mode}] review label fails after the summary posted: blocked with an explanation; the retry reuses the PR and doesn't repeat the summary`, async (t) => {
      const forge = new FakeForge(platform, scenario(platform, mode).issue);
      const root = mkdtempSync(join(tmpdir(), "lifecycle-"));
      const first = await runScenario(t, scenario(platform, mode, { forgeFailures: [{ ...labelWrite(platform), status: 500, skip: 1 }] }), forge, root);

      assert.equal(final(first.codes), 1, first.logs);
      assert.ok(forge.labels.includes("agent/blocked"), "never left on agent/working");
      const [summary, fallback, ...rest] = forge.botComments();
      assert.match(summary!, /^Paginated \/widgets\.\n\nReview: /);
      assert.match(fallback!, /I'd reached `ready_for_review`, but couldn't record it on the issue/);
      assert.deepEqual(rest, []);
      assert.match(first.logs, /\[outcome\] the agent had reached ready_for_review/);

      // A maintainer reruns it (`/agent continue`); the forge is healthy again.
      const retry = await runScenario(t, scenario(platform, mode, { env: { AGENT_TRIGGER: "command" } }), forge, root);
      assert.equal(final(retry.codes), 0, retry.logs);
      assert.deepEqual(forge.labels.filter((l) => l.startsWith("agent/")), ["agent/review"]);
      assert.equal(forge.reviews.length, 1, "the retry reuses the open PR/MR");
      assert.equal(forge.botComments().filter((c) => c.startsWith("Paginated /widgets.")).length, 1, "the summary is posted once");
    });

    test(`[${platform} ${mode}] summary comment fails: the label still lands on review, the run exits 1, and a retry posts the summary once`, async (t) => {
      const forge = new FakeForge(platform, scenario(platform, mode).issue);
      const root = mkdtempSync(join(tmpdir(), "lifecycle-"));
      const first = await runScenario(t, scenario(platform, mode, { forgeFailures: [{ ...commentPost, status: 502 }] }), forge, root);
      assert.equal(final(first.codes), 1, first.logs);
      assert.deepEqual(forge.labels.filter((l) => l.startsWith("agent/")), ["agent/review"]);
      assert.deepEqual(forge.botComments(), []);

      const retry = await runScenario(t, scenario(platform, mode, { env: { AGENT_TRIGGER: "command" } }), forge, root);
      assert.equal(final(retry.codes), 0, retry.logs);
      assert.equal(forge.botComments().length, 1);
      assert.equal(forge.reviews.length, 1);
    });

    test(`[${platform} ${mode}] the forge rejects every write: exit 1, the log says how to unstick it, and a later run settles it`, async (t) => {
      const forge = new FakeForge(platform, { ...scenario(platform, mode).issue, labels: ["agent", "agent/working"] });
      const root = mkdtempSync(join(tmpdir(), "lifecycle-"));
      const down = [
        { ...commentPost, status: 503, times: 99 },
        { ...labelWrite(platform), status: 503, times: 99, skip: 1 },
      ];
      const first = await runScenario(t, scenario(platform, mode, { forgeFailures: down }), forge, root);
      assert.equal(final(first.codes), 1, first.logs);
      assert.deepEqual(forge.labels.filter((l) => l.startsWith("agent/")), ["agent/working"]);
      assert.match(first.logs, /couldn't set #5 to blocked[\s\S]*\/agent continue/);
      assert.ok(!first.logs.includes(forge.token), "the forge token never reaches the log");

      forge.heal();
      const retry = await runScenario(t, scenario(platform, mode, { env: { AGENT_TRIGGER: "command" } }), forge, root);
      assert.equal(final(retry.codes), 0, retry.logs);
      assert.deepEqual(forge.labels.filter((l) => l.startsWith("agent/")), ["agent/review"]);
    });
  }
}
