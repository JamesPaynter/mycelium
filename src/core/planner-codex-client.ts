import path from "node:path";

import { Codex } from "@openai/codex-sdk";
import fse from "fs-extra";

import type { LlmClient, LlmCompletionOptions, LlmCompletionResult } from "../llm/client.js";

import { ensureCodexAuthForHome } from "./codexAuth.js";
import type { JsonlLogger } from "./logger.js";
import { parseJson } from "./planner-helpers.js";
import { ensureDir } from "./utils.js";

// =============================================================================
// PUBLIC API
// =============================================================================

export function createCodexPlannerClient(args: {
  model: string;
  codexHome: string;
  workingDirectory: string;
  log?: JsonlLogger;
}): LlmClient {
  return new CodexPlannerClient(args);
}

// =============================================================================
// CODEX CLIENT
// =============================================================================

class CodexPlannerClient implements LlmClient {
  private readonly model: string;
  private readonly codexHome: string;
  private readonly workingDirectory: string;
  private readonly log?: JsonlLogger;

  constructor(args: {
    model: string;
    codexHome: string;
    workingDirectory: string;
    log?: JsonlLogger;
  }) {
    this.model = args.model;
    this.codexHome = args.codexHome;
    this.workingDirectory = args.workingDirectory;
    this.log = args.log;
  }

  async complete<TParsed = unknown>(
    prompt: string,
    options: LlmCompletionOptions = {},
  ): Promise<LlmCompletionResult<TParsed>> {
    const codexHome = this.codexHome;
    await ensureDir(codexHome);
    await writePlannerCodexConfig(path.join(codexHome, "config.toml"), this.model);

    // If the user authenticated via `codex login`, auth material typically lives under
    // ~/.codex/auth.json (file-based storage). Because we run with a custom CODEX_HOME,
    // we copy that auth file into this planner CODEX_HOME when no API key is provided.
    const auth = await ensureCodexAuthForHome(codexHome);
    this.log?.log({
      type: "codex.auth",
      mode: auth.mode,
      source: auth.mode === "env" ? auth.var : "auth.json",
    });

    const env: Record<string, string> = { CODEX_HOME: codexHome };
    if (process.env.CODEX_API_KEY) env.CODEX_API_KEY = process.env.CODEX_API_KEY;
    if (process.env.OPENAI_API_KEY) env.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (process.env.OPENAI_BASE_URL) env.OPENAI_BASE_URL = process.env.OPENAI_BASE_URL;
    if (process.env.OPENAI_ORGANIZATION) {
      env.OPENAI_ORGANIZATION = process.env.OPENAI_ORGANIZATION;
    }

    const codex = new Codex({ env });
    const thread = codex.startThread({ workingDirectory: this.workingDirectory });

    const result = await thread.run(prompt, { outputSchema: options.schema as any });
    const text = result.finalResponse ?? "";
    const parsed = options.schema ? parseJson<TParsed>(text) : undefined;

    return { text, parsed, finishReason: null };
  }
}

async function writePlannerCodexConfig(filePath: string, model: string): Promise<void> {
  const content = [
    `model = "${model}"`,
    // "never" means no approval prompts (the planner runs unattended; sandbox is read-only).
    `approval_policy = "never"`,
    `sandbox_mode = "read-only"`,
    "",
  ].join("\n");
  await ensureDir(path.dirname(filePath));
  await fse.writeFile(filePath, content, "utf8");
}
