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
import { attachLineStream } from "../docker/streams.js";
import { cloneRepo, createBranchInClone, checkoutBranchInClone } from "../git/branches.js";
import {
  ensureCleanWorkingTree,
  checkout,
  mergeNoFf,
  addRemote,
  fetchRemote,
  removeRemote,
} from "../git/git.js";

import type { ProjectConfig } from "./config.js";
import { JsonlLogger, type JsonObject } from "./logger.js";
import { loadTaskSpecs } from "./task-loader.js";
import type { TaskSpec } from "./task-manifest.js";
import {
  orchestratorHome,
  orchestratorLogPath,
  runStatePath,
  taskEventsLogPath,
  taskLogsDir,
  taskWorkspaceDir,
  workerCodexHomeDir,
} from "./paths.js";
import { buildGreedyBatch, topologicalReady } from "./scheduler.js";
import { createRunState, saveRunState, loadRunState, type RunState } from "./state.js";
import { ensureDir, defaultRunId, isoNow, pathExists } from "./utils.js";

export type RunOptions = {
  runId?: string;
  tasks?: string[]; // limit to IDs
  maxParallel?: number;
  dryRun?: boolean;
  buildImage?: boolean;
  cleanupOnSuccess?: boolean;
};

export async function runProject(
  projectName: string,
  config: ProjectConfig,
  opts: RunOptions,
): Promise<{ runId: string; state: RunState }> {
  const runId = opts.runId ?? defaultRunId();
  const maxParallel = opts.maxParallel ?? config.max_parallel;

  const repoPath = config.repo_path;
  const docker = dockerClient();

  // Prepare directories
  await ensureDir(orchestratorHome());
  const statePath = runStatePath(projectName, runId);
  const orchLog = new JsonlLogger(orchestratorLogPath(projectName, runId), { runId });

  orchLog.log({
    type: "run.start",
    payload: { project: projectName, repo_path: repoPath },
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
    orchLog.log({ type: "run.tasks_invalid", payload: { message } });
    orchLog.close();
    throw err;
  }
  if (opts.tasks && opts.tasks.length > 0) {
    const allow = new Set(opts.tasks);
    tasks = tasks.filter((t) => allow.has(t.manifest.id));
  }

  if (tasks.length === 0) {
    orchLog.log({ type: "run.no_tasks" });
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
    };
  }

  // Ensure worker image exists.
  const workerImage = config.docker.image;
  const haveImage = await imageExists(docker, workerImage);
  if (!haveImage) {
    if (opts.buildImage ?? true) {
      orchLog.log({ type: "docker.image.build.start", payload: { image: workerImage } });
      await buildWorkerImage({
        tag: workerImage,
        dockerfile: config.docker.dockerfile,
        context: config.docker.build_context,
      });
      orchLog.log({ type: "docker.image.build.complete", payload: { image: workerImage } });
    } else {
      throw new Error(
        `Docker image not found: ${workerImage}. Build it or run with --build-image.`,
      );
    }
  }

  // Create or resume run state
  let state: RunState;
  if (await pathExists(statePath)) {
    state = await loadRunState(statePath);
    orchLog.log({ type: "run.resume", payload: { status: state.status } });
    // If a previous run was marked complete/failed, we keep it immutable unless the user
    // explicitly changes the run ID.
    if (state.status !== "running") {
      orchLog.log({ type: "run.resume.blocked", payload: { reason: "state_not_running" } });
      orchLog.close();
      return { runId, state };
    }

    // Best-effort crash recovery:
    // - Treat previously "running" tasks as "pending" again (we don't attempt to
    //   reattach to old containers in this MVP implementation).
    // - Ensure any newly added tasks appear in state.
    for (const [_id, tState] of Object.entries(state.tasks)) {
      if (tState.status === "running") {
        tState.status = "pending";
        tState.container_id = undefined;
        tState.branch = undefined;
        tState.workspace = undefined;
        tState.logs_dir = undefined;
        tState.started_at = undefined;
        tState.last_error = "Recovered from crash: previous status was running";
      }
    }
    for (const t of tasks) {
      if (!state.tasks[t.manifest.id]) {
        state.tasks[t.manifest.id] = { status: "pending", attempts: 0 };
      }
    }
    await saveRunState(statePath, state);
  } else {
    state = createRunState({
      runId,
      project: projectName,
      repoPath,
      mainBranch: config.main_branch,
      taskIds: tasks.map((t) => t.manifest.id),
    });
    await saveRunState(statePath, state);
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

  let batchId = Math.max(0, ...state.batches.map((b) => b.batch_id));
  while (true) {
    const pendingTasks = tasks.filter((t) => state.tasks[t.manifest.id]?.status === "pending");
    if (pendingTasks.length === 0) break;

    const ready = topologicalReady(pendingTasks, completed);
    if (ready.length === 0) {
      orchLog.log({
        type: "run.deadlock",
        payload: {
          message: "No dependency-satisfied tasks remaining. Check dependencies field.",
        },
      });
      state.status = "failed";
      await saveRunState(statePath, state);
      break;
    }

    batchId += 1;
    const { batch } = buildGreedyBatch(ready, maxParallel);

    const batchTaskIds = batch.map((t) => t.manifest.id);
    state.batches.push({
      batch_id: batchId,
      status: "running",
      tasks: batchTaskIds,
      started_at: isoNow(),
    });
    for (const t of batch) {
      state.tasks[t.manifest.id] = {
        ...state.tasks[t.manifest.id],
        status: "running",
        batch_id: batchId,
        started_at: isoNow(),
      };
    }
    await saveRunState(statePath, state);

    orchLog.log({
      type: "batch.start",
      payload: { batch_id: batchId, tasks: batchTaskIds },
    });

    if (opts.dryRun) {
      orchLog.log({ type: "batch.dry_run", payload: { batch_id: batchId } });
      // Mark all as skipped for dry-run
      for (const t of batch) {
        state.tasks[t.manifest.id].status = "skipped";
        state.tasks[t.manifest.id].completed_at = isoNow();
        completed.add(t.manifest.id);
      }
      state.batches[state.batches.length - 1].status = "complete";
      state.batches[state.batches.length - 1].completed_at = isoNow();
      await saveRunState(statePath, state);
      continue;
    }

    // Launch tasks in parallel.
    const results = await Promise.all(
      batch.map(async (task) => {
        const taskId = task.manifest.id;
        const taskSlug = task.slug;
        const branchName = `${config.task_branch_prefix}${taskId}-${taskSlug}`;

        const workspace = taskWorkspaceDir(projectName, runId, taskId, taskSlug);
        const tLogsDir = taskLogsDir(projectName, runId, taskId, taskSlug);
        const codexHome = workerCodexHomeDir(projectName, runId, taskId, taskSlug);

        await ensureDir(workspace);
        await ensureDir(tLogsDir);
        await ensureDir(codexHome);
        await writeCodexConfig(path.join(codexHome, "config.toml"), {
          model: config.worker.model,
          // "never" means no approval prompts (unattended runs). See Codex config reference.
          approvalPolicy: "never",
          sandboxMode: "danger-full-access",
        });

        // Clone repo into workspace
        orchLog.log({
          type: "workspace.clone.start",
          taskId,
          payload: { workspace },
        });
        await cloneRepo({ sourceRepo: repoPath, destDir: workspace });
        orchLog.log({
          type: "workspace.clone.complete",
          taskId,
          payload: { workspace },
        });

        // Ensure tasks directory is available inside the clone (copy from integration repo).
        const srcTasksDir = path.join(repoPath, config.tasks_dir);
        const destTasksDir = path.join(workspace, config.tasks_dir);
        await fse.remove(destTasksDir);
        await fse.copy(srcTasksDir, destTasksDir);

        // Checkout integration branch and create task branch.
        await checkoutBranchInClone(workspace, config.main_branch);
        await createBranchInClone(workspace, branchName, config.main_branch);

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
            CODEX_API_KEY: process.env.CODEX_API_KEY,
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
            BOOTSTRAP_CMDS: config.bootstrap ? JSON.stringify(config.bootstrap) : undefined,
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
        await saveRunState(statePath, state);

        orchLog.log({
          type: "container.create",
          taskId,
          payload: { container_id: containerId, name: containerName },
        });

        // Attach log stream
        const detach = await attachLineStream(container, (line, stream) => {
          try {
            const parsed = JSON.parse(line);
            if (
              parsed &&
              typeof parsed === "object" &&
              "type" in (parsed as Record<string, unknown>) &&
              typeof (parsed as Record<string, unknown>).type === "string"
            ) {
              const { type, ts, ...rest } = parsed as Record<string, unknown>;
              const data = { ...rest, stream } as JsonObject;
              taskEvents.log({
                type: String(type),
                ts: typeof ts === "string" ? ts : undefined,
                payload: data,
              });
              return;
            }
          } catch {
            // fall through to raw log
          }
          taskEvents.log({ type: "task.log", payload: { stream, raw: line } });
        });

        await startContainer(container);
        orchLog.log({
          type: "container.start",
          taskId,
          payload: { container_id: containerId },
        });

        const waited = await waitContainer(container);
        detach();
        taskEvents.close();

        orchLog.log({
          type: "container.exit",
          taskId,
          payload: { container_id: containerId, exit_code: waited.exitCode },
        });

        if (waited.exitCode === 0) {
          return { taskId, taskSlug, branchName, workspace, success: true as const };
        }

        return { taskId, taskSlug, branchName, workspace, success: false as const };
      }),
    );

    // Update task statuses
    for (const r of results) {
      if (r.success) {
        state.tasks[r.taskId].status = "complete";
        state.tasks[r.taskId].completed_at = isoNow();
        completed.add(r.taskId);
        orchLog.log({ type: "task.complete", taskId: r.taskId });
      } else {
        state.tasks[r.taskId].status = "failed";
        state.tasks[r.taskId].completed_at = isoNow();
        failed.add(r.taskId);
        orchLog.log({ type: "task.failed", taskId: r.taskId });
      }
    }

    // Merge successful tasks sequentially into integration branch.
    const toMerge = results.filter((r) => r.success);
    if (toMerge.length > 0) {
      orchLog.log({
        type: "batch.merging",
        payload: { batch_id: batchId, tasks: toMerge.map((r) => r.taskId) },
      });
      await checkout(repoPath, config.main_branch);

      for (const r of toMerge) {
        const remoteName = `task-${r.taskId}`;
        try {
          await addRemote(repoPath, remoteName, r.workspace);
          await fetchRemote(repoPath, remoteName, r.branchName);
          await mergeNoFf(repoPath, "FETCH_HEAD", `Merge ${r.branchName}`);
        } finally {
          await removeRemote(repoPath, remoteName).catch(() => undefined);
        }
      }

      // Integration doctor
      orchLog.log({
        type: "doctor.integration.start",
        payload: { batch_id: batchId, command: config.doctor },
      });
      const doctorRes = await execaCommand(config.doctor, {
        cwd: repoPath,
        shell: true,
        reject: false,
        timeout: config.doctor_timeout ? config.doctor_timeout * 1000 : undefined,
      });
      const doctorOk = doctorRes.exitCode === 0;
      orchLog.log({
        type: doctorOk ? "doctor.integration.pass" : "doctor.integration.fail",
        payload: { batch_id: batchId, exit_code: doctorRes.exitCode ?? -1 },
      });

      const b = state.batches.find((b) => b.batch_id === batchId);
      if (b) {
        b.integration_doctor_passed = doctorOk;
      }

      if (!doctorOk) {
        // Mark run failed but still record what happened.
        state.status = "failed";
      }
    }

    // Mark batch complete
    const batchState = state.batches.find((b) => b.batch_id === batchId);
    if (batchState) {
      batchState.status = failed.size > 0 ? "failed" : "complete";
      batchState.completed_at = isoNow();
    }
    await saveRunState(statePath, state);

    orchLog.log({ type: "batch.complete", payload: { batch_id: batchId } });

    if (state.status === "failed") {
      orchLog.log({ type: "run.stop", payload: { reason: "integration_doctor_failed" } });
      break;
    }
  }

  if (state.status === "running") {
    state.status = failed.size > 0 ? "failed" : "complete";
  }
  await saveRunState(statePath, state);

  orchLog.log({ type: "run.complete", payload: { status: state.status } });
  orchLog.close();

  // Optional cleanup of successful workspaces can be added later.
  return { runId, state };
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
