# Task Orchestrator Worker Image
#
# Runs one task in an isolated container, executing Codex SDK + doctor loop.

FROM node:20-bookworm AS build

WORKDIR /app

# System dependencies commonly required by doctor commands
RUN apt-get update && apt-get install -y \
    git \
    python3 \
    python3-pip \
    python3-venv \
    make \
    curl \
    jq \
  && rm -rf /var/lib/apt/lists/*

COPY package.json ./
# If you use a lockfile, copy it here for deterministic builds:
# COPY package-lock.json ./

RUN npm install

COPY tsconfig.json ./
COPY src ./src
COPY worker ./worker

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

COPY package.json ./
# COPY package-lock.json ./

RUN npm install --omit=dev

COPY --from=build /app/dist ./dist

# Default workspace mount point
WORKDIR /workspace

# Worker entrypoint (orchestrator supplies env vars)
CMD ["node", "/app/dist/worker/index.js"]
