import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import fse from "fs-extra";
import Handlebars from "handlebars";

// =============================================================================
// TYPES
// =============================================================================

export type PromptTemplateName =
  | "planner"
  | "test-validator"
  | "style-validator"
  | "doctor-validator";

export type PromptTemplateValues = Record<string, string>;

// =============================================================================
// PUBLIC API
// =============================================================================

export async function renderPromptTemplate(
  name: PromptTemplateName,
  values: PromptTemplateValues,
): Promise<string> {
  const template = await loadTemplate(name);
  const output = template(values).trim();

  if (/\{\{[^}]+\}\}/.test(output)) {
    throw new Error(`Unresolved placeholder(s) remain in ${name} prompt output`);
  }

  return output;
}

// =============================================================================
// INTERNALS
// =============================================================================

const TEMPLATE_CACHE = new Map<PromptTemplateName, Handlebars.TemplateDelegate>();

async function loadTemplate(name: PromptTemplateName): Promise<Handlebars.TemplateDelegate> {
  const cached = TEMPLATE_CACHE.get(name);
  if (cached) return cached;

  const templatePath = await resolveTemplatePath(name);
  const raw = await fse.readFile(templatePath, "utf8");
  const compiled = Handlebars.compile(raw, { noEscape: true, strict: true });

  TEMPLATE_CACHE.set(name, compiled);
  return compiled;
}

async function resolveTemplatePath(name: PromptTemplateName): Promise<string> {
  const promptsDir = await resolvePromptsDir();
  const templatePath = path.join(promptsDir, `${name}.md`);
  const exists = await fse.pathExists(templatePath);
  if (!exists) {
    throw new Error(`Prompt template not found: ${templatePath}`);
  }
  return templatePath;
}

async function resolvePromptsDir(): Promise<string> {
  const packageRoot = findPackageRoot(fileURLToPath(new URL(".", import.meta.url)));
  return path.join(packageRoot, "templates", "prompts");
}

// Walk upward until we find the repo root so compiled builds resolve templates correctly.
function findPackageRoot(startDir: string): string {
  let current = startDir;

  while (true) {
    const candidate = path.join(current, "package.json");
    if (fs.existsSync(candidate)) return current;

    const parent = path.dirname(current);
    if (parent === current) break;

    current = parent;
  }

  throw new Error("package.json not found while resolving prompts directory");
}
