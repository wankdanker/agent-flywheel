import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Repo, Ticket, Tracker } from "./tracker.ts";

export type WorkerConfig = {
  tracker: Tracker;
  repo: Repo;            // the project the issue lives on; our own source by default
  workDir: string;       // where we clone repos
  pluginDir: string;     // our baked-in skills/agents/hooks
  model?: string;
  maxTurns: number;
};

export type Outcome = { kind: "asked" | "done" | "incomplete"; detail: string };

export const branchFor = (t: Ticket) => `agent/issue-${t.number}`;

// We render the whole issue, including prior Q&A, into the prompt so every
// run is self-contained. A human reply + a re-run is our "resume".
export function buildPrompt(t: Ticket, cfg: WorkerConfig) {
  const thread = t.comments.map((c) => `[${c.at}] ${c.fromBot ? "BOT" : `HUMAN @${c.author}`}: ${c.text}`).join("\n");
  const skill = cfg.tracker.platform === "github" ? "github-pr" : "gitlab-mr";
  return `You are working ${cfg.tracker.platform} issue #${t.number} "${t.title}" (${t.url}).

<issue_body>
${t.body || "(empty)"}
</issue_body>

<comment_thread>
${thread || "(no comments yet)"}
</comment_thread>

Repository: ${cfg.repo.cloneUrl} (default branch ${cfg.repo.defaultBranch}). This is the project the
issue was filed on, and also the source of your own worker image. Work here unless the issue names another repo.
Branch: ${branchFor(t)}
Open the ${cfg.tracker.platform === "github" ? "PR" : "MR"} with the \`${skill}\` skill.`;
}

export async function runTicket(t: Ticket, cfg: WorkerConfig): Promise<Outcome> {
  let outcome: Outcome = { kind: "incomplete", detail: "Agent stopped without asking or finishing." };

  const ticketTools = createSdkMcpServer({
    name: "ticket",
    version: "1.0.0",
    tools: [
      tool("ask_question", "Post a clarifying question on the issue and mark it blocked. Stop working after calling this.",
        { question: z.string() },
        async ({ question }) => {
          await cfg.tracker.comment(question);
          await cfg.tracker.setState("blocked");
          outcome = { kind: "asked", detail: question };
          return { content: [{ type: "text", text: "Question posted. End your turn now." }] };
        }),
      tool("finish", "Report completed work on the issue and mark it for review.",
        { summary: z.string(), mr_url: z.string() },
        async ({ summary, mr_url }) => {
          await cfg.tracker.comment(`${summary}\n\nReview: ${mr_url}`);
          await cfg.tracker.setState("review");
          outcome = { kind: "done", detail: mr_url };
          return { content: [{ type: "text", text: "Issue updated. You're done." }] };
        }),
    ],
  });

  // Custom SDK tools want streaming input, so we yield our single prompt.
  async function* prompt() {
    yield { type: "user" as const, message: { role: "user" as const, content: buildPrompt(t, cfg) }, parent_tool_use_id: null };
  }

  for await (const msg of query({
    prompt: prompt(),
    options: {
      cwd: cfg.workDir,
      model: cfg.model,
      maxTurns: cfg.maxTurns,
      mcpServers: { ticket: ticketTools },
      // Our house rules come from ~/.claude/CLAUDE.md; skills/agents/hooks from our plugin.
      plugins: [{ type: "local", path: cfg.pluginDir }],
      // The container is our sandbox; nobody is around to approve prompts.
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      systemPrompt: { type: "preset", preset: "claude_code" },
    },
  })) {
    if (msg.type === "assistant") {
      for (const b of msg.message.content) {
        if (b.type === "text") console.log(`[claude] ${b.text}`);
        if (b.type === "tool_use") console.log(`[tool] ${b.name} ${JSON.stringify(b.input).slice(0, 200)}`);
      }
    }
    if (msg.type === "result") console.log(`[result] ${msg.subtype} turns=${msg.num_turns} cost=$${msg.total_cost_usd.toFixed(2)}`);
  }
  return outcome;
}
