import { describe, expect, test } from "bun:test";
import { scoreSkill, suggestSkills, tokenize } from "@/skill/activation";

const SKILLS = [
  { name: "customize-opencode", description: "Use ONLY when editing opencode configuration files and plugins" },
  { name: "overcode-skill-author", description: "Use when creating, reviewing, or fixing an Overcode skill" },
  { name: "deploy-preview", description: "Use when deploying a preview build to check visual changes" },
];

describe("skill activation", () => {
  test("tokenize drops stopwords and single chars", () => {
    expect(tokenize("Use the SKILL when editing a config!")).toEqual(["skill", "editing", "config"]);
  });

  test("name hits outrank description hits", () => {
    const nameHit = scoreSkill({ name: "deploy-preview", description: "something else entirely" }, "deploy preview");
    const descHit = scoreSkill({ name: "other-thing", description: "deploy preview workflow steps" }, "deploy preview");
    expect(nameHit).toBeGreaterThan(descHit);
  });

  test("exact phrases score higher than scattered tokens", () => {
    const phrase = scoreSkill({ name: "x", description: "steps for fixing skill activation" }, "fixing skill");
    const scattered = scoreSkill({ name: "x", description: "fixing typos is a skill anyone learns" }, "fixing skill");
    expect(phrase).toBeGreaterThan(scattered);
  });

  test("suggest ranks the right skill first", () => {
    const ranked = suggestSkills(SKILLS, "how do I create a new skill file");
    expect(ranked[0]?.name).toBe("overcode-skill-author");
  });

  test("suggest drops zero-score skills and is stable on ties", () => {
    const ranked = suggestSkills(SKILLS, "opencode configuration plugins");
    expect(ranked.map((item) => item.name)).toEqual(["customize-opencode"]);
    const tied = suggestSkills(
      [
        { name: "b-skill", description: "shared words here" },
        { name: "a-skill", description: "shared words here" },
      ],
      "shared words",
    );
    expect(tied.map((item) => item.name)).toEqual(["b-skill", "a-skill"]);
  });

  test("empty query scores nothing", () => {
    expect(suggestSkills(SKILLS, "   ")).toEqual([]);
    expect(suggestSkills(SKILLS, "   ", 5, true)).toHaveLength(3);
  });

  test("limit is honored", () => {
    expect(suggestSkills(SKILLS, "use when", 1, true)).toHaveLength(1);
  });
});
