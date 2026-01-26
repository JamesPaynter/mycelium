/**
 * Orchestrator ports define the boundary between the run engine and adapters.
 * Purpose: make dependencies explicit and replaceable for testing.
 * Assumptions: ports stay small and map to stable runtime capabilities.
 * Usage: provide implementations in `run-context.ts` and inject into RunContext.
 */

import type { WorkerLogger } from "../../../worker/logging.js";
import type { WorkerConfig } from "../../../worker/loop.js";
import type {
  ControlPlaneBuildOptions,
  ControlPlaneBuildResult,
} from "../../control-plane/model/build.js";
import type { ControlPlaneModel } from "../../control-plane/model/schema.js";
import type { ControlPlaneStore } from "../../control-plane/storage.js";
import type { JsonObject, JsonlLogger } from "../../core/logger.js";
import type { StateStore } from "../../core/state-store.js";
import type {
  PrepareTaskWorkspaceOptions,
  PrepareTaskWorkspaceResult,
} from "../../core/workspaces.js";
import type {
  ArchitectureValidationReport,
  ArchitectureValidatorArgs,
} from "../../validators/architecture-validator.js";
import type {
  DoctorValidationReport,
  DoctorValidatorArgs,
} from "../../validators/doctor-validator.js";
import type {
  StyleValidationReport,
  StyleValidatorArgs,
} from "../../validators/style-validator.js";
import type { TestValidationReport, TestValidatorArgs } from "../../validators/test-validator.js";

import type { Vcs } from "./vcs/vcs.js";

// =============================================================================
// PORTS
// =============================================================================

export interface WorkspaceStore {
  prepareTaskWorkspace(options: PrepareTaskWorkspaceOptions): Promise<PrepareTaskWorkspaceResult>;
  removeTaskWorkspace(projectName: string, runId: string, taskId: string): Promise<void>;
  removeRunWorkspace(projectName: string, runId: string): Promise<void>;
}

export interface WorkerRunner {
  runWorker(config: WorkerConfig, logger?: WorkerLogger): Promise<void>;
}

export interface ValidatorRunner {
  runDoctorValidator(args: DoctorValidatorArgs): Promise<DoctorValidationReport | null>;
  runTestValidator(args: TestValidatorArgs): Promise<TestValidationReport | null>;
  runStyleValidator(args: StyleValidatorArgs): Promise<StyleValidationReport | null>;
  runArchitectureValidator(
    args: ArchitectureValidatorArgs,
  ): Promise<ArchitectureValidationReport | null>;
}

export interface StateRepository {
  create(projectName: string, runId: string): StateStore;
  findLatestRunId(projectName: string): Promise<string | null>;
}

export interface LogSink {
  createOrchestratorLogger(projectName: string, runId: string): JsonlLogger;
  logOrchestratorEvent(logger: JsonlLogger, type: string, payload?: JsonObject): void;
}

export interface Clock {
  now(): Date;
  isoNow(): string;
}

export interface ControlPlaneClient {
  buildModel(options: ControlPlaneBuildOptions): Promise<ControlPlaneBuildResult>;
  loadModel(modelPath: string): Promise<ControlPlaneModel>;
  createStore(repoPath: string): ControlPlaneStore;
}

export type OrchestratorPorts = {
  workspaceStore: WorkspaceStore;
  vcs: Vcs;
  workerRunner: WorkerRunner;
  validatorRunner: ValidatorRunner;
  stateRepository: StateRepository;
  logSink: LogSink;
  clock: Clock;
  controlPlaneClient: ControlPlaneClient;
};
