// A split's sub-issues run one at a time, on a feature integration branch (#31):
//   - on split, applyOutcome (src/worker.ts) creates `agent/issue-<parent>` from the default
//     branch and opens the sub-issues, only the first with `agent`; the rest wait on
//     `agent/queued`. Each body starts with a chain header (below);
//   - a sub-issue's run branches from, is validated against, and opens its PR/MR into the
//     integration branch (baseBranchFor);
//   - once that PR/MR's typecheck + tests pass, CI merges it and calls advanceChain
//     (bin/advance-chain.ts), which releases the next queued sub-issue, or, after the last one,
//     opens the one integration PR/MR into the default branch for a human to review.
// The header is the platform-neutral source of truth for the chain, and it's only believed on an
// issue whose author is trusted (our own token, or a maintainer). No npm deps: CI runs
// bin/advance-chain.ts on stock node.
import { STATE_LABELS, type ChainForge, type Ticket } from "./tracker.ts";

export const MAX_SUBTASKS = 4;

export type ChainLink = { parent: number; index: number; total: number; blockedBy?: number };

export const integrationBranch = (parent: number) => `agent/issue-${parent}`;

export function chainHeader(l: ChainLink): string {
  return [
    `Parent: #${l.parent}`,
    `Base branch: ${integrationBranch(l.parent)}`,
    `Sub-issue: ${l.index} of ${l.total}`,
    ...(l.blockedBy ? [`Blocked by: #${l.blockedBy}`] : []),
  ].join("\n");
}

// The header at the top of a body, or undefined if it isn't one of ours. The base branch is
// always derived from the parent, never read from the text, so a header can't point a run at
// any other branch.
export function parseChain(body: string): ChainLink | undefined {
  const head = body.replace(/\r\n/g, "\n").split("\n\n")[0]!;
  const field = (name: string) => new RegExp(`^${name}: (.+)$`, "m").exec(head)?.[1]!.trim();
  const parent = /^#(\d+)$/.exec(field("Parent") ?? "")?.[1];
  const position = /^(\d+) of (\d+)$/.exec(field("Sub-issue") ?? "");
  if (!parent || !position || field("Base branch") !== integrationBranch(Number(parent))) return undefined;
  const blockedBy = /^#(\d+)$/.exec(field("Blocked by") ?? "")?.[1];
  const link: ChainLink = { parent: Number(parent), index: Number(position[1]), total: Number(position[2]) };
  if (link.index < 1 || link.index > link.total) return undefined;
  return blockedBy ? { ...link, blockedBy: Number(blockedBy) } : link;
}

// A ticket's place in a chain, trusting the header only from a trusted author.
export const chainOf = (t: Pick<Ticket, "body" | "trust">): ChainLink | undefined => (t.trust === "trusted" ? parseChain(t.body) : undefined);

// What a run starts from, is validated against, and targets with its PR/MR.
export const baseBranchFor = (t: Pick<Ticket, "body" | "trust">, defaultBranch: string) => {
  const link = chainOf(t);
  return link ? integrationBranch(link.parent) : defaultBranch;
};

export const integrationReviewBody = (parent: Ticket, total: number) =>
  `All ${total} sub-issues of #${parent.number} have merged into \`${integrationBranch(parent.number)}\`. ` +
  `This merges the combined work into the default branch; review it as a whole.\n\nCloses #${parent.number}`;

// Merges the sub-issue PR/MR `review` (when `merge` is set; CI only asks once typecheck and
// tests passed on `sha`), then moves the chain along. Idempotent, since both the merge job and
// the merged event can call it for one PR/MR. Returns what it did, for the log.
export async function advanceChain(forge: ChainForge, o: { review: number; merge?: { sha: string } }): Promise<string> {
  const pr = await forge.getReview(o.review);
  const issue = /^agent\/issue-(\d+)$/.exec(pr.head)?.[1];
  if (!pr.sameRepo || !issue) return `!${o.review} isn't from an agent/issue-<n> branch in this repo; nothing to do`;
  const sub = forge.tracker(Number(issue));
  const t = await sub.getTicket();
  const link = chainOf(t);
  // Only a PR/MR from a chain member into its own parent's integration branch is ours to merge.
  if (!link || pr.base !== integrationBranch(link.parent)) return `#${t.number} isn't a sub-issue targeting ${pr.base}; nothing to do`;

  if (o.merge) {
    if (!pr.open) return `!${o.review} isn't open; nothing to merge`;
    if (pr.sha !== o.merge.sha) return `!${o.review} moved on from ${o.merge.sha} (now ${pr.sha}); its own run merges it`;
    await forge.mergeReview(o.review, o.merge.sha);
  } else if (!pr.merged) {
    return `!${o.review} isn't merged; nothing to advance`;
  }

  await forge.close(t.number);
  const parent = forge.tracker(link.parent);
  if (link.index < link.total) {
    const next = (await forge.listQueued()).find((q) => {
      const l = chainOf(q);
      return l?.parent === link.parent && l.blockedBy === t.number;
    });
    if (!next) return `#${t.number} merged; no queued sub-issue waits on it (already released?)`;
    await forge.release(next.number);
    await parent.comment(`Sub-issue #${t.number} (${link.index} of ${link.total}) merged into \`${integrationBranch(link.parent)}\`; starting #${next.number}.`);
    return `#${t.number} merged; released #${next.number}`;
  }

  // The last one: one integration PR/MR for a human to review as a whole.
  const p = await parent.getTicket();
  if (p.labels.includes(STATE_LABELS.review)) return `#${t.number} merged; #${p.number} is already up for review`;
  const repo = await parent.repo();
  const review = await parent.openReview({
    branch: integrationBranch(p.number),
    base: repo.defaultBranch,
    title: p.title,
    body: integrationReviewBody(p, link.total),
  });
  await parent.comment(`All ${link.total} sub-issues have merged into \`${integrationBranch(p.number)}\`. Integration review: ${review.url}`);
  await parent.setState("review");
  return `#${t.number} merged (last of ${link.total}); ${review.created ? "opened" : "reusing"} ${review.url}`;
}
