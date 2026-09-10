import { EventV2 } from "@opencode-ai/core/event"
import { Effect } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { EventV2Bridge } from "@/event-v2-bridge"
import * as Sync from "@/sync/service"
import type { SyncChange as SyncChangeRow } from "@opencode-ai/core/sync/sql"
import {
  ChangesPayload,
  DeviceSyncApi,
  ImportPayload,
  SyncEnvelope,
  SyncProfileEnvelope,
  SyncProfileIncomingEnvelope,
  SyncProfilePutPayload,
  ProjectMappingPayload,
} from "../groups/device-sync"

const MAX_IMPORT_EVENTS = 10_000
const MAX_SOURCE_DEVICE_LENGTH = 160
const MAX_PROFILE_BYTES = 256 * 1024
const MAX_SYNC_BATCH = 1_000

function responseEnvelope(deviceID: string, latestRevision: number, changes: readonly SyncChangeRow[]) {
  const encoded = changes.map((change) => ({
    revision: change.revision,
    id: EventV2.ID.make(change.id),
    aggregate_id: change.aggregate_id,
    seq: change.seq,
    type: change.type,
    data: change.data,
    source_device: change.source_device,
    time_created: change.time_created,
  }))
  return {
    protocol: "overcode-sync-v1" as const,
    deviceID,
    cursor: encoded.at(-1)?.revision ?? latestRevision,
    latestRevision,
    changes: encoded,
  } satisfies typeof SyncEnvelope.Type
}

function profileEnvelope(deviceID: string, updatedAt: number, data: Record<string, unknown>) {
  return {
    protocol: "overcode-sync-profile-v1" as const,
    deviceID,
    updatedAt,
    data,
  } satisfies typeof SyncProfileEnvelope.Type
}

export const deviceSyncHandlers = HttpApiBuilder.group(DeviceSyncApi, "deviceSync", (handlers) =>
  Effect.gen(function* () {
    const sync = yield* Sync.Service
    const events = yield* EventV2Bridge.Service

    const snapshot = Effect.fn("DeviceSyncHttpApi.snapshot")(function* () {
      // Initial pairing is intentionally paged. The client can resume with
      // the returned cursor, so a large history never becomes one oversized
      // response or blocks the local application while it is starting.
      const rows = yield* sync.snapshot(MAX_SYNC_BATCH)
      return responseEnvelope(yield* sync.deviceID(), yield* sync.latestRevision(), rows)
    })

    const changes = Effect.fn("DeviceSyncHttpApi.changes")(function* (ctx: { payload: typeof ChangesPayload.Type }) {
      const rows = yield* sync.changes(ctx.payload.after, Math.min(ctx.payload.limit ?? MAX_SYNC_BATCH, MAX_SYNC_BATCH))
      return responseEnvelope(yield* sync.deviceID(), yield* sync.latestRevision(), rows)
    })

    const importChanges = Effect.fn("DeviceSyncHttpApi.import")(function* (ctx: {
      payload: typeof ImportPayload.Type
    }) {
      const request = yield* HttpServerRequest.HttpServerRequest
      const authenticatedDevice = request.headers["x-overcode-device-id"]
      const sourceDevice = authenticatedDevice ?? ctx.payload.sourceDevice
      if (
        sourceDevice.length === 0 ||
        sourceDevice.length > MAX_SOURCE_DEVICE_LENGTH ||
        ctx.payload.events.length > MAX_IMPORT_EVENTS
      )
        return yield* new HttpApiError.BadRequest({})

      const incoming = [...ctx.payload.events].sort(
        (a, b) => a.aggregateID.localeCompare(b.aggregateID) || a.seq - b.seq || a.id.localeCompare(b.id),
      )
      yield* Effect.forEach(
        incoming,
        (event) =>
          events.replay(
            {
              id: event.id,
              aggregateID: event.aggregateID,
              seq: event.seq,
              type: event.type,
              data: event.data,
            },
            {
              publish: true,
              rebase: true,
              metadata: { syncImport: true, sourceDevice },
            },
          ),
        { discard: true },
      ).pipe(Effect.catchCause(() => Effect.fail(new HttpApiError.BadRequest({}))))

      return { imported: incoming.length }
    })

    const profile = Effect.fn("DeviceSyncHttpApi.profile")(function* () {
      const deviceID = yield* sync.deviceID()
      const row = yield* sync.profile()
      return profileEnvelope(deviceID, row?.updated_at ?? 0, row?.data ?? {})
    })

    const incomingProfiles = Effect.fn("DeviceSyncHttpApi.incomingProfiles")(function* () {
      const profiles = yield* sync.incomingProfiles()
      return {
        protocol: "overcode-sync-profile-v1" as const,
        deviceID: yield* sync.deviceID(),
        profiles: profiles.map((row) => ({ deviceID: row.device_id, updatedAt: row.updated_at, data: row.data })),
      } satisfies typeof SyncProfileIncomingEnvelope.Type
    })

    const putProfile = Effect.fn("DeviceSyncHttpApi.profilePut")(function* (ctx: {
      payload: typeof SyncProfilePutPayload.Type
    }) {
      const request = yield* HttpServerRequest.HttpServerRequest
      const authenticatedDevice = request.headers["x-overcode-device-id"]
      const deviceID = authenticatedDevice ?? ctx.payload.deviceID
      let bytes = 0
      try {
        bytes = new TextEncoder().encode(JSON.stringify(ctx.payload.data)).byteLength
      } catch {
        return yield* new HttpApiError.BadRequest({})
      }
      if (
        deviceID.length === 0 ||
        deviceID.length > MAX_SOURCE_DEVICE_LENGTH ||
        bytes > MAX_PROFILE_BYTES
      )
        return yield* new HttpApiError.BadRequest({})
      yield* sync.upsertProfile({ deviceID, updatedAt: ctx.payload.updatedAt, data: ctx.payload.data })
      return profileEnvelope(deviceID, ctx.payload.updatedAt, ctx.payload.data)
    })

    const projectMappings = Effect.fn("DeviceSyncHttpApi.projectMappings")(function* () {
      return {
        protocol: "overcode-sync-v1" as const,
        projects: yield* sync.projectMappings(),
      }
    })

    const setProjectMapping = Effect.fn("DeviceSyncHttpApi.setProjectMapping")(function* (ctx: {
      payload: typeof ProjectMappingPayload.Type
    }) {
      if (
        ctx.payload.projectID.length === 0 ||
        ctx.payload.projectID.length > 320 ||
        ctx.payload.localWorktree.length === 0 ||
        ctx.payload.localWorktree.length > 4_096
      )
        return yield* new HttpApiError.BadRequest({})
      const mapping = yield* sync.setProjectMapping({
        projectID: ctx.payload.projectID,
        localWorktree: ctx.payload.localWorktree,
      })
      if (!mapping) return yield* new HttpApiError.BadRequest({})
      return mapping
    })

    return handlers
      .handle("snapshot", snapshot)
      .handle("changes", changes)
      .handle("import", importChanges)
      .handle("profile", profile)
      .handle("incomingProfiles", incomingProfiles)
      .handle("profilePut", putProfile)
      .handle("projectMappings", projectMappings)
      .handle("setProjectMapping", setProjectMapping)
  }),
)
