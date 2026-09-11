/** Return the provider IDs referenced by portable model preferences. */
export function providerIDsFromModel(model: Record<string, unknown>) {
  const ids = new Set<string>()
  for (const key of ["user", "recent"]) {
    const values = model[key]
    if (!Array.isArray(values)) continue
    for (const value of values) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue
      const providerID = (value as Record<string, unknown>).providerID
      if (typeof providerID === "string" && providerID.length > 0 && providerID.length <= 160) ids.add(providerID)
    }
  }
  return [...ids].sort()
}

export const PORTABLE_PROFILE_FIELDS = ["pins", "projects", "model", "settings", "language"] as const
export type PortableProfileField = (typeof PORTABLE_PROFILE_FIELDS)[number]
export type ProfileClock = { updatedAt: number; deviceID: string }
export type ProfileClocks = Partial<Record<PortableProfileField, ProfileClock>>
export type ProjectVisibilityClocks = Record<string, ProfileClock>

/**
 * Compare two field clocks using the same deterministic order on every
 * installation. The device ID is only a tie-breaker for simultaneous writes.
 */
export function compareProfileClocks(left: ProfileClock, right: ProfileClock) {
  return left.updatedAt - right.updatedAt || left.deviceID.localeCompare(right.deviceID)
}

export function profileValueChanged(
  previous: Record<string, unknown> | undefined,
  next: Record<string, unknown>,
  field: PortableProfileField,
) {
  return JSON.stringify(previous?.[field]) !== JSON.stringify(next[field])
}

export function mergeProfileFields(input: {
  local: Record<string, unknown>
  localClocks: ProfileClocks
  incoming: Record<string, unknown>
  incomingClocks: ProfileClocks
  incomingFallbackClock: ProfileClock
}) {
  const data = { ...input.local }
  const clocks: ProfileClocks = { ...input.localClocks }
  let changed = false

  for (const field of PORTABLE_PROFILE_FIELDS) {
    if (!(field in input.incoming) || input.incoming[field] === undefined) continue
    const incomingClock = input.incomingClocks[field] ?? input.incomingFallbackClock
    const localClock = clocks[field] ?? { updatedAt: 0, deviceID: "" }
    if (compareProfileClocks(incomingClock, localClock) <= 0) continue
    if (JSON.stringify(data[field]) !== JSON.stringify(input.incoming[field])) changed = true
    data[field] = input.incoming[field]
    clocks[field] = incomingClock
  }

  return { data, clocks, changed }
}

export function mergeProjectVisibility(input: {
  local: Record<string, boolean>
  localClocks: ProjectVisibilityClocks
  incoming: Record<string, boolean>
  incomingClocks: ProjectVisibilityClocks
  incomingFallbackClock: ProfileClock
}) {
  const data = { ...input.local }
  const clocks: ProjectVisibilityClocks = { ...input.localClocks }
  let changed = false

  for (const [projectID, visible] of Object.entries(input.incoming)) {
    const incomingClock = input.incomingClocks[projectID] ?? input.incomingFallbackClock
    const localClock = clocks[projectID] ?? { updatedAt: 0, deviceID: "" }
    if (compareProfileClocks(incomingClock, localClock) <= 0) continue
    if (data[projectID] !== visible) changed = true
    data[projectID] = visible
    clocks[projectID] = incomingClock
  }

  return { data, clocks, changed }
}

export function sanitizeProfileClocks(value: unknown): ProfileClocks {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  const input = value as Record<string, unknown>
  const result: ProfileClocks = {}
  for (const field of PORTABLE_PROFILE_FIELDS) {
    const clock = input[field]
    if (!clock || typeof clock !== "object" || Array.isArray(clock)) continue
    const entry = clock as Record<string, unknown>
    if (
      typeof entry.updatedAt !== "number" ||
      !Number.isInteger(entry.updatedAt) ||
      entry.updatedAt < 0 ||
      typeof entry.deviceID !== "string" ||
      entry.deviceID.length === 0 ||
      entry.deviceID.length > 160
    )
      continue
    result[field] = { updatedAt: entry.updatedAt, deviceID: entry.deviceID }
  }
  return result
}

export function sanitizeProjectVisibilityClocks(value: unknown): ProjectVisibilityClocks {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  const result: ProjectVisibilityClocks = {}
  for (const [projectID, entryValue] of Object.entries(value as Record<string, unknown>).slice(0, 10_000)) {
    if (
      projectID.length === 0 ||
      projectID.length > 320 ||
      !entryValue ||
      typeof entryValue !== "object" ||
      Array.isArray(entryValue)
    )
      continue
    const clock = entryValue as Record<string, unknown>
    if (
      typeof clock.updatedAt !== "number" ||
      !Number.isInteger(clock.updatedAt) ||
      clock.updatedAt < 0 ||
      typeof clock.deviceID !== "string" ||
      clock.deviceID.length === 0 ||
      clock.deviceID.length > 160
    )
      continue
    result[projectID] = { updatedAt: clock.updatedAt, deviceID: clock.deviceID }
  }
  return result
}
