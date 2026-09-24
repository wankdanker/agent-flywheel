#!/usr/bin/env bash
set -euo pipefail

# Git auth via token, scoped to our forge's host only.
if [ -n "${GH_TOKEN:-}" ]; then
  host="${GITHUB_SERVER_URL:-https://github.com}"; host="${host#https://}"
  git config --global url."https://x-access-token:${GH_TOKEN}@${host}/".insteadOf "https://${host}/"
fi
if [ -n "${AGENT_GITLAB_TOKEN:-}" ]; then
  git config --global url."https://oauth2:${AGENT_GITLAB_TOKEN}@${CI_SERVER_HOST}/".insteadOf "https://${CI_SERVER_HOST}/"
fi
git config --global user.name  "${GIT_AUTHOR_NAME:-Agent Flywheel}"
git config --global user.email "${GIT_AUTHOR_EMAIL:-agent-flywheel@users.noreply.localhost}"
# WORK_DIR may be a cache restored by CI onto a bind mount owned by a different uid
# (e.g. the GitHub Actions runner user); git refuses to touch those by default.
git config --global --add safe.directory "*"

exec node /opt/agent/bin/run-ticket.ts "$@"
