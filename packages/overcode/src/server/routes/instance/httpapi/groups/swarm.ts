import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { SessionID } from "@/session/schema"
import { SwarmSchema } from "@/swarm/schema"
import { SwarmNotFoundError } from "../errors"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery, WorkspaceRoutingQueryFields } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/swarm"

const StartPayload = Schema.Struct({
  sessionID: SessionID,
  task: Schema.String,
  preset: Schema.optional(SwarmSchema.Preset),
  config: Schema.optional(SwarmSchema.Config),
  model: Schema.optional(SwarmSchema.ModelRef),
})

const ListQuery = Schema.Struct({
  sessionID: SessionID,
  ...WorkspaceRoutingQueryFields,
})

export type StartPayload = typeof StartPayload.Type

export const SwarmApi = HttpApi.make("swarm")
  .add(
    HttpApiGroup.make("swarm")
      .add(
        HttpApiEndpoint.post("start", root, {
          query: WorkspaceRoutingQuery,
          payload: StartPayload,
          success: described(SwarmSchema.Record, "Started swarm run"),
          error: [HttpApiError.BadRequest],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "swarm.start",
            summary: "Start a swarm run",
            description: "Start coordinated multi-agent execution on a session task.",
          }),
        ),
        HttpApiEndpoint.get("get", `${root}/:swarmID`, {
          params: { swarmID: SwarmSchema.ID },
          query: WorkspaceRoutingQuery,
          success: described(SwarmSchema.Record, "Swarm run state"),
          error: [HttpApiError.BadRequest, SwarmNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "swarm.get",
            summary: "Get swarm state",
            description: "Get the current state, agents, and result of a swarm run.",
          }),
        ),
        HttpApiEndpoint.get("list", `${root}`, {
          query: ListQuery,
          success: described(Schema.Array(SwarmSchema.Record), "Swarm runs for a session"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "swarm.list",
            summary: "List swarm runs",
            description: "List swarm runs started on a session.",
          }),
        ),
        HttpApiEndpoint.post("cancel", `${root}/:swarmID/cancel`, {
          params: { swarmID: SwarmSchema.ID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Swarm cancelled"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "swarm.cancel",
            summary: "Cancel a swarm run",
            description: "Cancel a swarm run and all of its child agents.",
          }),
        ),
        HttpApiEndpoint.get("agents", `${root}/:swarmID/agents`, {
          params: { swarmID: SwarmSchema.ID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(SwarmSchema.AgentState), "Swarm child agents"),
          error: [HttpApiError.BadRequest, SwarmNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "swarm.agents",
            summary: "List swarm agents",
            description: "List child agents of a swarm run with their statuses.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "swarm",
          description: "Experimental HttpApi swarm routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "overcode experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
