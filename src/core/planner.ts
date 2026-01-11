import path from "node:path";

import { Codex } from "@openai/codex-sdk";
import { execa } from "execa";
import fse from "fs-extra";

import type { ProjectConfig } from "./config.js";
import { JsonlLogger } from "./logger.js";
import { orchestratorHome } from "./paths.js";
import { renderPromptTemplate } from "./prompts.js";
import { slugify, ensureDir, isoNow } from "./utils.js";

export type PlannedTask = {
  id: string;
  name: string;
  description: string;
  estimated_minutes: number;
  dependencies?: string[];
  locks: { reads: string[]; writes: string[] };
  files: { reads: string[]; writes: string[] };
  affected_tests: string[];
  verify: { doctor: string; fast?: string };
  spec: string;
};

export type PlanResult = { tasks: PlannedTask[] };

const PlannerOutputSchema = {
  type: "object",
  properties: {
    tasks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          description: { type: "string" },
          estimated_minutes: { type: "integer" },
          dependencies: { type: "array", items: { type: "string" } },
          locks: {
            type: "object",
            properties: {
              reads: { type: "array", items: { type: "string" } },
              writes: { type: "array", items: { type: "string" } },
            },
            required: ["reads", "writes"],
            additionalProperties: false,
          },
          files: {
            type: "object",
            properties: {
              reads: { type: "array", items: { type: "string" } },
              writes: { type: "array", items: { type: "string" } },
            },
            required: ["reads", "writes"],
            additionalProperties: false,
          },
          affected_tests: { type: "array", items: { type: "string" } },
          verify: {
            type: "object",
            properties: {
              doctor: { type: "string" },
              fast: { type: "string" },
            },
            required: ["doctor"],
            additionalProperties: false,
          },
          spec: { type: "string" },
        },
        required: [
          "id",
          "name",
          "description",
          "estimated_minutes",
          "locks",
          "files",
          "affected_tests",
          "verify",
          "spec",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["tasks"],
  additionalProperties: false,
} as const;

export async function planFromImplementationPlan(args: {
  projectName: string;
  config: ProjectConfig;
  inputPath: string;
  outputDir: string;
  dryRun?: boolean;
  log?: JsonlLogger;
}): Promise<PlanResult> {
  const { projectName, config, inputPath, outputDir, dryRun } = args;

  const repoPath = config.repo_path;
  const inputAbs = path.isAbsolute(inputPath) ? inputPath : path.join(repoPath, inputPath);
  const implementationPlan = await fse.readFile(inputAbs, "utf8");

  // Codebase tree (tracked files only) for determinism.
  const tree = await execa("git", ["ls-files"], { cwd: repoPath, stdio: "pipe" });
  const codebaseTree = tree.stdout.trim();

  const resourcesBlock = config.resources
    .map((r) => {
      const desc = r.description ? `: ${r.description}` : "";
      return `- **${r.name}**${desc}\n  - Paths: ${r.paths.join(", ")}`;
    })
    .join("\n");

  const prompt = await renderPromptTemplate("planner", {
    project_name: projectName,
    repo_path: repoPath,
    resources: resourcesBlock,
    doctor_command: config.doctor,
    implementation_plan: implementationPlan,
    codebase_tree: codebaseTree,
  });

  const log = args.log;
  log?.log({ type: "planner.start", payload: { project: projectName, input: inputAbs } });

  // Planner runs via Codex SDK in read-only mode.
  const codexHome = path.join(orchestratorHome(), "codex", projectName, "planner");
  await ensureDir(codexHome);
  await writePlannerCodexConfig(path.join(codexHome, "config.toml"), config.planner.model);

  const codex = new Codex({ env: { CODEX_HOME: codexHome } });
  const thread = codex.startThread({ workingDirectory: repoPath });

  const result = await thread.run(prompt, { outputSchema: PlannerOutputSchema as any });

  let parsed: PlanResult;
  try {
    parsed = JSON.parse(result.finalResponse) as PlanResult;
  } catch (_err) {
    throw new Error(`Planner returned non-JSON output. Raw:\n${result.finalResponse}`);
  }

  if (!parsed.tasks || !Array.isArray(parsed.tasks)) {
    throw new Error(`Planner output did not include tasks[]`);
  }

  log?.log({ type: "planner.complete", payload: { task_count: parsed.tasks.length } });

  if (dryRun) {
    return parsed;
  }

  // Write tasks to disk.
  await ensureDir(outputDir);
  for (const t of parsed.tasks) {
    const dirName = `${t.id}-${slugify(t.name)}`;
    const taskDir = path.join(outputDir, dirName);
    await ensureDir(taskDir);

    const manifest = {
      id: t.id,
      name: t.name,
      description: t.description,
      estimated_minutes: t.estimated_minutes,
      dependencies: t.dependencies,
      locks: t.locks,
      files: t.files,
      affected_tests: t.affected_tests,
      verify: t.verify,
    };

    await fse.writeFile(
      path.join(taskDir, "manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
      "utf8",
    );
    await fse.writeFile(path.join(taskDir, "spec.md"), t.spec.trim() + "\n", "utf8");
  }

  // Also write a top-level plan index.
  await fse.writeFile(
    path.join(outputDir, "_plan.json"),
    JSON.stringify(
      {
        generated_at: isoNow(),
        project: projectName,
        input: inputAbs,
        task_count: parsed.tasks.length,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  log?.log({ type: "planner.write.complete", payload: { output_dir: outputDir } });

  return parsed;
}

async function writePlannerCodexConfig(filePath: string, model: string): Promise<void> {
  const content = [
    `model = "${model}"`,
    // "never" means no approval prompts (the planner runs unattended; sandbox is read-only).
    `approval_policy = "never"`,
    `sandbox_mode = "read-only"`,
    "",
  ].join("\n");
  await fse.ensureDir(path.dirname(filePath));
  await fse.writeFile(filePath, content, "utf8");
}
