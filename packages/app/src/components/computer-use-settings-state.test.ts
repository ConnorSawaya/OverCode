import { describe, expect, test } from "bun:test"
import type { ComputerUsePlatform, ComputerUseState } from "@/computer-use"
import { COMPUTER_USE_COLORS, computerUseColor, createComputerUseSettings } from "./computer-use-settings-state"

const grantID = "4b642151-b115-4c31-99f4-f0632eb44d4a"

function fixture() {
  let value: ComputerUseState = { available: true, phase: "idle", color: "#38BDF8" }
  const listeners = new Set<(state: ComputerUseState) => void>()
  const saved: string[] = []
  const stopped: (string | undefined)[] = []
  const platform: ComputerUsePlatform = {
    state: async () => value,
    start: async () => {
      throw new Error("settings must never grant access")
    },
    stop: async (sessionID) => {
      stopped.push(sessionID)
      value = { ...value, phase: "idle", sessionID: undefined, grantID: undefined }
      return value
    },
    setColor: async (color) => {
      saved.push(color)
      value = { ...value, color }
      return value
    },
    onState: (callback) => {
      listeners.add(callback)
      return () => {
        listeners.delete(callback)
      }
    },
  }
  return {
    platform,
    saved,
    stopped,
    listeners,
    emit(state: ComputerUseState) {
      value = state
      listeners.forEach((listener) => listener(state))
    },
  }
}

describe("computer-use color settings", () => {
  test.each(["#FFF", "#ffffff00", "transparent", "rgba(0,0,0,0)", "#GGFF00", "red", ""])(
    "rejects invalid or transparent color: %s",
    (color) => {
      expect(computerUseColor(color)).toBeUndefined()
    },
  )
  test("normalizes only opaque RGB colors, including all swatches", () => {
    expect(computerUseColor(" #ab12ef ")).toBe("#AB12EF")
    expect(COMPUTER_USE_COLORS.every((color) => computerUseColor(color) === color)).toBe(true)
  })
  test("loads persisted color and saves through the desktop API", async () => {
    const native = fixture()
    const controller = createComputerUseSettings(native.platform)
    expect(controller.state.loading).toBe(true)
    await controller.refresh()
    expect(controller.state.color).toBe("#38BDF8")
    controller.editColor("#ab12ef")
    expect(await controller.saveColor()).toBe(true)
    expect(native.saved).toEqual(["#AB12EF"])
    expect(controller.state.dirty).toBe(false)
    expect(controller.state.color).toBe("#AB12EF")
    controller.dispose()
    const reopened = createComputerUseSettings(native.platform)
    await reopened.refresh()
    expect(reopened.state.color).toBe("#AB12EF")
    reopened.dispose()
    expect(native.listeners.size).toBe(0)
  })
  test("does not persist invalid input or replace unsaved input on native updates", async () => {
    const native = fixture()
    const controller = createComputerUseSettings(native.platform)
    await controller.refresh()
    controller.editColor("#12345600")
    native.emit({ available: true, phase: "active", color: "#38BDF8", sessionID: "session-current", grantID })
    expect(controller.state.color).toBe("#12345600")
    expect(await controller.saveColor()).toBe(false)
    expect(native.saved).toEqual([])
    expect(controller.state.invalid).toBe(true)
    controller.dispose()
  })
  test("stop is available only for active access and captures the owning session", async () => {
    const native = fixture()
    const controller = createComputerUseSettings(native.platform)
    await controller.refresh()
    await controller.stop()
    expect(native.stopped).toEqual([])
    native.emit({ available: true, phase: "active", color: "#38BDF8", sessionID: "session-current", grantID })
    await controller.stop()
    expect(native.stopped).toEqual(["session-current"])
    expect(controller.state.value?.phase).toBe("idle")
    expect(controller.state.value?.grantID).toBeUndefined()
    controller.dispose()
  })

  test("native stopping disables color changes and repeated Stop until idle", async () => {
    const native = fixture()
    const controller = createComputerUseSettings(native.platform)
    await controller.refresh()
    native.emit({ available: true, phase: "stopping", color: "#38BDF8", sessionID: "session-current", grantID })
    expect(controller.colorDisabled()).toBe(true)
    controller.editColor("#ABCDEF")
    expect(controller.state.color).toBe("#38BDF8")
    expect(await controller.saveColor("#ABCDEF")).toBe(false)
    await controller.stop()
    expect(native.saved).toEqual([])
    expect(native.stopped).toEqual([])
    native.emit({ available: true, phase: "idle", color: "#38BDF8" })
    expect(controller.colorDisabled()).toBe(false)
    controller.editColor("#ABCDEF")
    expect(await controller.saveColor()).toBe(true)
    expect(native.saved).toEqual(["#ABCDEF"])
    controller.dispose()
  })

  test("a local Stop request disables controls before the native stopping event arrives", async () => {
    const native = fixture()
    const pending = Promise.withResolvers<ComputerUseState>()
    native.platform.stop = async () => pending.promise
    const controller = createComputerUseSettings(native.platform)
    await controller.refresh()
    native.emit({ available: true, phase: "active", color: "#38BDF8", sessionID: "session-current", grantID })
    const stopping = controller.stop()
    expect(controller.colorDisabled()).toBe(true)
    expect(await controller.saveColor("#ABCDEF")).toBe(false)
    pending.resolve({ available: true, phase: "stopping", color: "#38BDF8" })
    await stopping
    expect(controller.colorDisabled()).toBe(true)
    expect(controller.state.error).toBeUndefined()
    native.emit({ available: true, phase: "idle", color: "#38BDF8" })
    expect(controller.colorDisabled()).toBe(false)
    controller.dispose()
  })
  test("native updates win over a stale initial state response", async () => {
    const native = fixture()
    const pending = Promise.withResolvers<ComputerUseState>()
    native.platform.state = () => pending.promise
    const controller = createComputerUseSettings(native.platform)
    native.emit({ available: true, phase: "active", color: "#34D399", sessionID: "session-current", grantID })
    pending.resolve({ available: true, phase: "idle", color: "#38BDF8" })
    await pending.promise
    expect(controller.state.value?.phase).toBe("active")
    expect(controller.state.color).toBe("#34D399")
    controller.dispose()
  })
  test("load and save failures are recoverable without discarding the draft color", async () => {
    const native = fixture()
    const read = native.platform.state
    native.platform.state = async () => {
      throw new Error("offline")
    }
    const controller = createComputerUseSettings(native.platform)
    await controller.refresh()
    expect(controller.state.error).toBe("load")
    native.platform.state = read
    await controller.refresh()
    expect(controller.state.error).toBeUndefined()
    controller.editColor("#ABCDEF")
    native.platform.setColor = async () => {
      throw new Error("storage unavailable")
    }
    expect(await controller.saveColor()).toBe(false)
    expect(controller.state.error).toBe("save")
    expect(controller.state.color).toBe("#ABCDEF")
    expect(controller.state.dirty).toBe(true)
    controller.dispose()
  })
})
