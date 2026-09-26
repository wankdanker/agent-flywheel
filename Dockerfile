# Our agent worker: a general-purpose dev toolchain + Claude Agent SDK.
# Node 24 runs our .ts directly (native type stripping), so no build step.
FROM node:24-bookworm

# Toolchain we expect most tickets to need; extend here rather than per-run installs.
# docker CLI for tickets that need Docker; gh for opening PRs on GitHub.
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential cmake pkg-config git curl ca-certificates jq python3 python3-pip \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
 && echo "deb [signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" \
      > /etc/apt/sources.list.d/docker.list \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends \
      docker-ce-cli docker-buildx-plugin docker-compose-plugin gh \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /opt/agent
COPY package.json package-lock.json ./
# Optional deps must stay on: that's where the SDK's native claude binary lives. npm installs
# both the glibc and musl builds (~220 MB each); we're on Debian (glibc), so drop the musl one.
RUN npm ci --omit=dev && rm -rf node_modules/@anthropic-ai/claude-agent-sdk-linux-*-musl
COPY src ./src
COPY bin ./bin
COPY --chmod=755 entrypoint.sh ./
# Our accumulated agent knowledge: plugin (skills, agents, hooks) + user-level CLAUDE.md.
COPY agent ./agent
COPY --chown=node:node agent/CLAUDE.md /home/node/.claude/CLAUDE.md

# Claude Code won't bypass permissions as root, and we don't want it root anyway.
RUN mkdir -p /work && chown node:node /work
USER node
ENTRYPOINT ["/opt/agent/entrypoint.sh"]
