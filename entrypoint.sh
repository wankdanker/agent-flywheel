#!/usr/bin/env bash
set -euo pipefail

# Run as an arbitrary uid (`docker run --user "$(id -u):$(id -g)"`, which CI does with workspace
# persistence, see bin/persist.sh), there's no passwd entry, so HOME is `/`, which that uid can't
# write. Claude Code needs a writable ~/.claude, so start a fresh HOME from the image's own one
# (our CLAUDE.md house rules).
if [ ! -w "${HOME:-/}" ]; then
  HOME="$(mktemp -d)"
  export HOME
  cp -R /home/node/.claude "$HOME/.claude"
fi

# No global git credential is set up here on purpose: the same process that later runs the
# model's bash tool calls (bypassPermissions) would be able to read a token embedded in
# git config just as easily as from an env var. run-ticket.ts clones the repo itself, before
# the agent's shell starts, using a token scoped to that one `git` subprocess (see
# src/clone.ts) instead of a config entry that would linger for the whole container's life.
git config --global user.name  "${GIT_AUTHOR_NAME:-Agent Flywheel}"
git config --global user.email "${GIT_AUTHOR_EMAIL:-agent-flywheel@users.noreply.localhost}"
# WORK_DIR may be a cache restored by CI onto a bind mount owned by a different uid
# (e.g. the GitHub Actions runner user); git refuses to touch those by default.
git config --global --add safe.directory "*"

# `--smoke`: one real model turn through the same proxy path, no issue (see src/smoke.ts).
if [ "${1:-}" = "--smoke" ]; then shift; exec node /opt/agent/bin/smoke.ts "$@"; fi
# `--stage prepare|agent|publish`: one CI job's third of a run, with only that stage's
# credential (see src/stages.ts); no args runs all three in this one container.
exec node /opt/agent/bin/run-ticket.ts "$@"
