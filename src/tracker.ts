// What the worker needs from an issue tracker. The issue (body, labels, comment
// thread) IS our state: every run rebuilds its context from here, no db.
// No npm deps in here or the adapters: CI imports them on stock node.
import type { Trust } from "./trust.ts";

export const OPT_IN_LABEL = "agent";
// `queued` is a sub-issue waiting its turn in a split's chain (see src/chain.ts): it has no
// `agent` label yet, so nothing runs it until the sub-issue before it merges.
export const STATE_LABELS = { working: "agent/working", blocked: "agent/blocked", review: "agent/review", queued: "agent/queued" };
// Hidden in rendered markdown; how we tell our own comments apart whatever token posted them.
export const BOT_MARKER = "<!-- agent-flywheel -->";
// Visible prefix so a comment still reads as ours when posted with a personal access token
// (AGENT_GH_TOKEN/AGENT_GITLAB_TOKEN), which otherwise shows up as that token owner, not a bot.
export const BOT_BADGE = "🤖 **Agent Flywheel**";

export type TicketState = keyof typeof STATE_LABELS;
export type Comment = { author: string; trust: Trust; fromBot: boolean; text: string; at: string };

export type Ticket = {
  number: number;
  url: string;
  title: string;
  body: string;
  author: string;
  trust: Trust; // trust of the issue's author; gates whether title/body are usable as instructions
  labels: string[];
  comments: Comment[];
};

export type Repo = { cloneUrl: string; webUrl: string; defaultBranch: string };

export type NewSubIssue = { title: string; body: string };
// `runnable` sub-issues get the `agent` label (their run starts right away); the rest get
// `agent/queued`. `parent`/`blockedBy` are also recorded natively where the platform can
// (best effort: the body's chain header, src/chain.ts, is the source of truth).
export type SubIssueRequest = NewSubIssue & { runnable: boolean; parent: number; blockedBy?: number };
export type CreatedIssue = { number: number; url: string };
export type ReviewRequest = { branch: string; base: string; title: string; body: string };

export interface Tracker {
  platform: "github" | "gitlab";
  repo(): Promise<Repo>;
  getTicket(): Promise<Ticket>;
  comment(text: string): Promise<void>;
  setState(state: TicketState): Promise<void>;
  // Opens a new issue. A `runnable` one gets the `agent` label, so it starts its own run (see
  // worker.ts's split); implementations must ensure the opt-in label actually fires that
  // platform's trigger — see github.ts/gitlab.ts for why they differ. The others get
  // `agent/queued` and wait for src/chain.ts's advanceChain to release them.
  createSubIssue(input: SubIssueRequest): Promise<CreatedIssue>;
  // Creates `branch` from the current tip of `from`, unless it already exists. True if created.
  ensureBranch(branch: string, from: string): Promise<boolean>;
  // Opens a PR/MR from `branch` into `base`, or returns the one already open for that branch
  // (`created: false`), so a retried or resumed publication never opens a duplicate. Only
  // the trusted publisher calls this (see worker.ts's applyOutcome), after pushing the branch.
  openReview(input: ReviewRequest): Promise<{ url: string; created: boolean }>;
  // Starts a fresh run on this issue with AGENT_TRIGGER=relay: the publish stage's auto-relay
  // after a checkpoint (src/stages.ts), capped by MAX_CHAINED_RUNS (src/dispatch.ts). GitHub
  // dispatches agent.yml; GitLab creates a pipeline that bin/dispatch-gitlab.ts picks up.
  dispatchRelay(): Promise<void>;
}

// An open issue carrying `agent/queued`, as advanceChain needs it.
export type QueuedIssue = Pick<Ticket, "number" | "url" | "body" | "trust">;
export type ReviewInfo = { number: number; open: boolean; merged: boolean; head: string; base: string; sha: string; sameRepo: boolean };

// The repo-level forge calls that advancing a split's chain needs (src/chain.ts), beyond one
// issue's Tracker. Only the chain step (bin/advance-chain.ts) uses it, never the agent's run.
export interface ChainForge {
  tracker(issue: number): Tracker;
  listQueued(): Promise<QueuedIssue[]>;
  // `agent/queued` → `agent`, which starts that issue's run.
  release(issue: number): Promise<void>;
  close(issue: number): Promise<void>;
  getReview(number: number): Promise<ReviewInfo>;
  // The PR/MR (open or not) from `branch` whose head is `sha`, if any.
  findReview(branch: string, sha: string): Promise<number | undefined>;
  // Merges the PR/MR only if its head is still `sha` (what was tested).
  mergeReview(number: number, sha: string): Promise<void>;
}

export const need = (k: string): string => process.env[k] || (console.error(`missing env ${k}`), process.exit(2));

export const withMarker = (text: string) => `${BOT_BADGE}\n\n${text}\n\n${BOT_MARKER}`;

// `trust` is the poster's own trust (association / project membership), independent of
// what the comment body claims. The marker text alone is never enough to call a comment
// ours: anyone can paste it into a comment body, so `fromBot` only fires when the poster
// is also independently trusted (our bot posts through a trusted token) or is `isSelf`: the
// exact account our own forge token authenticates as (on GitHub, the worker's resolved bot
// identity — see workerIdentity in github.ts; never "any account of type Bot", which any
// other installed app also is). A comment that fools this check is, by definition, from a
// poster we already trust or from us.
export const toComment = (author: string, body: string, at: string, trust: Trust, isSelf = false): Comment => {
  const fromBot = (trust === "trusted" || isSelf) && body.includes(BOT_MARKER);
  return {
    author,
    trust: fromBot ? "trusted" : trust,
    fromBot,
    text: body.replace(BOT_BADGE, "").replace(BOT_MARKER, "").trim(),
    at,
  };
};
