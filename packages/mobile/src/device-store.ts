import type { MobileConnection } from "@overcode-ai/mobile-relay/pairing"

export type MobileDeviceRecord = MobileConnection & {
  id: string
  name: string
  pairedAt: string
  lastUsedAt: number
}

export type MobileDeviceStore = {
  devices: MobileDeviceRecord[]
  activeId?: string
}

export function mobileDeviceId(connection: MobileConnection) {
  return connection.deviceId ?? `${connection.relay}|${connection.token}`
}

export function createMobileDevice(
  connection: MobileConnection,
  input: { name: string; now?: number; pairedAt?: string },
): MobileDeviceRecord {
  const now = input.now ?? Date.now()
  return {
    ...connection,
    id: mobileDeviceId(connection),
    name: input.name.trim() || "Overcode PC",
    pairedAt: input.pairedAt ?? new Date(now).toISOString(),
    lastUsedAt: now,
  }
}

export function upsertMobileDevice(
  state: MobileDeviceStore,
  connection: MobileConnection,
  input: { name: string; now?: number },
): MobileDeviceStore {
  const next = createMobileDevice(connection, input)
  const index = state.devices.findIndex((device) => device.id === next.id)
  const devices = [...state.devices]
  if (index === -1) devices.push(next)
  else devices[index] = { ...devices[index], ...next, pairedAt: devices[index].pairedAt }
  return { devices, activeId: next.id }
}

export function selectMobileDevice(state: MobileDeviceStore, id: string, now = Date.now()): MobileDeviceStore {
  const device = state.devices.find((item) => item.id === id)
  if (!device) return state
  return {
    devices: state.devices.map((item) => (item.id === id ? { ...item, lastUsedAt: now } : item)),
    activeId: id,
  }
}

export function removeMobileDevice(state: MobileDeviceStore, id: string): MobileDeviceStore {
  const devices = state.devices.filter((device) => device.id !== id)
  if (state.activeId !== id) return { devices, activeId: state.activeId }
  const fallback = [...devices].sort((left, right) => right.lastUsedAt - left.lastUsedAt)[0]
  return { devices, activeId: fallback?.id }
}

export function activeMobileDevice(state: MobileDeviceStore) {
  return state.devices.find((device) => device.id === state.activeId) ?? state.devices[0]
}
