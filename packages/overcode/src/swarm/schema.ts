export * as SwarmSchema from "./schema"

import { ModelV2 } from "@overcode-ai/core/model"
import { ProviderV2 } from "@overcode-ai/core/provider"
import { Schema } from "effect"
import { Identifier } from "@/id/id"
import { SessionID } from "@/session/schema"

export const ID = Schema.String.check(Schema.isStartsWith("swm")).pipe(Schema.brand("Swarm.ID"))
export type ID = typeof ID.Type

const createID = () => ID.make(Identifier.create("swm", "ascending"))

export const Role = Schema.Literals([
  "planner",
  "solver",
  "implementer",
  "critic",
  "tester",
  "reviewer",
  "judge",
  "repair",
])
export type Role = typeof Role.Type

export const AgentStatus = Schema.Literals([
  "queued",
  "running",
  "waiting_for_permission",
  "completed",
  "failed",
  "cancelled",
])
export type AgentStatus = typeof AgentStatus.Type

export const Status = Schema.Literals([
  "queued",
  "planning",
  "running",
  "waiting_for_permission",
  "reviewing",
  "verifying",
  "repairing",
  "completed",
  "failed",
  "cancelled",
])
export type Status = typeof Status.Type

export const ModelRef = Schema.Struct({
  providerID: ProviderV2.ID,
  modelID: ModelV2.ID,
  variant: Schema.optional(Schema.String),
})

const Finding = Schema.Struct({
  kind: Schema.Literals(["fact", "risk", "suggestion"]),
  text: Schema.String,
})

const ProposedChange = Schema.Struct({
  path: Schema.String,
  /** Unified diff when known, otherwise a description of the intended change. */
  diff: Schema.optional(Schema.String),
  description: Schema.String,
})

const TestResult = Schema.Struct({
  name: Schema.String,
  passed: Schema.Boolean,
  output: Schema.optional(Schema.String),
})

const Usage = Schema.Struct({
  cost: Schema.optional(Schema.Number),
  input: Schema.optional(Schema.Number),
  output: Schema.optional(Schema.Number),
  reasoning: Schema.optional(Schema.Number),
})

/** Structured handoff every worker produces. Parsed from the worker transcript, never free-form chat. */
export const AgentResult = Schema.Struct({
  agentId: Schema.String,
  role: Role,
  status: Schema.Literals(["completed", "failed", "cancelled"]),
  summary: Schema.String,
  findings: Schema.optional(Schema.Array(Finding)),
  proposedChanges: Schema.optional(Schema.Array(ProposedChange)),
  filesTouched: Schema.optional(Schema.Array(Schema.String)),
  testsRun: Schema.optional(Schema.Array(TestResult)),
  concerns: Schema.optional(Schema.Array(Schema.String)),
  confidence: Schema.optional(Schema.Number),
  usage: Schema.optional(Usage),
})
export type AgentResult = typeof AgentResult.Type

export const AgentState = Schema.Struct({
  id: Schema.String,
  sessionID: SessionID,
  role: Role,
  status: AgentStatus,
  model: Schema.optional(ModelRef),
  progress: Schema.optional(Schema.String),
  filesClaimed: Schema.optional(Schema.Array(Schema.String)),
  filesTouched: Schema.optional(Schema.Array(Schema.String)),
  error: Schema.optional(Schema.String),
  timeCreated: Schema.Number,
  timeUpdated: Schema.Number,
})
export type AgentState = typeof AgentState.Type

export const Preset = Schema.Literals(["fast", "balanced", "max", "custom", "deep"])
export type Preset = typeof Preset.Type

export const Config = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  preset: Schema.optional(Preset),
  workers: Schema.optional(Schema.Int),
  maxRounds: Schema.optional(Schema.Int),
  maxModelCalls: Schema.optional(Schema.Int),
  maxTokens: Schema.optional(Schema.Int),
  repairAttempts: Schema.optional(Schema.Int),
  timeoutMs: Schema.optional(Schema.Int),
  stopWhenVerified: Schema.optional(Schema.Boolean),
  roleModels: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  reasoning: Schema.optional(Schema.Record(Schema.String, Schema.String)),
})
export type Config = typeof Config.Type

export const FinalResult = Schema.Struct({
  summary: Schema.String,
  filesChanged: Schema.optional(Schema.Array(Schema.String)),
  testsPassed: Schema.optional(Schema.Number),
  testsFailed: Schema.optional(Schema.Number),
  concerns: Schema.optional(Schema.Array(Schema.String)),
  agentsUsed: Schema.Number,
  toolCalls: Schema.Number,
})
export type FinalResult = typeof FinalResult.Type

export const Instrumentation = Schema.Struct({
  taskDurationMs: Schema.Number,
  agents: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      role: Role,
      model: Schema.optional(Schema.String),
      modelCalls: Schema.Number,
      input: Schema.Number,
      output: Schema.Number,
      reasoning: Schema.Number,
      cost: Schema.Number,
      toolCalls: Schema.Number,
    }),
  ),
  modelCalls: Schema.Number,
  input: Schema.Number,
  output: Schema.Number,
  reasoning: Schema.Number,
  cost: Schema.Number,
  toolCalls: Schema.Number,
  testsPassed: Schema.Number,
  testsFailed: Schema.Number,
  repairRounds: Schema.Number,
  success: Schema.Boolean,
  verified: Schema.Boolean,
})
export type Instrumentation = typeof Instrumentation.Type

export const Record = Schema.Struct({
  id: ID,
  sessionID: SessionID,
  status: Status,
  preset: Preset,
  config: Config,
  agents: Schema.Array(AgentState),
  result: Schema.optional(FinalResult),
  instrumentation: Schema.optional(Instrumentation),
  timeCreated: Schema.Number,
  timeUpdated: Schema.Number,
})
export type Record = typeof Record.Type

/** In-engine mutable mirror of Record (Schema structs are readonly). */
export type MutableAgentState = { -readonly [K in keyof AgentState]: AgentState[K] }
export type MutableRecord = Omit<{ -readonly [K in keyof Record]: Record[K] }, "agents"> & {
  agents: MutableAgentState[]
}

export const create = (input: {
  sessionID: SessionID
  preset: Preset
  config: Config
}): MutableRecord => {
  const now = Date.now()
  return {
    id: createID(),
    sessionID: input.sessionID,
    status: "queued",
    preset: input.preset,
    config: input.config,
    agents: [],
    timeCreated: now,
    timeUpdated: now,
  }
}
