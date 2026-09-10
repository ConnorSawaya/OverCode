import { expect, test } from "bun:test"
import { computerUseAudit } from "./computer-use-audit"

test("computer audit never includes typed secrets, key contents or screenshot bytes", () => {
  const value = computerUseAudit(
    { action: "type", text: "secret password", key: "secret chord", frameId: "frame-1" },
    { frameId: "frame-2", image: "data:image/jpeg;base64,sensitive" },
  )
  expect(value).toEqual({ action: "type", coordinates: {}, frameId: "frame-2", characters: 15, stopped: false })
  expect(JSON.stringify(value)).not.toContain("secret")
  expect(JSON.stringify(value)).not.toContain("sensitive")
})

test("computer audit retains action and safe normalized coordinates", () => {
  expect(computerUseAudit({ action: "drag", x: 0, y: 1000, endX: 300, endY: 400 }, { stopped: true })).toEqual({
    action: "drag",
    coordinates: { x: 0, y: 1000, endX: 300, endY: 400 },
    frameId: undefined,
    characters: undefined,
    stopped: true,
  })
  expect(computerUseAudit({ action: "secret", x: -1, y: 1001, endX: NaN, endY: "secret" }, {}).coordinates).toEqual({})
  expect(computerUseAudit({ action: "secret" }, {}).action).toBe("unknown")
})
