// When an issue event should start a run. One set of pure functions for both platforms: the
// GitLab dispatcher (bin/dispatch-gitlab.ts) decides webhooks with them, GitHub's agent.yml
// mirrors them in its `if`/`concurrency` expressions as a prefilter, and the prepare stage
// (src/stages.ts, and main() in src/run.ts) re-checks the trigger against the issue's live
// labels, so a queued run whose reason has since gone away (e.g. a second reply on a blocked
// issue that the first reply's run already settled) never starts the agent.
// No npm deps here, same as tracker.ts: bin/dispatch-gitlab.ts imports this on stock node.
import { BOT_MARKER, OPT_IN_LABEL, STATE_LABELS, type Comment } from "./tracker.ts";

export const CONTINUE_COMMAND = "/agent continue";

// The explicit rerun command: the comment's first nonblank line is exactly `/agent continue`
// (case-sensitive; trailing whitespace allowed). Up to 3 leading spaces are still a markdown
// paragraph; 4 or a tab is an indented code block, and `>`/```` ``` ```` start a quote or a
// fence, so a command inside any of those never counts.
export function isContinueCommand(body: string): boolean {
  const first = body.split(/\r?\n/).find((l) => l.trim() !== "");
  return first !== undefined && /^ {0,3}\/agent continue[ \t]*$/.test(first);
}

// Why a run was (or wasn't) started. How the event got in:
//   label    `agent` was added (or the issue opened/reopened with it): the initial run.
//   command  a trusted `/agent continue` comment: runs from any state.
//   comment  any other trusted comment: resumes only an `agent/blocked` issue.
//   manual   workflow_dispatch / a manual pipeline / a local run: always runs.
//   relay    our own publish stage re-dispatching a checkpointed issue (see "Chained runs"
//            below): runs only while that relay is still the latest word on a blocked issue.
//   pickup   a poller found the ticket ready (Notion: To Do, assigned to the agent; see
//            src/notion.ts): runs only while it's still unstarted, so a poll that raced a run
//            already under way, or queued behind one that has since settled, does nothing.
export type Trigger = "label" | "command" | "comment" | "manual" | "relay" | "pickup";
export const TRIGGERS: readonly Trigger[] = ["label", "command", "comment", "manual", "relay", "pickup"];
export type Decision = { run: boolean; reason: string };

export type CommentEvent = {
  open: boolean;
  labels: string[];
  trusted: boolean;
  body: string;
  onPullRequest?: boolean; // GitHub delivers PR comments as issue_comment too
};

const run = (reason: string): Decision => ({ run: true, reason });
const skip = (reason: string): Decision => ({ run: false, reason });

// The cheap checks first, so callers can skip the (GitLab: API call) trust lookup: pass
// `trusted: true` to ask "would this run if the poster is trusted?".
export function decideComment(e: CommentEvent): Decision & { trigger?: Trigger } {
  if (e.onPullRequest) return skip("comment is on a pull request, not an issue");
  if (!e.open) return skip("issue is closed");
  if (!e.labels.includes(OPT_IN_LABEL)) return skip(`issue has no \`${OPT_IN_LABEL}\` label`);
  if (e.body.includes(BOT_MARKER)) return skip("comment carries the bot marker");
  if (!e.trusted) return skip("commenter isn't trusted");
  if (isContinueCommand(e.body)) return { ...run(`explicit \`${CONTINUE_COMMAND}\``), trigger: "command" };
  const state = stateOf(e.labels);
  if (state === STATE_LABELS.blocked) return { ...run(`reply on a \`${state}\` issue`), trigger: "comment" };
  return skip(`ordinary comment on ${state ? `a \`${state}\`` : "an unstarted"} issue; only \`${STATE_LABELS.blocked}\` resumes on a reply (use \`${CONTINUE_COMMAND}\` to force a run)`);
}

// ---- Chained runs ----
//
// A run nobody asked for in the thread (an auto-relay after a checkpoint) is "chained". How many
// have run in a row is derived from the thread, not stored: each relay's announcement (our own
// marker-tagged comment) carries a hidden CHAIN_MARKER with its position, and a trusted human
// comment resets the count. MAX_CHAINED_RUNS caps it; past that, the issue waits on a human.
export const DEFAULT_MAX_CHAINED_RUNS = 3;
export const chainMarker = (n: number) => `<!-- agent-flywheel:chain=${n} -->`;
const CHAIN_MARKER = /<!-- agent-flywheel:chain=(\d+) -->/;

// Only our own comments count (`fromBot`, which toComment only grants to a trusted poster), so
// pasting the marker into a comment does nothing.
const chainPosition = (c: Comment) => (c.fromBot ? Number(CHAIN_MARKER.exec(c.text)?.[1] ?? NaN) : NaN);
const isHuman = (c: Comment) => c.trust === "trusted" && !c.fromBot;

// Consecutive chained runs so far: the latest relay's position, or 0 once a trusted human has
// commented since (or there's never been one).
export function chainedRuns(comments: Comment[]): number {
  for (const c of [...comments].reverse()) {
    if (isHuman(c)) return 0;
    const n = chainPosition(c);
    if (Number.isInteger(n)) return n;
  }
  return 0;
}

// The relay a `relay` run was started for, if it's still the latest trusted word on the thread:
// the newest trusted comment is our relay announcement. Anything a human said since means that
// comment's own run (or nobody) picks the issue up, not the relay.
export function pendingRelay(comments: Comment[]): number | undefined {
  const last = [...comments].reverse().find((c) => c.trust === "trusted");
  const n = last ? chainPosition(last) : NaN;
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

// The prepare stage's re-check of a trigger against the issue as it is now. `trigger` comes
// from AGENT_TRIGGER, set by the CI gate that already checked trust and the bot marker; unset
// means a manual or local run. `comments` and `maxChained` only matter to a relay.
export function recheckTrigger(trigger: Trigger | undefined, labels: string[], comments: Comment[] = [], maxChained = DEFAULT_MAX_CHAINED_RUNS): Decision {
  if (!trigger || trigger === "manual") return run("manual run");
  if (!labels.includes(OPT_IN_LABEL)) return skip(`\`${OPT_IN_LABEL}\` label is gone`);
  if (trigger === "label") return run(`\`${OPT_IN_LABEL}\` label added`);
  if (trigger === "command") return run(`explicit \`${CONTINUE_COMMAND}\``);
  const state = stateOf(labels);
  if (trigger === "pickup") return state ? skip(`ticket is already \`${state}\`; only an unstarted one is picked up`) : run("picked up, unstarted");
  if (trigger === "relay") {
    if (state !== STATE_LABELS.blocked) return skip(`issue is now ${state ? `\`${state}\`` : "unstarted"}, not the \`${STATE_LABELS.blocked}\` a relay continues`);
    const n = pendingRelay(comments);
    if (n === undefined) return skip("the latest trusted comment isn't a relay announcement; someone has weighed in since");
    if (n > maxChained) return skip(`relay ${n} is over MAX_CHAINED_RUNS (${maxChained})`);
    return run(`chained run ${n} of at most ${maxChained}`);
  }
  return state === STATE_LABELS.blocked
    ? run(`reply on a \`${state}\` issue`)
    : skip(`issue is now ${state ? `\`${state}\`` : "unstarted"}, not \`${STATE_LABELS.blocked}\`, so a reply no longer resumes it`);
}

// AGENT_TRIGGER, plus (GitHub) AGENT_COMMENT: agent.yml's expressions can't parse the command
// strictly, so it hands over the triggering comment's body and we classify it here.
export function triggerFromEnv(env: NodeJS.ProcessEnv): Trigger | undefined {
  const t = env.AGENT_TRIGGER;
  if (t === undefined) return undefined;
  if (!(TRIGGERS as string[]).includes(t)) throw new Error(`AGENT_TRIGGER must be one of ${TRIGGERS.join(", ")}, got ${JSON.stringify(t)}`);
  if (t === "comment" && env.AGENT_COMMENT !== undefined && isContinueCommand(env.AGENT_COMMENT)) return "command";
  return t as Trigger;
}

const stateOf = (labels: string[]) => Object.values(STATE_LABELS).find((l) => labels.includes(l));

// What every blocked-state comment tells people about resuming.
export const RESUME_HINT =
  `Any reply here from a maintainer resumes me while this issue is \`${STATE_LABELS.blocked}\`. From any other ` +
  `state, only a comment whose first line is \`${CONTINUE_COMMAND}\` starts a run.`;
export const REVIEW_HINT =
  `Comments here won't start another run. To have me rework this, comment with \`${CONTINUE_COMMAND}\` as the ` +
  `first line, followed by what to change.`;
