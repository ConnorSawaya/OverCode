import { safeStorage } from "electron"
import { hostname } from "node:os"
import type {
  MobileAccessPlatform,
  MobileAccessState,
  SyncDevicesPlatform,
  SyncProjectMapping,
  SyncDevicesState,
  SyncPeer,
} from "@opencode-ai/app"
import { isPairingCode, isRelayToken, isRelayUrl, normalizePairingCode } from "@opencode-ai/mobile-relay/pairing"
import type { ServerReadyData } from "../preload/types"
import { getStore } from "./store"
import { SYNC_DEVICES_KEY, SYNC_PROFILE_STATE_KEY } from "./store-keys"
import {
  mergeProfileFields,
  mergeProjectVisibility,
  PORTABLE_PROFILE_FIELDS,
  profileValueChanged,
  providerIDsFromModel,
  sanitizeProfileClocks,
  sanitizeProjectVisibilityClocks,
  type ProfileClocks,
  type ProjectVisibilityClocks,
} from "./sync-profile"

type LocalServer = Pick<ServerReadyData, "url" | "username" | "password">
type SyncChange = {
  revision: number
  id: string
  aggregate_id: string
  seq: number
  type: string
  data: Record<string, unknown>
  source_device: string
  time_created: number
}
type SyncEnvelope = {
  protocol: "overcode-sync-v1"
  deviceID: string
  cursor: number
  latestRevision: number
  changes: SyncChange[]
}
type PortableProfile = {
  version: 1
  pins: { chats: Array<{ server: string; sessionID: string }> }
  projects: Array<{ projectID: string; order: number; expanded: boolean; pinned: boolean; last: boolean }>
  model: Record<string, unknown>
  requiredProviders: string[]
  settings: Record<string, unknown>
  language?: { locale: string }
  projectVisibility: Record<string, boolean>
  _clocks?: ProfileClocks
  _projectClocks?: ProjectVisibilityClocks
}
type SyncProfileEnvelope = {
  protocol: "overcode-sync-profile-v1"
  deviceID: string
  updatedAt: number
  data: Record<string, unknown>
}
type SyncProfileIncomingEnvelope = {
  protocol: "overcode-sync-profile-v1"
  deviceID: string
  profiles: Array<{ deviceID: string; updatedAt: number; data: Record<string, unknown> }>
}
type ProjectMappingsEnvelope = {
  protocol: "overcode-sync-v1"
  projects: SyncProjectMapping[]
}
type LocalProject = { id: string; worktree: string }
type ProfileState = {
  updatedAt: number
  fingerprint: string
  clocks: ProfileClocks
  projectClocks: ProjectVisibilityClocks
}
type StoredPeer = {
  id: string
  token: string
  relayUrl: string
  name: string
  pairedAt: string
  lastSeen: string
  remoteDeviceID?: string
  remoteRevision: number
  localRevision: number
}

const DEFAULT_RELAY_URL = process.env.OVERCODE_RELAY_URL ?? "https://overcode-relay-production.up.railway.app"
const REQUEST_TIMEOUT_MS = 20_000
const SYNC_INTERVAL_MS = 5_000
const SYNC_BATCH_SIZE = 1_000
const GLOBAL_STORE = "opencode.global.dat"
const MAX_STORED_PEERS = 64
const MAX_ENCRYPTED_STORE_VALUE = 256_000
const MAX_PROFILE_FINGERPRINT = 1_000_000

/**
 * Synchronizes portable event history between trusted Overcode installations.
 * Filesystem mappings and credentials remain local; only the event payloads
 * already marked durable by the server are exchanged.
 */
export class SyncDevicesController implements SyncDevicesPlatform {
  private readonly options: {
    mobileAccess: MobileAccessPlatform
    getLocalServer: () => Promise<LocalServer>
  }
  private storedPeers: StoredPeer[]
  private profileState: ProfileState
  private missingProviders = new Set<string>()
  private currentState: SyncDevicesState
  private readonly listeners = new Set<(state: SyncDevicesState) => void>()
  private readonly profileListeners = new Set<() => void>()
  private readonly unsubscribeMobile: () => void
  private timer: ReturnType<typeof setTimeout> | undefined
  private inFlight: Promise<SyncDevicesState> | undefined

  constructor(
    options: {
      mobileAccess: MobileAccessPlatform
      getLocalServer: () => Promise<LocalServer>
    },
  ) {
    this.options = options
    this.storedPeers = readStoredPeers()
    this.profileState = readProfileState()
    this.currentState = this.buildState()
    this.unsubscribeMobile = options.mobileAccess.onState(() => this.setState(this.buildState()))
    this.scheduleSync(0)
  }

  state() {
    return this.currentState
  }

  onState(callback: (state: SyncDevicesState) => void) {
    this.listeners.add(callback)
    callback(this.currentState)
    return () => this.listeners.delete(callback)
  }

  onProfileApplied(callback: () => void) {
    this.profileListeners.add(callback)
    return () => this.profileListeners.delete(callback)
  }

  async pair(code: string, relayUrl = DEFAULT_RELAY_URL) {
    const normalizedCode = normalizePairingCode(code)
    const relay = normalizeRelayUrl(relayUrl)
    if (!isPairingCode(normalizedCode)) return this.fail("invalid_pairing_code")
    if (!relay) return this.fail("pairing_failed")
    if (!safeStorage.isEncryptionAvailable()) return this.fail("secure_storage_unavailable")

    this.setState({ ...this.buildState(), status: "pairing", error: undefined })
    try {
      const response = await fetch(`${relay}/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: normalizedCode, deviceName: `${hostname()} Overcode`, deviceType: "Overcode desktop" }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (!response.ok) throw new Error("pairing_failed")
      const value = (await response.json()) as { token?: unknown; deviceId?: unknown }
      const token = typeof value.token === "string" ? value.token : undefined
      if (!isRelayToken(token)) throw new Error("pairing_failed")
      if (typeof value.deviceId !== "string" || value.deviceId.length === 0 || value.deviceId.length > 160)
        throw new Error("pairing_failed")

      const now = new Date().toISOString()
      const peer: StoredPeer = {
        id: value.deviceId,
        token,
        relayUrl: relay,
        name: "Overcode device",
        pairedAt: now,
        lastSeen: now,
        remoteRevision: 0,
        localRevision: 0,
      }
      if (!this.storedPeers.some((item) => item.id === peer.id) && this.storedPeers.length >= MAX_STORED_PEERS) {
        throw new Error("peer_limit")
      }
      this.storedPeers = [...this.storedPeers.filter((item) => item.id !== peer.id), peer]
      saveStoredPeers(this.storedPeers)
      await this.syncNow()
      return this.currentState
    } catch {
      return this.fail("pairing_failed")
    }
  }

  async removePeer(deviceId: string) {
    const mobileDevice = this.options.mobileAccess.state().devices?.some((device) => device.id === deviceId)
    if (mobileDevice && this.options.mobileAccess.revokeDevice) {
      await this.options.mobileAccess.revokeDevice(deviceId).catch(() => undefined)
    }
    this.storedPeers = this.storedPeers.filter((peer) => peer.id !== deviceId)
    saveStoredPeers(this.storedPeers)
    if (this.storedPeers.length === 0 && this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.setState(this.buildState())
    return this.currentState
  }

  async mapProject(projectID: string, localWorktree: string) {
    try {
      const local = await this.options.getLocalServer()
      await putLocalProjectMapping(local, { projectID, localWorktree })
      const projects = await requestLocalProjectMappings(local)
      this.setState(this.buildState(this.currentState.lastSynced, projects))
    } catch {
      this.setState({ ...this.currentState, error: "project_mapping_failed", status: "error" })
    }
    return this.currentState
  }

  syncNow() {
    if (this.inFlight) return this.inFlight
    this.inFlight = this.runSync().finally(() => {
      this.inFlight = undefined
      if (this.storedPeers.length > 0) this.scheduleSync(SYNC_INTERVAL_MS)
    })
    return this.inFlight
  }

  dispose() {
    this.unsubscribeMobile()
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.listeners.clear()
    this.profileListeners.clear()
  }

  private async runSync() {
    this.missingProviders = new Set()
    if (this.storedPeers.length === 0) {
      try {
        const local = await this.options.getLocalServer()
        const projects = await requestLocalProjectMappings(local)
        const state = this.buildState(Date.now(), projects)
        this.setState({
          ...state,
          status: state.status === "error" ? "error" : state.status === "disabled" ? "disabled" : "online",
        })
      } catch {
        this.setState({ ...this.buildState(), status: "error", error: "sync_failed" })
      }
      return this.currentState
    }

    this.setState({ ...this.buildState(), status: "syncing", error: undefined })
    let failed = false
    for (const peer of this.storedPeers) {
      try {
        await this.syncPeer(peer)
      } catch {
        failed = true
      }
    }
    let projects = this.currentState.projects
    try {
      projects = await requestLocalProjectMappings(await this.options.getLocalServer())
    } catch {
      failed = true
    }
    this.setState({
      ...this.buildState(failed ? this.currentState.lastSynced : Date.now(), projects),
      status: failed ? "error" : "online",
      ...(failed ? { error: "sync_failed" } : {}),
    })
    return this.currentState
  }

  private async syncPeer(peer: StoredPeer) {
    const local = await this.options.getLocalServer()
    const remote = await requestRemoteEnvelope(peer)
    const localEnvelope = await requestLocalEnvelope(local, peer.localRevision)
    peer.remoteDeviceID = remote.deviceID

    const inbound = remote.changes.filter(
      (change) => change.source_device !== localEnvelope.deviceID && change.source_device !== peer.id,
    )
    if (inbound.length > 0) {
      await importChanges(local, remote.deviceID, inbound)
    }

    // Import project/session history before applying the portable profile so
    // project IDs from the peer can already resolve to local mappings.
    const requiredProviders = await this.syncProfile(local, localEnvelope.deviceID, peer)
    const connectedProviders = await requestLocalConnectedProviders(local).catch(() => undefined)
    if (connectedProviders) {
      requiredProviders
        .filter((providerID) => !connectedProviders.has(providerID))
        .forEach((providerID) => this.missingProviders.add(providerID))
    }
    peer.remoteRevision = remote.cursor

    const outbound = localEnvelope.changes.filter(
      (change) => change.source_device !== remote.deviceID && change.source_device !== peer.id,
    )
    if (outbound.length > 0) {
      await importRemoteChanges(peer, localEnvelope.deviceID, outbound)
    }
    peer.localRevision = localEnvelope.cursor
    peer.lastSeen = new Date().toISOString()
    this.storedPeers = this.storedPeers.map((item) => (item.id === peer.id ? { ...peer } : item))
    saveStoredPeers(this.storedPeers)
  }

  private async syncProfile(local: LocalServer, localDeviceID: string, peer: StoredPeer) {
    const localProjects = await requestLocalProjects(local).catch(() => [])
    const localMappings = await requestLocalProjectMappings(local).catch(() => [])
    const localProfile = readPortableProfile(localProjects)
    const fingerprint = JSON.stringify(localProfile)
    const previousProfile = asRecord(parseStored(this.profileState.fingerprint))
    const clocks: ProfileClocks = { ...this.profileState.clocks }
    const projectClocks: ProjectVisibilityClocks = { ...this.profileState.projectClocks }
    const profileWriteAt = Math.max(Date.now(), this.profileState.updatedAt + 1)
    let localProfileChanged = false
    for (const field of PORTABLE_PROFILE_FIELDS) {
      if (!previousProfile || profileValueChanged(previousProfile, localProfile, field)) {
        clocks[field] = { updatedAt: profileWriteAt, deviceID: localDeviceID }
        localProfileChanged = true
      }
    }
    const previousVisibility = asRecord(previousProfile?.projectVisibility)
    for (const [projectID, visible] of Object.entries(localProfile.projectVisibility)) {
      if (previousVisibility?.[projectID] !== visible) {
        projectClocks[projectID] = { updatedAt: profileWriteAt, deviceID: localDeviceID }
        localProfileChanged = true
      }
    }
    if (fingerprint !== this.profileState.fingerprint) {
      this.profileState = {
        updatedAt: profileWriteAt,
        fingerprint,
        clocks,
        projectClocks,
      }
      saveProfileState(this.profileState)
    } else if (Object.keys(clocks).length !== Object.keys(this.profileState.clocks).length) {
      this.profileState = { ...this.profileState, clocks, projectClocks }
      saveProfileState(this.profileState)
    } else if (Object.keys(projectClocks).length !== Object.keys(this.profileState.projectClocks).length) {
      this.profileState = { ...this.profileState, clocks, projectClocks }
      saveProfileState(this.profileState)
    } else if (localProfileChanged) {
      this.profileState = { ...this.profileState, clocks, projectClocks }
      saveProfileState(this.profileState)
    }

    // The paired installation is the relay target, so its current profile
    // must be read through the relay before writing anything. Reading after
    // the upload would make this device overwrite the peer snapshot and
    // silently discard newer model/settings changes made there.
    const remote = await requestRemoteProfile(peer)
    const incoming = await requestLocalIncomingProfiles(local)
    const candidates = [
      ...(remote && remote.deviceID !== localDeviceID
        ? [{ deviceID: remote.deviceID, updatedAt: remote.updatedAt, data: remote.data }]
        : []),
      ...(incoming?.profiles ?? []).filter((profile) => profile.deviceID !== localDeviceID),
    ]
      .map((profile) => ({ ...profile, data: sanitizePortableProfile(profile.data) }))
      .sort((a, b) => a.updatedAt - b.updatedAt || a.deviceID.localeCompare(b.deviceID))
    let merged = {
      data: localProfile as unknown as Record<string, unknown>,
      clocks,
      projectClocks,
      changed: false,
    }
    let latestProfileTimestamp = this.profileState.updatedAt
    for (const candidate of candidates) {
      const incomingClocks = candidate.data._clocks ?? {}
      const result = mergeProfileFields({
        local: merged.data,
        localClocks: merged.clocks,
        incoming: candidate.data as unknown as Record<string, unknown>,
        incomingClocks,
        incomingFallbackClock: { updatedAt: candidate.updatedAt, deviceID: candidate.deviceID },
      })
      const visibility = (candidate.data.projectVisibility ?? {}) as Record<string, boolean>
      const visibilityResult = mergeProjectVisibility({
        local: (merged.data.projectVisibility ?? {}) as Record<string, boolean>,
        localClocks: merged.projectClocks,
        incoming: visibility,
        incomingClocks: candidate.data._projectClocks ?? {},
        incomingFallbackClock: { updatedAt: candidate.updatedAt, deviceID: candidate.deviceID },
      })
      merged = {
        data: { ...result.data, projectVisibility: visibilityResult.data },
        clocks: result.clocks,
        projectClocks: visibilityResult.clocks,
        changed: merged.changed || result.changed || visibilityResult.changed,
      }
      latestProfileTimestamp = Math.max(latestProfileTimestamp, candidate.updatedAt)
    }
    if (merged.changed) {
      applyPortableProfile(merged.data, localProjects, localMappings)
      for (const listener of this.profileListeners) listener()
      const next = readPortableProfile(localProjects)
      this.profileState = {
        updatedAt: latestProfileTimestamp,
        fingerprint: JSON.stringify(next),
        clocks: merged.clocks,
        projectClocks: merged.projectClocks,
      }
      saveProfileState(this.profileState)
    }

    const current = readPortableProfile(localProjects)
    const snapshot = {
      protocol: "overcode-sync-profile-v1" as const,
      deviceID: localDeviceID,
      updatedAt: this.profileState.updatedAt,
      data: {
        ...current,
        _clocks: this.profileState.clocks,
        _projectClocks: this.profileState.projectClocks,
      } as unknown as Record<string, unknown>,
    }
    await putLocalProfile(local, snapshot)
    await putRemoteProfile(peer, snapshot)
    return current.requiredProviders
  }

  private scheduleSync(delay: number) {
    if (this.timer || (this.storedPeers.length === 0 && delay > 0)) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.syncNow()
    }, delay)
  }

  private buildState(lastSynced = this.currentState?.lastSynced, projects = this.currentState?.projects ?? []) {
    const mobile = this.options.mobileAccess.state()
    const mobilePeers: SyncPeer[] = (mobile.devices ?? []).map((device) => ({
      ...device,
      status: isFresh(device.lastSeen) ? "online" : "offline",
    }))
    const desktopPeers: SyncPeer[] = this.storedPeers.map((peer) => ({
      id: peer.id,
      name: peer.name,
      deviceType: "Overcode desktop",
      pairedAt: peer.pairedAt,
      lastSeen: peer.lastSeen,
      status: isFresh(peer.lastSeen) ? "online" : "offline",
    }))
    const peers = [...mobilePeers, ...desktopPeers]
    const status = statusFromMobile(mobile, this.storedPeers.length > 0)
    return {
      status,
      deviceId: mobile.deviceId,
      peers,
      projects,
      ...(this.missingProviders.size > 0 ? { missingProviders: [...this.missingProviders].sort() } : {}),
      ...(lastSynced ? { lastSynced } : {}),
      ...(mobile.error ? { error: mobile.error } : {}),
    } satisfies SyncDevicesState
  }

  private fail(error: string) {
    this.setState({ ...this.buildState(), status: "error", error })
    return this.currentState
  }

  private setState(next: SyncDevicesState) {
    this.currentState = next
    for (const listener of this.listeners) listener(next)
  }
}

async function requestLocalEnvelope(local: LocalServer, cursor: number) {
  const url = new URL(cursor === 0 ? "/sync/snapshot" : "/sync/changes", local.url)
  const headers = new Headers({ accept: "application/json" })
  if (local.password) headers.set("authorization", basicAuth(local.username ?? "opencode", local.password))
  if (cursor !== 0) {
    headers.set("content-type", "application/json")
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ after: cursor, limit: SYNC_BATCH_SIZE }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    return readEnvelope(response)
  }
  return readEnvelope(await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }))
}

async function requestRemoteEnvelope(peer: StoredPeer) {
  const url = new URL(peer.remoteRevision === 0 ? "/sync/snapshot" : "/sync/changes", peer.relayUrl)
  const headers = new Headers({ accept: "application/json", "x-overcode-channel-token": peer.token })
  const init: RequestInit = {
    method: peer.remoteRevision === 0 ? "GET" : "POST",
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }
  if (peer.remoteRevision !== 0) {
    headers.set("content-type", "application/json")
    init.body = JSON.stringify({ after: peer.remoteRevision, limit: SYNC_BATCH_SIZE })
  }
  const response = await fetch(url, init)
  return readEnvelope(response)
}

async function readEnvelope(response: Response): Promise<SyncEnvelope> {
  if (!response.ok) throw new Error(`sync_http_${response.status}`)
  const value = (await response.json()) as Partial<SyncEnvelope>
  if (
    value.protocol !== "overcode-sync-v1" ||
    typeof value.deviceID !== "string" ||
    !Number.isInteger(value.cursor) ||
    !Number.isInteger(value.latestRevision) ||
    !Array.isArray(value.changes)
  )
    throw new Error("sync_payload_invalid")
  if (
    value.deviceID.length === 0 ||
    value.deviceID.length > 160 ||
    value.cursor! < 0 ||
    value.latestRevision! < value.cursor! ||
    value.changes.length > SYNC_BATCH_SIZE
  )
    throw new Error("sync_payload_invalid")
  for (const change of value.changes) {
    if (
      !change ||
      typeof change !== "object" ||
      !Number.isInteger(change.revision) ||
      change.revision < 0 ||
      typeof change.id !== "string" ||
      change.id.length === 0 ||
      change.id.length > 160 ||
      typeof change.aggregate_id !== "string" ||
      change.aggregate_id.length === 0 ||
      change.aggregate_id.length > 320 ||
      !Number.isInteger(change.seq) ||
      change.seq < 0 ||
      typeof change.type !== "string" ||
      change.type.length === 0 ||
      change.type.length > 320 ||
      !change.data ||
      typeof change.data !== "object" ||
      Array.isArray(change.data) ||
      typeof change.source_device !== "string" ||
      change.source_device.length === 0 ||
      change.source_device.length > 160 ||
      !Number.isInteger(change.time_created) ||
      change.time_created < 0
    )
      throw new Error("sync_payload_invalid")
  }
  return value as SyncEnvelope
}

async function importChanges(local: LocalServer, sourceDevice: string, changes: SyncChange[]) {
  const headers = new Headers({ "content-type": "application/json" })
  if (local.password) headers.set("authorization", basicAuth(local.username ?? "opencode", local.password))
  const response = await fetch(new URL("/sync/import", local.url), {
    method: "POST",
    headers,
    body: JSON.stringify({
      protocol: "overcode-sync-v1",
      sourceDevice,
      events: changes.map(toImportEvent),
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`sync_import_${response.status}`)
}

async function importRemoteChanges(peer: StoredPeer, sourceDevice: string, changes: SyncChange[]) {
  const response = await fetch(`${peer.relayUrl}/sync/import`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-overcode-channel-token": peer.token },
    body: JSON.stringify({
      protocol: "overcode-sync-v1",
      sourceDevice,
      events: changes.map(toImportEvent),
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`sync_import_${response.status}`)
}

async function requestLocalProjectMappings(local: LocalServer): Promise<SyncProjectMapping[]> {
  const headers = new Headers({ accept: "application/json" })
  if (local.password) headers.set("authorization", basicAuth(local.username ?? "opencode", local.password))
  const response = await fetch(new URL("/sync/project-mappings", local.url), {
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`project_mappings_${response.status}`)
  const value = (await response.json()) as Partial<ProjectMappingsEnvelope>
  if (value.protocol !== "overcode-sync-v1" || !Array.isArray(value.projects))
    throw new Error("project_mappings_invalid")
  if (value.projects.length > 10_000) throw new Error("project_mappings_invalid")
  for (const project of value.projects) {
    if (
      !project ||
      typeof project.projectID !== "string" ||
      project.projectID.length === 0 ||
      project.projectID.length > 320 ||
      typeof project.sourceWorktree !== "string" ||
      project.sourceWorktree.length > 4_096 ||
      (project.localWorktree !== undefined &&
        (typeof project.localWorktree !== "string" || project.localWorktree.length > 4_096))
    )
      throw new Error("project_mappings_invalid")
  }
  return value.projects
}

async function requestLocalProjects(local: LocalServer): Promise<LocalProject[]> {
  const headers = new Headers({ accept: "application/json" })
  if (local.password) headers.set("authorization", basicAuth(local.username ?? "opencode", local.password))
  const response = await fetch(new URL("/project", local.url), {
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`projects_${response.status}`)
  const value = (await response.json()) as unknown
  if (!Array.isArray(value) || value.length > 10_000) throw new Error("projects_invalid")
  return value.flatMap((item) => {
    const project = asRecord(item)
    if (!project || typeof project.id !== "string" || typeof project.worktree !== "string") return []
    if (
      project.id.length === 0 ||
      project.id.length > 320 ||
      project.worktree.length === 0 ||
      project.worktree.length > 4_096
    )
      return []
    return [{ id: project.id, worktree: project.worktree }]
  })
}

async function requestLocalConnectedProviders(local: LocalServer): Promise<Set<string>> {
  const headers = new Headers({ accept: "application/json" })
  if (local.password) headers.set("authorization", basicAuth(local.username ?? "opencode", local.password))
  const response = await fetch(new URL("/provider", local.url), {
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`providers_${response.status}`)
  const value = asRecord(await response.json())
  if (!Array.isArray(value?.connected) || value.connected.length > 10_000) throw new Error("providers_invalid")
  return new Set(
    value.connected.filter(
      (providerID): providerID is string => typeof providerID === "string" && providerID.length > 0,
    ),
  )
}

async function putLocalProjectMapping(local: LocalServer, input: { projectID: string; localWorktree: string }) {
  const headers = new Headers({ "content-type": "application/json" })
  if (local.password) headers.set("authorization", basicAuth(local.username ?? "opencode", local.password))
  const response = await fetch(new URL("/sync/project-mappings", local.url), {
    method: "POST",
    headers,
    body: JSON.stringify({ protocol: "overcode-sync-v1", ...input }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`project_mapping_${response.status}`)
}

function toImportEvent(change: SyncChange) {
  return {
    id: change.id,
    aggregateID: change.aggregate_id,
    seq: change.seq,
    type: change.type,
    data: change.data,
  }
}

function statusFromMobile(state: MobileAccessState, hasDesktopPeer: boolean): SyncDevicesState["status"] {
  if (state.status === "starting") return "pairing"
  if (state.status === "error") return "error"
  if (state.status === "online") return "online"
  return hasDesktopPeer ? "offline" : "disabled"
}

function isFresh(value: string) {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && Date.now() - timestamp < 2 * 60_000
}

function normalizeRelayUrl(value: string) {
  const trimmed = value.trim().replace(/\/+$/, "")
  if (!trimmed) return
  try {
    const url = new URL(trimmed)
    if (!isRelayUrl(url)) return
    url.search = ""
    url.hash = ""
    return url.toString().replace(/\/$/, "")
  } catch {
    return
  }
}

function basicAuth(username: string, password: string) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
}

function readPortableProfile(projects: LocalProject[] = []): PortableProfile {
  const store = getStore(GLOBAL_STORE)
  const pins = asRecord(parseStored(store.get("pins")))
  const chats = Array.isArray(pins?.chats)
    ? pins.chats
        .map((item) => {
          const value = asRecord(item)
          if (!value || typeof value.server !== "string" || typeof value.sessionID !== "string") return
          if (value.server.length > 2_000 || value.sessionID.length === 0 || value.sessionID.length > 200) return
          return { server: value.server, sessionID: value.sessionID }
        })
        .filter((item): item is { server: string; sessionID: string } => item !== undefined)
        .slice(0, 2_000)
    : []
  const projectByPath = new Map(projects.map((project) => [profilePath(project.worktree), project.id]))
  const server = asRecord(parseStored(store.get("server")))
  const serverProjects = asRecord(server?.projects)
  const localProjects = Array.isArray(serverProjects?.local) ? serverProjects.local : []
  const localProjectEntries = localProjects.flatMap((item, order) => {
    const value = asRecord(item)
    if (!value || typeof value.worktree !== "string") return []
    const projectID = projectByPath.get(profilePath(value.worktree))
    if (!projectID) return []
    return [{ projectID, order, expanded: value.expanded !== false }]
  })
  const visibleProjectIDs = new Set(localProjectEntries.map((item) => item.projectID))
  const recentProjectState = asRecord(server?.recentlyClosed)
  const recentlyClosed = Array.isArray(recentProjectState?.local) ? recentProjectState.local : []
  const closedProjectIDs = new Set(
    recentlyClosed.flatMap((item) => {
      if (typeof item !== "string") return []
      const projectID = projectByPath.get(profilePath(item))
      return projectID && projectID !== "global" ? [projectID] : []
    }),
  )
  const projectVisibility = Object.fromEntries([
    ...[...visibleProjectIDs].map((projectID) => [projectID, true] as const),
    ...[...closedProjectIDs].map((projectID) => [projectID, false] as const),
  ])
  const pinned = Array.isArray(pins?.projects)
    ? pins.projects.flatMap((item) => {
        if (typeof item !== "string") return []
        const projectID = projectByPath.get(profilePath(item))
        return projectID ? [projectID] : []
      })
    : []
  const lastProjects = asRecord(server?.lastProject)
  const lastProject =
    typeof lastProjects?.local === "string" ? projectByPath.get(profilePath(lastProjects.local)) : undefined
  const projectStates = new Map<
    string,
    { projectID: string; order: number; expanded: boolean; pinned: boolean; last: boolean }
  >()
  for (const item of localProjectEntries) {
    projectStates.set(item.projectID, { ...item, pinned: false, last: item.projectID === lastProject })
  }
  for (const projectID of pinned) {
    const current = projectStates.get(projectID)
    if (current) current.pinned = true
    else
      projectStates.set(projectID, { projectID, order: projectStates.size, expanded: true, pinned: true, last: false })
  }
  const model = sanitizeModel(parseStored(store.get("model")))
  const language = sanitizeLanguage(parseStored(store.get("language")))
  return {
    version: 1,
    pins: { chats },
    projects: [...projectStates.values()].sort((a, b) => a.order - b.order).slice(0, 10_000),
    model,
    requiredProviders: providerIDsFromModel(model),
    settings: sanitizeSettings(parseStored(store.get("settings.v3"))),
    ...(language ? { language } : {}),
    projectVisibility,
  }
}

function sanitizePortableProfile(value: unknown): PortableProfile {
  const profile = asRecord(value)
  const pins = asRecord(profile?.pins)
  const chats = Array.isArray(pins?.chats)
    ? pins.chats
        .map((item) => {
          const pin = asRecord(item)
          if (!pin || typeof pin.server !== "string" || typeof pin.sessionID !== "string") return
          if (pin.server.length > 2_000 || pin.sessionID.length === 0 || pin.sessionID.length > 200) return
          return { server: pin.server, sessionID: pin.sessionID }
        })
        .filter((item): item is { server: string; sessionID: string } => item !== undefined)
        .slice(0, 2_000)
    : []
  const projects = Array.isArray(profile?.projects)
    ? profile.projects
        .map((item) => {
          const project = asRecord(item)
          if (!project || typeof project.projectID !== "string") return
          if (
            project.projectID.length === 0 ||
            project.projectID.length > 320 ||
            typeof project.order !== "number" ||
            !Number.isInteger(project.order) ||
            project.order < 0
          )
            return
          return {
            projectID: project.projectID,
            order: project.order,
            expanded: project.expanded !== false,
            pinned: project.pinned === true,
            last: project.last === true,
          }
        })
        .filter((item): item is PortableProfile["projects"][number] => item !== undefined)
        .sort((a, b) => a.order - b.order || a.projectID.localeCompare(b.projectID))
        .slice(0, 10_000)
    : []
  const projectVisibility =
    profile?.projectVisibility &&
    typeof profile.projectVisibility === "object" &&
    !Array.isArray(profile.projectVisibility)
      ? Object.fromEntries(
          Object.entries(profile.projectVisibility as Record<string, unknown>)
            .filter(
              ([projectID, visible]) => projectID.length > 0 && projectID.length <= 320 && typeof visible === "boolean",
            )
            .slice(0, 10_000)
            .map(([projectID, visible]) => [projectID, visible as boolean]),
        )
      : Object.fromEntries(projects.map((project) => [project.projectID, true]))
  const model = sanitizeModel(profile?.model)
  const language = sanitizeLanguage(profile?.language)
  const clocks = sanitizeProfileClocks(profile?._clocks)
  const projectClocks = sanitizeProjectVisibilityClocks(profile?._projectClocks)
  const requestedProviders = Array.isArray(profile?.requiredProviders)
    ? profile.requiredProviders
        .filter(
          (providerID): providerID is string =>
            typeof providerID === "string" && providerID.length > 0 && providerID.length <= 160,
        )
        .slice(0, 256)
    : []
  return {
    version: 1,
    pins: { chats },
    projects,
    model,
    requiredProviders: [
      ...new Set(requestedProviders.length > 0 ? requestedProviders : providerIDsFromModel(model)),
    ].sort(),
    settings: sanitizeSettings(profile?.settings),
    ...(language ? { language } : {}),
    projectVisibility,
    ...(Object.keys(clocks).length > 0 ? { _clocks: clocks } : {}),
    ...(Object.keys(projectClocks).length > 0 ? { _projectClocks: projectClocks } : {}),
  }
}

function sanitizeLanguage(value: unknown): { locale: string } | undefined {
  const language = asRecord(value)
  const locale = language?.locale
  if (typeof locale !== "string" || locale.length === 0 || locale.length > 32) return
  if (!/^[A-Za-z0-9-]+$/.test(locale)) return
  return { locale }
}

function sanitizeModel(value: unknown): Record<string, unknown> {
  const model = asRecord(value)
  const user = Array.isArray(model?.user)
    ? model.user
        .map((item) => {
          const entry = asRecord(item)
          if (!entry || typeof entry.providerID !== "string" || typeof entry.modelID !== "string") return
          if (entry.providerID.length > 160 || entry.modelID.length > 320) return
          return {
            providerID: entry.providerID,
            modelID: entry.modelID,
            ...(entry.visibility === "show" || entry.visibility === "hide" ? { visibility: entry.visibility } : {}),
            ...(typeof entry.favorite === "boolean" ? { favorite: entry.favorite } : {}),
          }
        })
        .filter((item) => item !== undefined)
        .slice(0, 2_000)
    : []
  const recent = Array.isArray(model?.recent)
    ? model.recent
        .map((item) => {
          const entry = asRecord(item)
          if (!entry || typeof entry.providerID !== "string" || typeof entry.modelID !== "string") return
          if (entry.providerID.length > 160 || entry.modelID.length > 320) return
          return { providerID: entry.providerID, modelID: entry.modelID }
        })
        .filter((item) => item !== undefined)
        .slice(0, 20)
    : []
  const variant = asRecord(model?.variant)
  const safeVariant = variant
    ? Object.fromEntries(
        Object.entries(variant)
          .filter(([key, value]) => key.length <= 480 && typeof value === "string" && value.length <= 480)
          .slice(0, 2_000),
      )
    : {}
  return { user, recent, variant: safeVariant }
}

function sanitizeSettings(value: unknown): Record<string, unknown> {
  const settings = asRecord(value)
  const general = copySettingsFields(asRecord(settings?.general), [
    "autoSave",
    "releaseNotes",
    "followup",
    "showFileTree",
    "showNavigation",
    "showSearch",
    "showStatus",
    "showTerminal",
    "showReasoningSummaries",
    "shellToolPartsExpanded",
    "editToolPartsExpanded",
    "showCustomAgents",
    "quickChatEnabled",
    "composerEffects",
    "mobileTitlebarPosition",
    "newLayoutDesigns",
    "layoutTransitionEligible",
    "agentVisibilityInitialized",
    "newInterfaceNoticeDismissed",
    "shouldDisplayTabsToast",
  ])
  const appearance = copySettingsFields(asRecord(settings?.appearance), [
    "fontSize",
    "mono",
    "sans",
    "terminal",
    "backgroundPreset",
  ])
  const rawKeybinds = asRecord(settings?.keybinds)
  const keybinds = rawKeybinds
    ? Object.fromEntries(
        Object.entries(rawKeybinds)
          .filter(([key, value]) => key.length <= 160 && typeof value === "string" && value.length <= 160)
          .slice(0, 1_000),
      )
    : {}
  const permissions = copySettingsFields(asRecord(settings?.permissions), ["autoApprove"])
  const notifications = copySettingsFields(asRecord(settings?.notifications), ["agent", "permissions", "errors"])
  const sounds = copySettingsFields(asRecord(settings?.sounds), [
    "agentEnabled",
    "agent",
    "permissionsEnabled",
    "permissions",
    "errorsEnabled",
    "errors",
  ])
  return { general, appearance, keybinds, permissions, notifications, sounds }
}

function copySettingsFields(value: Record<string, unknown> | undefined, keys: string[]) {
  if (!value) return {}
  return Object.fromEntries(
    keys.flatMap((key) => {
      const item = value[key]
      if (
        typeof item === "boolean" ||
        typeof item === "string" ||
        (typeof item === "number" && Number.isFinite(item))
      ) {
        return [[key, item]]
      }
      return []
    }),
  )
}

function applyPortableProfile(
  value: Record<string, unknown>,
  projects: LocalProject[],
  mappings: SyncProjectMapping[],
) {
  const profile = sanitizePortableProfile(value)
  const store = getStore(GLOBAL_STORE)
  const currentPins = asRecord(parseStored(store.get("pins")))
  const localPathByProject = new Map(projects.map((project) => [project.id, project.worktree]))
  for (const mapping of mappings) {
    if (mapping.localWorktree) localPathByProject.set(mapping.projectID, mapping.localWorktree)
  }
  const closedProjectIDs = new Set(
    Object.entries(profile.projectVisibility)
      .filter(([, visible]) => visible === false)
      .map(([projectID]) => projectID),
  )
  const incomingProjectIDs = new Set(
    profile.projects.map((project) => project.projectID).filter((projectID) => !closedProjectIDs.has(projectID)),
  )
  const knownProjectIDs = new Set([
    ...Object.keys(profile.projectVisibility),
    ...profile.projects.map((project) => project.projectID),
  ])
  const knownProjectPaths = new Set(
    [...knownProjectIDs].flatMap((projectID) => {
      const path = localPathByProject.get(projectID)
      return path ? [profilePath(path)] : []
    }),
  )
  const currentProjectPins = Array.isArray(currentPins?.projects)
    ? currentPins.projects.filter((item): item is string => typeof item === "string")
    : []
  const incomingProjectPins = profile.projects
    .filter((project) => project.pinned && !closedProjectIDs.has(project.projectID))
    .sort((a, b) => a.order - b.order)
    .flatMap((project) => {
      const path = localPathByProject.get(project.projectID)
      return path ? [path] : []
    })
  const preservedProjectPins = currentProjectPins.filter((path) => !knownProjectPaths.has(profilePath(path)))
  const projectPins = [...new Set([...incomingProjectPins, ...preservedProjectPins])]
  store.set("pins", JSON.stringify({ ...currentPins, chats: profile.pins.chats, projects: projectPins }))

  const currentServer = asRecord(parseStored(store.get("server")))
  const currentProjectState = asRecord(currentServer?.projects)
  const currentLocalProjects = Array.isArray(currentProjectState?.local) ? currentProjectState.local : []
  const preservedLocalProjects = currentLocalProjects.filter((item) => {
    const current = asRecord(item)
    const worktree = current?.worktree
    if (typeof worktree !== "string") return false
    const projectID = projects.find((project) => profilePath(project.worktree) === profilePath(worktree))?.id
    return !projectID || (!incomingProjectIDs.has(projectID) && !closedProjectIDs.has(projectID))
  })
  const incomingLocalProjects = profile.projects
    .sort((a, b) => a.order - b.order)
    .flatMap((project) => {
      if (closedProjectIDs.has(project.projectID)) return []
      const worktree = localPathByProject.get(project.projectID)
      return worktree ? [{ worktree, expanded: project.expanded }] : []
    })
  const nextLocalProjects = [...incomingLocalProjects, ...preservedLocalProjects]
  const currentServerClosed = asRecord(currentServer?.recentlyClosed)
  const currentClosedProjects = Array.isArray(currentServerClosed?.local)
    ? currentServerClosed.local.filter((item): item is string => typeof item === "string")
    : []
  const incomingClosedProjects = [...closedProjectIDs].flatMap((projectID) => {
    const worktree = localPathByProject.get(projectID)
    return worktree ? [worktree] : []
  })
  const nextClosedProjects = [
    ...new Set([
      ...incomingClosedProjects,
      ...currentClosedProjects.filter((worktree) => !knownProjectPaths.has(profilePath(worktree))),
    ]),
  ].slice(0, 10_000)
  const currentLastProject = asRecord(currentServer?.lastProject)
  const last = profile.projects.find((project) => project.last && !closedProjectIDs.has(project.projectID))
  const lastWorktree = last ? localPathByProject.get(last.projectID) : undefined
  const nextLastProject = (() => {
    if (lastWorktree) return { ...currentLastProject, local: lastWorktree }
    const currentLast = currentLastProject?.local
    if (typeof currentLast !== "string" || !knownProjectPaths.has(profilePath(currentLast))) return currentLastProject
    const next = { ...currentLastProject }
    delete next.local
    return next
  })()
  store.set(
    "server",
    JSON.stringify({
      ...currentServer,
      projects: { ...currentProjectState, local: nextLocalProjects },
      recentlyClosed: { ...currentServerClosed, local: nextClosedProjects },
      lastProject: nextLastProject,
    }),
  )
  store.set("model", JSON.stringify(profile.model))
  if (profile.language) store.set("language", JSON.stringify(profile.language))
  const currentSettings = asRecord(parseStored(store.get("settings.v3")))
  const settings = Object.fromEntries(
    ["general", "appearance", "keybinds", "permissions", "notifications", "sounds"].map((section) => [
      section,
      section === "keybinds"
        ? { ...asRecord(currentSettings?.[section]), ...asRecord(profile.settings[section]) }
        : { ...asRecord(currentSettings?.[section]), ...asRecord(profile.settings[section]) },
    ]),
  )
  store.set("settings.v3", JSON.stringify({ ...currentSettings, ...settings }))
}

function profilePath(value: string) {
  return value.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase()
}

function parseStored(value: unknown): unknown {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

async function putLocalProfile(local: LocalServer, profile: SyncProfileEnvelope) {
  const headers = new Headers({ accept: "application/json", "content-type": "application/json" })
  if (local.password) headers.set("authorization", basicAuth(local.username ?? "opencode", local.password))
  const response = await fetch(new URL("/sync/profile", local.url), {
    method: "POST",
    headers,
    body: JSON.stringify(profile),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (response.status === 404) return
  if (!response.ok) throw new Error(`sync_profile_local_${response.status}`)
}

async function putRemoteProfile(peer: StoredPeer, profile: SyncProfileEnvelope) {
  const response = await fetch(`${peer.relayUrl}/sync/profile`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "x-overcode-channel-token": peer.token },
    body: JSON.stringify(profile),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (response.status === 404) return
  if (!response.ok) throw new Error(`sync_profile_remote_${response.status}`)
}

async function requestRemoteProfile(peer: StoredPeer): Promise<SyncProfileEnvelope | undefined> {
  const response = await fetch(`${peer.relayUrl}/sync/profile`, {
    headers: { accept: "application/json", "x-overcode-channel-token": peer.token },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (response.status === 404) return
  if (!response.ok) throw new Error(`sync_profile_remote_read_${response.status}`)
  const value = (await response.json()) as Partial<SyncProfileEnvelope>
  const updatedAt = value.updatedAt
  if (
    value.protocol !== "overcode-sync-profile-v1" ||
    typeof value.deviceID !== "string" ||
    value.deviceID.length === 0 ||
    value.deviceID.length > 160 ||
    typeof updatedAt !== "number" ||
    !Number.isInteger(updatedAt) ||
    updatedAt < 0 ||
    !asRecord(value.data)
  )
    throw new Error("sync_profile_invalid")
  return value as SyncProfileEnvelope
}

async function requestLocalIncomingProfiles(local: LocalServer): Promise<SyncProfileIncomingEnvelope | undefined> {
  const headers = new Headers({ accept: "application/json" })
  if (local.password) headers.set("authorization", basicAuth(local.username ?? "opencode", local.password))
  const response = await fetch(new URL("/sync/profile/incoming", local.url), {
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (response.status === 404) return
  if (!response.ok) throw new Error(`sync_profile_incoming_${response.status}`)
  const value = (await response.json()) as Partial<SyncProfileIncomingEnvelope>
  if (
    value.protocol !== "overcode-sync-profile-v1" ||
    typeof value.deviceID !== "string" ||
    !Array.isArray(value.profiles) ||
    value.deviceID.length === 0 ||
    value.deviceID.length > 160 ||
    value.profiles.length > 128
  )
    throw new Error("sync_profile_invalid")
  for (const profile of value.profiles) {
    if (
      !profile ||
      typeof profile.deviceID !== "string" ||
      profile.deviceID.length === 0 ||
      profile.deviceID.length > 160 ||
      !Number.isInteger(profile.updatedAt) ||
      profile.updatedAt < 0 ||
      !asRecord(profile.data)
    )
      throw new Error("sync_profile_invalid")
  }
  return value as SyncProfileIncomingEnvelope
}

function readStoredPeers(): StoredPeer[] {
  if (!safeStorage.isEncryptionAvailable()) return []
  const encoded = getStore().get(SYNC_DEVICES_KEY)
  if (typeof encoded !== "string" || encoded.length > MAX_ENCRYPTED_STORE_VALUE) return []
  try {
    const value = JSON.parse(safeStorage.decryptString(Buffer.from(encoded, "base64"))) as unknown
    if (!Array.isArray(value)) return []
    return value.filter(isStoredPeer).slice(0, MAX_STORED_PEERS)
  } catch {
    return []
  }
}

function readProfileState(): ProfileState {
  if (!safeStorage.isEncryptionAvailable()) return { updatedAt: 0, fingerprint: "", clocks: {}, projectClocks: {} }
  const encoded = getStore().get(SYNC_PROFILE_STATE_KEY)
  if (typeof encoded !== "string" || encoded.length > MAX_ENCRYPTED_STORE_VALUE) return { updatedAt: 0, fingerprint: "", clocks: {}, projectClocks: {} }
  try {
    const value = JSON.parse(safeStorage.decryptString(Buffer.from(encoded, "base64"))) as Partial<ProfileState>
    const updatedAt = value.updatedAt
    if (
      typeof updatedAt === "number" &&
      Number.isSafeInteger(updatedAt) &&
      updatedAt >= 0 &&
      typeof value.fingerprint === "string" &&
      value.fingerprint.length <= MAX_PROFILE_FINGERPRINT
    ) {
      return {
        updatedAt,
        fingerprint: value.fingerprint,
        clocks: sanitizeProfileClocks(value.clocks),
        projectClocks: sanitizeProjectVisibilityClocks(value.projectClocks),
      }
    }
  } catch {}
  return { updatedAt: 0, fingerprint: "", clocks: {}, projectClocks: {} }
}

function saveProfileState(value: ProfileState) {
  if (!safeStorage.isEncryptionAvailable()) return
  getStore().set(SYNC_PROFILE_STATE_KEY, safeStorage.encryptString(JSON.stringify(value)).toString("base64"))
}

function saveStoredPeers(value: StoredPeer[]) {
  if (!safeStorage.isEncryptionAvailable()) return
  getStore().set(SYNC_DEVICES_KEY, safeStorage.encryptString(JSON.stringify(value.slice(0, MAX_STORED_PEERS))).toString("base64"))
}

function isStoredPeer(value: unknown): value is StoredPeer {
  if (!value || typeof value !== "object") return false
  const item = value as Record<string, unknown>
  return (
    typeof item.id === "string" &&
    item.id.length > 0 &&
    item.id.length <= 160 &&
    typeof item.token === "string" &&
    isRelayToken(item.token) &&
    typeof item.relayUrl === "string" &&
    item.relayUrl.length <= 2_048 &&
    isRelayUrl(item.relayUrl) &&
    typeof item.name === "string" &&
    item.name.length <= 256 &&
    typeof item.pairedAt === "string" &&
    item.pairedAt.length <= 64 &&
    Number.isFinite(Date.parse(item.pairedAt)) &&
    typeof item.lastSeen === "string" &&
    item.lastSeen.length <= 64 &&
    Number.isFinite(Date.parse(item.lastSeen)) &&
    typeof item.remoteRevision === "number" &&
    Number.isSafeInteger(item.remoteRevision) &&
    item.remoteRevision >= 0 &&
    typeof item.localRevision === "number" &&
    Number.isSafeInteger(item.localRevision) &&
    item.localRevision >= 0 &&
    (item.remoteDeviceID === undefined ||
      (typeof item.remoteDeviceID === "string" && item.remoteDeviceID.length > 0 && item.remoteDeviceID.length <= 160))
  )
}
