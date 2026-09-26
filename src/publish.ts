// The privileged publisher: the only code that pushes the agent's branch, and it runs in this
// trusted process after query() has ended, never from a tool the model can call. It treats the
// agent's work dir as data, not code:
//   - the agent's commits are fetched out of the work dir into a fresh, empty repo of our own,
//     so the push runs against our config and hooks, never the checkout's (`.git/config`,
//     `.git/hooks` and the working tree are all agent-writable);
//   - that fetch runs with a minimal env holding no credential, and fsck-checks every object;
//   - the base is fetched from the forge itself, not trusted from the work dir's refs;
//   - every commit on the branch is checked against that base (validateRange below), and one
//     bad path anywhere means nothing is pushed at all.
// Opening/updating the PR/MR is the tracker's job (Tracker#openReview); see applyOutcome.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { git, withCredential, type Credential } from "./clone.ts";

// The branch failed validation: report `failed`, push nothing.
export class PublishRejected extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`refused to publish: ${problems.join("; ")}`);
    this.name = "PublishRejected";
    this.problems = problems;
  }
}

export type PushResult = { pushed: boolean; head: string; commits: number };

export interface Publisher {
  // Validates the agent's branch and pushes it. Throws PublishRejected (having pushed nothing)
  // if validation fails; `requireCommits` also rejects a branch with no commits over the base.
  pushBranch(o?: { requireCommits?: boolean }): PushResult;
}

// One entry of `git diff-tree --raw`.
export type Change = { oldMode: string; newMode: string; newSha: string; status: string; path: string };

const GITLINK = "160000";
const SYMLINK = "120000";

// Files that usually hold a secret. Adding or changing one is refused even if the content
// looks harmless, since the publisher can't tell a real key from a placeholder.
const CREDENTIAL_FILE = [
  /^\.git-credentials$/i,
  /^[._]netrc$/i,
  /^\.pgpass$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)$/i,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /^\.env(\.(?!example$|sample$|template$|dist$)[^.]+)?$/i,
  /^credentials(\.json)?$/i,
];

// Why one change can't be published, or undefined if it's fine. `symlinkTarget` reads the
// blob a symlink points to (only called for symlinks).
export function checkChange(c: Change, symlinkTarget: (sha: string) => string): string | undefined {
  const p = c.path;
  const parts = p.split("/");
  if (p.startsWith("/") || parts.some((s) => s === "" || s === "." || s === "..")) return `${p}: path escapes the repository`;
  // `.git` in any case, and the 8.3 short name Windows gives it.
  if (parts.some((s) => /^\.git$/i.test(s.replace(/[. ]+$/, "")) || /^git~\d+$/i.test(s))) return `${p}: touches a .git directory`;
  if (c.oldMode === GITLINK || c.newMode === GITLINK) return `${p}: adds or changes a submodule (gitlink)`;
  if (parts.some((s) => /^\.gitmodules$/i.test(s))) return `${p}: changes submodule config`;
  if (c.status === "D") return undefined;
  const base = parts[parts.length - 1]!;
  if (CREDENTIAL_FILE.some((re) => re.test(base))) return `${p}: looks like a credential file`;
  if (c.newMode === SYMLINK) {
    const target = symlinkTarget(c.newSha);
    if (target.startsWith("/")) return `${p}: symlink to an absolute path`;
    const resolved = posix.normalize(posix.join(posix.dirname(p), target));
    if (resolved === ".." || resolved.startsWith("../")) return `${p}: symlink points outside the repository`;
    if (resolved.split("/").some((s) => /^\.git$/i.test(s))) return `${p}: symlink points into a .git directory`;
  }
  return undefined;
}

// `git diff-tree -r -z --raw` output: ":oldmode newmode oldsha newsha status\0path\0" per entry.
export function parseRawDiff(out: string): Change[] {
  const fields = out.split("\0");
  const changes: Change[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const meta = fields[i]!;
    if (!meta.startsWith(":")) break;
    const [oldMode, newMode, , newSha, status] = meta.slice(1).split(" ");
    changes.push({ oldMode: oldMode!, newMode: newMode!, newSha: newSha!, status: status!.charAt(0), path: fields[i + 1]! });
  }
  return changes;
}

// Every commit in base..head, each diffed against the base (not just its parent), so a merge
// or a file added and later deleted is still seen. Returns the problems, deduplicated.
export function validateRange(repoDir: string, base: string, head: string, env: NodeJS.ProcessEnv): string[] {
  const run = (args: string[]) => git(args, { cwd: repoDir, env });
  const commits = run(["rev-list", `${base}..${head}`]).split("\n").filter(Boolean);
  const problems = new Set<string>();
  for (const commit of commits) {
    const raw = run(["diff-tree", "-r", "-z", "--raw", "--no-renames", "--no-abbrev", base, commit]);
    for (const change of parseRawDiff(raw)) {
      const why = checkChange(change, (sha) => run(["cat-file", "blob", sha]));
      if (why) problems.add(why);
    }
  }
  return [...problems];
}

// Just enough env for git to find itself and ~/.gitconfig (safe.directory), and no secret:
// used for every git call that reads from the agent-writable work dir.
function bareEnv(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, HOME: process.env.HOME, GIT_TERMINAL_PROMPT: "0" };
}

// Hardening for our own scratch repo: no hooks, and every object fetched is fsck'd (which
// also rejects `..`/`.git` tree entries and malicious .gitmodules outright).
const TRUSTED_CONFIG = ["-c", "core.hooksPath=/dev/null", "-c", "fetch.fsckObjects=true", "-c", "transfer.fsckObjects=true"];

export function gitPublisher(o: {
  workDir: string;       // the agent's checkout: read as data only
  cloneUrl: string;      // where to push; the allowlisted origin
  branch: string;        // agent/issue-<n>, in the work dir and on the remote
  defaultBranch: string; // what the branch is validated against
  credential?: Credential;
}): Publisher {
  return {
    pushBranch({ requireCommits = false } = {}) {
      const scratch = mkdtempSync(join(tmpdir(), "agent-publish-"));
      try {
        const env = bareEnv();
        const run = (args: string[], e: NodeJS.ProcessEnv = env) => git([...TRUSTED_CONFIG, ...args], { cwd: scratch, env: e });
        run(["init", "-q", "--bare"]);

        // The agent's commits: exactly one ref, fetched over file:// (so git goes through
        // upload-pack rather than hardlinking the work dir's object store).
        try {
          run(["fetch", "-q", "--no-tags", `file://${o.workDir}`, `+refs/heads/${o.branch}:refs/agent/head`]);
        } catch (err) {
          throw new PublishRejected([`couldn't read branch ${o.branch} from the work dir (${firstLine(err)})`]);
        }
        const head = run(["rev-parse", "refs/agent/head"]);

        // The base (and the branch as last published) come from the forge, never the work dir.
        withCredential(o.credential, (credEnv) => {
          const e = { ...credEnv, ...env };
          run(["fetch", "-q", "--no-tags", o.cloneUrl, `+refs/heads/${o.defaultBranch}:refs/base/default`], e);
          // A branch that isn't on the remote yet is fine; anything else failing isn't.
          if (run(["ls-remote", "--heads", o.cloneUrl, o.branch], e)) {
            run(["fetch", "-q", "--no-tags", o.cloneUrl, `+refs/heads/${o.branch}:refs/base/published`], e);
          }
        });

        let base: string;
        try {
          base = run(["merge-base", "refs/base/default", head]);
        } catch {
          throw new PublishRejected([`${o.branch} shares no history with ${o.defaultBranch}`]);
        }
        const problems = validateRange(scratch, base, head, env);
        if (problems.length) throw new PublishRejected(problems);

        const commits = Number(run(["rev-list", "--count", `${base}..${head}`]));
        if (requireCommits && commits === 0) throw new PublishRejected([`${o.branch} has no commits over ${o.defaultBranch}`]);
        const published = tryRun(() => run(["rev-parse", "-q", "--verify", "refs/base/published"]));
        if (published === head || (!published && commits === 0)) return { pushed: false, head, commits };

        withCredential(o.credential, (credEnv) => {
          run(["push", "-q", o.cloneUrl, `${head}:refs/heads/${o.branch}`], { ...credEnv, ...env });
        });
        return { pushed: true, head, commits };
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    },
  };
}

function tryRun(f: () => string): string | undefined {
  try {
    return f();
  } catch {
    return undefined;
  }
}

const firstLine = (err: unknown) => (err instanceof Error ? err.message : String(err)).split("\n")[0];
