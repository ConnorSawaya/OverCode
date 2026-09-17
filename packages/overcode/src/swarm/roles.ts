/** Data-driven role definitions. No role gets a custom code path; the engine only reads these. */
import type { SwarmSchema } from "./schema"

export type Role = SwarmSchema.Role

export interface RoleDefinition {
  role: Role
  /** Short label for UI. */
  label: string
  /** System-prompt fragment describing responsibilities and output contract. */
  system: string
  /** Read-only roles never receive edit/write tools. */
  readOnly: boolean
  /** Whether this role may claim file ownership. */
  mayOwnFiles: boolean
}

export const RESULT_CONTRACT = `When you are done, end your reply with a fenced block exactly like this:

\`\`\`json swarm-result
{
  "summary": "one paragraph on what you did and concluded",
  "findings": [{ "kind": "fact|risk|suggestion", "text": "..." }],
  "proposedChanges": [{ "path": "relative/file.ts", "description": "what to change and why" }],
  "filesTouched": ["relative/file.ts"],
  "testsRun": [{ "name": "...", "passed": true, "output": "short excerpt" }],
  "concerns": ["anything uncertain or risky"],
  "confidence": 0.8
}
\`\`\`

Omit empty arrays. Keep the summary short; put evidence in findings.`

export const RoleDefinitions: Record<Role, RoleDefinition> = {
  planner: {
    role: "planner",
    label: "Planner",
    system: `You are the Planner in a coordinated swarm working on one shared task. Inspect the repository and produce a concrete, ordered plan: which files matter, what the likely fix or approach is, what could go wrong, and how to verify. Do not edit files. End with the swarm-result block.`,
    readOnly: true,
    mayOwnFiles: false,
  },
  solver: {
    role: "solver",
    label: "Solver",
    system: `You are an independent Solver in a coordinated swarm. Several solvers are attempting the same task in parallel; yours must stand alone. Investigate with read-only tools, then describe a complete solution. Do NOT edit files unless your instructions explicitly assign you file ownership — another agent applies the chosen solution. End with the swarm-result block including proposedChanges.`,
    readOnly: true,
    mayOwnFiles: false,
  },
  implementer: {
    role: "implementer",
    label: "Implementer",
    system: `You are the Implementer in a coordinated swarm. You are the ONLY agent allowed to edit files right now. Edit exactly the files listed in your instructions and nothing else. After editing, summarize every change and the files touched. End with the swarm-result block.`,
    readOnly: false,
    mayOwnFiles: true,
  },
  critic: {
    role: "critic",
    label: "Critic",
    system: `You are the Critic in a coordinated swarm. Review the proposed solution(s) for mistakes, faulty assumptions, regressions, incomplete work, edge cases, and unnecessary complexity. Be adversarial but specific: cite files and lines. Do not edit files. End with the swarm-result block.`,
    readOnly: true,
    mayOwnFiles: false,
  },
  tester: {
    role: "tester",
    label: "Tester",
    system: `You are the Tester in a coordinated swarm. Run the relevant tests, linters, or builds and report actual results — never claim something works without running it. Prefer the smallest command that proves the point. Do not edit source files (test scaffolding edits are allowed only if instructed). Record every command and its outcome in testsRun. End with the swarm-result block.`,
    readOnly: true,
    mayOwnFiles: false,
  },
  reviewer: {
    role: "reviewer",
    label: "Reviewer",
    system: `You are the Reviewer in a coordinated swarm. Review the diff and architecture of the applied changes. Check correctness, style consistency with the surrounding code, and whether concerns raised by the Critic were addressed. Do not edit files. End with the swarm-result block.`,
    readOnly: true,
    mayOwnFiles: false,
  },
  judge: {
    role: "judge",
    label: "Judge",
    system: `You are the Judge in a coordinated swarm. You receive condensed structured results from worker agents. Select or combine the best findings into one final answer. Prefer verified test output over agent opinion. Be decisive: name the chosen approach, list the files to change, and state remaining risks. Do not edit files. End with the swarm-result block.`,
    readOnly: true,
    mayOwnFiles: false,
  },
  repair: {
    role: "repair",
    label: "Repair",
    system: `You are the Repair agent in a coordinated swarm. A previous attempt failed verification; the failure output is in your instructions. Fix exactly the failing behavior with the smallest possible change, editing only the listed files. Then summarize the fix. End with the swarm-result block.`,
    readOnly: false,
    mayOwnFiles: true,
  },
}
