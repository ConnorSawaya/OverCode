import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { SessionID } from "@/session/schema"
import { Swarm } from "@/swarm/service"
import { SwarmSchema } from "@/swarm/schema"
import { InstanceHttpApi } from "../api"
import type { StartPayload } from "../groups/swarm"
import { SwarmNotFoundError } from "../errors"

const missing = (swarmID: SwarmSchema.ID) =>
  new SwarmNotFoundError({ swarmID: String(swarmID), message: `Swarm not found: ${swarmID}` })

export const swarmHandlers = HttpApiBuilder.group(InstanceHttpApi, "swarm", (handlers) =>
  Effect.gen(function* () {
    const svc = yield* Swarm.Service

    const start = Effect.fn("SwarmHttpApi.start")(function* (ctx: { payload: StartPayload }) {
      return yield* svc
        .start({
          sessionID: ctx.payload.sessionID,
          task: ctx.payload.task,
          preset: ctx.payload.preset,
          config: ctx.payload.config,
          ...(ctx.payload.model
            ? {
                model: {
                  providerID: ctx.payload.model.providerID as string,
                  modelID: ctx.payload.model.modelID as string,
                  ...(ctx.payload.model.variant ? { variant: ctx.payload.model.variant } : {}),
                },
              }
            : {}),
        })
        .pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
    })

    const get = Effect.fn("SwarmHttpApi.get")(function* (ctx: { params: { swarmID: SwarmSchema.ID } }) {
      const record = yield* svc.get(ctx.params.swarmID)
      if (!record) return yield* Effect.fail(missing(ctx.params.swarmID))
      return record
    })

    const list = Effect.fn("SwarmHttpApi.list")(function* (ctx: { query: { sessionID: SessionID } }) {
      return yield* svc.listBySession(ctx.query.sessionID)
    })

    const cancel = Effect.fn("SwarmHttpApi.cancel")(function* (ctx: { params: { swarmID: SwarmSchema.ID } }) {
      yield* svc.cancel(ctx.params.swarmID)
      return true
    })

    const agents = Effect.fn("SwarmHttpApi.agents")(function* (ctx: { params: { swarmID: SwarmSchema.ID } }) {
      const record = yield* svc.get(ctx.params.swarmID)
      if (!record) return yield* Effect.fail(missing(ctx.params.swarmID))
      return record.agents
    })

    return handlers.handle("start", start).handle("get", get).handle("list", list).handle("cancel", cancel).handle("agents", agents)
  }),
)
