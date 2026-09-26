// The privileged publisher (src/publish.ts) against real git: a local bare repo stands in
// for the forge, prepareRepo makes the agent's work dir, and "the agent" is whatever
// commits a test makes there. What's under test: a valid branch is pushed (idempotently),
// an invalid one is rejected with nothing pushed, and nothing from the work dir's own git
// config or hooks ever runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { prepareRepo } from "../src/clone.ts";
import { checkChange, gitPublisher, PublishRejected, type Change } from "../src/publish.ts";
import type { ReviewRequest, Ticket, Tracker } from "../src/tracker.ts";
import { applyOutcome } from "../src/worker.ts";

const BRANCH = "agent/issue-1";

function git(args: string[], cwd: string) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout.trim();
}

type Fixture = { root: string; origin: string; work: string; publisher: ReturnType<typeof gitPublisher> };

function withFixture(fn: (f: Fixture) => void | Promise<void>) {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-flywheel-publish-test-"));
    try {
      const seed = join(root, "seed");
      git(["init", "-q", "-b", "main", seed], root);
      git(["-C", seed, "config", "user.email", "t@t.test"], root);
      git(["-C", seed, "config", "user.name", "t"], root);
      writeFileSync(join(seed, "README.md"), "hello\n");
      git(["-C", seed, "add", "-A"], root);
      git(["-C", seed, "commit", "-q", "-m", "init"], root);
      const origin = join(root, "origin.git");
      git(["clone", "-q", "--bare", seed, origin], root);

      const work = join(root, "work");
      prepareRepo({ cloneUrl: origin, workDir: work, branch: BRANCH, defaultBranch: "main" });
      git(["config", "user.email", "agent@t.test"], work);
      git(["config", "user.name", "agent"], work);
      const publisher = gitPublisher({ workDir: work, cloneUrl: origin, branch: BRANCH, defaultBranch: "main" });
      await fn({ root, origin, work, publisher });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

// "The agent" commits whatever `make` does to the work dir.
function commit(work: string, message: string, make: () => void) {
  make();
  git(["add", "-A"], work);
  git(["commit", "-q", "-m", message], work);
  return git(["rev-parse", "HEAD"], work);
}

const write = (work: string, path: string, content = "x\n") => () => {
  mkdirSync(dirname(join(work, path)), { recursive: true });
  writeFileSync(join(work, path), content);
};

const remoteBranch = (origin: string) => git(["ls-remote", "--heads", origin, BRANCH], origin);

function assertRejected(f: Fixture, pattern: RegExp, opts?: { requireCommits?: boolean }) {
  assert.throws(() => f.publisher.pushBranch(opts), (err: unknown) => {
    assert.ok(err instanceof PublishRejected, String(err));
    assert.match(err.message, pattern);
    return true;
  });
  assert.equal(remoteBranch(f.origin), "", "nothing may be pushed when validation fails");
}

test("valid branch: pushed; publishing again is a no-op; a new commit updates the same branch", withFixture((f) => {
  const first = commit(f.work, "add feature", write(f.work, "src/feature.ts", "export const x = 1;\n"));
  assert.deepEqual(f.publisher.pushBranch({ requireCommits: true }), { pushed: true, head: first, commits: 1 });
  assert.match(remoteBranch(f.origin), new RegExp(`^${first}\\s`));

  assert.deepEqual(f.publisher.pushBranch({ requireCommits: true }), { pushed: false, head: first, commits: 1 });

  const second = commit(f.work, "more", write(f.work, "src/more.ts"));
  assert.deepEqual(f.publisher.pushBranch(), { pushed: true, head: second, commits: 2 });
  assert.match(remoteBranch(f.origin), new RegExp(`^${second}\\s`));
}));

test("in-tree symlinks and example env files are fine", withFixture((f) => {
  commit(f.work, "ok", () => {
    write(f.work, "docs/guide.md")();
    symlinkSync("docs/guide.md", join(f.work, "docs-link"));
    mkdirSync(join(f.work, "a/b"), { recursive: true });
    symlinkSync("../../docs/guide.md", join(f.work, "a/b/link"));
    write(f.work, ".env.example", "API_KEY=\n")();
  });
  assert.equal(f.publisher.pushBranch().pushed, true);
}));

test("new submodule (gitlink) is rejected, nothing pushed", withFixture((f) => {
  const sha = git(["rev-parse", "HEAD"], f.work);
  git(["update-index", "--add", "--cacheinfo", `160000,${sha},vendor/lib`], f.work);
  git(["commit", "-q", "-m", "add submodule"], f.work);
  assertRejected(f, /vendor\/lib: adds or changes a submodule/);
}));

test(".gitmodules change is rejected, nothing pushed", withFixture((f) => {
  commit(f.work, "submodule config", write(f.work, ".gitmodules", '[submodule "x"]\n\tpath = x\n\turl = https://evil.example/x.git\n'));
  assertRejected(f, /\.gitmodules: changes submodule config/);
}));

test("symlink escaping the repo (relative or absolute) is rejected, nothing pushed", withFixture((f) => {
  commit(f.work, "escape", () => {
    symlinkSync("../../../etc/passwd", join(f.work, "passwd"));
    symlinkSync("/home/node/.gitconfig", join(f.work, "gitconfig"));
  });
  assertRejected(f, /passwd: symlink points outside the repository[\s\S]*gitconfig: symlink to an absolute path|gitconfig: symlink to an absolute path[\s\S]*passwd: symlink points outside/);
}));

test("credential-looking files are rejected, nothing pushed", withFixture((f) => {
  for (const path of [".git-credentials", "deploy/id_ed25519", ".env", "certs/server.pem", ".netrc"]) {
    git(["reset", "-q", "--hard", "origin/main"], f.work);
    commit(f.work, `add ${path}`, write(f.work, path, "secret\n"));
    assertRejected(f, new RegExp(`${path.replace(/[.]/g, "\\.")}: looks like a credential file`));
  }
}));

test("a credential file added and then deleted is still rejected: history gets pushed, not just the tip", withFixture((f) => {
  commit(f.work, "oops", write(f.work, ".git-credentials", "https://u:tok@example.test\n"));
  commit(f.work, "remove it", () => rmSync(join(f.work, ".git-credentials")));
  assertRejected(f, /\.git-credentials: looks like a credential file/);
}));

test("ready_for_review with no commits over the base is rejected; a checkpoint with none just pushes nothing", withFixture((f) => {
  assertRejected(f, /no commits over main/, { requireCommits: true });
  assert.deepEqual(f.publisher.pushBranch(), { pushed: false, head: git(["rev-parse", "HEAD"], f.work), commits: 0 });
  assert.equal(remoteBranch(f.origin), "");
}));

test("never runs hooks or config-driven commands from the work dir", withFixture((f) => {
  const marker = join(f.root, "pwned");
  const hooks = join(f.root, "evil-hooks");
  mkdirSync(hooks);
  // Records which hook ran, and whether a credential was in its env (never the value).
  const script = `#!/bin/sh\necho "$0 token-visible=$([ -n "$ASKPASS_TOKEN$GH_TOKEN" ] && echo yes || echo no)" >> '${marker}'\n`;
  for (const h of ["pre-push", "post-checkout", "reference-transaction", "pre-commit", "post-update", "pre-upload-pack"]) {
    writeFileSync(join(hooks, h), script);
    chmodSync(join(hooks, h), 0o755);
  }
  const fsmonitor = join(f.root, "fsmonitor.sh");
  writeFileSync(fsmonitor, script);
  chmodSync(fsmonitor, 0o755);

  commit(f.work, "feature", write(f.work, "src/feature.ts"));
  // A forged base in the work dir must not matter either: the base comes from the forge.
  git(["update-ref", "refs/remotes/origin/main", "HEAD"], f.work);
  // Written after the agent's own git calls above so those don't trip them.
  git(["config", "core.hooksPath", hooks], f.work);
  git(["config", "core.fsmonitor", fsmonitor], f.work);
  git(["config", "uploadpack.packObjectsHook", fsmonitor], f.work);
  git(["config", "credential.helper", `!${fsmonitor}`], f.work);

  const publisher = gitPublisher({
    workDir: f.work, cloneUrl: f.origin, branch: BRANCH, defaultBranch: "main",
    credential: { username: "x-access-token", token: "SECRET-TOKEN" },
  });
  assert.equal(publisher.pushBranch({ requireCommits: true }).pushed, true);
  assert.equal(existsSync(marker), false, `a work-dir hook or config command ran during publication: ${existsSync(marker) && readFileSync(marker, "utf8")}`);
}));

test("checkChange: path escapes and .git entries, even ones git itself wouldn't produce", () => {
  const c = (path: string, over: Partial<Change> = {}): Change => ({ oldMode: "000000", newMode: "100644", newSha: "0", status: "A", path, ...over });
  const none = () => "";
  assert.match(checkChange(c("../outside"), none)!, /escapes/);
  assert.match(checkChange(c("/etc/passwd"), none)!, /escapes/);
  assert.match(checkChange(c("a//b"), none)!, /escapes/);
  assert.match(checkChange(c(".git/config"), none)!, /\.git directory/);
  assert.match(checkChange(c("sub/.GIT/hooks/pre-push"), none)!, /\.git directory/);
  assert.match(checkChange(c("GIT~1/config"), none)!, /\.git directory/);
  assert.match(checkChange(c("link", { newMode: "120000" }), () => "../.git/config")!, /outside/);
  assert.match(checkChange(c("a/link", { newMode: "120000" }), () => "../.git/config")!, /into a \.git directory/);
  assert.equal(checkChange(c(".gitignore"), none), undefined);
  assert.equal(checkChange(c("src/keys.ts"), none), undefined);
  assert.equal(checkChange(c(".env.example"), none), undefined);
  assert.match(checkChange(c("config/.env.production.local"), none)!, /credential/);
  // Deleting a credential file is fine; touching a submodule is not, in either direction.
  assert.equal(checkChange(c(".env", { status: "D", newMode: "000000" }), none), undefined);
  assert.match(checkChange(c("vendor/lib", { status: "D", oldMode: "160000", newMode: "000000" }), none)!, /submodule/);
});

// The whole trusted post-agent step with the real publisher: an invalid branch ends
// `failed` + blocked, with nothing pushed and no PR/MR opened.
test("applyOutcome with the real publisher: invalid branch -> failed, nothing pushed, no PR", withFixture(async (f) => {
  commit(f.work, "oops", write(f.work, "id_rsa", "-----BEGIN OPENSSH PRIVATE KEY-----\n"));
  const calls: { comments: string[]; states: string[]; reviews: ReviewRequest[] } = { comments: [], states: [], reviews: [] };
  const tracker: Tracker = {
    platform: "github",
    repo: async () => ({ cloneUrl: f.origin, webUrl: "", defaultBranch: "main" }),
    getTicket: async () => { throw new Error("unused"); },
    comment: async (text) => void calls.comments.push(text),
    setState: async (s) => void calls.states.push(s),
    createSubIssue: async () => { throw new Error("unused"); },
    openReview: async (r) => (calls.reviews.push(r), { url: "https://x/pull/1", created: true }),
  };
  const t: Ticket = { number: 1, url: "https://x/issues/1", title: "t", body: "", author: "m", trust: "trusted", labels: [], comments: [] };
  const cfg = { tracker, repo: await tracker.repo(), workDir: f.work, pluginDir: "/tmp", maxTurns: 5, publisher: f.publisher };

  const outcome = await applyOutcome(t, cfg, { status: "ready_for_review", summary: "Done." });
  assert.equal(outcome.kind, "failed");
  assert.equal(remoteBranch(f.origin), "");
  assert.equal(calls.reviews.length, 0);
  assert.deepEqual(calls.states, ["blocked"]);
  assert.match(calls.comments[0]!, /id_rsa: looks like a credential file/);

  // Fixed up (history rewritten without the key): now it publishes and opens the PR.
  git(["reset", "-q", "--hard", "origin/main"], f.work);
  commit(f.work, "feature", write(f.work, "src/feature.ts"));
  const ok = await applyOutcome(t, cfg, { status: "ready_for_review", summary: "Done." });
  assert.equal(ok.kind, "ready_for_review");
  assert.notEqual(remoteBranch(f.origin), "");
  assert.deepEqual(calls.reviews.map((r) => r.branch), [BRANCH]);
}));
