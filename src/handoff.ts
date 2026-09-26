// The files the split stages (src/stages.ts) hand each other, next to the clone in the work
// dir, which CI carries from job to job:
//   prepared.json  prepare → agent: the issue and repo, fetched with the forge token, since the
//                  agent job has none to fetch them itself.
//   outcome.json   agent → publish: the AgentOutcome the agent's tool calls recorded.
// outcome.json is written from inside the agent's container, where the model runs Bash with
// permissions bypassed, so the publish job treats it as hostile data: never followed through a
// symlink, capped in size, and parsed against a strict schema with capped lengths. Nothing in it
// decides where anything is pushed or what the PR/MR URL is; the publisher and openReview do.
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Repo, Ticket, Tracker } from "./tracker.ts";
import type { AgentOutcome } from "./worker.ts";

export const HANDOFF_VERSION = 1;

export const handoffDirFor = (workDir: string) => `${workDir}.handoff`;
const PREPARED = "prepared.json";
const OUTCOME = "outcome.json";

// A handoff file is missing, unreadable or malformed. Its message only ever names paths and
// schema issue codes, never the file's content, since it can end up in an issue comment.
export class HandoffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HandoffError";
  }
}

export type Prepared = { version: number; platform: Tracker["platform"]; ticket: Ticket; repo: Repo };
export type HandedOutcome = { version: number; issue: number; recorded: AgentOutcome | null; maxTurnsHit: boolean };

// Well under GitHub's 65,536-character comment limit, even with a checkpoint's two fields
// and our own wording around them.
export const MAX_TEXT = 30_000;
export const MAX_TITLE = 255;
export const MAX_SUBTASKS = 20;
const MAX_OUTCOME_BYTES = 256 * 1024;

const text = (max: number) => z.string().max(max);
const AgentOutcomeSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("blocked"), question: text(MAX_TEXT).min(1) }),
  z.strictObject({ status: z.literal("ready_for_review"), summary: text(MAX_TEXT) }),
  z.strictObject({
    status: z.literal("split"),
    summary: text(MAX_TEXT),
    subtasks: z.array(z.strictObject({ title: text(MAX_TITLE).min(1), body: text(MAX_TEXT) })).min(2).max(MAX_SUBTASKS),
  }),
  z.strictObject({ status: z.literal("failed"), summary: text(MAX_TEXT) }),
  z.strictObject({ status: z.literal("checkpoint"), summary: text(MAX_TEXT), nextSteps: text(MAX_TEXT) }),
]);

const HandedOutcomeSchema = z.strictObject({
  version: z.literal(HANDOFF_VERSION),
  issue: z.number().int().positive(),
  recorded: AgentOutcomeSchema.nullable(),
  maxTurnsHit: z.boolean(),
});

// The prepare job wrote this, and only the (unprivileged) agent job reads it, so a sanity check
// on its shape is enough; there's nothing in the agent job for a forged one to reach.
const PreparedSchema = z.object({
  version: z.literal(HANDOFF_VERSION),
  platform: z.enum(["github", "gitlab"]),
  ticket: z.object({ number: z.number().int().positive() }).passthrough(),
  repo: z.object({ cloneUrl: z.string(), webUrl: z.string(), defaultBranch: z.string() }),
});

const issueList = (err: z.ZodError) => err.issues.slice(0, 10).map((i) => `${i.path.join(".") || "<root>"}: ${i.code}`).join("; ");

// Starts a fresh handoff for this run: whatever an earlier run (or its agent) left is gone.
export function resetHandoff(workDir: string) {
  const dir = handoffDirFor(workDir);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

function write(workDir: string, name: string, data: unknown) {
  const dir = handoffDirFor(workDir);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  rmSync(path, { force: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, { flag: "wx" });
}

export const writePrepared = (workDir: string, p: Omit<Prepared, "version">) => write(workDir, PREPARED, { version: HANDOFF_VERSION, ...p });

export const writeOutcome = (workDir: string, o: Omit<HandedOutcome, "version">) => write(workDir, OUTCOME, { version: HANDOFF_VERSION, ...o });

export const clearOutcome = (workDir: string) => rmSync(join(handoffDirFor(workDir), OUTCOME), { force: true });

// Reads one handoff file without following a symlink at either the directory or the file (a
// link to, say, /proc/self/environ would otherwise be read with the publish job's forge token
// in it), without blocking on a FIFO, and only if it's a regular file under `maxBytes`.
// Undefined if it doesn't exist.
export function readHandoffFile(workDir: string, name: string, maxBytes: number): string | undefined {
  const dir = handoffDirFor(workDir);
  let st;
  try {
    st = lstatSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new HandoffError(`can't read the handoff directory (${(err as NodeJS.ErrnoException).code})`);
  }
  if (!st.isDirectory()) throw new HandoffError("the handoff directory isn't a plain directory");

  let fd: number;
  try {
    fd = openSync(join(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    throw new HandoffError(`${name} can't be opened (${code === "ELOOP" ? "it's a symlink" : code})`);
  }
  try {
    const f = fstatSync(fd);
    if (!f.isFile()) throw new HandoffError(`${name} isn't a regular file`);
    if (f.size > maxBytes) throw new HandoffError(`${name} is ${f.size} bytes, over the ${maxBytes}-byte limit`);
    const buf = Buffer.alloc(f.size);
    let off = 0;
    while (off < buf.length) {
      const n = readSync(fd, buf, off, buf.length - off, off);
      if (n === 0) break;
      off += n;
    }
    return buf.subarray(0, off).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function parseJson(name: string, raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new HandoffError(`${name} isn't valid JSON`);
  }
}

// Undefined when the prepare stage left nothing (it settled the issue itself, or didn't run).
export function readPrepared(workDir: string): Prepared | undefined {
  const raw = readHandoffFile(workDir, PREPARED, 8 * 1024 * 1024);
  if (raw === undefined) return undefined;
  const parsed = PreparedSchema.safeParse(parseJson(PREPARED, raw));
  if (!parsed.success) throw new HandoffError(`${PREPARED} failed validation: ${issueList(parsed.error)}`);
  return parsed.data as unknown as Prepared;
}

// What the agent job recorded for issue `issue`, validated. Throws a HandoffError when it's
// missing (the agent job failed, or never ran) or doesn't pass the schema.
export function readOutcome(workDir: string, issue: number): HandedOutcome {
  const raw = readHandoffFile(workDir, OUTCOME, MAX_OUTCOME_BYTES);
  if (raw === undefined) throw new HandoffError(`the agent stage left no ${OUTCOME}: it failed or never ran; see its job log`);
  const parsed = HandedOutcomeSchema.safeParse(parseJson(OUTCOME, raw));
  if (!parsed.success) throw new HandoffError(`${OUTCOME} failed validation: ${issueList(parsed.error)}`);
  if (parsed.data.issue !== issue) throw new HandoffError(`${OUTCOME} is for issue ${parsed.data.issue}, not #${issue}`);
  return parsed.data;
}
