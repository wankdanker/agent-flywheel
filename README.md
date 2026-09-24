# Agent Flywheel

A minimal Claude agent that works issues on the project it lives in. That includes
issues about itself.

1. CI builds this repo into a Docker image in the project's own registry.
2. You label an issue `agent`, and CI runs that image on the issue.
3. The agent clones this repo, makes the change, and opens an MR/PR.
4. You merge it. CI builds a new image, and the agent now has the new ability.

Start small ("add a Notion integration", "add a Python toolchain") and let it grow itself.

The same repo works on GitHub (`.github/workflows/`) and GitLab (`.gitlab-ci.yml` +
`.gitlab/ci/`). Each platform ignores the other's files.

## How an issue flows

- **Label `agent`:** a run starts.
- **Status labels:** the agent sets `agent/working`, then either:
  - `agent/blocked`, when it asked a question or ran out of turns, or
  - `agent/review`, when it opened an MR/PR.
- **Reply on the issue:** a new run reads the whole thread and continues on branch `agent/issue-<n>`.
- **State:** there is none besides the issue and the git remote. Every run is a fresh container.
  CI does cache the work dir per issue, so a run that dies partway usually resumes from its
  existing clone instead of starting over, but that cache isn't guaranteed to survive.

Only trusted people can start a run:
- **Labels:** GitHub needs triage access and GitLab needs Reporter+.
- **Comments:** GitHub needs owner, member or collaborator. GitLab needs Developer+.

This matters because the agent runs with permissions bypassed and holds your secrets.

Exit codes are 0 done, 10 asked a question, 1 incomplete, 2 bad config. CI treats 10 as a success.

## Image versions and rollback

| Push to | Tags |
|---|---|
| Default branch | `:latest`, `:sha-<short>` |
| Git tag | `:<tag>` |
| Other branch | `:<branch>` |

Issues run on `AGENT_IMAGE` if you set it, otherwise on `:latest`. If a merged change breaks
the agent, it can't fix itself. Pin `AGENT_IMAGE` to the last good `:sha-…` until it's fixed.

To try an image change before merging, run a single issue on the branch's image:
- **GitHub:** the `image` input of the *agent* workflow.
- **GitLab:** `AGENT_IMAGE` on a manual pipeline run.

## Set up on GitHub

1. Push this repo to GitHub.
2. Add the `ANTHROPIC_API_KEY` repository secret, or `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`.
3. *Actions → build → Run workflow* to make the first image.
4. Create an `agent` label, open an issue, and apply the label.

Optional settings:
- **Variables:** `AGENT_IMAGE`, `CLAUDE_MODEL`, `MAX_TURNS`.
- **`AGENT_GH_TOKEN` secret:** a PAT or GitHub App token. The built-in `GITHUB_TOKEN` can't
  change `.github/workflows/`, and PRs it opens don't start CI. Merging still builds the image,
  because the merge is yours.

## Set up on GitLab

1. Push this repo. The push pipeline builds `:latest`.
2. Create a project access token with `api` + `write_repository` and the Developer role.
3. Add CI/CD variables, masked:
   - `AGENT_GITLAB_TOKEN`: the token from step 2.
   - `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`.
   - Optional: `AGENT_IMAGE`, `CLAUDE_MODEL`, `MAX_TURNS`.
4. *Settings → CI/CD → Pipeline trigger tokens*: create a token.
5. *Settings → Webhooks*: add
   `https://<host>/api/v4/projects/<id>/trigger/pipeline?token=<trigger token>&ref=<default branch>`,
   with **Issues events** and **Comments** enabled.
6. Create an `agent` label, open an issue, and apply the label.

Every issue event starts a small dispatch pipeline. `bin/dispatch-gitlab.ts` drops the events
that don't need a run. To run one issue by hand, use *Run pipeline* with `ISSUE=<iid>`.

## Run locally

    docker build -t agent-flywheel .
    cp .env.example .env   # fill in
    docker run --rm --env-file .env agent-flywheel

Need Docker inside issues? Hand the container the host socket. Only do this for trusted
issues, because it is root-equivalent on the host.

    docker run --rm --env-file .env \
      -v /var/run/docker.sock:/var/run/docker.sock \
      --group-add "$(stat -c %g /var/run/docker.sock)" \
      agent-flywheel

## The agent's own knowledge (`agent/`)

- `agent/CLAUDE.md` is baked to `~/.claude/CLAUDE.md`. It holds the always-on house rules. Keep it short.
- `agent/plugin/` is loaded via the SDK `plugins` option:
  - skills under `skills/<name>/SKILL.md`,
  - subagents under `agents/`,
  - hooks in `hooks/hooks.json`.

  Skills load on demand from their `description`, so they cost almost nothing until used.
- Each cloned repo's own `CLAUDE.md` still applies on top of these.
