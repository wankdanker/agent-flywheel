// What the worker needs from an issue tracker. The issue (body, labels, comment
// thread) IS our state: every run rebuilds its context from here, no db.
// No npm deps in here or the adapters: CI imports them on stock node.

export const OPT_IN_LABEL = "agent";
export const STATE_LABELS = { working: "agent/working", blocked: "agent/blocked", review: "agent/review" };
// Hidden in rendered markdown; how we tell our own comments apart whatever token posted them.
export const BOT_MARKER = "<!-- agent-flywheel -->";

export type TicketState = keyof typeof STATE_LABELS;
export type Comment = { author: string; fromBot: boolean; text: string; at: string };

export type Ticket = {
  // GitHub/GitLab give us a sequential issue number; Notion tickets get a short id
  // derived from the page id instead (see src/notion.ts).
  number: number | string;
  url: string;
  title: string;
  body: string;
  labels: string[];
  comments: Comment[];
};

export type Repo = { cloneUrl: string; webUrl: string; defaultBranch: string };

export interface Tracker {
  platform: "github" | "gitlab" | "notion";
  repo(): Promise<Repo>;
  getTicket(): Promise<Ticket>;
  comment(text: string): Promise<void>;
  setState(state: TicketState): Promise<void>;
}

export const need = (k: string): string => process.env[k] || (console.error(`missing env ${k}`), process.exit(2));

export const withMarker = (text: string) => `${text}\n\n${BOT_MARKER}`;

export const toComment = (author: string, body: string, at: string): Comment => ({
  author,
  fromBot: body.includes(BOT_MARKER),
  text: body.replace(BOT_MARKER, "").trim(),
  at,
});
