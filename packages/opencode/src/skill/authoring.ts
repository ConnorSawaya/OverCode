// Overcode skill authoring contract (validator + template).
//
// A skill is a SKILL.md with frontmatter {name, description} plus a body the
// model reads on load. GoodBarber-style lessons encoded here:
// - description carries a "use when" discovery cue (warning, not error),
// - guardrails section for mutating skills (warning when absent and the body
//   mentions destructive verbs),
// - input/output contract section (warning when absent).
// Errors are structural (loader would choke); warnings are quality coaching.

export type SkillFileInput = {
  path: string;
  name: unknown;
  description: unknown;
  content: unknown;
};

export type SkillValidation = {
  errors: string[];
  warnings: string[];
};

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DESTRUCTIVE_VERBS = ["delete", "drop", "remove", "destroy", "overwrite", "force-push", "reset --hard", "rm -rf"];

export function validateSkillFile(input: SkillFileInput): SkillValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (typeof input.name !== "string" || !input.name) {
    errors.push("frontmatter.name is required");
  } else {
    if (!NAME_PATTERN.test(input.name)) errors.push(`frontmatter.name "${input.name}" must be kebab-case (a-z, 0-9, dashes)`);
    if (input.name.length > 64) errors.push("frontmatter.name must be 64 characters or fewer");
  }

  if (typeof input.description !== "string" || !input.description.trim()) {
    errors.push("frontmatter.description is required");
  } else {
    const description = input.description.trim();
    if (description.length < 20) errors.push("frontmatter.description must be at least 20 characters");
    if (description.length > 500) errors.push("frontmatter.description must be 500 characters or fewer");
    if (!/\b(when|use|for|if)\b/i.test(description)) {
      warnings.push("frontmatter.description should say when to use the skill (a 'use when' cue)");
    }
  }

  if (typeof input.content !== "string" || !input.content.trim()) {
    errors.push("SKILL.md body must not be empty");
    return { errors, warnings };
  }
  const body = input.content;
  if (body.trim().length < 50) errors.push("SKILL.md body is too short to be useful (minimum 50 characters)");

  const lower = body.toLowerCase();
  const destructive = DESTRUCTIVE_VERBS.some((verb) => lower.includes(verb));
  if (destructive && !/^#{1,3}\s*guardrails/im.test(body)) {
    warnings.push("skill mentions destructive actions but has no Guardrails section");
  }
  if (!/^#{1,3}\s*(input|inputs|usage|contract)/im.test(body)) {
    warnings.push("consider an Input/Usage section so callers know what to provide");
  }
  if (!/^#{1,3}\s*(output|outputs|result|returns)/im.test(body)) {
    warnings.push("consider an Output section so callers know what to expect");
  }
  return { errors, warnings };
}
