import { test } from "node:test";
import assert from "node:assert/strict";
import { chainHeader, chainOf, parseTarget, targetOf, targetRepo } from "../src/chain.ts";

test("Target: header: parses a GitHub owner/repo and a GitLab nested group path", () => {
  assert.deepEqual(parseTarget("Target: acme/api\n\nFix the bug."), { path: "acme/api" });
  assert.deepEqual(parseTarget("Target: acme/api", "github"), { path: "acme/api" });
  assert.deepEqual(parseTarget("Target: group/sub/project\n\nFix it.", "gitlab"), { path: "group/sub/project" });
  assert.deepEqual(parseTarget("Target: my-org/my_repo.js\r\n\r\nBody."), { path: "my-org/my_repo.js" });
  // Trailing whitespace on the line is harmless.
  assert.deepEqual(parseTarget("Target: acme/api  \n\nBody."), { path: "acme/api" });
});

test("Target: header: no header (or one outside the first paragraph) is no target at all", () => {
  assert.equal(parseTarget("Fix the bug."), undefined);
  assert.equal(parseTarget(""), undefined);
  assert.equal(parseTarget("Intro paragraph.\n\nTarget: acme/api"), undefined);
  assert.equal(parseTarget("Please work in acme/api.\nRepository: acme/api"), undefined);
});

test("Target: header: anything but exactly one valid repo path is invalid, never ignored", () => {
  const invalid = [
    "Target: https://github.com/acme/api",
    "Target: https://github.com/acme/api.git",
    "Target: git@github.com:acme/api.git",
    "Target: github.com/acme/api",
    "Target: gitlab.example.com/group/project",
    "Target: acme/api.git",
    "Target: acme/../hub",
    "Target: ../acme/api",
    "Target: ./api",
    "Target: acme/./api",
    "Target: acme/ api",
    "Target: acme api",
    "Target: acme",
    "Target: /acme/api",
    "Target: acme/api/",
    "Target: acme//api",
    "Target:",
    "Target: ",
    "Target:acme/api",
    "target: acme/api",
    "TARGET: acme/api",
    "Target: acme/api\nTarget: acme/web",
    "Target: acme/api\nTarget: acme/api",
    "Target: acme/a;rm -rf",
    "Target: acme/api?x=1",
  ];
  for (const body of invalid) {
    const h = parseTarget(`${body}\n\nBody.`, "gitlab");
    assert.ok(h && "invalid" in h, `${JSON.stringify(body)} parsed as ${JSON.stringify(h)}`);
  }
  // GitHub repos are exactly owner/repo.
  const gh = parseTarget("Target: group/sub/project", "github");
  assert.ok(gh && "invalid" in gh);
  assert.match((parseTarget("Target: acme/api\nTarget: acme/web") as { invalid: string }).invalid, /2 `Target:` lines/);
  assert.match((parseTarget("Target: https://github.com/acme/api") as { invalid: string }).invalid, /not a URL or a host/);
});

test("Target: header: believed only from a trusted author", () => {
  const body = "Target: acme/api\n\nFix the bug.";
  assert.deepEqual(targetOf({ trust: "trusted", body }), { path: "acme/api" });
  assert.equal(targetOf({ trust: "untrusted", body }), undefined);
  assert.equal(targetRepo({ trust: "trusted", body }), "acme/api");
  assert.equal(targetRepo({ trust: "untrusted", body }), undefined);
  // An invalid header isn't a target repo, but targetOf still reports it (the run blocks on it).
  assert.equal(targetRepo({ trust: "trusted", body: "Target: acme" }), undefined);
  assert.ok("invalid" in targetOf({ trust: "trusted", body: "Target: acme" })!);
  assert.equal(targetOf({ trust: "untrusted", body: "Target: https://evil.example/x" }), undefined);
});

test("Target: header: sits alongside a chain header, before or after it", () => {
  const link = { parent: 12, index: 2, total: 3, blockedBy: 21 };
  for (const head of [`${chainHeader(link)}\nTarget: acme/api`, `Target: acme/api\n${chainHeader(link)}`]) {
    const t = { trust: "trusted" as const, body: `${head}\n\nPart two.` };
    assert.deepEqual(targetOf(t), { path: "acme/api" });
    assert.deepEqual(chainOf(t), link);
  }
});
