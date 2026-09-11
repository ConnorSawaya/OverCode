import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { EventTable } from "../event/sql"
import { makeGlobalNode } from "../effect/app-node"
import { Project } from "@opencode-ai/schema/project"
import { AbsolutePath } from "../schema"
import { SyncProjectMappingTable } from "../sync/sql"
import { importedEventWins } from "../sync/conflict"
import { ProjectTable } from "./sql"

// Project metadata is replicated, but filesystem mappings are local to each
// installation. A remote project appears immediately with a safe placeholder
// until the user maps a local folder from Sync & Devices.
function localPath(value: string) {
  try {
    return AbsolutePath.make(value)
  } catch {
    return AbsolutePath.make(process.cwd())
  }
}

function unmappedProjectPath(projectID: string) {
  const safeID = projectID.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "project"
  return AbsolutePath.make(join(tmpdir(), "overcode-unmapped", safeID))
}

function isSyncImport(event: { metadata?: Record<string, unknown> }) {
  return event.metadata?.syncImport === true
}

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const { db } = yield* Database.Service

    yield* events.project(Project.Event.Updated, (event) =>
      Effect.gen(function* () {
        const current = yield* db
          .select({ worktree: ProjectTable.worktree, sandboxes: ProjectTable.sandboxes, vcs: ProjectTable.vcs })
          .from(ProjectTable)
          .where(eq(ProjectTable.id, event.data.id))
          .get()
          .pipe(Effect.orDie)
        const mapping = yield* db
          .select()
          .from(SyncProjectMappingTable)
          .where(eq(SyncProjectMappingTable.project_id, event.data.id))
          .get()
          .pipe(Effect.orDie)
        const imported = isSyncImport(event)
        if (imported) {
          const previous = yield* db
            .select({ id: EventTable.id, data: EventTable.data, type: EventTable.type })
            .from(EventTable)
            .where(eq(EventTable.aggregate_id, event.data.id))
            .all()
            .pipe(Effect.orDie)
          // Keep project metadata deterministic when two installations edit
          // it offline and one event arrives after the other.
          if (
            !importedEventWins(
              { time: event.data.time.updated, id: event.id },
              previous.filter(
                (item) =>
                  item.type ===
                  EventV2.versionedType(Project.Event.Updated.type, Project.Event.Updated.durable!.version),
              ),
            )
          )
            return
        }
        const worktree = imported
          ? mapping?.local_worktree
            ? AbsolutePath.make(mapping.local_worktree)
            : (current?.worktree ?? unmappedProjectPath(event.data.id))
          : (current?.worktree ?? localPath(event.data.worktree))

        if (imported) {
          yield* db
            .insert(SyncProjectMappingTable)
            .values({
              project_id: event.data.id,
              source_worktree: event.data.worktree,
              local_worktree: mapping?.local_worktree ?? current?.worktree ?? null,
              time_updated: Date.now(),
            })
            .onConflictDoUpdate({
              target: SyncProjectMappingTable.project_id,
              set: { source_worktree: event.data.worktree, time_updated: Date.now() },
            })
            .run()
            .pipe(Effect.orDie)
        }

        const icon = event.data.icon
        const values = {
          id: event.data.id,
          worktree,
          vcs: current?.vcs ?? event.data.vcs ?? null,
          name: event.data.name,
          icon_url: icon?.url,
          icon_url_override: icon?.override,
          icon_color: icon?.color,
          time_created: event.data.time.created,
          time_updated: event.data.time.updated,
          time_initialized: event.data.time.initialized,
          sandboxes: current?.sandboxes ?? [],
          commands: event.data.commands,
        }
        yield* db
          .insert(ProjectTable)
          .values(values)
          .onConflictDoUpdate({
            target: ProjectTable.id,
            set: {
              name: values.name,
              icon_url: values.icon_url,
              icon_url_override: values.icon_url_override,
              icon_color: values.icon_color,
              time_updated: values.time_updated,
              time_initialized: values.time_initialized,
              commands: values.commands,
            },
          })
          .run()
          .pipe(Effect.orDie)
      }),
    )
  }),
)

export const node = makeGlobalNode({ name: "project-projector", layer, deps: [EventV2.node, Database.node] })

export * as ProjectProjector from "./projector"
