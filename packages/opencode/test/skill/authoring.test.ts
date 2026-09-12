import { describe, expect, test } from "bun:test";
import path from "path";
import { ConfigMarkdown } from "@/config/markdown";
import { validateSkillFile } from "@/skill/authoring";

const TEMPLATE = path.join(import.meta.dir, "../../src/skill/template/SKILL.md");

describe("skill authoring contract", () => {
  test("the bundled template passes its own validator", async () => {
    const parsed = await ConfigMarkdown.parse(TEMPLATE);
    const result = validateSkillFile({
      path: TEMPLATE,
      name: (parsed.data as Record<string, unknown>).name,
      description: (parsed.data as Record<string, unknown>).description,
      content: parsed.content,
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test("structural problems are errors", () => {
    expect(validateSkillFile({ path: "x", name: "Bad Name!", description: "short", content: "" }).errors).toEqual([
      'frontmatter.name "Bad Name!" must be kebab-case (a-z, 0-9, dashes)',
      "frontmatter.description must be at least 20 characters",
      "SKILL.md body must not be empty",
    ]);
    expect(validateSkillFile({ path: "x", name: undefined, description: undefined, content: "ok".repeat(30) }).errors).toContain(
      "frontmatter.name is required",
    );
  });

  test("missing guidance is a warning, not an error", () => {
    const result = validateSkillFile({
      path: "x",
      name: "my-skill",
      description: "A skill that does things to stuff in places.",
      content: "# My skill\n\n".concat("Body text. ".repeat(20)),
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings.some((w) => w.includes("use when"))).toBe(true);
  });

  test("destructive skills without guardrails are flagged", () => {
    const result = validateSkillFile({
      path: "x",
      name: "cleaner",
      description: "Use when disk space runs low and cleanup is needed.",
      content: "# Cleaner\n\n## Usage\n\nProvide a path.\n\n## Output\n\nRemoved files.\n\nRuns rm -rf on caches. ".repeat(5),
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings.some((w) => w.includes("Guardrails"))).toBe(true);
  });
});
