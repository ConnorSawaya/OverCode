import { EventV2 } from "@opencode-ai/core/event"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { described } from "./metadata"

const root = "/sync"

export const SyncChangeSchema = Schema.Struct({
  revision: NonNegativeInt,
  id: EventV2.ID,
  aggregate_id: Schema.String,
  seq: NonNegativeInt,
  type: Schema.String,
  data: Schema.Record(Schema.String, Schema.Unknown),
  source_device: Schema.String,
  time_created: NonNegativeInt,
})

export const SyncEnvelope = Schema.Struct({
  protocol: Schema.Literal("overcode-sync-v1"),
  deviceID: Schema.String,
  cursor: NonNegativeInt,
  latestRevision: NonNegativeInt,
  changes: Schema.Array(SyncChangeSchema),
})

export const ChangesPayload = Schema.Struct({
  after: NonNegativeInt,
  limit: Schema.optional(NonNegativeInt),
})

export const ImportPayload = Schema.Struct({
  protocol: Schema.Literal("overcode-sync-v1"),
  sourceDevice: Schema.String,
  events: Schema.Array(
    Schema.Struct({
      id: EventV2.ID,
      aggregateID: Schema.String,
      seq: NonNegativeInt,
      type: Schema.String,
      data: Schema.Record(Schema.String, Schema.Unknown),
    }),
  ),
})

export const ImportResponse = Schema.Struct({ imported: NonNegativeInt })

const SyncProfileData = Schema.Record(Schema.String, Schema.Unknown)
export const SyncProfileEnvelope = Schema.Struct({
  protocol: Schema.Literal("overcode-sync-profile-v1"),
  deviceID: Schema.String,
  updatedAt: NonNegativeInt,
  data: SyncProfileData,
})
export const SyncProfilePutPayload = Schema.Struct({
  protocol: Schema.Literal("overcode-sync-profile-v1"),
  deviceID: Schema.String,
  updatedAt: NonNegativeInt,
  data: SyncProfileData,
})
export const SyncProfileIncomingEnvelope = Schema.Struct({
  protocol: Schema.Literal("overcode-sync-profile-v1"),
  deviceID: Schema.String,
  profiles: Schema.Array(
    Schema.Struct({
      deviceID: Schema.String,
      updatedAt: NonNegativeInt,
      data: SyncProfileData,
    }),
  ),
})

export const ProjectMapping = Schema.Struct({
  projectID: Schema.String,
  name: Schema.optional(Schema.String),
  sourceWorktree: Schema.String,
  localWorktree: Schema.optional(Schema.String),
})
export const ProjectMappingsEnvelope = Schema.Struct({
  protocol: Schema.Literal("overcode-sync-v1"),
  projects: Schema.Array(ProjectMapping),
})
export const ProjectMappingPayload = Schema.Struct({
  protocol: Schema.Literal("overcode-sync-v1"),
  projectID: Schema.String,
  localWorktree: Schema.String,
})

export const DeviceSyncPaths = {
  snapshot: `${root}/snapshot`,
  changes: `${root}/changes`,
  import: `${root}/import`,
  profile: `${root}/profile`,
  incomingProfiles: `${root}/profile/incoming`,
  projectMappings: `${root}/project-mappings`,
} as const

// Kept as a separate API because older consumers construct RootHttpApi in
// isolation. The desktop server mounts this authenticated API beside the
// normal root routes without changing the existing OpenCode contract.
export const DeviceSyncApi = HttpApi.make("device-sync").add(
  HttpApiGroup.make("deviceSync")
    .add(
      HttpApiEndpoint.get("snapshot", DeviceSyncPaths.snapshot, {
        success: described(SyncEnvelope, "Initial synchronization snapshot"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "device-sync.snapshot",
          summary: "Get sync snapshot",
          description: "Read the portable event snapshot used when a device is paired for the first time.",
        }),
      ),
      HttpApiEndpoint.post("changes", DeviceSyncPaths.changes, {
        payload: ChangesPayload,
        success: described(SyncEnvelope, "Incremental synchronization changes"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "device-sync.changes",
          summary: "Get sync changes",
          description: "Read incremental portable changes after a local monotonic revision cursor.",
        }),
      ),
      HttpApiEndpoint.post("import", DeviceSyncPaths.import, {
        payload: ImportPayload,
        success: described(ImportResponse, "Imported synchronization changes"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "device-sync.import",
          summary: "Import sync changes",
          description: "Merge portable events into the local event log with stable-ID deduplication.",
        }),
      ),
      HttpApiEndpoint.get("profile", DeviceSyncPaths.profile, {
        success: described(SyncProfileEnvelope, "Portable profile snapshot"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "device-sync.profile",
          summary: "Get portable profile",
          description: "Read safe preferences and model selections without exposing credentials or machine paths.",
        }),
      ),
      HttpApiEndpoint.get("incomingProfiles", DeviceSyncPaths.incomingProfiles, {
        success: described(SyncProfileIncomingEnvelope, "Profiles received from trusted devices"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "device-sync.profile-incoming",
          summary: "Get received profiles",
          description: "Read portable profile snapshots received from other trusted devices.",
        }),
      ),
      HttpApiEndpoint.post("profilePut", DeviceSyncPaths.profile, {
        payload: SyncProfilePutPayload,
        success: described(SyncProfileEnvelope, "Stored portable profile snapshot"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "device-sync.profile-put",
          summary: "Store portable profile",
          description: "Store a bounded, credential-free profile snapshot for a trusted device.",
        }),
      ),
      HttpApiEndpoint.get("projectMappings", DeviceSyncPaths.projectMappings, {
        success: described(ProjectMappingsEnvelope, "Portable project mappings"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "device-sync.project-mappings",
          summary: "List local project mappings",
          description: "Read machine-local folder mappings for synchronized project identities.",
        }),
      ),
      HttpApiEndpoint.post("setProjectMapping", DeviceSyncPaths.projectMappings, {
        payload: ProjectMappingPayload,
        success: described(ProjectMapping, "Updated project mapping"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "device-sync.project-mapping-put",
          summary: "Map a synchronized project folder",
          description: "Set the local filesystem folder used by one synchronized project identity.",
        }),
      ),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "device-sync",
        description: "Cross-device synchronization routes. Secrets and filesystem contents are excluded.",
      }),
    ),
)
