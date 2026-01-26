export type MyceliumGitignoreOptions = {
  includeSessions?: boolean;
};

export function buildMyceliumGitignore(options: MyceliumGitignoreOptions = {}): string {
  const entries = buildEntries(options);
  const lines = [
    "# Managed by Mycelium. Edit this file if you need different repo hygiene.",
    ...entries,
    "",
  ];
  return lines.join("\n");
}

function buildEntries(options: MyceliumGitignoreOptions): string[] {
  const entries = ["logs/", "state/", "workspaces/", "codex/", "projects/"];

  if (options.includeSessions ?? true) {
    entries.push("planning/sessions/");
  }

  return Array.from(new Set(entries)).sort();
}
