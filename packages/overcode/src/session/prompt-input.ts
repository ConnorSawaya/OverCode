export * as SessionPromptInput from "./prompt-input"

import { SessionV1 } from "@overcode-ai/core/v1/session"
import { ModelV2 } from "@overcode-ai/core/model"
import { ProviderV2 } from "@overcode-ai/core/provider"
import { Schema } from "effect"
import { MessageID, SessionID } from "./schema"

const ModelRef = Schema.Struct({
  providerID: ProviderV2.ID,
  modelID: ModelV2.ID,
})

export const Delivery = Schema.Literals(["steer", "queue"])
export type Delivery = typeof Delivery.Type

export const ExecutionMode = Schema.Literals(["normal", "deep", "swarm"])
export type ExecutionMode = typeof ExecutionMode.Type

export const PromptInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
  model: Schema.optional(ModelRef),
  agent: Schema.optional(Schema.String),
  mode: Schema.optional(ExecutionMode).annotate({
    description: "Execution mode: normal single-agent, deep single-agent with critique, or multi-agent swarm",
  }),
  noReply: Schema.optional(Schema.Boolean),
  delivery: Schema.optional(Delivery),
  tools: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)).annotate({
    description:
      "@deprecated tools and permissions have been merged, you can set permissions on the session itself now",
  }),
  format: Schema.optional(SessionV1.Format),
  system: Schema.optional(Schema.String),
  variant: Schema.optional(Schema.String),
  parts: Schema.Array(
    Schema.Union([
      SessionV1.TextPartInput,
      SessionV1.FilePartInput,
      SessionV1.AgentPartInput,
      SessionV1.SubtaskPartInput,
    ]).annotate({ discriminator: "type" }),
  ),
})
export type PromptInput = Schema.Schema.Type<typeof PromptInput>
