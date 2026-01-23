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
