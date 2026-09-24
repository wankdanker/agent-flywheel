# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Agent Flywheel is a Docker image that works one issue per container run with the Claude Agent SDK, then opens an MR/PR. The issues are on the same GitHub or GitLab project the repo lives in. The repo is self-hosting: the agent usually changes this repo, and merging rebuilds its own image. See README.md for setup and the issue lifecycle.

It's stateless. The only state is:
- the issue: body, comment thread, and labels (`agent` to opt in; `agent/working|blocked|review` for status);
- the branch `agent/issue-<n>` on the remote.

## Commands

- `npm run typecheck` runs `tsc -p .`. It is the only static check; there are no tests or linter.
- `docker build -t agent-flywheel . && docker run --rm --env-file .env agent-flywheel` works one issue end to end. See `.env.example`.
- `TRIGGER_PAYLOAD=payload.json CI_REGISTRY_IMAGE=x node bin/dispatch-gitlab.ts` prints the GitLab child-pipeline YAML for a saved webhook payload. Payloads for human comments also call the members API, which needs `CI_API_V4_URL`, `CI_PROJECT_ID` and `AGENT_GITLAB_TOKEN`.

There is no build step: Node 24 runs the `.ts` files directly. So:
- imports use the `.ts` extension;
- type-only imports must be `import type` / `type X`, which `verbatimModuleSyntax` enforces;
- `erasableSyntaxOnly` rules out `enum`, `namespace` and parameter properties.

## Architecture

- `bin/run-ticket.ts` is the container entry, run via `entrypoint.sh`, which first sets up git token auth for `GH_TOKEN` or `AGENT_GITLAB_TOKEN`. It:
  - detects the platform from `AGENT_PLATFORM`, `GITLAB_CI` or `GITHUB_ACTIONS`;
  - builds a `Tracker`;
  - runs the worker;
  - maps the outcome to an exit code: 0 done, 10 asked a question, 1 incomplete, 2 bad config. Both CIs treat 10 as success.
- `src/tracker.ts` holds the platform-neutral `Tracker` interface, the label names, and `BOT_MARKER`. The marker tags our own comments so both CIs (and Notion, via a plain substring match) can tell them apart from a human's; on GitHub/GitLab it's a hidden HTML comment, but Notion has no such syntax so it's visible there.
- `src/github.ts` and `src/gitlab.ts` are REST adapters built on plain `fetch`.
- `src/notion.ts` is a third `Tracker` adapter, also plain `fetch`. Unlike GitHub/GitLab, a
  Notion ticket has no inherent repo and the database schema isn't pinned down, so property
  names/values are read from `NOTION_*` env vars (see `.env.example`) with best-guess
  defaults, and `bin/list-notion-tickets.ts` (a poller) matches values generically across
  property types rather than assuming one. Nothing calls the poller yet: it needs a
  scheduled GitHub Actions workflow that a maintainer adds by hand, since our own PR token
  can't create `.github/workflows/*` files (see README's Notion section). The
  `notion-ticket` skill resolves the target repo per ticket and keeps
  `agent/notion-repo-map.md` current.
- `src/worker.ts` renders the issue and its thread into one prompt, then runs `query()` with:
  - `bypassPermissions`;
  - our plugin;
  - an in-process MCP server with `ask_question` (→ blocked) and `finish` (→ review).

  If the agent calls neither tool, the outcome is `incomplete`.
- CI on each platform:
  - **GitHub:** `.github/workflows/agent.yml` gates on the label and the commenter's association, then `docker run`s the image on a plain runner.
  - **GitLab:** an issue webhook hits the trigger API. `.gitlab/ci/agent.yml` runs `bin/dispatch-gitlab.ts` on stock `node:24-slim` with **no `npm install`**. The dispatcher filters the `TRIGGER_PAYLOAD` event and emits a child pipeline that runs the image.

  Keep `bin/dispatch-gitlab.ts` and `src/tracker.ts` free of npm dependencies.
- `.gitlab-ci.yml` only declares stages and includes `.gitlab/ci/*.yml`. Put new GitLab jobs in their own file there.

## `agent/` holds the bot's instructions, not yours

- `agent/CLAUDE.md` is baked into the image as `/home/node/.claude/CLAUDE.md`. It holds the house rules for the unattended agent.
- `agent/plugin/` is loaded via the SDK `plugins` option. It contains the skills `gitlab-mr` (push options), `github-pr` (`gh`), and `notion-ticket` (resolving a Notion ticket's target repo).
- `agent/notion-repo-map.md` is the bot's own knowledge of which Notion tickets map to which repos, maintained by the `notion-ticket` skill.

## Docker notes

- The image runs as `node`, because Claude Code refuses to bypass permissions as root. Repos are cloned under `/work`.
- `npm ci` must keep optional dependencies, because the SDK's native `claude` binary ships in them.
- Add toolchain packages the agent needs to the Dockerfile, not at runtime.
