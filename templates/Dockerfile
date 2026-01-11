# Task Orchestrator Worker Image
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
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
COPY worker ./worker

RUN npm ci
RUN npm run build


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
  && rm -rf /var/lib/apt/lists/*

# Install Codex CLI for ad-hoc debugging and manual runs
RUN npm install -g @openai/codex

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist

# Default workspace mount point
WORKDIR /workspace

# Worker entrypoint (orchestrator passes env vars and mounts)
CMD ["node", "/app/dist/worker/index.js"]
