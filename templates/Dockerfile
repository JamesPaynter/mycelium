# Mycelium Worker Image
#
# Base image for running the Codex worker loop inside Docker.
# Includes system dependencies often needed by doctor/bootstrap commands,
# installs the Codex CLI, and bundles the built worker from this repo.

FROM node:20-bookworm AS build

WORKDIR /app

# System dependencies required during build and runtime
RUN apt-get update && apt-get install -y \
    git \
    python3 \
    python3-pip \
    python3-venv \
    make \
    curl \
    jq \
    ripgrep \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json tsconfig.json ./
COPY index.ts ./
COPY src ./src
COPY scripts ./scripts
COPY templates ./templates
COPY worker ./worker

RUN npm ci
RUN npm --prefix src/ui/grove install
RUN npm run build
RUN ln -s ../templates dist/templates || true


FROM node:20-bookworm

WORKDIR /app

RUN apt-get update && apt-get install -y \
    git \
    python3 \
    python3-pip \
    python3-venv \
    make \
    curl \
    jq \
    ripgrep \
  && rm -rf /var/lib/apt/lists/*

# Install Codex CLI for ad-hoc debugging and manual runs
RUN npm install -g @openai/codex
RUN corepack enable && corepack prepare pnpm@latest --activate

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist
COPY --from=build /app/templates ./templates
COPY bin ./bin

# Ensure mycelium CLI is discoverable even if PATH is reset by subprocesses.
RUN ln -s /app/bin/mycelium /usr/local/bin/mycelium

# Create non-root user for worker processes
RUN if ! id -u worker >/dev/null 2>&1; then useradd -m -s /bin/bash worker; fi \
  && mkdir -p /workspace \
  && chown -R worker:worker /workspace

USER worker
ENV HOME=/home/worker
ENV PATH="/app/bin:${PATH}"

# Default workspace mount point
WORKDIR /workspace

# Worker entrypoint (Mycelium passes env vars and mounts)
CMD ["node", "/app/dist/worker/index.js"]
