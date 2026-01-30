import { create } from "zustand";

import {
  BLOOM_POS,
  IDLE_BEFORE_DESPAWN_MS,
  MAX_VISIBLE_AGENTS,
  MOVE_TRANSITION_MS,
  MIN_MOVE_DURATION_MS,
  SPEECH_BUBBLE_DURATION_MS,
  WALK_SPEED_PERCENT_PER_SEC,
  WANDER_MAX_MS,
  WANDER_MIN_MS,
} from "../lib/constants";
import {
  directionFromPoints,
  nearestExitPoint,
  rand,
  randomEdgeSpawn,
  randomPointInBounds,
  type Direction8,
} from "../lib/geometry";

export type Role = "bloom" | "planner" | "worker" | "auditor";
export type AgentState = "idle" | "walking";
export type BubbleKind = "speech" | "thought";

export interface Agent {
  id: string;
  role: Role;
  state: AgentState;
  action: string; // used for sprite selection (configurable)
  x: number;
  y: number;
  heading: Direction8;
  moveDurationMs: number;
  moveToken: number;
  lastActiveAt: number;
  nextWanderAt: number;
  isLeaving: boolean;

  taskId?: string;
  batchId?: string;
  validatorName?: string;
}

export interface SpeechBubble {
  id: string;
  agentId: string;
  kind: BubbleKind;
  text: string;
  createdAt: number;
}

export interface GroveState {
  agents: Agent[];
  bubbles: SpeechBubble[];

  resetForRun: () => void;

  processEvents: (events: any[]) => void;
  tick: () => void;

  showBubble: (agentId: string, kind: BubbleKind, text: string) => void;
  touchAgent: (agentId: string) => void;
  setAgentAction: (agentId: string, action: string) => void;

  spawnPlanner: (batchId?: string) => Agent | null;
  spawnAuditor: (validatorName?: string) => Agent | null;
  spawnWorker: (taskId: string) => Agent | null;

  moveAgent: (agentId: string, x: number, y: number) => void;
  startLeaving: (agentId: string) => void;
}

function makeId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}-${Date.now().toString(36)}`;
}

function roleLabel(role: Role): string {
  switch (role) {
    case "bloom":
      return "Bloom";
    case "planner":
      return "Planner";
    case "worker":
      return "Worker";
    case "auditor":
      return "Auditor";
  }
}

function randomWanderDelayMs(): number {
  return Math.floor(rand(WANDER_MIN_MS, WANDER_MAX_MS));
}

function truncate(text: string, maxLen = 60): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(0, maxLen - 1))}…`;
}

function getTaskId(ev: any): string | null {
  return (
    ev?.task_id ??
    ev?.taskId ??
    ev?.payload?.task_id ??
    ev?.payload?.taskId ??
    ev?.payload?.payload?.task_id ??
    null
  );
}

function getBatchId(ev: any): string | null {
  return (
    ev?.batch_id ??
    ev?.batchId ??
    ev?.payload?.batch_id ??
    ev?.payload?.batchId ??
    ev?.payload?.batch?.id ??
    null
  );
}

function getValidatorName(ev: any): string | null {
  return (
    ev?.validator ??
    ev?.validator_name ??
    ev?.validatorName ??
    ev?.payload?.validator_name ??
    ev?.payload?.validatorName ??
    ev?.payload?.name ??
    ev?.payload?.validator ??
    null
  );
}

function getFailureReason(ev: any): string | null {
  const fromPayload =
    ev?.payload?.reason ?? ev?.payload?.error ?? ev?.payload?.message ?? ev?.payload?.summary;
  if (typeof fromPayload === "string" && fromPayload.trim()) return fromPayload.trim();
  if (typeof ev?.reason === "string" && ev.reason.trim()) return ev.reason.trim();
  return null;
}

function classifyWorkerEvent(
  type: string,
  ev: any,
): { kind: BubbleKind; action: string; text: string } | null {
  const normalized = type.toLowerCase();

  if (normalized === "worker.start") {
    return { kind: "speech", action: "idle", text: "Starting" };
  }

  if (normalized.startsWith("bootstrap.")) {
    return { kind: "speech", action: "bootstrap", text: "Bootstrapping…" };
  }

  if (normalized.startsWith("git.")) {
    if (normalized === "git.commit" || normalized.startsWith("git.commit."))
      return { kind: "speech", action: "git", text: "Commit" };
    if (normalized === "git.checkpoint" || normalized.startsWith("git.checkpoint"))
      return { kind: "speech", action: "git", text: "Checkpoint" };
    return { kind: "speech", action: "git", text: "Git" };
  }

  if (normalized.startsWith("lint.")) {
    if (normalized === "lint.pass") return { kind: "speech", action: "lint", text: "Lint passed" };
    if (normalized === "lint.fail") return { kind: "speech", action: "lint", text: "Lint failed" };
    return { kind: "speech", action: "lint", text: "Linting…" };
  }

  if (normalized.startsWith("doctor.")) {
    if (normalized === "doctor.pass")
      return { kind: "speech", action: "doctor", text: "Doctor passed" };
    if (normalized === "doctor.fail")
      return { kind: "speech", action: "doctor", text: "Doctor failed" };
    return { kind: "speech", action: "doctor", text: "Doctor…" };
  }

  if (normalized.startsWith("tdd.stage.")) {
    const stage = ev?.payload?.stage ?? ev?.payload?.stage_name ?? ev?.payload?.name ?? "";
    const label = stage ? `TDD ${stage}` : "TDD";
    return { kind: "thought", action: "test", text: label };
  }

  if (
    normalized.startsWith("codex.") ||
    normalized.startsWith("turn.") ||
    normalized.startsWith("agent.") ||
    normalized.startsWith("llm.") ||
    normalized.startsWith("mock.")
  ) {
    return { kind: "thought", action: "thinking", text: "Thinking…" };
  }

  if (normalized === "task.retry") {
    const attempt = ev?.attempt ?? ev?.payload?.attempt;
    return {
      kind: "speech",
      action: "coding",
      text: attempt ? `Retrying (attempt ${attempt})` : "Retrying…",
    };
  }

  if (normalized === "task.complete") {
    return { kind: "speech", action: "celebrate", text: "Done" };
  }

  if (normalized === "task.failed") {
    const reason = getFailureReason(ev) ?? "Failed";
    return { kind: "speech", action: "error", text: truncate(reason, 70) };
  }

  return null;
}

function classifyOrchestratorTaskEvent(
  type: string,
  ev: any,
): { kind: BubbleKind; action: string; text: string } | null {
  const normalized = type.toLowerCase();

  if (normalized.startsWith("workspace.prepare.")) {
    return { kind: "speech", action: "bootstrap", text: "Preparing workspace" };
  }
  if (normalized === "task.stage.move") {
    return { kind: "speech", action: "coding", text: "Working…" };
  }
  if (normalized === "task.blast_radius") {
    return { kind: "thought", action: "thinking", text: "Assessing changes" };
  }
  if (normalized === "task.complete") {
    return { kind: "speech", action: "celebrate", text: "Done" };
  }
  if (normalized === "task.failed") {
    const reason = getFailureReason(ev) ?? "Failed";
    return { kind: "speech", action: "error", text: truncate(reason, 70) };
  }
  if (normalized === "task.reset") {
    return { kind: "speech", action: "idle", text: "Reset" };
  }

  return null;
}

function classifyPlannerEvent(
  type: string,
): { kind: BubbleKind; action: string; text: string } | null {
  const normalized = type.toLowerCase();
  if (normalized === "batch.start")
    return { kind: "speech", action: "planning", text: "Batch start" };
  if (normalized === "batch.dry_run")
    return { kind: "thought", action: "planning", text: "Dry run" };
  if (normalized === "batch.merging")
    return { kind: "speech", action: "merging", text: "Merging…" };
  if (normalized === "batch.merge_conflict")
    return { kind: "speech", action: "error", text: "Merge conflict" };
  if (normalized === "batch.complete")
    return { kind: "speech", action: "idle", text: "Batch done" };
  return null;
}

function classifyBloomEvent(
  type: string,
  ev: any,
): { kind: BubbleKind; action: string; text: string } | null {
  const normalized = type.toLowerCase();

  if (normalized === "run.start") return { kind: "speech", action: "idle", text: "Run started" };
  if (normalized === "run.resume") return { kind: "speech", action: "idle", text: "Resumed" };
  if (normalized === "run.paused") return { kind: "speech", action: "blocked", text: "Paused" };
  if (normalized === "run.blocked") {
    const reason = ev?.payload?.reason ?? ev?.payload?.message;
    return {
      kind: "speech",
      action: "blocked",
      text: reason ? `Blocked: ${truncate(String(reason), 60)}` : "Blocked",
    };
  }
  if (normalized === "run.stop") return { kind: "speech", action: "blocked", text: "Stopped" };
  if (normalized === "run.complete")
    return { kind: "speech", action: "celebrate", text: "Complete" };

  return null;
}

function classifyAuditorEvent(
  type: string,
  ev: any,
): { kind: BubbleKind; action: string; text: string } | null {
  const normalized = type.toLowerCase();

  if (normalized.startsWith("doctor.integration.")) {
    if (normalized.endsWith(".start"))
      return { kind: "speech", action: "test", text: "Integration tests" };
    if (normalized.endsWith(".fail"))
      return { kind: "speech", action: "error", text: "Integration failed" };
    if (normalized.endsWith(".pass"))
      return { kind: "speech", action: "test", text: "Integration passed" };
    return { kind: "speech", action: "test", text: "Integration" };
  }

  if (normalized.startsWith("doctor.canary.")) {
    if (normalized.endsWith(".start"))
      return { kind: "speech", action: "test", text: "Doctor canary" };
    if (normalized.includes("fail"))
      return { kind: "speech", action: "error", text: "Canary failed" };
    return { kind: "speech", action: "test", text: "Canary" };
  }

  if (normalized === "validator.block") {
    const name = getValidatorName(ev) ?? "Validator";
    return { kind: "speech", action: "blocked", text: `${name} blocked` };
  }

  if (normalized.startsWith("ledger.write.")) {
    if (normalized.endsWith(".start"))
      return { kind: "thought", action: "thinking", text: "Writing ledger…" };
    if (normalized.endsWith(".complete"))
      return { kind: "speech", action: "idle", text: "Ledger written" };
    if (normalized.endsWith(".error"))
      return { kind: "speech", action: "error", text: "Ledger error" };
    return { kind: "thought", action: "thinking", text: "Ledger…" };
  }

  return null;
}

export const useGroveStore = create<GroveState>((set, get) => {
  const now = Date.now();

  const bloom: Agent = {
    id: "bloom",
    role: "bloom",
    state: "idle",
    action: "idle",
    x: BLOOM_POS.x,
    y: BLOOM_POS.y,
    heading: "south",
    moveDurationMs: MOVE_TRANSITION_MS,
    moveToken: now,
    lastActiveAt: now,
    nextWanderAt: now + randomWanderDelayMs(),
    isLeaving: false,
  };

  function canSpawnMore(): boolean {
    return get().agents.length < MAX_VISIBLE_AGENTS;
  }

  function updateAgent(agentId: string, patch: Partial<Agent>): void {
    set((state) => ({
      agents: state.agents.map((a) => (a.id === agentId ? { ...a, ...patch } : a)),
    }));
  }

  function findWorker(taskId: string): Agent | undefined {
    return get().agents.find((a) => a.role === "worker" && a.taskId === taskId);
  }

  function findPlannerForBatch(batchId: string): Agent | undefined {
    return get().agents.find((a) => a.role === "planner" && a.batchId === batchId);
  }

  function findReusablePlanner(): Agent | undefined {
    return get().agents.find(
      (a) => a.role === "planner" && !a.isLeaving && a.state === "idle" && !a.batchId,
    );
  }

  function findAuditorForValidator(validatorName: string): Agent | undefined {
    return get().agents.find((a) => a.role === "auditor" && a.validatorName === validatorName);
  }

  function findReusableAuditor(): Agent | undefined {
    return get().agents.find(
      (a) => a.role === "auditor" && !a.isLeaving && a.state === "idle" && !a.validatorName,
    );
  }

  return {
    agents: [bloom],
    bubbles: [],

    resetForRun: () => {
      const now2 = Date.now();
      set(() => ({
        agents: [
          {
            ...bloom,
            x: BLOOM_POS.x,
            y: BLOOM_POS.y,
            heading: "south",
            moveDurationMs: MOVE_TRANSITION_MS,
            lastActiveAt: now2,
            moveToken: now2,
            nextWanderAt: now2 + randomWanderDelayMs(),
            isLeaving: false,
            action: "idle",
          },
        ],
        bubbles: [],
      }));
    },

    showBubble: (agentId, kind, text) => {
      const now2 = Date.now();
      const bubbleId = makeId("bubble");
      const safeText = truncate(text, 90);

      set((state) => {
        const remaining = state.bubbles.filter((b) => b.agentId !== agentId);
        return {
          bubbles: [...remaining, { id: bubbleId, agentId, kind, text: safeText, createdAt: now2 }],
        };
      });

      window.setTimeout(() => {
        set((state) => ({ bubbles: state.bubbles.filter((b) => b.id !== bubbleId) }));
      }, SPEECH_BUBBLE_DURATION_MS);
    },

    touchAgent: (agentId) => {
      const now2 = Date.now();
      updateAgent(agentId, {
        lastActiveAt: now2,
        nextWanderAt: now2 + randomWanderDelayMs(),
      });
    },

    setAgentAction: (agentId, action) => {
      updateAgent(agentId, { action });
    },

    spawnPlanner: (batchId) => {
      if (!canSpawnMore()) return null;

      const existing = batchId ? findPlannerForBatch(batchId) : undefined;
      if (existing) {
        updateAgent(existing.id, { lastActiveAt: Date.now(), batchId });
        return existing;
      }

      const reusable = findReusablePlanner();
      if (reusable) {
        updateAgent(reusable.id, { lastActiveAt: Date.now(), batchId, action: "planning" });
        return reusable;
      }

      const spawn = randomEdgeSpawn();
      const agent: Agent = {
        id: makeId("planner"),
        role: "planner",
        state: "idle",
        action: "planning",
        x: spawn.x,
        y: spawn.y,
        heading: spawn.heading,
        moveDurationMs: MOVE_TRANSITION_MS,
        moveToken: Date.now(),
        lastActiveAt: Date.now(),
        nextWanderAt: Date.now() + randomWanderDelayMs(),
        isLeaving: false,
        batchId,
      };

      set((state) => ({ agents: [...state.agents, agent] }));
      return agent;
    },

    spawnAuditor: (validatorName) => {
      if (!canSpawnMore()) return null;

      const existing = validatorName ? findAuditorForValidator(validatorName) : undefined;
      if (existing) {
        updateAgent(existing.id, { lastActiveAt: Date.now(), validatorName });
        return existing;
      }

      const reusable = findReusableAuditor();
      if (reusable) {
        updateAgent(reusable.id, { lastActiveAt: Date.now(), validatorName, action: "test" });
        return reusable;
      }

      const spawn = randomEdgeSpawn();
      const agent: Agent = {
        id: makeId("auditor"),
        role: "auditor",
        state: "idle",
        action: "test",
        x: spawn.x,
        y: spawn.y,
        heading: spawn.heading,
        moveDurationMs: MOVE_TRANSITION_MS,
        moveToken: Date.now(),
        lastActiveAt: Date.now(),
        nextWanderAt: Date.now() + randomWanderDelayMs(),
        isLeaving: false,
        validatorName,
      };

      set((state) => ({ agents: [...state.agents, agent] }));
      return agent;
    },

    spawnWorker: (taskId) => {
      if (!canSpawnMore()) return null;

      const existing = findWorker(taskId);
      if (existing) {
        updateAgent(existing.id, { lastActiveAt: Date.now(), taskId, isLeaving: false });
        return existing;
      }

      const spawn = randomEdgeSpawn();
      const agent: Agent = {
        id: makeId("worker"),
        role: "worker",
        state: "idle",
        action: "idle",
        x: spawn.x,
        y: spawn.y,
        heading: spawn.heading,
        moveDurationMs: MOVE_TRANSITION_MS,
        moveToken: Date.now(),
        lastActiveAt: Date.now(),
        nextWanderAt: Date.now() + randomWanderDelayMs(),
        isLeaving: false,
        taskId,
      };

      set((state) => ({ agents: [...state.agents, agent] }));
      return agent;
    },

    moveAgent: (agentId, x, y) => {
      const state = get();
      const agent = state.agents.find((a) => a.id === agentId);
      if (!agent) return;

      const moveToken = Date.now();
      const dx = x - agent.x;
      const dy = y - agent.y;
      const distance = Math.max(1e-3, Math.hypot(dx, dy));
      const durationMs = Math.max(
        MIN_MOVE_DURATION_MS,
        (distance / WALK_SPEED_PERCENT_PER_SEC) * 1000,
      );

      updateAgent(agentId, {
        x,
        y,
        state: "walking",
        heading: directionFromPoints({ x: agent.x, y: agent.y }, { x, y }),
        moveDurationMs: durationMs,
        moveToken,
      });

      window.setTimeout(() => {
        const latest = get().agents.find((a) => a.id === agentId);
        if (!latest) return;
        if (latest.moveToken !== moveToken) return;
        updateAgent(agentId, { state: "idle" });
      }, durationMs);
    },

    startLeaving: (agentId) => {
      const agent = get().agents.find((a) => a.id === agentId);
      if (!agent) return;
      if (agent.role === "bloom") return;

      const exit = nearestExitPoint({ x: agent.x, y: agent.y });
      updateAgent(agentId, { isLeaving: true, nextWanderAt: Number.POSITIVE_INFINITY });
      get().moveAgent(agentId, exit.x, exit.y);

      window.setTimeout(() => {
        set((state) => ({ agents: state.agents.filter((a) => a.id !== agentId) }));
      }, agent.moveDurationMs + 250);
    },

    processEvents: (events) => {
      if (!Array.isArray(events) || events.length === 0) return;

      for (const ev of events) {
        const type = String(ev?.type || "");
        if (!type) continue;

        // Bloom (run-level)
        const bloomUpdate = classifyBloomEvent(type, ev);
        if (bloomUpdate) {
          get().touchAgent("bloom");
          get().setAgentAction("bloom", bloomUpdate.action);
          get().showBubble("bloom", bloomUpdate.kind, bloomUpdate.text);
          continue;
        }

        // Planner (batch-level)
        if (type.toLowerCase().startsWith("batch.")) {
          const batchId = getBatchId(ev) || "batch";
          const planner = get().spawnPlanner(String(batchId));
          if (planner) {
            const upd = classifyPlannerEvent(type) ?? {
              kind: "speech",
              action: "planning",
              text: `Batch ${batchId}`,
            };
            get().touchAgent(planner.id);
            get().setAgentAction(planner.id, upd.action);
            get().showBubble(
              planner.id,
              upd.kind,
              upd.text.replace("Batch start", `Batch ${batchId}`),
            );
            if (type.toLowerCase() === "batch.complete") {
              updateAgent(planner.id, { batchId: undefined, action: "idle" });
            }
          }
          continue;
        }

        // Auditor (run-level validation / ledger)
        if (
          type.toLowerCase().startsWith("validator.") ||
          type.toLowerCase().startsWith("doctor.integration") ||
          type.toLowerCase().startsWith("doctor.canary") ||
          type.toLowerCase().startsWith("ledger.write")
        ) {
          const name =
            getValidatorName(ev) ||
            (type.toLowerCase().startsWith("doctor") ? "doctor" : "validator");
          const auditor = get().spawnAuditor(String(name));
          if (auditor) {
            const upd = classifyAuditorEvent(type, ev) ?? {
              kind: "speech",
              action: "test",
              text: String(name),
            };
            get().touchAgent(auditor.id);
            get().setAgentAction(auditor.id, upd.action);
            get().showBubble(auditor.id, upd.kind, upd.text);
            if (
              type.toLowerCase().endsWith(".pass") ||
              type.toLowerCase().endsWith(".fail") ||
              type.toLowerCase().endsWith(".complete")
            ) {
              updateAgent(auditor.id, { validatorName: undefined, action: "idle" });
            }
          }
          continue;
        }

        // Worker events (prefer task-id)
        const taskId = getTaskId(ev);
        if (taskId) {
          const worker = get().spawnWorker(String(taskId));
          if (!worker) continue;

          // Determine whether this is orchestrator-level task.* or worker-level
          const upd =
            classifyWorkerEvent(type, ev) ??
            (type.toLowerCase().startsWith("task.") || type.toLowerCase().startsWith("workspace.")
              ? classifyOrchestratorTaskEvent(type, ev)
              : null);

          if (upd) {
            get().touchAgent(worker.id);
            get().setAgentAction(worker.id, upd.action);
            get().showBubble(worker.id, upd.kind, upd.text);
          }
          continue;
        }
      }
    },

    tick: () => {
      const now2 = Date.now();
      const agents = get().agents;

      for (const agent of agents) {
        if (agent.isLeaving) continue;

        const isBloom = agent.role === "bloom";

        if (agent.state === "idle") {
          if (!isBloom) {
            const idleMs = now2 - agent.lastActiveAt;
            if (idleMs >= IDLE_BEFORE_DESPAWN_MS) {
              get().startLeaving(agent.id);
              continue;
            }
          }

          if (now2 >= agent.nextWanderAt) {
            const target = randomPointInBounds();
            updateAgent(agent.id, { nextWanderAt: Number.POSITIVE_INFINITY });
            get().moveAgent(agent.id, target.x, target.y);
          }
        }
      }
    },
  };
});

export function getRoleLabel(role: Role): string {
  return roleLabel(role);
}
