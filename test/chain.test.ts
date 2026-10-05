import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { advanceChain, baseBranchFor, chainHeader, chainOf, parseChain } from "../src/chain.ts";
import { STATE_LABELS, type ChainForge, type ReviewInfo, type ReviewRequest, type Ticket, type TicketState, type Tracker } from "../src/tracker.ts";

test("chain header: round-trips, and derives the base branch from the parent rather than reading it", () => {
  const link = { parent: 12, index: 2, total: 3, blockedBy: 21 };
  assert.deepEqual(parseChain(`${chainHeader(link)}\n\nBody text.`), link);
  assert.deepEqual(parseChain(chainHeader({ parent: 12, index: 1, total: 3 })), { parent: 12, index: 1, total: 3 });
  // A header naming any other base branch isn't one of ours.
  assert.equal(parseChain("Parent: #12\nBase branch: main\nSub-issue: 1 of 2"), undefined);
  assert.equal(parseChain("Parent: #12\nBase branch: agent/issue-12\nSub-issue: 3 of 2"), undefined);
  // Only the first paragraph counts.
  assert.equal(parseChain(`Intro.\n\n${chainHeader(link)}`), undefined);
  assert.equal(chainOf({ trust: "untrusted", body: chainHeader(link) }), undefined);
  assert.equal(baseBranchFor({ trust: "trusted", body: chainHeader(link) }, "main"), "agent/issue-12");
  assert.equal(baseBranchFor({ trust: "untrusted", body: chainHeader(link) }, "main"), "main");
});

type Issue = { number: number; title: string; body: string; trust: Ticket["trust"]; labels: string[]; open: boolean; comments: string[] };

// Issues #12 (parent) and #21..#23 (its chain), PRs keyed by number.
function fakeForge(o: { released?: number[] } = {}) {
  const issues = new Map<number, Issue>();
  const add = (i: Omit<Issue, "open" | "comments">) => issues.set(i.number, { ...i, open: true, comments: [] });
  add({ number: 12, title: "Big feature", body: "Do everything.", trust: "trusted", labels: ["agent", STATE_LABELS.blocked] });
  for (const [n, index, blockedBy] of [[21, 1, undefined], [22, 2, 21], [23, 3, 22]] as const) {
    const queued = index > 1 && !o.released?.includes(n);
    add({
      number: n, title: `Part ${index}`, trust: "trusted",
      body: `${chainHeader({ parent: 12, index, total: 3, blockedBy })}\n\nPart ${index}.`,
      labels: queued ? [STATE_LABELS.queued] : ["agent", STATE_LABELS.review],
    });
  }
  const prs = new Map<number, ReviewInfo>();
  const reviews: ReviewRequest[] = [];
  const merges: [number, string][] = [];

  const tracker = (n: number): Tracker => ({
    platform: "github",
    repo: async () => ({ cloneUrl: "https://x/r.git", webUrl: "https://x/r", defaultBranch: "main" }),
    async getTicket() {
      const i = issues.get(n)!;
      return { number: n, url: `https://x/issues/${n}`, title: i.title, body: i.body, author: "bot", trust: i.trust, labels: i.labels, comments: [] };
    },
    comment: async (text) => void issues.get(n)!.comments.push(text),
    async setState(s: TicketState) {
      const i = issues.get(n)!;
      i.labels = [...i.labels.filter((l) => !Object.values(STATE_LABELS).includes(l)), STATE_LABELS[s]];
    },
    createSubIssue: async () => { throw new Error("unused"); },
    ensureBranch: async () => { throw new Error("unused"); },
    openReview: async (r) => (reviews.push(r), { url: "https://x/pull/99", created: reviews.length === 1 }),
    dispatchRelay: async () => { throw new Error("unused"); },
    retarget: () => { throw new Error("unused"); },
  });
  const forge: ChainForge = {
    tracker,
    listQueued: async () =>
      [...issues.values()].filter((i) => i.open && i.labels.includes(STATE_LABELS.queued))
        .map((i) => ({ number: i.number, url: `https://x/issues/${i.number}`, body: i.body, trust: i.trust })),
    async release(n) {
      const i = issues.get(n)!;
      i.labels = [...i.labels.filter((l) => l !== STATE_LABELS.queued), "agent"];
    },
    close: async (n) => void (issues.get(n)!.open = false),
    getReview: async (n) => ({ ...prs.get(n)! }),
    findReview: async (branch, sha) => [...prs.values()].find((p) => p.head === branch && p.sha === sha)?.number,
    async mergeReview(n, sha) {
      const pr = prs.get(n)!;
      assert.equal(pr.sha, sha);
      Object.assign(pr, { open: false, merged: true });
      merges.push([n, sha]);
    },
  };
  const pr = (n: number, over: Partial<ReviewInfo>) =>
    prs.set(n, { number: n, open: true, merged: false, head: "agent/issue-21", base: "agent/issue-12", sha: "aaa", sameRepo: true, ...over });
  return { forge, issues, prs, pr, reviews, merges };
}

test("advanceChain: merging sub-issue 1 closes it and releases sub-issue 2 only", async () => {
  const f = fakeForge();
  f.pr(5, {});
  const did = await advanceChain(f.forge, { review: 5, merge: { sha: "aaa" } });

  assert.match(did, /released #22/);
  assert.deepEqual(f.merges, [[5, "aaa"]]);
  assert.equal(f.issues.get(21)!.open, false);
  assert.deepEqual(f.issues.get(22)!.labels, ["agent"]);
  assert.deepEqual(f.issues.get(23)!.labels, [STATE_LABELS.queued]);
  assert.match(f.issues.get(12)!.comments[0]!, /starting #22/);
  assert.equal(f.reviews.length, 0);

  // The merged event for the same PR afterwards: nothing more to do.
  assert.match(await advanceChain(f.forge, { review: 5 }), /no queued sub-issue waits on it/);
  assert.deepEqual(f.issues.get(23)!.labels, [STATE_LABELS.queued]);
  assert.equal(f.issues.get(12)!.comments.length, 1);
});

test("advanceChain: after the last sub-issue merges, opens one integration PR into the default branch and moves the parent to review", async () => {
  const f = fakeForge({ released: [22, 23] });
  f.pr(7, { head: "agent/issue-23", merged: true, open: false });
  const did = await advanceChain(f.forge, { review: 7 });

  assert.match(did, /last of 3/);
  assert.deepEqual(f.reviews.map((r) => [r.branch, r.base, r.title]), [["agent/issue-12", "main", "Big feature"]]);
  assert.match(f.reviews[0]!.body, /Closes #12/);
  assert.ok(f.issues.get(12)!.labels.includes(STATE_LABELS.review));
  assert.match(f.issues.get(12)!.comments[0]!, /Integration review: https:\/\/x\/pull\/99/);

  // Idempotent: a second call (merge job + merged event) doesn't comment again.
  assert.match(await advanceChain(f.forge, { review: 7 }), /already up for review/);
  assert.equal(f.issues.get(12)!.comments.length, 1);
});

test("advanceChain: refuses PRs that aren't a chain member's into its own integration branch, and stale heads", async () => {
  const f = fakeForge();
  f.pr(1, { head: "feature/x" });
  f.pr(2, { sameRepo: false });
  f.pr(3, { base: "main" });
  f.pr(4, { base: "agent/issue-99" });
  f.pr(5, { sha: "bbb" });
  f.pr(6, { head: "agent/issue-12", base: "agent/issue-12" });
  for (const n of [1, 2, 3, 4, 6]) assert.match(await advanceChain(f.forge, { review: n, merge: { sha: "aaa" } }), /nothing to do/);
  assert.match(await advanceChain(f.forge, { review: 5, merge: { sha: "aaa" } }), /moved on/);
  // Not merged and not asked to merge: no advance.
  f.pr(8, {});
  assert.match(await advanceChain(f.forge, { review: 8 }), /isn't merged/);

  // An untrusted-authored "sub-issue" is never believed.
  f.issues.get(21)!.trust = "untrusted";
  f.pr(9, {});
  assert.match(await advanceChain(f.forge, { review: 9, merge: { sha: "aaa" } }), /nothing to do/);

  assert.deepEqual(f.merges, []);
  assert.ok(f.issues.get(21)!.open);
  assert.deepEqual(f.issues.get(22)!.labels, [STATE_LABELS.queued]);
});

test("advanceChain: a queued issue claiming the chain but written by an untrusted author isn't released", async () => {
  const f = fakeForge();
  f.issues.get(22)!.trust = "untrusted";
  f.pr(5, {});
  assert.match(await advanceChain(f.forge, { review: 5, merge: { sha: "aaa" } }), /no queued sub-issue/);
  assert.deepEqual(f.issues.get(22)!.labels, [STATE_LABELS.queued]);
});

test("bin/advance-chain.ts and everything it imports are dependency-free (CI runs it on stock node, no npm install)", () => {
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const m of readFileSync(file, "utf8").matchAll(/^import\s+(?!type\b)[^;]*?from\s+"([^"]+)"/gm)) {
      const spec = m[1]!;
      if (spec.startsWith("node:")) continue;
      assert.ok(spec.startsWith("."), `${file} imports ${spec}`);
      visit(join(dirname(file), spec));
    }
  };
  visit("bin/advance-chain.ts");
  assert.ok(seen.has("src/github.ts") && seen.has("src/gitlab.ts") && seen.has("src/chain.ts"));
});
