// src/core/codexAuth.ts
import os from "node:os";
import path from "node:path";
import fse from "fs-extra";

import { isMockLlmEnabled } from "../llm/mock.js";

export type CodexAuthProvisioned =
  | { mode: "env"; var: "CODEX_API_KEY" | "OPENAI_API_KEY" | "MOCK_LLM" }
  | { mode: "copied"; from: string; to: string };

/**
 * Ensure the Codex SDK can authenticate when running under a custom CODEX_HOME.
 *
 * Why this exists:
 * - The Codex CLI typically stores login state under CODEX_HOME (default: ~/.codex).
 * - This orchestrator runs Codex in separate CODEX_HOME directories per planner/task.
 * - If you authenticated via `codex login`, the auth material may live at ~/.codex/auth.json
 *   (when using file-based credential storage) rather than in the orchestrator's CODEX_HOME.
 *
 * Strategy:
 * 1) If CODEX_API_KEY or OPENAI_API_KEY is set, do nothing (Codex will use env auth).
 * 2) Otherwise, copy the CLI's auth.json into the provided CODEX_HOME.
 *
 * Security:
 * - We never log token contents.
 * - We attempt to chmod the destination to 0600 on POSIX systems.
 */
export async function ensureCodexAuthForHome(codexHome: string): Promise<CodexAuthProvisioned> {
  if (isMockLlmEnabled()) {
    await fse.ensureDir(codexHome);
    return { mode: "env", var: "MOCK_LLM" };
  }

  const envCodex = process.env.CODEX_API_KEY?.trim();
  if (envCodex) return { mode: "env", var: "CODEX_API_KEY" };

  const envOpenai = process.env.OPENAI_API_KEY?.trim();
  if (envOpenai) return { mode: "env", var: "OPENAI_API_KEY" };

  const src = await findCodexAuthJson();
  if (!src) {
    const defaultHome = path.join(os.homedir(), ".codex");
    const defaultAuth = path.join(defaultHome, "auth.json");
    throw new Error(
      [
        "Codex credentials not found.",
        "",
        "Set CODEX_API_KEY (or OPENAI_API_KEY), or authenticate via the Codex CLI:",
        "  codex login",
        "",
        "If you logged in via the CLI but this still fails, ensure your credentials are stored in a file.",
        `This orchestrator looks for auth.json under CODEX_HOME (default: ${defaultAuth}).`,
      ].join("\n"),
    );
  }

  const dest = path.join(codexHome, "auth.json");
  await fse.ensureDir(codexHome);
  await fse.copy(src, dest, { overwrite: true });

  // Best-effort tighten permissions (may fail on Windows).
  await fse.chmod(dest, 0o600).catch(() => undefined);

  return { mode: "copied", from: src, to: dest };
}

async function findCodexAuthJson(): Promise<string | null> {
  const candidates: string[] = [];

  // If the user runs Codex CLI with a custom CODEX_HOME, respect it.
  // (Note: this is the *host* CODEX_HOME, not the per-task CODEX_HOME we set when running Codex.)
  const envHome = process.env.CODEX_HOME?.trim();
  if (envHome) candidates.push(path.join(envHome, "auth.json"));

  // Default Codex home per official docs.
  candidates.push(path.join(os.homedir(), ".codex", "auth.json"));

  // Legacy / alternate locations (best-effort).
  candidates.push(path.join(os.homedir(), ".config", "codex", "auth.json"));

  for (const p of candidates) {
    try {
      if (await fse.pathExists(p)) return p;
    } catch {
      // ignore
    }
  }
  return null;
}
