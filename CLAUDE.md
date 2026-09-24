# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Agent Flywheel is a Docker image that works one issue per container run with the Claude Agent SDK, then opens an MR/PR. The issues are on the same GitHub or GitLab project the repo lives in. The repo is self-hosting: the agent usually changes this repo, and merging rebuilds its own image. See README.md for setup and the issue lifecycle.

It's stateless. The only state is:
- the issue: body, comment thread, and labels (`agent` to opt in; `agent/working|blocked|review` for status);
- the branch `agent/issue-<n>` on the remote;
- the work dir (clones, in-progress edits), which CI caches per issue so a run that dies
  partway can resume from it. It's not guaranteed to survive, so treat it as an optimization,
  not state to depend on.

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
  - namespaces the work dir as `<WORK_DIR>/issue-<n>`, so a `WORK_DIR` shared across issues
    (e.g. a CI cache mount) can't let two issues' clones collide;
  - runs the worker;
  - maps the outcome to an exit code: 0 done, 10 asked a question, 1 incomplete, 2 bad config. Both CIs treat 10 as success.
- `src/tracker.ts` holds the platform-neutral `Tracker` interface, the label names, and `BOT_MARKER`. The marker is a hidden HTML comment that tags our own comments, which is how both CIs avoid re-triggering on them. `withMarker` also prepends `BOT_BADGE`, a visible "🤖 Agent Flywheel" line, since a comment posted with a personal access token (`AGENT_GH_TOKEN`/`AGENT_GITLAB_TOKEN`) otherwise shows up as that token's owner with no sign it's from the agent.
- `src/github.ts` and `src/gitlab.ts` are REST adapters built on plain `fetch`.
- `src/worker.ts` renders the issue and its thread into one prompt, then runs `query()` with:
  - `bypassPermissions`;
  - our plugin;
  - an in-process MCP server with `ask_question` (→ blocked) and `finish` (→ review).

  If the agent calls neither tool, the outcome is `incomplete`.
- CI on each platform:
  - **GitHub:** `.github/workflows/agent.yml` gates on the label and the commenter's association, then `docker run`s the image on a plain runner. The work dir is an `actions/cache`-backed host dir bind-mounted to `/work`; its owner is chowned to the image's user (looked up at run time) before each run, since the cache round-trip doesn't preserve uid.
  - **GitLab:** an issue webhook hits the trigger API. `.gitlab/ci/agent.yml` runs `bin/dispatch-gitlab.ts` on stock `node:24-slim` with **no `npm install`**. The dispatcher filters the `TRIGGER_PAYLOAD` event and emits a child pipeline that runs the image, with a native GitLab `cache:` (`when: always`, so a failed run still saves) on `WORK_DIR`.

  Keep `bin/dispatch-gitlab.ts` and `src/tracker.ts` free of npm dependencies.
- `.gitlab-ci.yml` only declares stages and includes `.gitlab/ci/*.yml`. Put new GitLab jobs in their own file there.
- `labels.json` at the repo root is the platform-neutral source of truth for issue labels (name,
  color, description). `bin/sync-labels.ts` applies it via each platform's REST API: the `labels`
  job in `.github/workflows/build.yml`, and `.gitlab/ci/labels.yml`, both on pushes to the default
  branch. It creates missing labels and fixes drift; it only deletes labels absent from the file
  when `labels.json` sets `"prune": true`, since deleting a label also strips it from every issue
  that has it. Keep `bin/sync-labels.ts` free of npm dependencies, same as the dispatcher.

## `agent/` holds the bot's instructions, not yours

- `agent/CLAUDE.md` is baked into the image as `/home/node/.claude/CLAUDE.md`. It holds the house rules for the unattended agent.
- `agent/plugin/` is loaded via the SDK `plugins` option. It contains the skills `gitlab-mr` (push options) and `github-pr` (`gh`).

## Docker notes

- The image runs as `node`, because Claude Code refuses to bypass permissions as root. Repos are cloned under `/work/issue-<n>` (`WORK_DIR` defaults to `/work`; see `bin/run-ticket.ts`).
- `npm ci` must keep optional dependencies, because the SDK's native `claude` binary ships in them.
- Add toolchain packages the agent needs to the Dockerfile, not at runtime.
- `entrypoint.sh` sets `git config --global safe.directory '*'`, because a cached work dir can come
  back owned by a different uid than the one that wrote it (the CI cache round-trip, on GitHub
  especially), and git otherwise refuses to touch it.
