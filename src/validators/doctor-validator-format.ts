import type { DoctorRunSample, DoctorCanaryResult, ValidationContext } from "./doctor-validator-context.js";

// =============================================================================
// FORMATTING
// =============================================================================

export function formatDoctorRunsForPrompt(runs: DoctorRunSample[]): string {
  if (runs.length === 0) {
    return "No doctor runs recorded for this run.";
  }

  return runs
    .map((run) => {
      const statusLabel =
        run.status === undefined
          ? "status: unknown"
          : run.status === "pass"
            ? "status: pass"
            : `status: fail${run.exitCode !== undefined ? ` (exit ${run.exitCode})` : ""}`;

      const header = [`Task ${run.taskId}`, `attempt ${run.attempt}`, statusLabel].join(" — ");
      const summaryLine = run.summary ? `Summary: ${run.summary}` : null;
      const pathLine = run.logPath ? `Log: ${run.logPath}` : null;

      return [
        header,
        summaryLine,
        pathLine,
        "```",
        run.log,
        "```",
        run.truncated ? "[truncated]" : "",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}

export function buildDoctorExpectations(context: ValidationContext): string {
  const stats = computeRunStats(context.doctorRuns);
  const lines = [
    `Trigger: ${context.trigger}`,
    `Doctor runs observed: ${stats.total} (pass: ${stats.passes}, fail: ${stats.failures})`,
  ];

  if (context.triggerNotes) {
    lines.push(`Notes: ${context.triggerNotes}`);
  }
  if (context.integrationDoctorOutput) {
    lines.push("Integration doctor output (most recent):", context.integrationDoctorOutput);
  }
  lines.push(formatDoctorCanaryForPrompt(context.doctorCanary));

  return lines.join("\n");
}

export function computeRunStats(runs: DoctorRunSample[]): {
  total: number;
  passes: number;
  failures: number;
} {
  return runs.reduce(
    (acc, run) => {
      acc.total += 1;
      if (run.status === "pass") acc.passes += 1;
      if (run.status === "fail") acc.failures += 1;
      return acc;
    },
    { total: 0, passes: 0, failures: 0 },
  );
}

export function formatDoctorCanaryForPrompt(canary?: DoctorCanaryResult): string {
  if (!canary) {
    return "Doctor canary: not yet recorded. Add canary env var handling to your doctor wrapper.";
  }

  if (canary.status === "skipped") {
    return `Doctor canary: skipped (${canary.reason}).`;
  }

  const envLabel = formatDoctorCanaryEnvVar(canary.envVar);
  const lines = [
    canary.status === "unexpected_pass"
      ? `Doctor canary: DID NOT fail when ${envLabel} (unexpected pass).`
      : `Doctor canary: failed as expected when ${envLabel}.`,
    `Exit code: ${canary.exitCode}`,
  ];

  if (canary.output.trim().length > 0) {
    lines.push("Output:", canary.output);
  }

  return lines.join("\n");
}

function formatDoctorCanaryEnvVar(envVar?: string): string {
  const trimmed = envVar?.trim();
  return `${trimmed && trimmed.length > 0 ? trimmed : "ORCH_CANARY"}=1`;
}
