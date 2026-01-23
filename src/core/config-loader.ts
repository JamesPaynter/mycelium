import fs from "node:fs";
import path from "node:path";

import yaml from "js-yaml";
import type { ZodIssue } from "zod";

import { ProjectConfigSchema, type ProjectConfig } from "./config.js";
import { normalizeTestPaths, DEFAULT_TEST_PATHS } from "./test-paths.js";
import { ConfigError } from "./errors.js";

type ExpandContext = {
  file: string;
  trail: string[];
};

function expandEnv(value: unknown, ctx: ExpandContext): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_match, varName: string) => {
      const envValue = process.env[varName];
      if (envValue === undefined) {
        const location = ctx.trail.length > 0 ? ctx.trail.join(".") : "<root>";
        throw new ConfigError(
          `Environment variable ${varName} is not set but is referenced in ${ctx.file} (${location}).`,
        );
      }
      return envValue;
    });
  }

  if (Array.isArray(value)) {
    return value.map((item, index) =>
      expandEnv(item, { ...ctx, trail: [...ctx.trail, `${index}`] }),
    );
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        expandEnv(v, { ...ctx, trail: [...ctx.trail, k] }),
      ]),
    );
  }

  return value;
}

function formatIssues(issues: ZodIssue[]): string {
  return issues
    .map((issue) => {
      const location = issue.path.length > 0 ? issue.path.join(".") : "<root>";

      if (issue.code === "invalid_type") {
        return `${location}: Expected ${issue.expected}, received ${issue.received}`;
      }
      if (issue.code === "invalid_enum_value") {
        const options = issue.options.map((o) => JSON.stringify(o)).join(", ");
        return `${location}: Expected one of ${options}, received ${JSON.stringify(issue.received)}`;
      }
      if (issue.code === "unrecognized_keys") {
        return `${location}: Unrecognized keys: ${issue.keys.join(", ")}`;
      }

      return `${location}: ${issue.message}`;
    })
    .join("\n");
}

export function loadProjectConfig(configPath: string): ProjectConfig {
  const absolutePath = path.resolve(configPath);
  if (!fs.existsSync(absolutePath)) {
    throw new ConfigError(`Project config not found at: ${absolutePath}`);
  }

  let raw: string;
  try {
    raw = fs.readFileSync(absolutePath, "utf8");
  } catch (err) {
    throw new ConfigError(`Failed to read project config at ${absolutePath}`, err);
  }

  let doc: unknown;
  try {
    doc = yaml.load(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ConfigError(`Failed to parse YAML config at ${absolutePath}: ${detail}`, err);
  }

  const expanded = expandEnv(doc, { file: absolutePath, trail: [] });

  const parsed = ProjectConfigSchema.safeParse(expanded);
  if (!parsed.success) {
    const details = formatIssues(parsed.error.issues);
    throw new ConfigError(`Invalid project config at ${absolutePath}:\n${details}`, parsed.error);
  }

  const cfg = parsed.data;
  const configDir = path.dirname(absolutePath);
  const normalizedTestPaths = normalizeTestPaths(cfg.test_paths);

  // Normalize relative paths against the config directory for portability.
  return {
    ...cfg,
    test_paths: normalizedTestPaths.length > 0 ? normalizedTestPaths : DEFAULT_TEST_PATHS,
    repo_path: path.resolve(configDir, cfg.repo_path),
    docker: {
      ...cfg.docker,
      dockerfile: path.resolve(configDir, cfg.docker.dockerfile),
      build_context: path.resolve(configDir, cfg.docker.build_context),
    },
  };
}
