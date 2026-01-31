import { describe, expect, it } from "vitest";

import { buildDeveloperPrompt } from "./loop-prompts.js";

describe("buildDeveloperPrompt control graph guidance", () => {
  it("includes deterministic mycelium cg commands and fallback guidance", () => {
    const prompt = buildDeveloperPrompt({
      spec: "Spec",
      manifest: { id: "PROMPT1", name: "Prompt test" },
      manifestPath: "manifest.json",
    });

    expect(prompt).toContain("mycelium cg owner <path> --json --repo .");
    expect(prompt).toContain("mycelium cg symbols find <query> --json --repo .");
    expect(prompt).toContain("mycelium cg symbols def <symbol_id> --json --repo .");
    expect(prompt).toContain("mycelium cg components list --json --repo .");
    expect(prompt).toContain("fall back");
    expect(prompt).toContain("grep");
  });
});
