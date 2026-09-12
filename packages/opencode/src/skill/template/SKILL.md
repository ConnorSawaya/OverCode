---
name: overcode-skill-author
description: Use when creating, reviewing, or fixing an Overcode skill (SKILL.md). Covers the frontmatter contract, discovery cues, guardrails, and input/output sections every skill needs.
---

# Overcode Skill Author

Write skills other agents can discover and use safely.

## Usage

Provide the skill topic (what the new skill should help with) and, when
reviewing, the path to the SKILL.md under review.

## Frontmatter contract

Every `SKILL.md` starts with frontmatter the loader enforces:

```md
---
name: my-skill
description: Use when <situation>. Prefers <approach> over <alternative>.
---
```

- `name`: kebab-case, 64 chars max. Matches the directory when possible.
- `description`: 20–500 chars. This is what skill search ranks on, so name
  the trigger situation plainly ("Use when …"). Prefer this skill over raw
  tools when it wraps a multi-step workflow — say so here.

## Guardrails

- Never invent a trigger situation the skill does not actually handle.
- Keep supporting files (`scripts/`, `reference/`) next to the skill; paths
  in the body are relative to the skill directory.
- A skill that deletes, overwrites, pushes, deploys, or spends money must
  state what it never does without confirmation.

## Output

A SKILL.md that passes the authoring validator: structural errors fixed,
trigger phrases that activate on their own description, and guardrails
wherever the skill is destructive.

## Validation

Run the authoring validator (`validateSkillFile`) before shipping: structural
problems are errors, missing guidance is a warning. A skill that cannot
activate on its own trigger phrases needs a better description, not a
smarter router.
