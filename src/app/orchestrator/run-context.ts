/**
 * RunContext + default adapters for orchestrator runs.
 * Purpose: centralize run-scoped config types and injected ports to avoid globals.
 * Assumptions: ports are thin adapters over core modules and are overrideable for tests.
 * Usage: buildRunContext(...) from run-context-builder and call runEngine.
 */

import { runWorker } from "../../../worker/loop.js";
import { buildControlPlaneModel } from "../../control-plane/model/build.js";
import type { ControlPlaneModel } from "../../control-plane/model/schema.js";
import type { SurfacePatternSet } from "../../control-plane/policy/types.js";
import { ControlPlaneStore } from "../../control-plane/storage.js";
import type {
  ControlPlaneChecksMode,
  ControlPlaneLockMode,
  ControlPlaneResourcesMode,
  ControlPlaneScopeMode,
  ManifestEnforcementPolicy,
  ProjectConfig,
  ValidatorMode,
} from "../../core/config.js";
import { JsonlLogger, logOrchestratorEvent } from "../../core/logger.js";
import type { JsonObject } from "../../core/logger.js";
import type { PathsContext } from "../../core/paths.js";
import { orchestratorLogPath } from "../../core/paths.js";
import { StateStore, findLatestRunId } from "../../core/state-store.js";
import { isoNow, readJsonFile } from "../../core/utils.js";
import { removeRunWorkspace, removeTaskWorkspace, prepareTaskWorkspace } from "../../core/workspaces.js";
import type { ContainerSpec } from "../../docker/docker.js";
import { runArchitectureValidator } from "../../validators/architecture-validator.js";
import { runDoctorValidator } from "../../validators/doctor-validator.js";
import { runStyleValidator } from "../../validators/style-validator.js";
import { runTestValidator } from "../../validators/test-validator.js";

import type { OrchestratorPorts } from "./ports.js";
import { createGitVcs } from "./vcs/git-vcs.js";


// =============================================================================
// TYPES
// =============================================================================

export type LegacyExecutor<RunOptions, RunResult> = {
  runProject: (projectName: string, config: ProjectConfig, options: RunOptions) => Promise<RunResult>;
};

export type RunContextOptions = {
  runId?: string;
  resume?: boolean;
  reuseCompleted?: boolean;
  importRun?: string;
  maxParallel?: number;
  cleanupOnSuccess?: boolean;
  useDocker?: boolean;
  stopContainersOnExit?: boolean;
  useLegacyEngine?: boolean;
  crashAfterContainerStart?: boolean;
};

export type RunValidatorConfig<TConfig> = {
  config: TConfig | undefined;
  mode: ValidatorMode;
  enabled: boolean;
};

export type ControlPlaneChecksRunConfig = {
  mode: ControlPlaneChecksMode;
  commandsByComponent: Record<string, string>;
  maxComponentsForScoped: number;
  fallbackCommand?: string;
};

export type ControlPlaneRunConfig = {
  enabled: boolean;
  componentResourcePrefix: string;
  fallbackResource: string;
  resourcesMode: ControlPlaneResourcesMode;
  scopeMode: ControlPlaneScopeMode;
  lockMode: ControlPlaneLockMode;
  checks: ControlPlaneChecksRunConfig;
  surfacePatterns: SurfacePatternSet;
  surfaceLocksEnabled: boolean;
};

export type RunContextResolved = {
  run: {
    runId: string;
    isResume: boolean;
    reuseCompleted: boolean;
    importRunId?: string;
    maxParallel: number;
  };
  cleanup: {
    workspacesOnSuccess: boolean;
    containersOnSuccess: boolean;
  };
  paths: {
    repoPath: string;
    tasksRootAbs: string;
    tasksDirPosix: string;
    myceliumHome: string;
  };
  docker: {
    useDocker: boolean;
    stopContainersOnExit: boolean;
    workerImage: string;
    containerResources: ContainerSpec["resources"];
    containerSecurityPayload: JsonObject;
    networkMode: ProjectConfig["docker"]["network_mode"];
    containerUser: string;
  };
  controlPlane: {
    config: ControlPlaneRunConfig;
  };
  policy: {
    manifestPolicy: ManifestEnforcementPolicy;
    costPer1kTokens: number;
    mockLlmMode: boolean;
  };
  flags: {
    crashAfterContainerStart: boolean;
  };
  validators: {
    test: RunValidatorConfig<ProjectConfig["test_validator"]>;
    style: RunValidatorConfig<ProjectConfig["style_validator"]>;
    architecture: RunValidatorConfig<ProjectConfig["architecture_validator"]>;
    doctor: RunValidatorConfig<ProjectConfig["doctor_validator"]>;
    doctorCanary: ProjectConfig["doctor_canary"];
  };
};

export type RunContextBase<RunOptions = unknown> = {
  projectName: string;
  config: ProjectConfig;
  options: RunOptions;
  ports: OrchestratorPorts;
  resolved: RunContextResolved;
};

export type RunContext<RunOptions = unknown, RunResult = unknown> = {
  legacy: LegacyExecutor<RunOptions, RunResult>;
} & RunContextBase<RunOptions>;


// =============================================================================
// DEFAULT ADAPTERS
// =============================================================================

export function createDefaultPorts(
  config: ProjectConfig,
  paths?: PathsContext,
): OrchestratorPorts {
  return {
    workspaceStore: {
      prepareTaskWorkspace: (opts) => prepareTaskWorkspace({ ...opts, paths }),
      removeTaskWorkspace: (projectName, runId, taskId) =>
        removeTaskWorkspace(projectName, runId, taskId, paths),
      removeRunWorkspace: (projectName, runId) =>
        removeRunWorkspace(projectName, runId, paths),
    },
    vcs: createGitVcs({ taskBranchPrefix: config.task_branch_prefix }),
    workerRunner: {
      runWorker,
    },
    validatorRunner: {
      runDoctorValidator,
      runTestValidator,
      runStyleValidator,
      runArchitectureValidator,
    },
    stateRepository: {
      create: (projectName, runId) => new StateStore(projectName, runId, paths),
      findLatestRunId: (projectName) => findLatestRunId(projectName, paths),
    },
    logSink: {
      createOrchestratorLogger: (projectName, runId) =>
        new JsonlLogger(orchestratorLogPath(projectName, runId, paths), { runId }),
      logOrchestratorEvent,
    },
    clock: {
      now: () => new Date(),
      isoNow,
    },
    controlPlaneClient: {
      buildModel: buildControlPlaneModel,
      loadModel: (modelPath) => readJsonFile<ControlPlaneModel>(modelPath),
      createStore: (repoPath) => new ControlPlaneStore(repoPath),
    },
  };
}
