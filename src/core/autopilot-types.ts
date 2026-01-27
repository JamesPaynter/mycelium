// =============================================================================
// TYPES
// =============================================================================

export type AutopilotTurn = {
  role: "supervisor" | "human";
  message: string;
};

export type AutopilotArtifacts = {
  discovery: {
    requirements: string;
    researchNotes: string;
    apiFindings: string;
  };
  architecture: {
    architecture: string;
    decisions: string;
    infrastructure: string;
  };
  implementation: {
    plan: string;
    risks: string;
  };
  summary: string;
};

export type AutopilotArtifactPaths = {
  requirementsPath: string;
  researchNotesPath: string;
  apiFindingsPath: string;
  architecturePath: string;
  decisionsPath: string;
  infrastructurePath: string;
  implementationPlanPath: string;
  riskAssessmentPath: string;
};

export type PlanExecutionSummary = {
  tasksPlanned: number;
  outputDir: string;
  planIndexPath?: string | null;
  dryRun: boolean;
};

export type RunExecutionSummary = {
  runId: string;
  status: string;
  tasks?: {
    total: number;
    complete: number;
    running: number;
    failed: number;
    needsHuman: number;
  };
  error?: string;
  stopped?: {
    signal: string | null;
    containers: "left_running" | "stopped";
    stopContainersRequested: boolean;
  };
};

export type AutopilotTranscriptContext = {
  projectName: string;
  repoPath: string;
  sessionId: string;
  planInputPath: string;
  startedAt: string;
};

export type AutopilotTranscriptData = AutopilotTranscriptContext & {
  turns: AutopilotTurn[];
  artifacts?: AutopilotArtifacts;
  artifactPaths?: AutopilotArtifactPaths;
  supervisorNote?: string | null;
  plan?: PlanExecutionSummary;
  planError?: string;
  run?: RunExecutionSummary;
  runSkipped?: boolean;
  runError?: string;
};

export interface AutopilotIo {
  ask(question: string): Promise<string>;
  note(message: string): void;
}
