import { test } from "node:test";
import assert from "node:assert/strict";
import { isAllowedRepo, parseAllowlist, repoIdentifier } from "../src/allowlist.ts";

test("parseAllowlist splits a comma-separated AGENT_REPO_ALLOWLIST", () => {
  assert.deepEqual(parseAllowlist({ AGENT_REPO_ALLOWLIST: "owner/a, owner/b ,owner/c" }), [
    "owner/a",
    "owner/b",
    "owner/c",
  ]);
});

test("parseAllowlist defaults to GITHUB_REPOSITORY when unset", () => {
  assert.deepEqual(parseAllowlist({ GITHUB_REPOSITORY: "owner/repo" }), ["owner/repo"]);
});

test("parseAllowlist defaults to CI_PROJECT_PATH when unset", () => {
  assert.deepEqual(parseAllowlist({ CI_PROJECT_PATH: "group/project" }), ["group/project"]);
});

test("parseAllowlist is empty when nothing is configured", () => {
  assert.deepEqual(parseAllowlist({}), []);
});

test("repoIdentifier extracts owner/repo from https, token-embedded, and ssh clone URLs", () => {
  assert.equal(repoIdentifier("https://github.com/owner/repo.git"), "owner/repo");
  assert.equal(repoIdentifier("https://x-access-token:tok@github.com/owner/repo.git"), "owner/repo");
  assert.equal(repoIdentifier("git@github.com:owner/repo.git"), "owner/repo");
  assert.equal(repoIdentifier("https://gitlab.example.com/group/subgroup/project"), "group/subgroup/project");
});

test("isAllowedRepo matches case-insensitively regardless of URL form", () => {
  assert.equal(isAllowedRepo("https://github.com/Owner/Repo.git", ["owner/repo"]), true);
  assert.equal(isAllowedRepo("git@github.com:owner/repo.git", ["owner/repo"]), true);
});

test("isAllowedRepo rejects a repo outside the allowlist, without ever needing to clone it", () => {
  assert.equal(isAllowedRepo("https://github.com/attacker/other-repo.git", ["owner/repo"]), false);
});

test("isAllowedRepo rejects everything against an empty allowlist", () => {
  assert.equal(isAllowedRepo("https://github.com/owner/repo.git", []), false);
});
