import fs from "node:fs";
import path from "node:path";

const REQUIRED_FILES = [
  { path: "notes/release-notes.txt", description: "release notes", task: "001" },
  { path: "src/feature.txt", description: "feature tracker", task: "002" },
];

function fileHasMockUpdate(targetPath, description) {
  const fullPath = path.join(process.cwd(), targetPath);
  if (!fs.existsSync(fullPath)) {
    console.error(`Missing ${description} file at ${targetPath}`);
    return false;
  }

  const content = fs.readFileSync(fullPath, "utf8");
  if (!content.includes("Mock update")) {
    console.error(`Expected mock update marker in ${targetPath}`);
    return false;
  }

  return true;
}

function main() {
  const taskId = process.env.TASK_ID;
  const targets =
    taskId === undefined
      ? REQUIRED_FILES
      : (REQUIRED_FILES.filter((entry) => entry.task === taskId) ?? REQUIRED_FILES);

  const failures = targets.filter((entry) => !fileHasMockUpdate(entry.path, entry.description));

  if (failures.length > 0) {
    process.exit(1);
  }

  console.log("Doctor passed: mock updates detected in target files.");
}

main();
