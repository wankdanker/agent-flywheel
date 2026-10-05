import { test } from "node:test";
import assert from "node:assert/strict";
import { isAllowedRepo, parseAllowlist, repoIdentifier } from "../src/allowlist.ts";
import { ConfigError } from "../src/config-error.ts";

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

// ---- Patterns ----

const allowed = (path: string, pattern: string) => isAllowedRepo(`https://github.com/${path}.git`, [pattern]);

test("owner/* matches any repo directly under owner, and nothing deeper, shallower or elsewhere", () => {
  assert.equal(allowed("owner/a", "owner/*"), true);
  assert.equal(allowed("owner/a/b", "owner/*"), false);
  assert.equal(isAllowedRepo("https://github.com/owner", ["owner/*"]), false);
  assert.equal(allowed("other/a", "owner/*"), false);
});

test("group/** matches projects at any depth under group, but not group itself or a lookalike", () => {
  assert.equal(allowed("group/a", "group/**"), true);
  assert.equal(allowed("group/sub/a", "group/**"), true);
  assert.equal(isAllowedRepo("https://gitlab.com/group", ["group/**"]), false);
  assert.equal(allowed("groupx/a", "group/**"), false);
  assert.equal(allowed("group/sub/a", "group/sub/**"), true);
  assert.equal(allowed("group/other/a", "group/sub/**"), false);
});

test("* inside a segment matches any run of characters except /", () => {
  assert.equal(allowed("owner/whisper-core", "owner/whisper-*"), true);
  assert.equal(allowed("owner/whisper-", "owner/whisper-*"), true);
  assert.equal(allowed("owner/libwhspr", "owner/whisper-*"), false);
  assert.equal(allowed("owner/whisper/core", "owner/whisper-*"), false);
  assert.equal(allowed("owner/whisper-x/core", "owner/whisper-*"), false);
  assert.equal(allowed("owner/a-whisper-b", "owner/*-whisper-*"), true);
});

test("patterns match case-insensitively, the same across https and ssh clone URLs and GitLab nested groups", () => {
  for (const url of [
    "https://gitlab.example.com/Group/Sub/Project.git",
    "git@gitlab.example.com:group/sub/project.git",
    "ssh://git@gitlab.example.com/group/sub/project.git",
    "https://oauth2:tok@gitlab.example.com/group/sub/project",
  ]) {
    assert.equal(isAllowedRepo(url, ["GROUP/**"]), true, url);
    assert.equal(isAllowedRepo(url, ["group/SUB/*"]), true, url);
    assert.equal(isAllowedRepo(url, ["group/*"]), false, url);
    assert.equal(isAllowedRepo(url, ["group/sub/proj*"]), true, url);
  }
});

test("regex metacharacters in a literal stay literal", () => {
  assert.equal(allowed("owner/my.repo", "owner/my.repo"), true);
  assert.equal(allowed("owner/myxrepo", "owner/my.repo"), false);
  assert.equal(allowed("owner/myxrepo-1", "owner/my.repo-*"), false);
  assert.equal(allowed("owner/my.repo-1", "owner/my.repo-*"), true);
});

test("parseAllowlist accepts exact entries and patterns", () => {
  assert.deepEqual(parseAllowlist({ AGENT_REPO_ALLOWLIST: "owner/repo, owner/*, group/**, owner/whisper-*, g/s/my.repo_1" }), [
    "owner/repo",
    "owner/*",
    "group/**",
    "owner/whisper-*",
    "g/s/my.repo_1",
  ]);
});

test("parseAllowlist rejects malformed entries with a ConfigError, never failing open or matching nothing", () => {
  const bad = [
    "*", "**", "*/x", "**/x", "a*/x", "a/**/b", "a/b**", "a//b", "/a/b", "a/b/",
    "https://host/a/b", "git@host:a/b", "host:a/b", "a/../b", "a/./b", "a/b c", "a/b?", "a/[b]", "owner",
  ];
  for (const entry of bad) {
    assert.throws(() => parseAllowlist({ AGENT_REPO_ALLOWLIST: `ok/repo, ${entry}` }), ConfigError, entry);
  }
  // The defaults go through the same validation.
  assert.throws(() => parseAllowlist({ GITHUB_REPOSITORY: "*/x" }), ConfigError);
});

test("isAllowedRepo treats an invalid pattern that bypassed parseAllowlist as matching nothing", () => {
  assert.equal(allowed("owner/repo", "*/*"), false);
  assert.equal(allowed("owner/repo", "**"), false);
  assert.equal(isAllowedRepo("https://github.com/owner//repo.git", ["owner/**"]), false);
});
