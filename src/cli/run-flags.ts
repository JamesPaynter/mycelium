import type { RunOptions } from "../core/executor.js";

// =============================================================================
// RUN FLAGS
// =============================================================================

export type RunDebugFlags = Pick<
  RunOptions,
  "useLegacyEngine" | "crashAfterContainerStart"
>;

export function resolveRunDebugFlags(overrides: RunDebugFlags = {}): RunDebugFlags {
  const useLegacyEngine =
    overrides.useLegacyEngine ?? process.env.MYCELIUM_USE_LEGACY_RUN_ENGINE === "1";
  const crashAfterContainerStart =
    overrides.crashAfterContainerStart ??
    process.env.MYCELIUM_FAKE_CRASH_AFTER_CONTAINER_START === "1";

  return { useLegacyEngine, crashAfterContainerStart };
}
