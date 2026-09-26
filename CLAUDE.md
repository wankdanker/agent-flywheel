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

- `npm run typecheck` runs `tsc -p .`. There is no linter.
- `npm test` runs the `node:test` suite in `test/` (zero extra deps; Node runs the `.test.ts` files directly, same as `src`/`bin`). Both CIs run typecheck + tests before building the image (`test` job in `.github/workflows/build.yml`, `.gitlab/ci/test.yml`), and the image build `needs` it, so a red suite never reaches `:latest`.
- `docker build -t agent-flywheel . && docker run --rm --env-file .env agent-flywheel` works one issue end to end. See `.env.example`.
- `TRIGGER_PAYLOAD=payload.json CI_REGISTRY_IMAGE=x node bin/dispatch-gitlab.ts` prints the GitLab child-pipeline YAML for a saved webhook payload. Payloads for human comments also call the members API, which needs `CI_API_V4_URL`, `CI_PROJECT_ID` and `AGENT_GITLAB_TOKEN`.

There is no build step: Node 24 runs the `.ts` files directly. So:
- imports use the `.ts` extension;
- type-only imports must be `import type` / `type X`, which `verbatimModuleSyntax` enforces;
- `erasableSyntaxOnly` rules out `enum`, `namespace` and parameter properties.

## Architecture

- `bin/run-ticket.ts` is the container entry, run via `entrypoint.sh` (which only sets git identity and `safe.directory`, no credentials — see below). It only blanks out empty env vars and exits with `main()`'s code. `src/run.ts`'s `main()` is the run itself, importable so `test/run.test.ts` drives it with a fake tracker and a fake `runTicket` (every dependency is an optional `RunDeps` seam). It:
  - validates config first (model credential, `MAX_TURNS`, platform env) and returns 2 on a
    `ConfigError` before touching the issue;
  - detects the platform from `AGENT_PLATFORM`, `GITLAB_CI` or `GITHUB_ACTIONS`;
  - builds a `Tracker`;
  - checks the ticket's repo against the allowlist (`src/allowlist.ts`, `AGENT_REPO_ALLOWLIST`,
    defaulting to just `GITHUB_REPOSITORY`/`CI_PROJECT_PATH`) and refuses (exit 2, no clone) if
    it isn't listed;
  - sets `agent/working`, and from there on guarantees a terminal label: everything up to the
    settled outcome runs in a `try/catch`, and if no `review`/`blocked` label landed (tracked by
    `guardTracker`, which also skips a comment identical to one already posted, so retries don't
    repeat it) it posts a `sanitizeError`-scrubbed comment and sets `blocked`, logging (never
    throwing) any failure of those cleanup writes. A `SettlementError` from `applyOutcome` carries
    the outcome the agent reached so a tracker failure never hides it. See README's "Stuck on
    `agent/working`";
  - namespaces the work dir as `<WORK_DIR>/issue-<n>`, so a `WORK_DIR` shared across issues
    (e.g. a CI cache mount) can't let two issues' clones collide;
  - clones (or resumes) that one repo itself via `src/clone.ts`'s `prepareRepo`, before the
    agent's own shell starts, using the forge token only as a `GIT_ASKPASS` scoped to that one
    `git` subprocess — never written to git config, so nothing token-bearing is left for the
    model's bash tool calls (`bypassPermissions`) to read back out of `~/.gitconfig` or
    `.git-credentials`. Re-checks the resulting `origin` URL against the allowlist in case a
    cached work dir predates today's config;
  - starts `src/model-proxy.ts` with the real `ANTHROPIC_API_KEY`/`CLAUDE_CODE_OAUTH_TOKEN`
    and runs the worker with that credential stripped from its env (see README's "Model
    credential exposure"), closing the proxy in a `finally` regardless of outcome;
  - maps the outcome to an exit code: 0 ready for review, 10 blocked (question or split into sub-issues), 1 incomplete or failed, 2 bad config. Both CIs treat 10 as success.
  - Pushing (opening the PR/MR) still happens inside the agent's own shell, via the
    `github-pr`/`gitlab-mr` skills, which pass `GH_TOKEN`/`AGENT_GITLAB_TOKEN` to a one-shot
    `git -c credential.helper=...` on the push command itself rather than persistent config.
    Those env vars are still readable by the agent process; removing that needs splitting
    execution from a separate, privileged publish step, which is future work.
- `src/tracker.ts` holds the platform-neutral `Tracker` interface, the label names, and `BOT_MARKER`. The marker is a hidden HTML comment that tags our own comments, which is how both CIs avoid re-triggering on them. `withMarker` also prepends `BOT_BADGE`, a visible "🤖 Agent Flywheel" line, since a comment posted with a personal access token (`AGENT_GH_TOKEN`/`AGENT_GITLAB_TOKEN`) otherwise shows up as that token's owner with no sign it's from the agent. `toComment` only honors `BOT_MARKER` when the poster is independently trusted (or a GitHub `Bot`-type account) — the marker text alone, e.g. pasted by an attacker, is not enough.
- `src/trust.ts` is the one shared place for "who is trusted": GitHub's `OWNER`/`MEMBER`/`COLLABORATOR` associations, and GitLab's Developer+ membership check (an API call per user id — callers cache it per ticket fetch). `src/gitlab.ts` and `bin/dispatch-gitlab.ts` both call `gitlabMemberTrust` from here rather than duplicating the access-level threshold, so "who can trigger a run" and "whose content the model reads" can't drift apart. Keep it npm-dependency-free like `tracker.ts`.
- `src/github.ts` and `src/gitlab.ts` are REST adapters built on plain `fetch`. Both attach a `Trust` to the issue (from its author) and to every comment (from that comment's author) when building a `Ticket`.
- `src/worker.ts`'s `buildPrompt` renders the issue into a prompt, gated by trust (see README's "Trust model"): a trusted-authored issue's title/body/trusted-thread are used as before; an untrusted-authored issue's title/body are never included, and only trusted human comments (`trustedDirectives`) become the task. `runTicket` short-circuits to `agent/blocked` before ever calling the model when an untrusted-authored issue has no trusted directive yet. It then runs `query()` with:
  - `bypassPermissions`;
  - our plugin;
  - an in-process MCP server with `ask_question`, `finish`, `split_into_subtasks` and
    `report_failure`. None of these tool handlers touch the tracker directly — while the
    agent's turn is running, in the same process that holds the tracker's forge token, they
    only record a structured `AgentOutcome` in memory and return a short confirmation to the
    model. `runTicket` calls `applyOutcome` once the `query()` loop is fully over, which is
    the single place that actually calls `tracker.comment`/`setState`/`createSubIssue`:
    `ask_question` → blocked; `finish` → review; `split_into_subtasks` → blocked, opening
    sub-issues, each carrying the `agent` label so it starts its own run
    (`Tracker#createSubIssue`, one per platform since GitHub and GitLab differ in what makes
    a newly-created issue's label actually fire the trigger); `report_failure` → blocked.

  If the agent calls none of these tools, `applyOutcome` reports `incomplete`. `applyOutcome` attempts every write even when an earlier one fails (so a failed comment still gets the label applied) and then throws a `SettlementError`. If `query()` throws after the agent already recorded an outcome, `runTicket` still applies it.
- `src/model-proxy.ts` is the loopback-only HTTP proxy `bin/run-ticket.ts` puts in front of
  the real model credential (`startModelProxy`, `credentialFromEnv`, `sandboxEnv`; see
  README's "Model credential exposure"). It enforces `maxRequests`/`maxLifetimeMs` (on top
  of `MAX_TURNS`) and a per-request `requestTimeoutMs`, and forwards to
  `upstream ?? DEFAULT_UPSTREAM` so tests can point it at a fake server instead of the real
  API.
- CI on each platform:
  - **GitHub:** `.github/workflows/agent.yml` gates on the label and the commenter's association, then `docker run`s the image on a plain runner. The work dir is an `actions/cache`-backed host dir bind-mounted to `/work` (separate `restore`/`save` steps, the save `if: always()` so a failed run still keeps its work); its owner is chowned to the image's user (looked up at run time) before each run, since the cache round-trip doesn't preserve uid. The per-issue `concurrency` group is on the job, not the workflow, so skipped runs (our own label/comment events) never displace a pending real one.
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
