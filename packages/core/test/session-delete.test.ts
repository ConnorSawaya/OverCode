import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { inArray } from "drizzle-orm"
import { AppNodeBuilder } from "@overcode-ai/core/effect/app-node-builder"
import { Database } from "@overcode-ai/core/database/database"
import { EventV2 } from "@overcode-ai/core/event"
import { EventTable } from "@overcode-ai/core/event/sql"
import { LayerNode } from "@overcode-ai/core/effect/layer-node"
import { Location } from "@overcode-ai/core/location"
import { ProjectV2 } from "@overcode-ai/core/project"
import { AbsolutePath } from "@overcode-ai/core/schema"
import { SessionV2 } from "@overcode-ai/core/session"
import { SessionExecution } from "@overcode-ai/core/session/execution"
import { SessionProjector } from "@overcode-ai/core/session/projector"
import { Prompt } from "@overcode-ai/core/session/prompt"
import { SessionInputTable, SessionTable } from "@overcode-ai/core/session/sql"
import { SessionStore } from "@overcode-ai/core/session/store"
import { testEffect } from "./lib/effect"

const interrupted: SessionV2.ID[] = []
const execution = Layer.succeed(
  SessionExecution.Service,
  SessionExecution.Service.of({
    active: Effect.succeed(new Set()),
    resume: () => Effect.void,
    wake: () => Effect.void,
    interrupt: (sessionID) => Effect.sync(() => interrupted.push(sessionID)),
  }),
)
const projects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({
    resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
    directories: () => Effect.succeed([]),
    commit: () => Effect.void,
  }),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SessionStore.node, SessionV2.node]),
    [
      [ProjectV2.node, projects],
      [SessionExecution.node, execution],
    ],
  ),
)

const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })
const ids = {
  parent: SessionV2.ID.make("ses_delete_parent"),
  child: SessionV2.ID.make("ses_delete_child"),
  second: SessionV2.ID.make("ses_delete_second"),
  third: SessionV2.ID.make("ses_delete_third"),
}

describe("SessionV2.remove", () => {
  it.effect("deletes only the selected session tree and preserves two independent sessions", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const { db } = yield* Database.Service
      interrupted.length = 0

      for (const id of Object.values(ids)) yield* sessions.create({ id, location })
      yield* db
        .update(SessionTable)
        .set({ parent_id: ids.parent })
        .where(inArray(SessionTable.id, [ids.child]))
        .run()
        .pipe(Effect.orDie)

      const admitted = yield* Effect.all(
        [ids.parent, ids.child, ids.second, ids.third].map((sessionID) =>
          sessions.prompt({
            sessionID,
            prompt: Prompt.make({ text: `queued:${sessionID}` }),
            delivery: "queue",
            resume: false,
          }),
        ),
        { concurrency: "unbounded" },
      )

      yield* sessions.remove(ids.parent)

      expect(interrupted).toEqual([ids.parent, ids.child])
      expect((yield* sessions.get(ids.parent).pipe(Effect.flip))._tag).toBe("Session.NotFoundError")
      expect((yield* sessions.get(ids.child).pipe(Effect.flip))._tag).toBe("Session.NotFoundError")
      expect((yield* sessions.get(ids.second)).id).toBe(ids.second)
      expect((yield* sessions.get(ids.third)).id).toBe(ids.third)
      expect((yield* sessions.pending(ids.second)).map((item) => item.id)).toEqual([admitted[2]!.id])
      expect((yield* sessions.pending(ids.third)).map((item) => item.id)).toEqual([admitted[3]!.id])

      const remainingInputs = yield* db.select().from(SessionInputTable).all().pipe(Effect.orDie)
      expect(remainingInputs.map((row) => row.session_id).sort()).toEqual([ids.second, ids.third].sort())
      const removedEvents = yield* db
        .select()
        .from(EventTable)
        .where(inArray(EventTable.aggregate_id, [ids.parent, ids.child]))
        .all()
        .pipe(Effect.orDie)
      expect(removedEvents).toEqual([])
    }),
  )
})
