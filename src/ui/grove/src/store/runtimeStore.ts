import { create } from "zustand";

import { MAX_VISIBLE_AGENTS, POLL_INTERVAL_MS } from "../lib/constants";
import { loadSpriteActionsConfig } from "../lib/spriteConfig";
import { useGroveStore } from "./groveStore";

export type FetchApiFn = (url: string) => Promise<any>;

export type GroveMountOptions = {
  projectName: string;
  runId: string;
  pollingPaused: boolean;
  active: boolean;
  assetBase?: string; // default '/grove'
  fetchApi: FetchApiFn;
};

export type GroveController = {
  setTarget: (projectName: string, runId: string) => void;
  setSummary: (summary: any | null) => void;
  setActive: (active: boolean) => void;
  setPollingPaused: (paused: boolean) => void;
  refresh: () => void;
  reset: () => void;
  unmount: () => void;
};

type Cursor = number | "tail";

type GroveRuntimeState = {
  projectName: string;
  runId: string;
  active: boolean;
  pollingPaused: boolean;
  assetBase: string;
  fetchApi: FetchApiFn | null;

  spriteConfig: any | null;
  lastError: string | null;

  orchestratorCursor: Cursor;
  taskCursors: Record<string, Cursor>;
  activeTaskIds: string[];

  taskStatusById: Record<string, string>;
  runStatus: string | null;

  pollTimerId: number | null;
  tickTimerId: number | null;

  mount: (opts: GroveMountOptions) => void;
  unmount: () => void;

  setTarget: (projectName: string, runId: string) => void;
  setSummary: (summary: any | null) => void;
  setActive: (active: boolean) => void;
  setPollingPaused: (paused: boolean) => void;

  refresh: () => void;
  reset: () => void;

  // internal
  ensureLoops: () => void;
  stopLoops: () => void;
  pollOnce: () => Promise<void>;
};

function normalizeAssetBase(assetBase?: string): string {
  const base = assetBase && assetBase.trim() ? assetBase.trim() : "/grove";
  return base.endsWith("/") ? base.slice(0, -1) : base;
}

function buildOrchestratorEventsUrl(projectName: string, runId: string, cursor: Cursor): string {
  const cursorValue = cursor === "tail" ? "tail" : String(cursor);
  const params = new URLSearchParams({ cursor: cursorValue, maxBytes: String(256_000) });
  return `/api/projects/${encodeURIComponent(projectName)}/runs/${encodeURIComponent(runId)}/orchestrator/events?${params.toString()}`;
}

function buildTaskEventsUrl(
  projectName: string,
  runId: string,
  taskId: string,
  cursor: Cursor,
): string {
  const cursorValue = cursor === "tail" ? "tail" : String(cursor);
  const params = new URLSearchParams({ cursor: cursorValue, maxBytes: String(256_000) });
  return `/api/projects/${encodeURIComponent(projectName)}/runs/${encodeURIComponent(runId)}/tasks/${encodeURIComponent(taskId)}/events?${params.toString()}`;
}

function deriveActiveTaskIds(summary: any): string[] {
  const tasks = Array.isArray(summary?.tasks) ? summary.tasks : [];
  const active = tasks
    .filter((t: any) =>
      ["running", "needs_human_review", "needs_rescope", "rescope_required"].includes(
        String(t?.status),
      ),
    )
    .map((t: any) => String(t.id))
    .filter(Boolean);

  return active.slice(0, MAX_VISIBLE_AGENTS);
}

function summarizeHumanReview(summary: any, taskId: string): string | null {
  const rows = Array.isArray(summary?.humanReview) ? summary.humanReview : [];
  const match = rows.find((r: any) => String(r?.id) === taskId);
  if (!match) return null;

  const validator = match?.validator ? String(match.validator) : "validator";
  const reason = match?.reason ? String(match.reason) : "blocked";
  const extra = match?.summary ? ` — ${String(match.summary)}` : "";
  return `${validator}: ${reason}${extra}`;
}

function baselineActionForTaskStatus(status: string): string {
  switch (status) {
    case "running":
      return "coding";
    case "needs_human_review":
      return "blocked";
    case "needs_rescope":
    case "rescope_required":
      return "thinking";
    case "validated":
      return "test";
    case "complete":
      return "celebrate";
    case "failed":
      return "error";
    default:
      return "idle";
  }
}

function baselineBubbleForTaskStatus(
  summary: any,
  status: string,
  taskId: string,
): { kind: "speech" | "thought"; text: string } | null {
  switch (status) {
    case "running":
      return { kind: "thought", text: "Working…" };
    case "needs_human_review": {
      const detail = summarizeHumanReview(summary, taskId);
      return { kind: "speech", text: detail ? `Needs review: ${detail}` : "Needs review" };
    }
    case "needs_rescope":
    case "rescope_required":
      return { kind: "thought", text: "Needs rescope" };
    case "validated":
      return { kind: "speech", text: "Validated" };
    case "complete":
      return { kind: "speech", text: "Complete" };
    case "failed":
      return { kind: "speech", text: "Failed" };
    default:
      return null;
  }
}

function baselineBloomForRunStatus(
  status: string,
): { action: string; kind: "speech" | "thought"; text: string } | null {
  switch (status) {
    case "running":
      return { action: "idle", kind: "thought", text: "Running" };
    case "paused":
      return { action: "blocked", kind: "speech", text: "Paused" };
    case "complete":
      return { action: "celebrate", kind: "speech", text: "Complete" };
    case "failed":
      return { action: "error", kind: "speech", text: "Failed" };
    default:
      return null;
  }
}

export const useGroveRuntimeStore = create<GroveRuntimeState>((set, get) => ({
  projectName: "",
  runId: "",
  active: true,
  pollingPaused: false,
  assetBase: "/grove",
  fetchApi: null,

  spriteConfig: null,
  lastError: null,

  orchestratorCursor: "tail",
  taskCursors: {},
  activeTaskIds: [],

  taskStatusById: {},
  runStatus: null,

  pollTimerId: null,
  tickTimerId: null,

  mount: (opts) => {
    const assetBase = normalizeAssetBase(opts.assetBase);
    set({
      projectName: opts.projectName ?? "",
      runId: opts.runId ?? "",
      active: !!opts.active,
      pollingPaused: !!opts.pollingPaused,
      assetBase,
      fetchApi: opts.fetchApi,
      orchestratorCursor: "tail",
      taskCursors: {},
      activeTaskIds: [],
      taskStatusById: {},
      runStatus: null,
      lastError: null,
    });

    useGroveStore.getState().resetForRun();

    void loadSpriteActionsConfig(assetBase).then((cfg) => {
      set({ spriteConfig: cfg });
    });

    get().ensureLoops();
  },

  unmount: () => {
    get().stopLoops();
    set({ fetchApi: null });
    useGroveStore.getState().resetForRun();
  },

  setTarget: (projectName, runId) => {
    set({
      projectName: projectName ?? "",
      runId: runId ?? "",
      orchestratorCursor: "tail",
      taskCursors: {},
      activeTaskIds: [],
      taskStatusById: {},
      runStatus: null,
      lastError: null,
    });
    useGroveStore.getState().resetForRun();
    get().ensureLoops();
    get().refresh();
  },

  setSummary: (summary) => {
    if (!summary) {
      set({ activeTaskIds: [], taskCursors: {}, taskStatusById: {}, runStatus: null });
      return;
    }

    const prevRuntime = get();
    const nextRunStatus = summary?.status ? String(summary.status) : null;
    if (nextRunStatus && nextRunStatus !== prevRuntime.runStatus) {
      const bloom = baselineBloomForRunStatus(nextRunStatus);
      if (bloom) {
        useGroveStore.getState().setAgentAction("bloom", bloom.action);
        useGroveStore.getState().showBubble("bloom", bloom.kind, bloom.text);
      }
    }

    const activeTaskIds = deriveActiveTaskIds(summary);

    const tasks = Array.isArray(summary?.tasks) ? summary.tasks : [];
    const statusById = new Map<string, string>();
    for (const row of tasks) {
      const id = row?.id != null ? String(row.id) : "";
      if (!id) continue;
      const status = row?.status != null ? String(row.status) : "";
      if (status) statusById.set(id, status);
    }

    const groveAgents = useGroveStore.getState().agents;
    const existingWorkerIds = new Set(
      groveAgents.filter((a) => a.role === "worker" && a.taskId).map((a) => String(a.taskId)),
    );

    const trackedTaskIds = Array.from(new Set([...activeTaskIds, ...existingWorkerIds]))
      .map((id) => String(id))
      .filter(Boolean)
      .slice(0, MAX_VISIBLE_AGENTS);

    const nextTaskStatusById: Record<string, string> = {};
    for (const taskId of trackedTaskIds) {
      const status = statusById.get(taskId) ?? prevRuntime.taskStatusById[taskId] ?? "";
      if (status) {
        nextTaskStatusById[taskId] = status;
      }

      const prevStatus = prevRuntime.taskStatusById[taskId];
      const statusChanged = !!status && status !== prevStatus;
      const hadAgent = existingWorkerIds.has(taskId);

      // Only apply baseline action/bubble when status transitions OR when the agent is newly created.
      if (statusChanged || !hadAgent) {
        const worker = useGroveStore.getState().spawnWorker(taskId);
        if (worker) {
          useGroveStore.getState().setAgentAction(worker.id, baselineActionForTaskStatus(status));
          if (statusChanged) {
            const bubble = baselineBubbleForTaskStatus(summary, status, taskId);
            if (bubble) {
              useGroveStore.getState().showBubble(worker.id, bubble.kind, bubble.text);
            }
          }
        }
      }
    }

    set((state) => {
      const taskCursors = { ...state.taskCursors };
      for (const taskId of activeTaskIds) {
        if (taskCursors[taskId] === undefined) taskCursors[taskId] = "tail";
      }
      for (const key of Object.keys(taskCursors)) {
        if (!activeTaskIds.includes(key)) delete taskCursors[key];
      }
      return {
        activeTaskIds,
        taskCursors,
        taskStatusById: nextTaskStatusById,
        runStatus: nextRunStatus,
      };
    });
  },

  setActive: (active) => {
    set({ active: !!active });
    get().ensureLoops();
  },

  setPollingPaused: (paused) => {
    set({ pollingPaused: !!paused });
    get().ensureLoops();
  },

  refresh: () => {
    void get().pollOnce();
  },

  reset: () => {
    set({
      orchestratorCursor: "tail",
      taskCursors: {},
      activeTaskIds: [],
      taskStatusById: {},
      runStatus: null,
      lastError: null,
    });
    useGroveStore.getState().resetForRun();
  },

  ensureLoops: () => {
    const state = get();
    const shouldPoll =
      !!state.fetchApi &&
      state.active &&
      !state.pollingPaused &&
      !!state.projectName &&
      !!state.runId;

    if (shouldPoll && state.pollTimerId === null) {
      const id = window.setInterval(() => {
        void get().pollOnce();
      }, POLL_INTERVAL_MS);
      set({ pollTimerId: id });
    }

    if (!shouldPoll && state.pollTimerId !== null) {
      window.clearInterval(state.pollTimerId);
      set({ pollTimerId: null });
    }

    if (state.tickTimerId === null) {
      const id = window.setInterval(() => {
        useGroveStore.getState().tick();
      }, 250);
      set({ tickTimerId: id });
    }
  },

  stopLoops: () => {
    const { pollTimerId, tickTimerId } = get();
    if (pollTimerId !== null) window.clearInterval(pollTimerId);
    if (tickTimerId !== null) window.clearInterval(tickTimerId);
    set({ pollTimerId: null, tickTimerId: null });
  },

  pollOnce: async () => {
    const state = get();
    const fetchApi = state.fetchApi;
    if (!fetchApi) return;
    if (!state.projectName || !state.runId) return;
    if (!state.active || state.pollingPaused) return;

    try {
      const orchUrl = buildOrchestratorEventsUrl(
        state.projectName,
        state.runId,
        state.orchestratorCursor,
      );
      const orch = await fetchApi(orchUrl);
      if (Array.isArray(orch?.lines) && orch.lines.length > 0) {
        useGroveStore.getState().processEvents(orch.lines);
      }
      if (typeof orch?.nextCursor === "number") {
        set({ orchestratorCursor: orch.nextCursor });
      }

      const taskIds = state.activeTaskIds;
      if (Array.isArray(taskIds) && taskIds.length > 0) {
        for (const taskId of taskIds) {
          const cursor = get().taskCursors[taskId] ?? "tail";
          const url = buildTaskEventsUrl(state.projectName, state.runId, taskId, cursor);
          const chunk = await fetchApi(url);
          if (Array.isArray(chunk?.lines) && chunk.lines.length > 0) {
            useGroveStore.getState().processEvents(chunk.lines);
          }
          if (typeof chunk?.nextCursor === "number") {
            set((s) => ({ taskCursors: { ...s.taskCursors, [taskId]: chunk.nextCursor } }));
          }
        }
      }

      set({ lastError: null });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ lastError: message });
    }
  },
}));
