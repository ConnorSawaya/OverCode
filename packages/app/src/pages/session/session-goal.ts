export type SessionGoalStatus = "active" | "paused" | "blocked" | "completed" | "stopped"

export type SessionGoal = {
  id: string
  title: string
  status: SessionGoalStatus
  createdAt: number
  updatedAt: number
  initialTodoCount?: number
  initialCompletedTodos?: number
  iteration?: number
  maxIterations?: number
  evidence?: string
  remaining?: string
  reason?: string
  pendingMessageID?: string
}

export function goalFromMetadata(value: unknown): SessionGoal | undefined {
  if (!value || typeof value !== "object") return
  const item = value as Record<string, unknown>
  if (typeof item.objective !== "string" || typeof item.status !== "string") return
  const status = item.status === "complete" ? "completed" : item.status
  if (!["active", "paused", "blocked", "completed", "stopped"].includes(status)) return
  const createdAt = typeof item.createdAt === "string" ? Date.parse(item.createdAt) : Number(item.createdAt)
  const updatedAt = typeof item.updatedAt === "string" ? Date.parse(item.updatedAt) : Number(item.updatedAt)
  return {
    id: typeof item.id === "string" ? item.id : `goal-${createdAt}`,
    title: item.objective,
    status: status as SessionGoalStatus,
    createdAt: Number.isFinite(createdAt) ? createdAt : 0,
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
    iteration: typeof item.iteration === "number" ? item.iteration : 0,
    maxIterations: typeof item.maxIterations === "number" ? item.maxIterations : 20,
    evidence: typeof item.evidence === "string" ? item.evidence : undefined,
    remaining: typeof item.remaining === "string" ? item.remaining : undefined,
    reason: typeof item.reason === "string" ? item.reason : undefined,
    pendingMessageID: typeof item.pendingMessageID === "string" ? item.pendingMessageID : undefined,
  }
}

export function goalToMetadata(goal: SessionGoal, directory: string) {
  return {
    id: goal.id,
    objective: goal.title,
    status: goal.status,
    createdAt: new Date(goal.createdAt).toISOString(),
    updatedAt: new Date(goal.updatedAt).toISOString(),
    iteration: goal.iteration ?? 0,
    maxIterations: goal.maxIterations ?? 20,
    evidence: goal.evidence ?? "",
    remaining: goal.remaining ?? goal.title,
    reason: goal.reason ?? "",
    pendingMessageID: goal.pendingMessageID ?? null,
    directory,
  }
}

export type GoalTodo = { status: string }

export function parseGoalCommand(value: string) {
  const match = value.trim().match(/^\/goal(?:\s+([\s\S]*))?$/i)
  if (!match) return undefined
  return match[1]?.trim() ?? ""
}

export function goalProgress(todos: GoalTodo[]) {
  const total = todos.length
  const done = todos.filter((todo) => todo.status === "completed").length
  return {
    total,
    done,
    percent: total === 0 ? 0 : done / total,
    complete: total > 0 && done === total,
  }
}
