import { PermissionV1 } from "@overcode-ai/core/v1/permission"
import type { Agent } from "./agent"

/**
 * Build the `permission` ruleset for a subagent's session when it's spawned
 * via the task tool. Combines:
 *
 * 1. The parent session's deny rules and external_directory rules.
 *    Parent agent restrictions only govern that agent; the subagent's own
 *    permissions determine its capabilities.
 * 2. Default `todowrite` and `task` denies if the subagent's own ruleset
 *    doesn't already permit them.
 */
export function deriveSubagentSessionPermission(input: {
  parentSessionPermission: PermissionV1.Ruleset
  subagent: Agent.Info
}): PermissionV1.Ruleset {
  // A narrow deny (for example `task: { general: "deny" }`) does not permit
  // the tool; only a non-deny rule does. Otherwise a restrictive rule would
  // suppress the catch-all deny and let the subagent bypass it.
  const permitted = (permission: string) =>
    input.subagent.permission.some((rule) => rule.permission === permission && rule.action !== "deny")
  const canTask = permitted("task")
  const canTodo = permitted("todowrite")
  return [
    ...input.parentSessionPermission.filter(
      (rule) => rule.permission === "external_directory" || rule.action === "deny",
    ),
    ...(canTodo ? [] : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
    ...(canTask ? [] : [{ permission: "task" as const, pattern: "*" as const, action: "deny" as const }]),
  ]
}
