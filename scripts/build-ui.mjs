import { spawn } from "node:child_process";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// =============================================================================
// ENTRYPOINT
// =============================================================================

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = findPackageRoot(scriptDir);

const sourceDir = path.join(packageRoot, "src", "ui", "static");
const targetDir = path.join(packageRoot, "dist", "ui");

await buildUiAssets(sourceDir, targetDir);
await buildGroveAssets(packageRoot);

// =============================================================================
// HELPERS
// =============================================================================

async function buildUiAssets(source, target) {
  if (!fs.existsSync(source)) {
    throw new Error(`UI static source not found: ${source}`);
  }

  // Clear the target so removed assets do not linger between builds.
  await fsPromises.rm(target, { recursive: true, force: true });
  await fsPromises.mkdir(target, { recursive: true });

  const entries = await fsPromises.readdir(source, { withFileTypes: true });
  await Promise.all(
    entries.map((entry) =>
      fsPromises.cp(path.join(source, entry.name), path.join(target, entry.name), {
        recursive: true,
      }),
    ),
  );
}

// =============================================================================
// GROVE BUILD
// =============================================================================

async function buildGroveAssets(packageRoot) {
  const groveDir = path.join(packageRoot, "src", "ui", "grove");
  const grovePackageJson = path.join(groveDir, "package.json");
  if (!fs.existsSync(grovePackageJson)) {
    return;
  }

  const groveNodeModules = path.join(groveDir, "node_modules");
  if (!fs.existsSync(groveNodeModules)) {
    throw new Error("Grove UI dependencies not installed. Run: npm --prefix src/ui/grove install");
  }

  await runCommand(npmCommand(), ["run", "build"], { cwd: groveDir });
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function runCommand(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      ...options,
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
    });
  });
}

// =============================================================================
// PACKAGE ROOT
// =============================================================================

function findPackageRoot(startDir) {
  let current = startDir;

  while (true) {
    const candidate = path.join(current, "package.json");
    if (fs.existsSync(candidate)) return current;

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  throw new Error("package.json not found while resolving UI build root");
}
