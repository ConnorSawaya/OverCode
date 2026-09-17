import { describe, expect, test } from "bun:test"
import {
  activeMobileDevice,
  createMobileDevice,
  mobileDeviceId,
  removeMobileDevice,
  selectMobileDevice,
  upsertMobileDevice,
  type MobileDeviceStore,
} from "./device-store"

const first = { relay: "https://relay.example.test", token: "first_device_token_123456" }
const second = { relay: "https://relay.example.test", token: "second_device_token_123456" }

describe("mobile device store", () => {
  test("keeps same-relay devices distinct by relay device id", () => {
    const a = createMobileDevice({ ...first, deviceId: "pc-a" }, { name: "Main PC", now: 1 })
    const b = createMobileDevice({ ...second, deviceId: "pc-b" }, { name: "Travel PC", now: 2 })

    expect(a.id).toBe("pc-a")
    expect(b.id).toBe("pc-b")
    expect(mobileDeviceId(first)).not.toBe(mobileDeviceId(second))
  })

  test("upserts and activates a newly paired device", () => {
    const initial: MobileDeviceStore = { devices: [], activeId: undefined }
    const withFirst = upsertMobileDevice(initial, { ...first, deviceId: "pc-a" }, { name: "Main PC", now: 10 })
    const withSecond = upsertMobileDevice(withFirst, { ...second, deviceId: "pc-b" }, { name: "Travel PC", now: 20 })

    expect(withSecond.devices.map((device) => device.name)).toEqual(["Main PC", "Travel PC"])
    expect(withSecond.activeId).toBe("pc-b")
  })

  test("switches and removes devices with a recent-device fallback", () => {
    const withFirst = upsertMobileDevice(
      { devices: [], activeId: undefined },
      { ...first, deviceId: "pc-a" },
      { name: "Main PC", now: 10 },
    )
    const withSecond = upsertMobileDevice(withFirst, { ...second, deviceId: "pc-b" }, { name: "Travel PC", now: 20 })
    const selected = selectMobileDevice(withSecond, "pc-a", 30)
    const removed = removeMobileDevice(selected, "pc-a")

    expect(activeMobileDevice(selected)?.name).toBe("Main PC")
    expect(removed.activeId).toBe("pc-b")
    expect(removed.devices).toHaveLength(1)
  })
})
