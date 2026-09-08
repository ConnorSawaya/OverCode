import { describe, expect, test } from "bun:test"
import { goalFromMetadata, goalToMetadata, goalProgress, parseGoalCommand } from "./session-goal"

test("reads AI completion and blockers from shared goal state", () => {
  const goal = { objective: "Ship the app", status: "complete", evidence: "Build passed", createdAt: "2026-09-05T00:00:00Z", updatedAt: "2026-09-05T01:00:00Z" }
  expect(goalFromMetadata(goal)?.status).toBe("completed")
  expect(goalFromMetadata({ ...goal, status: "blocked", reason: "Need credentials" })?.reason).toBe("Need credentials")
  expect(goalFromMetadata(null)).toBeUndefined()
  expect(goalFromMetadata({ ...goal, status: "invalid" })).toBeUndefined()
  const item = goalFromMetadata(goal)!
  expect(goalFromMetadata(goalToMetadata(item, "C:/Project"))).toEqual({ ...item, remaining: item.title, reason: "" })
})

describe("parseGoalCommand", () => {
  test("accepts a goal title with extra whitespace", () => {
    expect(parseGoalCommand("  /goal   Ship the desktop build  ")).toBe("Ship the desktop build")
  })

  test("accepts an empty goal command so the caller can show guidance", () => {
    expect(parseGoalCommand("/goal")).toBe("")
  })

  test("does not treat other slash commands as goals", () => {
    expect(parseGoalCommand("/goals Ship it")).toBeUndefined()
  })
})

describe("goalProgress", () => {
  test("counts completed todo steps", () => {
    expect(
      goalProgress([
        { status: "completed" },
        { status: "in_progress" },
        { status: "pending" },
      ]),
    ).toEqual({ total: 3, done: 1, percent: 1 / 3, complete: false })
  })

  test("does not complete an empty goal", () => {
    expect(goalProgress([])).toEqual({ total: 0, done: 0, percent: 0, complete: false })
  })
})
