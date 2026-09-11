export type SyncConflictClock = {
  time: number
  id: string
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

/** Extracts the user-visible mutation time from the portable event shapes. */
export function eventTime(data: unknown) {
  const value = record(data)
  const info = record(value?.info)
  const infoTime = record(info?.time)
  const time = record(value?.time)
  const candidates = [infoTime?.updated, time?.updated, value?.timestamp]
  return candidates.find((item): item is number => typeof item === "number" && Number.isFinite(item))
}

/** Orders concurrent metadata events identically on every installation. */
export function compareSyncConflictClocks(left: SyncConflictClock, right: SyncConflictClock) {
  if (left.time !== right.time) return left.time - right.time
  return left.id.localeCompare(right.id)
}

export function latestSyncConflictClock(
  current: SyncConflictClock,
  previous: ReadonlyArray<{ id: string; data: unknown }>,
): SyncConflictClock {
  return previous.reduce((latest, item) => {
    const time = eventTime(item.data)
    if (time === undefined) return latest
    const candidate = { time, id: item.id }
    return compareSyncConflictClocks(candidate, latest) > 0 ? candidate : latest
  }, current)
}

export function importedEventWins(event: SyncConflictClock, previous: ReadonlyArray<{ id: string; data: unknown }>) {
  return compareSyncConflictClocks(event, latestSyncConflictClock(event, previous)) >= 0
}
