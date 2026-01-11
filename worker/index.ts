import fs from "node:fs";
import path from "node:path";

import { execa } from "execa";
import { Codex } from "@openai/codex-sdk";

type Json = Record<string, unknown>;

function isoNow(): string {
  return new Date().toISOString();
}

function log(event: Json): void {
  process.stdout.write(JSON.stringify({ ts: isoNow(), ...event }) + "\n");
}

function envOrThrow(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

async function main(): Promise<void> {
  const taskId = envOrThrow("TASK_ID");
  const specPath = envOrThrow("TASK_SPEC_PATH");
  const manifestPath = envOrThrow("TASK_MANIFEST_PATH");
  const doctorCmd = envOrThrow("DOCTOR_CMD");
  const maxRetries = parseInt(process.env.MAX_RETRIES || "20", 10);
  const doctorTimeoutSeconds = process.env.DOCTOR_TIMEOUT ? parseInt(process.env.DOCTOR_TIMEOUT, 10) : undefined;

  const bootstrapCmds = process.env.BOOTSTRAP_CMDS ? JSON.parse(process.env.BOOTSTRAP_CMDS) as string[] : [];

  const spec = fs.readFileSync(specPath, "utf8");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { id: string; name: string };

  // Ensure git identity exists so commits don't fail.
  await ensureGitIdentity();

  // Optional bootstrap (install deps, etc.)
  if (bootstrapCmds.length > 0) {
    log({ type: "bootstrap.start", task_id: taskId, cmds: bootstrapCmds });
    for (const cmd of bootstrapCmds) {
      const res = await execa.command(cmd, {
        cwd: "/workspace",
        shell: true,
        reject: false,
        stdio: "pipe"
      });
      log({ type: "bootstrap.cmd", task_id: taskId, cmd, exit_code: res.exitCode });
      if (res.exitCode !== 0) {
        writeRunLog(`bootstrap-${safeAttemptName(0)}.log`, `${res.stdout}\n${res.stderr}`);
        log({ type: "bootstrap.fail", task_id: taskId, cmd, exit_code: res.exitCode });
        process.exit(1);
      }
    }
    log({ type: "bootstrap.complete", task_id: taskId });
  }

  const codexHome = process.env.CODEX_HOME || "/codex-home";
  const codex = new Codex({ env: { CODEX_HOME: codexHome } });
  const thread = codex.startThread({ workingDirectory: "/workspace" });

  let lastDoctorOutput = "";

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    log({ type: "turn.start", task_id: taskId, attempt });

    const prompt = attempt === 1
      ? buildInitialPrompt({ spec, manifestPath, manifest })
      : buildRetryPrompt({ spec, lastDoctorOutput, attempt });

    const { events } = await thread.runStreamed(prompt);
    for await (const event of events) {
      // Ensure we don't throw if event has circular refs (shouldn't).
      log({ type: "codex.event", task_id: taskId, attempt, event });
    }

    log({ type: "turn.complete", task_id: taskId, attempt });

    // Run doctor
    log({ type: "doctor.start", task_id: taskId, attempt, command: doctorCmd });
    const doctorRes = await execa.command(doctorCmd, {
      cwd: "/workspace",
      shell: true,
      reject: false,
      timeout: doctorTimeoutSeconds ? doctorTimeoutSeconds * 1000 : undefined,
      stdio: "pipe"
    });

    const doctorOut = `${doctorRes.stdout}\n${doctorRes.stderr}`.trim();
    writeRunLog(`doctor-${safeAttemptName(attempt)}.log`, doctorOut + "\n");

    if (doctorRes.exitCode === 0) {
      log({ type: "doctor.pass", task_id: taskId, attempt });
      await maybeCommit({ taskId, taskName: manifest.name });
      log({ type: "task.complete", task_id: taskId, attempt });
      process.exit(0);
    }

    lastDoctorOutput = doctorOut.slice(0, 12_000); // keep prompt bounded
    log({ type: "doctor.fail", task_id: taskId, attempt, exit_code: doctorRes.exitCode, summary: lastDoctorOutput.slice(0, 500) });

    if (attempt < maxRetries) {
      log({ type: "task.retry", task_id: taskId, next_attempt: attempt + 1 });
    }
  }

  log({ type: "task.failed", task_id: taskId, attempts: maxRetries });
  process.exit(1);
}

function buildInitialPrompt(args: { spec: string; manifestPath: string; manifest: any }): string {
  const manifestJson = JSON.stringify(args.manifest, null, 2);
  return `You are a coding agent working in a git repository.

Task manifest (context):
${manifestJson}

Task spec:
${args.spec}

Rules:
- Prefer test-driven development: add/adjust tests first, confirm they fail for the right reason, then implement.
- Keep changes minimal and aligned with existing patterns.
- Run the provided verification commands in the spec and ensure the doctor command passes.
- If doctor fails, iterate until it passes.
`;
}

function buildRetryPrompt(args: { spec: string; lastDoctorOutput: string; attempt: number }): string {
  return `The doctor command failed on attempt ${args.attempt}.

Doctor output:
${args.lastDoctorOutput}

Re-read the task spec and fix the issues. Then re-run doctor until it passes.

Task spec:
${args.spec}`;
}

async function ensureGitIdentity(): Promise<void> {
  const nameRes = await execa("git", ["config", "--get", "user.name"], { cwd: "/workspace", reject: false, stdio: "pipe" });
  if (nameRes.exitCode !== 0) {
    await execa("git", ["config", "user.name", "task-orchestrator"], { cwd: "/workspace" });
  }
  const emailRes = await execa("git", ["config", "--get", "user.email"], { cwd: "/workspace", reject: false, stdio: "pipe" });
  if (emailRes.exitCode !== 0) {
    await execa("git", ["config", "user.email", "task-orchestrator@localhost"], { cwd: "/workspace" });
  }
}

async function maybeCommit(args: { taskId: string; taskName: string }): Promise<void> {
  // If nothing changed, don't fail.
  const status = await execa("git", ["status", "--porcelain"], { cwd: "/workspace", stdio: "pipe" });
  if (status.stdout.trim().length === 0) {
    log({ type: "git.commit.skip", task_id: args.taskId, reason: "no_changes" });
    return;
  }

  await execa("git", ["add", "-A"], { cwd: "/workspace" });

  const message = `[AUTO] ${args.taskId} ${args.taskName}\n\nTask: ${args.taskId}`;
  const commit = await execa("git", ["commit", "-m", message], { cwd: "/workspace", reject: false, stdio: "pipe" });

  if (commit.exitCode === 0) {
    const sha = (await execa("git", ["rev-parse", "HEAD"], { cwd: "/workspace", stdio: "pipe" })).stdout.trim();
    log({ type: "git.commit", task_id: args.taskId, sha });
    return;
  }

  // A non-zero commit exit can happen if git thinks there's nothing staged (race). Re-check.
  const status2 = await execa("git", ["status", "--porcelain"], { cwd: "/workspace", stdio: "pipe" });
  if (status2.stdout.trim().length === 0) {
    log({ type: "git.commit.skip", task_id: args.taskId, reason: "nothing_to_commit" });
    return;
  }

  throw new Error(`git commit failed: ${commit.stderr || commit.stdout}`);
}

function writeRunLog(fileName: string, content: string): void {
  const runLogsDir = process.env.RUN_LOGS_DIR || "/run-logs";
  try {
    fs.mkdirSync(runLogsDir, { recursive: true });
    fs.writeFileSync(path.join(runLogsDir, fileName), content, "utf8");
  } catch {
    // best-effort
  }
}

function safeAttemptName(attempt: number): string {
  return String(attempt).padStart(3, "0");
}

main().catch((err) => {
  log({ type: "worker.fatal", error: String(err?.stack || err) });
  process.exit(1);
});
