import { describe, expect, test } from "bun:test"
import { compareSyncConflictClocks, eventTime, importedEventWins } from "./conflict"

describe("sync conflict ordering", () => {
  test("uses stable IDs when event times tie", () => {
    expect(compareSyncConflictClocks({ time: 10, id: "b" }, { time: 10, id: "a" })).toBeGreaterThan(0)
    expect(importedEventWins({ time: 10, id: "b" }, [{ id: "a", data: { timestamp: 10 } }])).toBe(true)
  })

  test("extracts session and project mutation times", () => {
    expect(eventTime({ info: { time: { updated: 12 } } })).toBe(12)
    expect(eventTime({ time: { updated: 13 } })).toBe(13)
    expect(eventTime({ timestamp: 14 })).toBe(14)
  })

  test("does not let an older imported tombstone delete a newer edit", () => {
    expect(importedEventWins({ time: 10, id: "delete" }, [{ id: "edit", data: { timestamp: 20 } }])).toBe(false)
  })
})
