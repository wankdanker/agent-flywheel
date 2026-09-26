// What the worker needs from an issue tracker. The issue (body, labels, comment
// thread) IS our state: every run rebuilds its context from here, no db.
// No npm deps in here or the adapters: CI imports them on stock node.
import type { Trust } from "./trust.ts";

export const OPT_IN_LABEL = "agent";
export const STATE_LABELS = { working: "agent/working", blocked: "agent/blocked", review: "agent/review" };
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
export type CreatedIssue = { number: number; url: string };
export type ReviewRequest = { branch: string; base: string; title: string; body: string };

export interface Tracker {
  platform: "github" | "gitlab";
  repo(): Promise<Repo>;
  getTicket(): Promise<Ticket>;
  comment(text: string): Promise<void>;
  setState(state: TicketState): Promise<void>;
  // Opens a new issue with the `agent` label already applied, so it starts its own run
  // (see worker.ts's split_into_subtasks). Implementations must ensure the opt-in label
  // actually fires that platform's trigger — see github.ts/gitlab.ts for why they differ.
  createSubIssue(input: NewSubIssue): Promise<CreatedIssue>;
  // Opens a PR/MR from `branch` into `base`, or returns the one already open for that branch
  // (`created: false`), so a retried or resumed publication never opens a duplicate. Only
  // the trusted publisher calls this (see worker.ts's applyOutcome), after pushing the branch.
  openReview(input: ReviewRequest): Promise<{ url: string; created: boolean }>;
}

export const need = (k: string): string => process.env[k] || (console.error(`missing env ${k}`), process.exit(2));

export const withMarker = (text: string) => `${BOT_BADGE}\n\n${text}\n\n${BOT_MARKER}`;

// `trust` is the poster's own trust (association / project membership), independent of
// what the comment body claims. The marker text alone is never enough to call a comment
// ours: anyone can paste it into a comment body, so `fromBot` only fires when the poster
// is also independently trusted-ish (our bot posts through a trusted token, or, on GitHub,
// the platform's own `Bot` account type — see isBotAccount in github.ts). A comment that
// fools this check is, by definition, from a poster we already trust or recognize as us.
export const toComment = (author: string, body: string, at: string, trust: Trust, isBotAccount = false): Comment => {
  const fromBot = (trust === "trusted" || isBotAccount) && body.includes(BOT_MARKER);
  return {
    author,
    trust: fromBot ? "trusted" : trust,
    fromBot,
    text: body.replace(BOT_BADGE, "").replace(BOT_MARKER, "").trim(),
    at,
  };
};
