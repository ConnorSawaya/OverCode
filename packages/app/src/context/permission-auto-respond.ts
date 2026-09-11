import { base64Encode } from "@opencode-ai/core/util/encode"

export function acceptKey(sessionID: string, directory?: string) {
  if (!directory) return sessionID
  return `${base64Encode(directory)}/${sessionID}`
}

export function directoryAcceptKey(directory: string) {
  return `${base64Encode(directory)}/*`
}

function accepted(autoAccept: Record<string, boolean>, sessionID: string, directory?: string) {
  const key = acceptKey(sessionID, directory)
  return autoAccept[key] ?? autoAccept[sessionID]
}

export function isDirectoryAutoAccepting(autoAccept: Record<string, boolean>, directory: string) {
  const key = directoryAcceptKey(directory)
  return autoAccept[key] ?? false
}

function sessionLineage(session: { id: string; parentID?: string }[], sessionID: string) {
  const parent = session.reduce((acc, item) => {
    if (item.parentID) acc.set(item.id, item.parentID)
    return acc
  }, new Map<string, string>())
  const seen = new Set([sessionID])
  const ids = [sessionID]

  for (const id of ids) {
    const parentID = parent.get(id)
    if (!parentID || seen.has(parentID)) continue
    seen.add(parentID)
    ids.push(parentID)
  }

  return ids
}

export function autoRespondsPermission(
  autoAccept: Record<string, boolean>,
  session: { id: string; parentID?: string }[],
  permission: { sessionID: string },
  directory?: string,
) {
  const value = sessionAutoAccept(autoAccept, session, permission, directory)
  if (value !== undefined) return value
  return directory ? isDirectoryAutoAccepting(autoAccept, directory) : false
}

export function sessionAutoAccept(
  autoAccept: Record<string, boolean>,
  session: { id: string; parentID?: string }[],
  permission: { sessionID: string },
  directory?: string,
) {
  return sessionLineage(session, permission.sessionID)
    .map((id) => accepted(autoAccept, id, directory))
    .find((item): item is boolean => item !== undefined)
}

export type PermissionMode = "ask" | "auto" | "full"

export const resolvePermissionMode = (input: { directoryAuto: boolean; sessionAuto: boolean }): PermissionMode => {
  if (input.directoryAuto) return "full"
  if (input.sessionAuto) return "auto"
  return "ask"
}

export const cyclePermissionMode = (mode: PermissionMode): PermissionMode => {
  if (mode === "ask") return "auto"
  if (mode === "auto") return "full"
  return "ask"
}

export type PermissionModeApi = {
  enableAutoAccept: (sessionID: string, directory: string) => void
  disableAutoAccept: (sessionID: string, directory?: string) => void
  setDirectoryAutoAccept: (directory: string, value: boolean) => void
}

export const applyPermissionMode = (
  api: PermissionModeApi,
  directory: string,
  sessionID: string | undefined,
  mode: PermissionMode,
) => {
  if (mode === "full") {
    api.setDirectoryAutoAccept(directory, true)
    return
  }
  if (mode === "auto") {
    if (sessionID) {
      // Session auto-accept must replace directory-wide auto-accept, otherwise
      // resolving the mode still reports `full` after the user selects `auto`.
      api.setDirectoryAutoAccept(directory, false)
      api.enableAutoAccept(sessionID, directory)
      return
    }
    api.setDirectoryAutoAccept(directory, true)
    return
  }
  if (sessionID) api.disableAutoAccept(sessionID, directory)
  api.setDirectoryAutoAccept(directory, false)
}
