import path from "node:path";
import fse from "fs-extra";
import { execa } from "execa";
import { Codex } from "@openai/codex-sdk";

import type { ProjectConfig } from "./config.js";
import { slugify, ensureDir, isoNow } from "./utils.js";
import { JsonlLogger, eventWithTs } from "./logger.js";
import { orchestratorHome } from "./paths.js";

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
              writes: { type: "array", items: { type: "string" } }
            },
            required: ["reads", "writes"],
            additionalProperties: false
          },
          files: {
            type: "object",
            properties: {
              reads: { type: "array", items: { type: "string" } },
              writes: { type: "array", items: { type: "string" } }
            },
            required: ["reads", "writes"],
            additionalProperties: false
          },
          affected_tests: { type: "array", items: { type: "string" } },
          verify: {
            type: "object",
            properties: {
              doctor: { type: "string" },
              fast: { type: "string" }
            },
            required: ["doctor"],
            additionalProperties: false
          },
          spec: { type: "string" }
        },
        required: ["id", "name", "description", "estimated_minutes", "locks", "files", "affected_tests", "verify", "spec"],
        additionalProperties: false
      }
    }
  },
  required: ["tasks"],
  additionalProperties: false
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

  const prompt = buildPlannerPrompt({
    projectName,
    repoPath,
    resourcesBlock,
    doctor: config.doctor,
    implementationPlan,
    codebaseTree
  });

  const log = args.log;
  log?.log(eventWithTs({ type: "planner.start", project: projectName, input: inputAbs }));

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
  } catch (err) {
    throw new Error(`Planner returned non-JSON output. Raw:\n${result.finalResponse}`);
  }

  if (!parsed.tasks || !Array.isArray(parsed.tasks)) {
    throw new Error(`Planner output did not include tasks[]`);
  }

  log?.log(eventWithTs({ type: "planner.complete", task_count: parsed.tasks.length }));

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
      verify: t.verify
    };

    await fse.writeFile(path.join(taskDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
    await fse.writeFile(path.join(taskDir, "spec.md"), t.spec.trim() + "\n", "utf8");
  }

  // Also write a top-level plan index.
  await fse.writeFile(
    path.join(outputDir, "_plan.json"),
    JSON.stringify({ generated_at: isoNow(), project: projectName, input: inputAbs, task_count: parsed.tasks.length }, null, 2) + "\n",
    "utf8"
  );

  log?.log(eventWithTs({ type: "planner.write.complete", output_dir: outputDir }));

  return parsed;
}

function buildPlannerPrompt(args: {
  projectName: string;
  repoPath: string;
  resourcesBlock: string;
  doctor: string;
  implementationPlan: string;
  codebaseTree: string;
}): string {
  return `You are a planning agent. Your job is to convert an implementation plan into structured, executable tickets.

## Context

Project: ${args.projectName}
Repository: ${args.repoPath}

## Project Resources

This project has the following resources. Each ticket must declare which resources it reads and writes:

${args.resourcesBlock}

## Your Task

Given the implementation plan below, output a JSON object with this exact schema:

{\n  "tasks": [\n    {\n      "id": "001",\n      "name": "short-kebab-case-name",\n      "description": "One sentence description",\n      "estimated_minutes": 15,\n      "locks": {\n        "reads": ["resource-name"],\n        "writes": ["resource-name"]\n      },\n      "files": {\n        "reads": ["path/to/file"],\n        "writes": ["path/to/file"]\n      },\n      "affected_tests": ["path/to/test"],\n      "verify": {\n        "doctor": "${args.doctor}",\n        "fast": "pytest path/to/specific_test.py -x"\n      },\n      "spec": "Full markdown specification for this task..."\n    }\n  ]\n}

## Rules

1. Task size: Each task should be completable in 15-60 minutes. If larger, split it.
2. Independence: Each task must be an independent unit of work.
3. File declarations: Declare ALL files the task reads, including imports and dependencies.
4. Resource locks: Map file paths to the project resources. When in doubt, be conservative.
5. Task ordering: Include dependencies via a "dependencies" array when ordering matters.
6. Spec detail: Include exact file paths, symbol names, patterns to follow, edge cases, and verification.
7. Test coverage: Identify affected tests. If new tests are needed, specify them.

## Implementation Plan

<implementation-plan>
${args.implementationPlan}
</implementation-plan>

## Current Codebase Structure

<codebase>
${args.codebaseTree}
</codebase>

Output only valid JSON. No explanation or commentary.`;
}

async function writePlannerCodexConfig(filePath: string, model: string): Promise<void> {
  const content = [
    `model = "${model}"`,
    // "never" means no approval prompts (the planner runs unattended; sandbox is read-only).
    `approval_policy = "never"`,
    `sandbox_mode = "read-only"`,
    ""
  ].join("\n");
  await fse.ensureDir(path.dirname(filePath));
  await fse.writeFile(filePath, content, "utf8");
}
