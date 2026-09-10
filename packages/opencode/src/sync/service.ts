import { randomUUID } from "node:crypto"
import { asc, desc, eq, gt, ne } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import {
  SyncChangeTable,
  SyncProfileTable,
  SyncProjectMappingTable,
  SyncStateTable,
  type SyncChange,
  type SyncProfile,
} from "@opencode-ai/core/sync/sql"
import { Project } from "@opencode-ai/schema/project"
import { Durable } from "@opencode-ai/schema/durable-event-manifest"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"

const STATE_ID = "local"
const DEFAULT_LIMIT = 10_000
const MAX_LIMIT = 100_000

export type { SyncChange }

export type SyncProjectMappingInfo = {
  projectID: string
  name?: string
  sourceWorktree: string
  localWorktree?: string
}

export interface Interface {
  readonly deviceID: () => Effect.Effect<string>
  readonly latestRevision: () => Effect.Effect<number>
  readonly snapshot: (limit?: number) => Effect.Effect<SyncChange[]>
  readonly changes: (after: number, limit?: number) => Effect.Effect<SyncChange[]>
  readonly profile: () => Effect.Effect<SyncProfile | undefined>
  readonly incomingProfiles: () => Effect.Effect<SyncProfile[]>
  readonly upsertProfile: (input: { deviceID: string; updatedAt: number; data: Record<string, unknown> }) => Effect.Effect<void>
  readonly projectMappings: () => Effect.Effect<SyncProjectMappingInfo[]>
  readonly setProjectMapping: (input: {
    projectID: string
    localWorktree: string
  }) => Effect.Effect<SyncProjectMappingInfo | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@overcode/Sync") {}

function limit(value: number | undefined) {
  if (!Number.isFinite(value)) return DEFAULT_LIMIT
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(value!)))
}

function projectData(row: typeof ProjectTable.$inferSelect) {
  return {
    id: row.id,
    worktree: row.worktree,
    vcs: row.vcs === "git" ? ("git" as const) : undefined,
    name: row.name ?? undefined,
    icon:
      row.icon_url || row.icon_url_override || row.icon_color
        ? {
            url: row.icon_url ?? undefined,
            override: row.icon_url_override ?? undefined,
            color: row.icon_color ?? undefined,
          }
        : undefined,
    commands: row.commands ?? undefined,
    time: {
      created: row.time_created,
      updated: row.time_updated,
      initialized: row.time_initialized ?? undefined,
    },
    // Sandboxes are machine-specific mappings.  Keep the project event
    // portable and let the receiving installation retain its own mappings.
    sandboxes: [],
  } satisfies Project.Info
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service

    const ensureDeviceID = Effect.fn("Sync.deviceID")(function* () {
      const current = yield* db
        .select({ deviceID: SyncStateTable.device_id })
        .from(SyncStateTable)
        .where(eq(SyncStateTable.id, STATE_ID))
        .get()
        .pipe(Effect.orDie)
      if (current) return current.deviceID

      const now = Date.now()
      const deviceID = `desktop_${randomUUID()}`
      yield* db
        .insert(SyncStateTable)
        .values({ id: STATE_ID, device_id: deviceID, time_created: now, time_updated: now })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      const created = yield* db
        .select({ deviceID: SyncStateTable.device_id })
        .from(SyncStateTable)
        .where(eq(SyncStateTable.id, STATE_ID))
        .get()
        .pipe(Effect.orDie)
      return created?.deviceID ?? deviceID
    })

    const deviceID = yield* ensureDeviceID()

    const append = (change: {
      id: string
      aggregateID: string
      seq: number
      type: string
      data: Record<string, unknown>
      sourceDevice?: string
    }) =>
      db
        .insert(SyncChangeTable)
        .values({
          id: change.id,
          aggregate_id: change.aggregateID,
          seq: change.seq,
          type: change.type,
          data: change.data,
          source_device: change.sourceDevice ?? deviceID,
          time_created: Date.now(),
        })
        .onConflictDoNothing({ target: SyncChangeTable.id })
        .run()
        .pipe(Effect.orDie)

    // Backfill existing durable session events on upgrade.  This makes the
    // first pairing an actual initial sync instead of only syncing new chats.
    const existingEvents = yield* db
      .select()
      .from(EventTable)
      .orderBy(asc(EventTable.aggregate_id), asc(EventTable.seq))
      .all()
      .pipe(Effect.orDie)
    yield* Effect.forEach(
      existingEvents.filter((event) => Durable.get(event.type)?.durable !== undefined),
      (event) =>
        append({
          id: event.id,
          aggregateID: event.aggregate_id,
          seq: event.seq,
          type: event.type,
          data: event.data,
        }),
      { discard: true },
    )

    // Projects predate the durable event manifest.  Add a stable synthetic
    // current-value event for each project so old installations also receive
    // project metadata on their first sync.
    const projects = yield* db.select().from(ProjectTable).all().pipe(Effect.orDie)
    yield* Effect.forEach(
      projects,
      (project) => {
        const data = projectData(project)
        return append({
          id: `evt_sync_project_${project.id}`,
          aggregateID: project.id,
          seq: 0,
          type: EventV2.versionedType(Project.Event.Updated.type, Project.Event.Updated.durable!.version),
          data: data as Record<string, unknown>,
        })
      },
      { discard: true },
    )

    const unsubscribe = yield* events.listen((event) => {
      if (!event.durable) return Effect.void
      const sourceDevice = typeof event.metadata?.sourceDevice === "string" ? event.metadata.sourceDevice : deviceID
      return append({
        id: event.id,
        aggregateID: event.durable.aggregateID,
        seq: event.durable.seq,
        type: EventV2.versionedType(event.type, event.durable.version),
        data: event.data as Record<string, unknown>,
        sourceDevice,
      })
    })
    yield* Effect.addFinalizer(() => unsubscribe)

    return Service.of({
      deviceID: () => Effect.succeed(deviceID),
      latestRevision: () =>
        db
          .select({ revision: SyncChangeTable.revision })
          .from(SyncChangeTable)
          .orderBy(desc(SyncChangeTable.revision))
          .limit(1)
          .get()
          .pipe(Effect.map((row) => row?.revision ?? 0), Effect.orDie),
      snapshot: (requested) =>
        db.select().from(SyncChangeTable).orderBy(asc(SyncChangeTable.revision)).limit(limit(requested)).all().pipe(Effect.orDie),
      changes: (after, requested) =>
        db
          .select()
          .from(SyncChangeTable)
          .where(gt(SyncChangeTable.revision, after))
          .orderBy(asc(SyncChangeTable.revision))
          .limit(limit(requested))
          .all()
          .pipe(Effect.orDie),
      profile: () =>
        db
          .select()
          .from(SyncProfileTable)
          .where(eq(SyncProfileTable.device_id, deviceID))
          .get()
          .pipe(Effect.orDie),
      incomingProfiles: () =>
        db
          .select()
          .from(SyncProfileTable)
          .where(ne(SyncProfileTable.device_id, deviceID))
          .orderBy(asc(SyncProfileTable.updated_at), asc(SyncProfileTable.device_id))
          .all()
          .pipe(Effect.orDie),
      upsertProfile: (input) =>
        Effect.gen(function* () {
          const current = yield* db
            .select({ updatedAt: SyncProfileTable.updated_at })
            .from(SyncProfileTable)
            .where(eq(SyncProfileTable.device_id, input.deviceID))
            .get()
            .pipe(Effect.orDie)
          if (current && current.updatedAt > input.updatedAt) return
          yield* db
            .insert(SyncProfileTable)
            .values({ device_id: input.deviceID, updated_at: input.updatedAt, data: input.data })
            .onConflictDoUpdate({
              target: SyncProfileTable.device_id,
              set: { updated_at: input.updatedAt, data: input.data },
            })
            .run()
            .pipe(Effect.orDie)
        }),
      projectMappings: () =>
        Effect.gen(function* () {
          const projects = yield* db.select().from(ProjectTable).all().pipe(Effect.orDie)
          const mappings = yield* db.select().from(SyncProjectMappingTable).all().pipe(Effect.orDie)
          const byID = new Map(mappings.map((mapping) => [mapping.project_id, mapping]))
          return projects.flatMap((project) => {
            const mapping = byID.get(project.id)
            if (!mapping) return []
            return [
              {
                projectID: project.id,
                ...(project.name ? { name: project.name } : {}),
                sourceWorktree: mapping.source_worktree,
                ...(mapping.local_worktree ? { localWorktree: mapping.local_worktree } : {}),
              },
            ]
          })
        }),
      setProjectMapping: (input) =>
        Effect.gen(function* () {
          const localWorktree = (() => {
            try {
              return AbsolutePath.make(input.localWorktree)
            } catch {
              return undefined
            }
          })()
          if (!localWorktree) return undefined
          const projectID = Project.ID.make(input.projectID)
          const project = yield* db
            .select()
            .from(ProjectTable)
            .where(eq(ProjectTable.id, projectID))
            .get()
            .pipe(Effect.orDie)
          if (!project) return undefined
          const current = yield* db
            .select()
            .from(SyncProjectMappingTable)
            .where(eq(SyncProjectMappingTable.project_id, input.projectID))
            .get()
            .pipe(Effect.orDie)
          yield* db
            .update(ProjectTable)
            .set({ worktree: localWorktree })
            .where(eq(ProjectTable.id, projectID))
            .run()
            .pipe(Effect.orDie)
          yield* db
            .insert(SyncProjectMappingTable)
            .values({
              project_id: input.projectID,
              source_worktree: current?.source_worktree ?? project.worktree,
              local_worktree: localWorktree,
              time_updated: Date.now(),
            })
            .onConflictDoUpdate({
              target: SyncProjectMappingTable.project_id,
              set: { local_worktree: localWorktree, time_updated: Date.now() },
            })
            .run()
            .pipe(Effect.orDie)
          return {
            projectID: input.projectID,
            ...(project.name ? { name: project.name } : {}),
            sourceWorktree: current?.source_worktree ?? project.worktree,
            localWorktree,
          }
        }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [EventV2.node, Database.node] })
