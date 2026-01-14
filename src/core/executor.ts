import path from "node:path";

import { execa, execaCommand } from "execa";
import fse from "fs-extra";

import {
  dockerClient,
  createContainer,
  startContainer,
  waitContainer,
  removeContainer,
  imageExists,
  findContainerByName,
} from "../docker/docker.js";
import { buildWorkerImage } from "../docker/image.js";
import { streamContainerLogs } from "../docker/streams.js";
import { ensureCleanWorkingTree, checkout } from "../git/git.js";
import { mergeTaskBranches } from "../git/merge.js";
import { buildTaskBranchName } from "../git/branches.js";
import { ensureCodexAuthForHome } from "./codexAuth.js";

import type { ProjectConfig } from "./config.js";
import { JsonlLogger, logOrchestratorEvent, logRunResume, logTaskReset } from "./logger.js";
import { loadTaskSpecs } from "./task-loader.js";
import type { TaskSpec } from "./task-manifest.js";
import {
  orchestratorHome,
  orchestratorLogPath,
  taskEventsLogPath,
  taskLogsDir,
  taskWorkspaceDir,
  workerCodexHomeDir,
  validatorLogPath,
} from "./paths.js";
import { buildGreedyBatch, topologicalReady, type BatchPlan } from "./scheduler.js";
import { StateStore, findLatestRunId } from "./state-store.js";
import {
  completeBatch,
  createRunState,
  markTaskComplete,
  markTaskFailed,
  resetRunningTasks,
  startBatch,
  type RunState,
} from "./state.js";
import { ensureDir, defaultRunId, isoNow } from "./utils.js";
import { prepareTaskWorkspace } from "./workspaces.js";
import { runDoctorValidator } from "../validators/doctor-validator.js";
import { runTestValidator } from "../validators/test-validator.js";

export type RunOptions = {
  runId?: string;
  resume?: boolean;
  tasks?: string[]; // limit to IDs
  maxParallel?: number;
  dryRun?: boolean;
  buildImage?: boolean;
  cleanupOnSuccess?: boolean;
};

export type BatchPlanEntry = {
  batchId: number;
  taskIds: string[];
  locks: BatchPlan["locks"];
};

export type RunResult = { runId: string; state: RunState; plan: BatchPlanEntry[] };

type TaskRunResult =
  | {
      success: true;
      taskId: string;
      taskSlug: string;
      branchName: string;
      workspace: string;
      logsDir: string;
    }
  | {
      success: false;
      taskId: string;
      taskSlug: string;
      branchName: string;
      workspace: string;
      logsDir: string;
    };

export async function runProject(
  projectName: string,
  config: ProjectConfig,
  opts: RunOptions,
): Promise<RunResult> {
  const isResume = opts.resume ?? false;
  let runId: string;

  if (isResume) {
    const resolvedRunId = opts.runId ?? (await findLatestRunId(projectName));
    if (!resolvedRunId) {
      throw new Error(`No runs found to resume for project ${projectName}.`);
    }
    runId = resolvedRunId;
  } else {
    runId = opts.runId ?? defaultRunId();
  }
  const maxParallel = opts.maxParallel ?? config.max_parallel;
  const cleanupOnSuccess = opts.cleanupOnSuccess ?? false;
  const plannedBatches: BatchPlanEntry[] = [];

  const repoPath = config.repo_path;
  const docker = dockerClient();

  // Prepare directories
  await ensureDir(orchestratorHome());
  const stateStore = new StateStore(projectName, runId);
  const orchLog = new JsonlLogger(orchestratorLogPath(projectName, runId), { runId });
  const testValidatorConfig = config.test_validator;
  const testValidatorEnabled =
    testValidatorConfig !== undefined && testValidatorConfig.enabled !== false;
  const doctorValidatorConfig = config.doctor_validator;
  const doctorValidatorEnabled =
    doctorValidatorConfig !== undefined && doctorValidatorConfig.enabled !== false;
  let testValidatorLog: JsonlLogger | null = null;
  let doctorValidatorLog: JsonlLogger | null = null;
  const closeValidatorLogs = (): void => {
    if (testValidatorLog) {
      testValidatorLog.close();
    }
    if (doctorValidatorLog) {
      doctorValidatorLog.close();
    }
  };

  logOrchestratorEvent(orchLog, "run.start", {
    project: projectName,
    repo_path: repoPath,
  });

  // Ensure repo is clean and on integration branch.
  await ensureCleanWorkingTree(repoPath);
  await checkout(repoPath, config.main_branch).catch(async () => {
    // If branch doesn't exist, create it from current HEAD.
    await execa("git", ["checkout", "-b", config.main_branch], { cwd: repoPath, stdio: "pipe" });
  });

  // Load tasks.
  let tasks: TaskSpec[];
  try {
    const res = await loadTaskSpecs(repoPath, config.tasks_dir, {
      knownResources: config.resources.map((r) => r.name),
    });
    tasks = res.tasks;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logOrchestratorEvent(orchLog, "run.tasks_invalid", { message });
    closeValidatorLogs();
    orchLog.close();
    throw err;
  }
  if (opts.tasks && opts.tasks.length > 0) {
    const allow = new Set(opts.tasks);
    tasks = tasks.filter((t) => allow.has(t.manifest.id));
  }

  if (tasks.length === 0) {
    logOrchestratorEvent(orchLog, "run.no_tasks");
    closeValidatorLogs();
    orchLog.close();
    return {
      runId,
      state: createRunState({
        runId,
        project: projectName,
        repoPath,
        mainBranch: config.main_branch,
        taskIds: [],
      }),
      plan: plannedBatches,
    };
  }

  if (testValidatorEnabled) {
    testValidatorLog = new JsonlLogger(validatorLogPath(projectName, runId, "test-validator"), {
      runId,
    });
  }
  if (doctorValidatorEnabled) {
    doctorValidatorLog = new JsonlLogger(
      validatorLogPath(projectName, runId, "doctor-validator"),
      { runId },
    );
  }

  logOrchestratorEvent(orchLog, "run.tasks_loaded", {
    total_tasks: tasks.length,
    requested_tasks: opts.tasks?.length ?? null,
  });

  // Ensure worker image exists.
  const workerImage = config.docker.image;
  const haveImage = await imageExists(docker, workerImage);
  if (!haveImage) {
    if (opts.buildImage ?? true) {
      logOrchestratorEvent(orchLog, "docker.image.build.start", { image: workerImage });
      await buildWorkerImage({
        tag: workerImage,
        dockerfile: config.docker.dockerfile,
        context: config.docker.build_context,
      });
      logOrchestratorEvent(orchLog, "docker.image.build.complete", { image: workerImage });
    } else {
      throw new Error(
        `Docker image not found: ${workerImage}. Build it or run with --build-image.`,
      );
    }
  }

  // Create or resume run state
  let state: RunState;
  const stateExists = await stateStore.exists();
  if (stateExists) {
    state = await stateStore.load();

    const runResumeReason = isResume ? "resume_command" : "existing_state";
    if (state.status !== "running") {
      logRunResume(orchLog, { status: state.status, reason: runResumeReason });
      logOrchestratorEvent(orchLog, "run.resume.blocked", { reason: "state_not_running" });
      closeValidatorLogs();
      orchLog.close();
      return { runId, state, plan: plannedBatches };
    }

    const runningTasks = Object.entries(state.tasks)
      .filter(([, t]) => t.status === "running")
      .map(([id]) => id);

    const resetReason = "Resuming run: resetting in-flight tasks";
    if (runningTasks.length > 0) {
      resetRunningTasks(state, resetReason);
      for (const taskId of runningTasks) {
        logTaskReset(orchLog, taskId, resetReason);
      }
    }

    // Ensure new tasks found in the manifest are tracked for this run.
    for (const t of tasks) {
      if (!state.tasks[t.manifest.id]) {
        state.tasks[t.manifest.id] = { status: "pending", attempts: 0 };
      }
    }
    await stateStore.save(state);

    logRunResume(orchLog, {
      status: state.status,
      reason: runResumeReason,
      resetTasks: runningTasks.length,
    });
  } else {
    if (isResume) {
      logOrchestratorEvent(orchLog, "run.resume.blocked", { reason: "state_missing" });
      orchLog.close();
      throw new Error(`Cannot resume run ${runId}: state file not found.`);
    }

    state = createRunState({
      runId,
      project: projectName,
      repoPath,
      mainBranch: config.main_branch,
      taskIds: tasks.map((t) => t.manifest.id),
    });
    await stateStore.save(state);
  }

  // Main loop
  const completed = new Set<string>(
    Object.entries(state.tasks)
      .filter(([, s]) => s.status === "complete" || s.status === "skipped")
      .map(([id]) => id),
  );
  const failed = new Set<string>(
    Object.entries(state.tasks)
      .filter(([, s]) => s.status === "failed")
      .map(([id]) => id),
  );
  const doctorValidatorRunEvery = doctorValidatorConfig?.run_every_n_tasks;
  let doctorValidatorLastCount = completed.size + failed.size;
  let lastIntegrationDoctorOutput: string | undefined;
  let lastIntegrationDoctorExitCode: number | undefined;

  let batchId = Math.max(0, ...state.batches.map((b) => b.batch_id));
  while (true) {
    const pendingTasks = tasks.filter((t) => state.tasks[t.manifest.id]?.status === "pending");
    if (pendingTasks.length === 0) break;

    const ready = topologicalReady(pendingTasks, completed);
    if (ready.length === 0) {
      logOrchestratorEvent(orchLog, "run.deadlock", {
        message: "No dependency-satisfied tasks remaining. Check dependencies field.",
      });
      state.status = "failed";
      await stateStore.save(state);
      break;
    }

    batchId += 1;
    const { batch } = buildGreedyBatch(ready, maxParallel);

    const batchTaskIds = batch.tasks.map((t) => t.manifest.id);
    plannedBatches.push({ batchId, taskIds: batchTaskIds, locks: batch.locks });
    const startedAt = isoNow();
    startBatch(state, { batchId, taskIds: batchTaskIds, locks: batch.locks, now: startedAt });
    await stateStore.save(state);

    logOrchestratorEvent(orchLog, "batch.start", {
      batch_id: batchId,
      tasks: batchTaskIds,
      locks: batch.locks,
    });

    if (opts.dryRun) {
      logOrchestratorEvent(orchLog, "batch.dry_run", { batch_id: batchId, tasks: batchTaskIds });
      // Mark all as skipped for dry-run
      for (const t of batch.tasks) {
        state.tasks[t.manifest.id].status = "skipped";
        state.tasks[t.manifest.id].completed_at = isoNow();
        completed.add(t.manifest.id);
      }
      state.batches[state.batches.length - 1].status = "complete";
      state.batches[state.batches.length - 1].completed_at = isoNow();
      await stateStore.save(state);
      continue;
    }

    // Launch tasks in parallel.
    const results: TaskRunResult[] = await Promise.all(
      batch.tasks.map(async (task) => {
        const taskId = task.manifest.id;
        const taskSlug = task.slug;
        const branchName = buildTaskBranchName(
          config.task_branch_prefix,
          taskId,
          task.manifest.name,
        );

        const workspace = taskWorkspaceDir(projectName, runId, taskId);
        const tLogsDir = taskLogsDir(projectName, runId, taskId, taskSlug);
        const codexHome = workerCodexHomeDir(projectName, runId, taskId, taskSlug);

        await ensureDir(tLogsDir);
        await ensureDir(codexHome);
        await writeCodexConfig(path.join(codexHome, "config.toml"), {
          model: config.worker.model,
          // "never" means no approval prompts (unattended runs). See Codex config reference.
          approvalPolicy: "never",
          sandboxMode: "danger-full-access",
        });
        // If the user authenticated via `codex login`, auth material typically lives under
        // ~/.codex/auth.json (file-based storage). Because we run each worker with a custom
        // CODEX_HOME, we copy that auth file into this per-task CODEX_HOME when no API key is provided.
        const auth = await ensureCodexAuthForHome(codexHome);
        logOrchestratorEvent(orchLog, "codex.auth", {
          taskId,
          mode: auth.mode,
          source: auth.mode === "env" ? auth.var : "auth.json",
        });

        logOrchestratorEvent(orchLog, "workspace.prepare.start", { taskId, workspace });
        const workspacePrep = await prepareTaskWorkspace({
          projectName,
          runId,
          taskId,
          repoPath,
          mainBranch: config.main_branch,
          taskBranch: branchName,
        });
        logOrchestratorEvent(orchLog, "workspace.prepare.complete", {
          taskId,
          workspace,
          created: workspacePrep.created,
        });

        // Ensure tasks directory is available inside the clone (copy from integration repo).
        const srcTasksDir = path.join(repoPath, config.tasks_dir);
        const destTasksDir = path.join(workspace, config.tasks_dir);
        await fse.remove(destTasksDir);
        await fse.copy(srcTasksDir, destTasksDir);

        // Prepare per-task logger.
        const taskEvents = new JsonlLogger(
          taskEventsLogPath(projectName, runId, taskId, taskSlug),
          { runId, taskId },
        );

        // Create container
        const containerName = `to-${projectName}-${runId}-${taskId}-${taskSlug}`
          .replace(/[^a-zA-Z0-9_.-]/g, "-")
          .slice(0, 120);
        const existing = await findContainerByName(docker, containerName);
        if (existing) {
          // If container name already exists (stale), remove it.
          await removeContainer(existing);
        }

        const container = await createContainer(docker, {
          name: containerName,
          image: workerImage,
          env: {
            // Credentials / routing (passed through from the host).
            CODEX_API_KEY: process.env.CODEX_API_KEY ?? process.env.OPENAI_API_KEY,
            OPENAI_API_KEY: process.env.OPENAI_API_KEY,
            OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
            OPENAI_ORGANIZATION: process.env.OPENAI_ORGANIZATION,

            TASK_ID: taskId,
            TASK_SLUG: taskSlug,
            TASK_MANIFEST_PATH: path.posix.join(
              "/workspace",
              config.tasks_dir,
              path.basename(task.taskDir),
              "manifest.json",
            ),
            TASK_SPEC_PATH: path.posix.join(
              "/workspace",
              config.tasks_dir,
              path.basename(task.taskDir),
              "spec.md",
            ),
            TASK_BRANCH: branchName,
            DOCTOR_CMD: task.manifest.verify?.doctor ?? config.doctor,
            DOCTOR_TIMEOUT: config.doctor_timeout ? String(config.doctor_timeout) : undefined,
            MAX_RETRIES: String(config.max_retries),
            BOOTSTRAP_CMDS:
              config.bootstrap.length > 0 ? JSON.stringify(config.bootstrap) : undefined,
            CODEX_MODEL: config.worker.model,
            CODEX_HOME: "/codex-home",
            RUN_LOGS_DIR: "/run-logs",
          },
          binds: [
            { hostPath: workspace, containerPath: "/workspace", mode: "rw" },
            { hostPath: codexHome, containerPath: "/codex-home", mode: "rw" },
            { hostPath: tLogsDir, containerPath: "/run-logs", mode: "rw" },
          ],
          workdir: "/workspace",
          labels: {
            "task-orchestrator.project": projectName,
            "task-orchestrator.run_id": runId,
            "task-orchestrator.task_id": taskId,
          },
        });

        const containerInfo = await container.inspect();
        const containerId = containerInfo.Id;
        state.tasks[taskId].container_id = containerId;
        state.tasks[taskId].branch = branchName;
        state.tasks[taskId].workspace = workspace;
        state.tasks[taskId].logs_dir = tLogsDir;
        await stateStore.save(state);

        logOrchestratorEvent(orchLog, "container.create", {
          taskId,
          container_id: containerId,
          name: containerName,
        });

        // Attach log stream
        const detach = await streamContainerLogs(container, taskEvents, {
          fallbackType: "task.log",
        });

        await startContainer(container);
        logOrchestratorEvent(orchLog, "container.start", { taskId, container_id: containerId });

        const waited = await waitContainer(container);
        detach();
        taskEvents.close();

        logOrchestratorEvent(orchLog, "container.exit", {
          taskId,
          container_id: containerId,
          exit_code: waited.exitCode,
        });

        if (cleanupOnSuccess && waited.exitCode === 0) {
          await removeContainer(container);
        }

        if (waited.exitCode === 0) {
          return {
            taskId,
            taskSlug,
            branchName,
            workspace,
            logsDir: tLogsDir,
            success: true as const,
          };
        }

        return {
          taskId,
          taskSlug,
          branchName,
          workspace,
          logsDir: tLogsDir,
          success: false as const,
        };
      }),
    );

    // Update task statuses
    for (const r of results) {
      if (r.success) {
        markTaskComplete(state, r.taskId);
        completed.add(r.taskId);
        logOrchestratorEvent(orchLog, "task.complete", {
          taskId: r.taskId,
          attempts: state.tasks[r.taskId].attempts,
        });
      } else {
        markTaskFailed(state, r.taskId, "Task worker exited with a non-zero status");
        failed.add(r.taskId);
        logOrchestratorEvent(orchLog, "task.failed", {
          taskId: r.taskId,
          attempts: state.tasks[r.taskId].attempts,
        });
      }
    }

    await stateStore.save(state);

    if (testValidatorEnabled && testValidatorConfig) {
      const successfulTasks = results.filter((r) => r.success);
      for (const r of successfulTasks) {
        const taskSpec = tasks.find((t) => t.manifest.id === r.taskId);
        if (!taskSpec) continue;

        await runTestValidator({
          projectName,
          repoPath,
          runId,
          task: taskSpec,
          taskSlug: r.taskSlug,
          workspacePath: r.workspace,
          taskLogsDir: r.logsDir,
          mainBranch: config.main_branch,
          config: testValidatorConfig,
          orchestratorLog: orchLog,
          logger: testValidatorLog ?? undefined,
        }).catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          logOrchestratorEvent(orchLog, "validator.error", {
            validator: "test",
            taskId: r.taskId,
            message,
          });
        });
      }
    }

    let batchMergeCommit: string | undefined;
    let integrationDoctorPassed: boolean | undefined;
    let stopReason: "merge_conflict" | "integration_doctor_failed" | undefined;

    // Merge successful tasks sequentially into integration branch.
    const toMerge = results.filter((r) => r.success);
    if (toMerge.length > 0) {
      logOrchestratorEvent(orchLog, "batch.merging", {
        batch_id: batchId,
        tasks: toMerge.map((r) => r.taskId),
      });

      const mergeResult = await mergeTaskBranches({
        repoPath,
        mainBranch: config.main_branch,
        branches: toMerge.map((r) => ({
          taskId: r.taskId,
          branchName: r.branchName,
          workspacePath: r.workspace,
        })),
      });

      if (mergeResult.status === "conflict") {
        batchMergeCommit = mergeResult.mergeCommit;
        logOrchestratorEvent(orchLog, "batch.merge_conflict", {
          batch_id: batchId,
          task_id: mergeResult.conflict.taskId,
          branch: mergeResult.conflict.branchName,
          message: mergeResult.message,
        });
        state.status = "failed";
        stopReason = "merge_conflict";
      } else {
        batchMergeCommit = mergeResult.mergeCommit;

        // Integration doctor
        logOrchestratorEvent(orchLog, "doctor.integration.start", {
          batch_id: batchId,
          command: config.doctor,
        });
        const doctorRes = await execaCommand(config.doctor, {
          cwd: repoPath,
          shell: true,
          reject: false,
          timeout: config.doctor_timeout ? config.doctor_timeout * 1000 : undefined,
        });
        lastIntegrationDoctorOutput = `${doctorRes.stdout}\n${doctorRes.stderr}`.trim();
        const doctorExitCode = doctorRes.exitCode ?? -1;
        lastIntegrationDoctorExitCode = doctorExitCode;
        const doctorOk = doctorExitCode === 0;
        logOrchestratorEvent(
          orchLog,
          doctorOk ? "doctor.integration.pass" : "doctor.integration.fail",
          {
            batch_id: batchId,
            exit_code: doctorExitCode,
          },
        );
        integrationDoctorPassed = doctorOk;

        if (!doctorOk) {
          // Mark run failed but still record what happened.
          state.status = "failed";
          stopReason = "integration_doctor_failed";
        }
      }
    }

    // Mark batch complete
    const batchStatus: "complete" | "failed" =
      failed.size > 0 || stopReason ? "failed" : "complete";
    completeBatch(state, batchId, batchStatus, {
      mergeCommit: batchMergeCommit,
      integrationDoctorPassed,
    });
    await stateStore.save(state);

    const finishedCount = completed.size + failed.size;
    const shouldRunDoctorValidatorCadence =
      doctorValidatorEnabled &&
      doctorValidatorConfig &&
      doctorValidatorRunEvery !== undefined &&
      finishedCount - doctorValidatorLastCount >= doctorValidatorRunEvery;
    const shouldRunDoctorValidatorSuspicious =
      doctorValidatorEnabled && doctorValidatorConfig && integrationDoctorPassed === false;

    if (
      doctorValidatorEnabled &&
      doctorValidatorConfig &&
      (shouldRunDoctorValidatorCadence || shouldRunDoctorValidatorSuspicious)
    ) {
      const trigger = shouldRunDoctorValidatorSuspicious ? "integration_doctor_failed" : "cadence";
      const triggerNotes = shouldRunDoctorValidatorSuspicious
        ? `Integration doctor failed for batch ${batchId} (exit code ${lastIntegrationDoctorExitCode ?? -1})`
        : `Cadence reached after ${finishedCount} tasks (interval ${doctorValidatorRunEvery})`;

      await runDoctorValidator({
        projectName,
        repoPath,
        runId,
        mainBranch: config.main_branch,
        doctorCommand: config.doctor,
        trigger,
        triggerNotes,
        integrationDoctorOutput:
          trigger === "integration_doctor_failed" ? lastIntegrationDoctorOutput : undefined,
        config: doctorValidatorConfig,
        orchestratorLog: orchLog,
        logger: doctorValidatorLog ?? undefined,
      }).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        logOrchestratorEvent(orchLog, "validator.error", {
          validator: "doctor",
          message,
        });
      });

      doctorValidatorLastCount = finishedCount;
    }

    logOrchestratorEvent(orchLog, "batch.complete", { batch_id: batchId });

    if (stopReason) {
      logOrchestratorEvent(orchLog, "run.stop", { reason: stopReason });
      break;
    }
  }

  if (state.status === "running") {
    state.status = failed.size > 0 ? "failed" : "complete";
  }
  await stateStore.save(state);

  logOrchestratorEvent(orchLog, "run.complete", { status: state.status });
  closeValidatorLogs();
  orchLog.close();

  // Optional cleanup of successful workspaces can be added later.
  return { runId, state, plan: plannedBatches };
}

async function writeCodexConfig(
  filePath: string,
  opts: {
    model: string;
    // Valid values per Codex config reference.
    approvalPolicy: "untrusted" | "on-failure" | "on-request" | "never";
    sandboxMode: "read-only" | "workspace-write" | "danger-full-access";
  },
): Promise<void> {
  // Codex config format uses root keys in config.toml.
  // See upstream examples and config reference.
  // We keep it intentionally minimal here.
  const content = [
    `model = "${opts.model}"`,
    `approval_policy = "${opts.approvalPolicy}"`,
    `sandbox_mode = "${opts.sandboxMode}"`,
    "",
  ].join("\n");
  await fse.ensureDir(path.dirname(filePath));
  await fse.writeFile(filePath, content, "utf8");
}
