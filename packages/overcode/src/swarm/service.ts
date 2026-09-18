export * as Swarm from "./service"

import { SessionV1 } from "@overcode-ai/core/v1/session"
import { Context, Effect, Fiber, Layer, Ref, Schema } from "effect"
import path from "node:path"
import { LayerNode } from "@overcode-ai/core/effect/layer-node"
import { Database } from "@overcode-ai/core/database/database"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Agent } from "@/agent/agent"
import { deriveSubagentSessionPermission } from "@/agent/subagent-permissions"
import { MessageV2 } from "@/session/message-v2"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { InstanceState } from "@/effect/instance-state"
import { Config } from "@/config/config"
import { evaluate as evaluatePermission } from "@/permission/index"
import { SwarmSchema } from "./schema"
import { SwarmConfig } from "./config"
import { SwarmStore } from "./store"
import { RoleDefinitions, RESULT_CONTRACT, type Role } from "./roles"
import { MAX_RUN_TIMEOUT_MS } from "./preset"

export interface StartInput {
  sessionID: SessionID
  /** Raw user task text. */
  task: string
  /** Prompt parts persisted on the created user message (attachments, pasted text). */
  parts?: ReadonlyArray<SessionV1.TextPartInput | SessionV1.FilePartInput>
  preset?: SwarmSchema.Preset
  config?: SwarmSchema.Config
  /** Model override for roles without an explicit roleModels entry. */
  model?: { providerID: string; modelID: string; variant?: string }
}

export interface Interface {
  readonly create: (input: StartInput) => Effect.Effect<SwarmSchema.Record, Error>
  /** Persist + fork the engine. Returns immediately; use get() to follow progress. */
  readonly start: (input: StartInput) => Effect.Effect<SwarmSchema.Record, Error>
  /** Persist + run the engine to completion in the current fiber (prompt loop integration). */
  readonly runSync: (input: StartInput) => Effect.Effect<{ record: SwarmSchema.Record; finalMessageID: MessageID }, Error>
  readonly cancel: (id: SwarmSchema.ID) => Effect.Effect<void>
  readonly get: (id: SwarmSchema.ID) => Effect.Effect<SwarmSchema.Record | undefined>
  readonly listBySession: (sessionID: SessionID) => Effect.Effect<SwarmSchema.Record[]>
}

export class Service extends Context.Service<Service, Interface>()("@overcode/Swarm") {}

/** Which agent implementation backs each role. Read-only roles use least-privilege agents. */
const RoleAgent: Record<Role, string> = {
  planner: "plan",
  solver: "explore",
  implementer: "build",
  critic: "explore",
  tester: "explore",
  reviewer: "explore",
  judge: "explore",
  repair: "build",
}

const WRITE_KEYS = ["edit", "write", "apply_patch"] as const
const isExactRelativePath = (value: string) =>
  value.length > 0 &&
  !path.isAbsolute(value) &&
  !value.split(/[\\/]+/).includes("..") &&
  !/[?*\[\]]/.test(value)

// Tools ask permission with native path separators (path.relative on Windows
// yields `src\math.ts`), while judge-proposed paths use `/`. Ownership rules
// must cover both spellings or the wildcard deny blocks the edit.
const separatorVariants = (value: string) => [...new Set([value, value.replace(/\//g, "\\"), value.replace(/\\/g, "/")])]

// A hung provider stream must fail its worker, not stall the whole run until
// the run-level timeout. Bounded by the run timeout.
const WORKER_TIMEOUT_MS = 8 * 60_000

type Ctx = {
  record: SwarmSchema.MutableRecord
  effective: SwarmConfig.EffectiveConfig
  parent: SessionV1.SessionInfo
  parentModel: { providerID: string; modelID: string; variant?: string } | undefined
  task: string
  /** Local file attachments from the submitting turn, surfaced to every worker. */
  attachmentNote: string | undefined
  usage: { cost: number; input: number; output: number; reasoning: number; modelCalls: number; toolCalls: number }
  children: Map<SessionID, Fiber.Fiber<SwarmSchema.AgentResult, unknown>>
  progressMessageID: MessageID | undefined
  finalMessageID: MessageID | undefined
}

const textOf = (message: SessionV1.WithParts): string =>
  message.parts
    .filter((part): part is SessionV1.TextPart => part.type === "text")
    .map((part) => part.text)
    .join("\n")

const RESULT_FENCE = /```(?:json\s+swarm-result|swarm-result|json)?\s*([\s\S]*?)```/g

export function parseResult(text: string, agentId: string, role: Role): SwarmSchema.AgentResult {
  // The result is the LAST fenced block; earlier blocks are ordinary prose or
  // examples and must not shadow it.
  let match: RegExpExecArray | undefined
  for (const candidate of text.matchAll(RESULT_FENCE)) match = candidate as RegExpExecArray
  const fallback = (status: SwarmSchema.AgentResult["status"]): SwarmSchema.AgentResult => ({
    agentId,
    role,
    status,
    summary: text.trim().slice(-2000) || "(empty response)",
  })
  if (!match?.[1]) return fallback("failed")
  let parsed: unknown
  try {
    parsed = JSON.parse(match[1])
  } catch {
    return { ...fallback("failed"), concerns: ["Final swarm-result block was not valid JSON"] }
  }
  const record = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {}
  const status = typeof record.status === "string" ? (record.status as SwarmSchema.AgentResult["status"]) : "completed"
  const decoded = SchemaDecodeAgentResult({
    ...record,
    agentId,
    role,
    // A well-formed block means the worker finished; status stays available
    // for explicit failure reports.
    status,
  })
  if (!decoded) return { ...fallback("failed"), concerns: ["Final swarm-result block failed validation"] }
  return decoded
}

function SchemaDecodeAgentResult(input: unknown): SwarmSchema.AgentResult | undefined {
  const result = Schema.decodeUnknownOption(SwarmSchema.AgentResult)(input)
  return result._tag === "Some" ? result.value : undefined
}

const condensed = (result: SwarmSchema.AgentResult): string => {
  const lines = [`## ${result.role} (${result.agentId}) — ${result.status}`, result.summary.slice(0, 1500)]
  for (const finding of result.findings?.slice(0, 8) ?? []) lines.push(`- [${finding.kind}] ${finding.text}`.slice(0, 400))
  for (const change of result.proposedChanges?.slice(0, 12) ?? [])
    lines.push(`- change ${change.path}: ${change.description}`.slice(0, 300))
  for (const test of result.testsRun?.slice(0, 12) ?? [])
    lines.push(`- test ${test.name}: ${test.passed ? "PASS" : "FAIL"}`)
  for (const concern of result.concerns?.slice(0, 6) ?? []) lines.push(`- concern: ${concern}`.slice(0, 300))
  return lines.join("\n")
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const prompting = yield* SessionPrompt.Service
    const agents = yield* Agent.Service
    const database = yield* Database.Service
    const configSvc = yield* Config.Service
    // Provide ambient services once at layer scope so Interface methods stay
    // dependency-free (same pattern as Session service capturing db).
    const withDb = <A, E>(effect: Effect.Effect<A, E, Database.Service>) =>
      effect.pipe(Effect.provideService(Database.Service, database))
    const dbStore = {
      create: (record: SwarmSchema.MutableRecord) => withDb(SwarmStore.create(record)),
      update: (...args: Parameters<typeof SwarmStore.update>) => withDb(SwarmStore.update(...args)),
      addUsage: (...args: Parameters<typeof SwarmStore.addUsage>) => withDb(SwarmStore.addUsage(...args)),
      get: (...args: Parameters<typeof SwarmStore.get>) => withDb(SwarmStore.get(...args)),
      listBySession: (...args: Parameters<typeof SwarmStore.listBySession>) => withDb(SwarmStore.listBySession(...args)),
      sweepStale: (...args: Parameters<typeof SwarmStore.sweepStale>) => withDb(SwarmStore.sweepStale(...args)),
    }
    const loadConfig = (override?: SwarmSchema.Config) =>
      SwarmConfig.load(override).pipe(Effect.provideService(Config.Service, configSvc))
    const pageMessages = (sessionID: SessionID) =>
      withDb(MessageV2.page({ sessionID, limit: 200 })).pipe(
        Effect.catch(() => Effect.succeed({ items: [] as SessionV1.WithParts[] })),
      )
    const runs = yield* Ref.make(
      new Map<SwarmSchema.ID, { fiber: Fiber.Fiber<SwarmSchema.Record, unknown>; children: Ctx["children"] }>(),
    )
    // Crash recovery: a non-terminal record older than twice the maximum run
    // timeout cannot belong to a live run (its timeout would have fired), so a
    // previous process must have died mid-run. Never block startup on it.
    yield* dbStore
      .sweepStale(Date.now() - MAX_RUN_TIMEOUT_MS * 2)
      .pipe(Effect.catch(() => Effect.succeed(0)))
    // Graceful shutdown: stop this process's in-flight runs and persist them
    // as cancelled instead of leaving rows stuck on running forever.
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const active = yield* Ref.get(runs)
        for (const entry of active.values()) {
          yield* Fiber.interrupt(entry.fiber).pipe(Effect.catch(() => Effect.void))
        }
        for (const id of active.keys()) {
          const record = yield* dbStore.get(id).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (!record || ["completed", "failed", "cancelled"].includes(record.status)) continue
          yield* dbStore
            .update(id, {
              status: "cancelled",
              agents: record.agents.map((agent) =>
                ["queued", "running", "waiting_for_permission"].includes(agent.status)
                  ? { ...agent, status: "cancelled", timeUpdated: Date.now() }
                  : agent,
              ),
            })
            .pipe(Effect.catch(() => Effect.void))
        }
      }),
    )

    const persist = Effect.fn("Swarm.persist")(function* (record: SwarmSchema.MutableRecord) {
      yield* dbStore.update(record.id, {
        status: record.status,
        agents: record.agents,
        result: record.result,
        instrumentation: record.instrumentation,
        config: record.config,
      })
    })

    const touchAgent = (ctx: Ctx, id: string, patch: Partial<SwarmSchema.MutableAgentState>) =>
      Effect.gen(function* () {
        ctx.record.agents = ctx.record.agents.map((agent) =>
          agent.id === id ? { ...agent, ...patch, timeUpdated: Date.now() } : agent,
        )
        ctx.record.timeUpdated = Date.now()
        yield* persist(ctx.record)
      })

    const postParentMessage = Effect.fn("Swarm.postParentMessage")(function* (
      ctx: Ctx,
      text: string,
      parentID: MessageID,
    ) {
      const parent = ctx.parent
      const messageID = MessageID.ascending()
      const now = Date.now()
      yield* sessions.updateMessage({
        id: messageID,
        sessionID: ctx.record.sessionID,
        role: "assistant",
        parentID,
        modelID: (ctx.parentModel?.modelID ?? "swarm") as never,
        providerID: (ctx.parentModel?.providerID ?? "swarm") as never,
        mode: "primary",
        agent: parent.agent ?? "build",
        path: { cwd: parent.directory, root: parent.directory },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: now, completed: now },
      } as SessionV1.Assistant)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        sessionID: ctx.record.sessionID,
        messageID,
        type: "text",
        text,
        time: { start: now, end: Date.now() },
      } as SessionV1.TextPart)
      return messageID
    })

    const updateProgress = Effect.fn("Swarm.updateProgress")(function* (ctx: Ctx, text: string) {
      if (!ctx.progressMessageID) return
      yield* sessions
        .updatePart({
          id: PartID.ascending(),
          sessionID: ctx.record.sessionID,
          messageID: ctx.progressMessageID,
          type: "text",
          text,
          time: { start: Date.now(), end: Date.now() },
        } as SessionV1.TextPart)
        .pipe(Effect.catch(() => Effect.void))
    })

    const progressLine = (ctx: Ctx): string => {
      const done = ctx.record.agents.filter((a) => ["completed", "failed", "cancelled"].includes(a.status)).length
      const rows = ctx.record.agents.map((agent) => {
        const icon =
          agent.status === "completed" ? "●" : agent.status === "running" ? "◉" : agent.status === "failed" ? "✕" : "○"
        return `${icon} ${RoleDefinitions[agent.role].label} ${agent.progress ?? agent.status}`
      })
      return [`SWARM (${ctx.record.preset})`, "", ...rows, "", `${done} / ${ctx.record.agents.length} complete`].join("\n")
    }

    const checkBudgets = (ctx: Ctx) =>
      Effect.gen(function* () {
        const cfg = ctx.effective
        if (ctx.usage.modelCalls >= cfg.maxModelCalls)
          return yield* Effect.fail(new Error(`Swarm model-call budget exhausted (${cfg.maxModelCalls})`))
        if (ctx.usage.input + ctx.usage.output >= cfg.maxTokens)
          return yield* Effect.fail(new Error(`Swarm token budget exhausted (${cfg.maxTokens})`))
        // Reserve before the next yield so parallel workers cannot all pass
        // the check and exceed the model-call cap.
        ctx.usage.modelCalls += 1
      })

    const collectUsage = Effect.fn("Swarm.collectUsage")(function* (ctx: Ctx, sessionID: SessionID) {
      const info = yield* sessions.get(sessionID).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!info) return
      const tokens = (info as { tokens?: { input?: number; output?: number; reasoning?: number } }).tokens
      const usage = {
        cost: (info as { cost?: number }).cost ?? 0,
        input: tokens?.input ?? 0,
        output: tokens?.output ?? 0,
        reasoning: tokens?.reasoning ?? 0,
      }
      ctx.usage.cost += usage.cost
      ctx.usage.input += usage.input
      ctx.usage.output += usage.output
      ctx.usage.reasoning += usage.reasoning
      yield* dbStore.addUsage(ctx.record.id, usage).pipe(Effect.catch(() => Effect.void))
    })

    const countTools = Effect.fn("Swarm.countTools")(function* (sessionID: SessionID) {
      const first = yield* pageMessages(sessionID)
      return first.items.flatMap((msg) => msg.parts).filter((part) => part.type === "tool").length
    })

    // Real edit evidence from a writer's transcript, not its self-report.
    // Denied edit attempts are counted so a blocked writer cannot claim success.
    const editEvidence = Effect.fn("Swarm.editEvidence")(function* (sessionID: SessionID) {
      const page = yield* pageMessages(sessionID)
      const files = new Set<string>()
      let denied = 0
      for (const message of page.items) {
        for (const part of message.parts) {
          if (part.type !== "tool") continue
          const tool = part as SessionV1.ToolPart
          if (!(WRITE_KEYS as readonly string[]).includes(tool.tool)) continue
          const state = tool.state as { status?: string; input?: Record<string, unknown> }
          if (state?.status === "completed") {
            const file = state.input?.["filePath"] ?? state.input?.["path"]
            if (typeof file === "string") files.add(file)
          }
          if (state?.status === "error") denied += 1
        }
      }
      return { files: [...files], denied }
    })

    const spawnWorker = Effect.fn("Swarm.spawnWorker")(function* (
      ctx: Ctx,
      opts: {
        role: Role
        index: number
        objective: string
        ownedFiles?: string[]
        systemExtra?: string
      },
    ) {
      yield* checkBudgets(ctx)
      const def = RoleDefinitions[opts.role]
      const agentName = RoleAgent[opts.role]
      const agentInfo = yield* agents.get(agentName)
      if (!agentInfo) return yield* Effect.fail(new Error(`Unknown agent type: ${agentName}`))
      const parent = ctx.parent
      const childPermission = deriveSubagentSessionPermission({
        parentSessionPermission: parent.permission ?? [],
        subagent: agentInfo,
      })
      // Write ownership: writers may edit ONLY their assigned files. Parent
      // denies always win — owned files the parent forbids are dropped and
      // reported back as a constraint instead of overriding the parent.
      let objective = opts.objective
      let ownership: { permission: string; pattern: string; action: "allow" | "deny" }[] = []
      const requestedFiles = [...new Set(opts.ownedFiles ?? [])]
      const invalidFiles = requestedFiles.filter((file) => !isExactRelativePath(file))
      if (invalidFiles.length > 0) {
        objective += `\n\nThese proposed paths are not exact relative files and must not be edited: ${invalidFiles.join(", ")}.`
      }
      if (def.mayOwnFiles) {
        // The edit/write tools ask permission with `path.relative(worktree, absolute)`,
        // and non-git projects use worktree "/", yielding a drive-root-relative
        // path. Allow every spelling that resolves to the same owned file.
        const instanceCtx = yield* InstanceState.context.pipe(
          Effect.catch(() => Effect.succeed(undefined as { worktree?: string } | undefined)),
        )
        const worktree = instanceCtx?.worktree ?? "/"
        const filePatternVariants = (file: string) => {
          const absolute = path.resolve(parent.directory, file)
          const root = path.parse(absolute).root
          const asks = [file, absolute, path.relative(worktree, absolute), path.relative(root, absolute)]
          return [...new Set(asks.filter((value) => value.length > 0).flatMap(separatorVariants))]
        }
        const exactFiles = requestedFiles.filter(isExactRelativePath)
        const allowed = exactFiles.filter((file) =>
          filePatternVariants(file).every(
            (variant) => evaluatePermission("edit", variant, parent.permission ?? []).action !== "deny",
          ),
        )
        const denied = exactFiles.filter((file) => !allowed.includes(file))
        ownership = [
          ...WRITE_KEYS.flatMap((permission) => [{ permission, pattern: "*", action: "deny" as const }]),
          ...allowed.flatMap((pattern) =>
            filePatternVariants(pattern).flatMap((variant) =>
              WRITE_KEYS.map((permission) => ({ permission, pattern: variant, action: "allow" as const })),
            ),
          ),
        ]
        if (denied.length > 0) {
          objective += `\n\nNote: you must NOT touch ${denied.join(", ")} (forbidden by session permissions). Say so in concerns if it blocks you.`
        }
        objective += `\n\nYou own exactly these files for editing: ${allowed.join(", ") || "(none)"}. Do not edit anything else.`
      }
      const restrictions = [
        ...(def.readOnly ? WRITE_KEYS.map((permission) => ({ permission, pattern: "*", action: "deny" as const })) : []),
        ...(!def.mayRunShell ? [{ permission: "bash", pattern: "*", action: "deny" as const }] : []),
      ]
      // Headless workers have nobody to answer permission prompts: anything
      // that would default to "ask" must fail fast instead of hanging the
      // worker. These come first so explicit parent-session allows still win.
      const headlessDenies = [
        { permission: "external_directory", pattern: "*", action: "deny" as const },
        { permission: "doom_loop", pattern: "*", action: "deny" as const },
        { permission: "read", pattern: "*.env", action: "deny" as const },
        { permission: "read", pattern: "*.env.*", action: "deny" as const },
      ]
      const model =
        SwarmConfig.roleModel({ effective: ctx.effective, role: opts.role, fallback: ctx.parentModel }) ??
        ctx.parentModel
      const agentId = `${opts.role}-${opts.index + 1}`
      const child = yield* sessions.create({
        parentID: ctx.record.sessionID,
        title: `Swarm ${def.label}${opts.index > 0 ? ` #${opts.index + 1}` : ""}`,
        agent: agentName,
        metadata: { swarm: { id: ctx.record.id, agentId, role: opts.role } },
        ...(model
          ? { model: { id: model.modelID as never, providerID: model.providerID as never, variant: model.variant } }
          : {}),
        permission: [...headlessDenies, ...childPermission, ...restrictions, ...ownership] as never,
      })
      const now = Date.now()
      const state: SwarmSchema.MutableAgentState = {
        id: agentId,
        sessionID: child.id,
        role: opts.role,
        status: "queued",
        ...(model
          ? {
              model: {
                providerID: model.providerID as never,
                modelID: model.modelID as never,
                ...(model.variant ? { variant: model.variant } : {}),
              },
            }
          : {}),
        progress: "starting",
        ...(def.mayOwnFiles && requestedFiles.some(isExactRelativePath)
          ? { filesClaimed: requestedFiles.filter(isExactRelativePath) }
          : {}),
        timeCreated: now,
        timeUpdated: now,
      }
      ctx.record.agents = [...ctx.record.agents, state]
      yield* persist(ctx.record)

      const run = Effect.fn(`Swarm.worker.${opts.role}`)(function* () {
        yield* touchAgent(ctx, state.id, { status: "running", progress: "working" })
        yield* updateProgress(ctx, progressLine(ctx))
        const promptText = [
          `Swarm task (parent ${ctx.record.sessionID}):`,
          ctx.task,
          ...(ctx.attachmentNote ? [``, ctx.attachmentNote] : []),
          ``,
          def.system,
          opts.systemExtra ? `\n${opts.systemExtra}` : "",
          `Your assignment:`,
          objective,
          ``,
          RESULT_CONTRACT,
        ].join("\n")
        // NOTE: Effect.catch traps failures (worker error -> failed result) but
        // never interruption, so cancellation still propagates to the caller.
        const workerTimeoutMs = Math.min(ctx.effective.timeoutMs, WORKER_TIMEOUT_MS)
        const reply = (yield* prompting
          .prompt({
            sessionID: child.id,
            model: model as never,
            agent: agentName,
            parts: [{ type: "text", text: promptText } as never],
          })
          .pipe(
            Effect.timeout(workerTimeoutMs),
            Effect.map((maybe) =>
              maybe === undefined
                ? ({
                    info: {
                      role: "assistant",
                      error: {
                        name: "SwarmWorkerTimeout",
                        message: `Worker made no progress within ${workerTimeoutMs}ms`,
                      },
                    },
                    parts: [],
                  } as never)
                : maybe,
            ),
            Effect.catch((cause) =>
              Effect.succeed({
                info: { role: "assistant", error: { name: "SwarmWorkerError", message: String(cause) } },
                parts: [],
              } as never),
            ),
          )) as SessionV1.WithParts
        const failed = (reply.info as { error?: unknown }).error !== undefined
        const transcript = failed ? "" : textOf(reply)
        let result = failed
          ? ({
              agentId: state.id,
              role: opts.role,
              status: "failed",
              summary: `Worker failed: ${JSON.stringify((reply.info as { error?: unknown }).error).slice(0, 500)}`,
            } as SwarmSchema.AgentResult)
          : parseResult(transcript, state.id, opts.role)
        if (def.mayOwnFiles) {
          const edits = yield* editEvidence(child.id)
          if (edits.files.length > 0) {
            const normalize = (file: string) => {
              const value = path.isAbsolute(file) ? path.relative(ctx.parent.directory, file) : file
              return value.split(path.sep).join("/")
            }
            const touched = [...(result.filesTouched ?? []), ...edits.files]
              .map(normalize)
              .filter((file) => file.length > 0 && !file.startsWith(".."))
            result = { ...result, filesTouched: [...new Set(touched)] }
          } else if (result.status === "completed" && edits.denied > 0) {
            // The writer claims success, but every edit attempt was denied and
            // nothing changed. Report failure instead of a false success.
            result = {
              ...result,
              status: "failed",
              summary: `Editing was blocked by permissions ${edits.denied} time(s); no changes were applied.`,
            }
          }
        }
        const tools = yield* countTools(child.id)
        ctx.usage.toolCalls += tools
        yield* collectUsage(ctx, child.id)
        yield* touchAgent(ctx, state.id, {
          status: result.status === "completed" ? "completed" : "failed",
          progress: result.status,
          filesTouched: result.filesTouched,
          ...(result.status !== "completed" ? { error: result.summary.slice(0, 500) } : {}),
        })
        ctx.record.timeUpdated = Date.now()
        yield* persist(ctx.record)
        yield* updateProgress(ctx, progressLine(ctx))
        return result
      })
      return { state, run }
    })

    // Detached forks (no ambient Scope required) with explicit lifecycle:
    // every fork is joined on success, interrupted via cancel(), and swept by
    // the withCancelScope finalizer when the parent fiber is interrupted.
    const runOne = Effect.fn("Swarm.runOne")(function* (
      ctx: Ctx,
      spec: { role: Role; index?: number; objective: string; ownedFiles?: string[]; systemExtra?: string },
    ) {
      const { run, state } = yield* spawnWorker(ctx, {
        role: spec.role,
        index: spec.index ?? 0,
        objective: spec.objective,
        ownedFiles: spec.ownedFiles,
        systemExtra: spec.systemExtra,
      })
      const fiber = yield* Effect.forkDetach(run())
      ctx.children.set(state.sessionID, fiber)
      const result = yield* Fiber.join(fiber)
      ctx.children.delete(state.sessionID)
      return result
    })

    const runMany = Effect.fn("Swarm.runMany")(function* (
      ctx: Ctx,
      specs: { role: Role; objective: string; ownedFiles?: string[]; systemExtra?: string }[],
    ) {
      const started = yield* Effect.forEach(specs, (spec, index) =>
        spawnWorker(ctx, { role: spec.role, index, objective: spec.objective, ownedFiles: spec.ownedFiles, systemExtra: spec.systemExtra }),
      )
      const fibers = yield* Effect.forEach(started, ({ run, state }) =>
        Effect.forkDetach(run()).pipe(
          Effect.tap((fiber) => Effect.sync(() => ctx.children.set(state.sessionID, fiber))),
        ),
      )
      const results = yield* Effect.forEach(fibers, (fiber) => Fiber.join(fiber))
      for (const { state } of started) ctx.children.delete(state.sessionID)
      return results
    })

    const synthesize = (results: SwarmSchema.AgentResult[]): string =>
      results.map(condensed).join("\n\n---\n\n").slice(0, 24_000)

    const fail = Effect.fn("Swarm.fail")(function* (ctx: Ctx, note: string) {
      ctx.record.status = "failed"
      yield* persist(ctx.record)
      yield* updateProgress(ctx, progressLine(ctx) + `\n\n${note}`)
      return ctx.record
    })

    const failureText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)).slice(0, 1000)

    const failAndRethrow = (ctx: Ctx, cause: unknown, prefix: string) =>
      Effect.gen(function* () {
        yield* fail(ctx, `${prefix}: ${failureText(cause)}`)
        return yield* Effect.fail(cause instanceof Error ? cause : new Error(String(cause)))
      })

    const execute = Effect.fn("Swarm.execute")(function* (ctx: Ctx, userMessageID: MessageID) {
      const cfg = ctx.effective
      const startedAt = Date.now()
      ctx.record.status = "planning"
      yield* persist(ctx.record)
      const progressID = yield* postParentMessage(ctx, progressLine(ctx), userMessageID)
      ctx.progressMessageID = progressID

      // 1. Planning (optional).
      let plan = ""
      if (cfg.planner) {
        const [planner] = yield* runMany(ctx, [
          { role: "planner", objective: `Analyze the task and repository. Produce an ordered plan.` },
        ])
        plan = planner.summary
        if (planner.status !== "completed") return yield* fail(ctx, "Planner failed.")
      }

      // 2. Solvers in parallel (read-only investigators).
      ctx.record.status = "running"
      yield* persist(ctx.record)
      const solverObjective = (i: number) =>
        `Solve the task independently (you are solver ${i + 1} of ${cfg.workers}).${plan ? `\n\nCoordinator plan:\n${plan.slice(0, 4000)}` : ""}`
      const solvers = yield* runMany(
        ctx,
        Array.from({ length: cfg.workers }, (_, i) => ({ role: "solver" as Role, objective: solverObjective(i) })),
      )
      const viable = solvers.filter((r) => r.status === "completed")
      if (viable.length === 0) return yield* fail(ctx, "All solvers failed.")

      // 3. Critic (optional).
      let critique = ""
      if (cfg.critic) {
        ctx.record.status = "reviewing"
        yield* persist(ctx.record)
        const [critic] = yield* runMany(ctx, [
          { role: "critic", objective: `Review these candidate solutions:\n\n${synthesize(viable)}` },
        ])
        critique = critic.summary
      }

      // 4. Judge selects and plans application.
      const [judged] = yield* runMany(ctx, [
        {
          role: "judge",
          objective: [
            `Candidate solutions:\n\n${synthesize(viable)}`,
            critique ? `\n\nCritic review:\n${critique.slice(0, 4000)}` : "",
            `\n\nDecide the winning approach and list the exact files the implementer must change. If no code changes are needed (research/answer task), say so explicitly and give the final answer text as your summary.`,
          ].join("\n"),
        },
      ])
      if (judged.status !== "completed") return yield* fail(ctx, "Judge failed.")
      const ownedFiles = [...new Set((judged.proposedChanges ?? []).map((c) => c.path))].filter(isExactRelativePath)
      const needsEdits = ownedFiles.length > 0

      // 5. Implement (single writer owns the files).
      const implementResult: SwarmSchema.AgentResult | undefined = needsEdits
        ? yield* runOne(ctx, {
            role: "implementer",
            objective: `Apply this decided solution:\n\n${judged.summary.slice(0, 6000)}`,
            ownedFiles,
          })
        : undefined
      if (implementResult && implementResult.status !== "completed") return yield* fail(ctx, "Implementer failed.")
      const implementedFiles = implementResult?.filesTouched ?? []

      // 6. Verify + bounded repair.
      let verified = false
      let testsPassed = 0
      let testsFailed = 0
      let repairRounds = 0
      const filesForRepair = () => [...new Set([...implementedFiles, ...ownedFiles])].slice(0, 20)
      if (cfg.tester && (needsEdits || !cfg.stopWhenVerified)) {
        for (let round = 0; ; round++) {
          ctx.record.status = "verifying"
          yield* persist(ctx.record)
          const [tested] = yield* runMany(ctx, [
            {
              role: "tester",
              objective:
                round === 0
                  ? `Verify the applied solution for the task. Run the relevant tests/builds and report actual results.`
                  : `Re-verify after repair (round ${round}).`,
            },
          ])
          const ran = tested.testsRun ?? []
          testsPassed = ran.filter((t) => t.passed).length
          testsFailed = ran.filter((t) => !t.passed).length
          verified = tested.status === "completed" && ran.length > 0 && testsFailed === 0
          if (verified && cfg.stopWhenVerified) break
           if (round >= Math.min(cfg.repairAttempts, cfg.maxRounds - 1) || tested.status !== "completed") break
          ctx.record.status = "repairing"
          yield* persist(ctx.record)
          repairRounds += 1
          const repaired = yield* runOne(ctx, {
            role: "repair",
            index: repairRounds - 1,
            objective: `Fix the verified failure. Failing tests:\n${ran
              .filter((t) => !t.passed)
              .map((t) => `${t.name}: ${(t.output ?? "").slice(0, 2000)}`)
              .join("\n")
              .slice(0, 6000)}`,
            ownedFiles: filesForRepair(),
          })
          if (repaired.status !== "completed") break
        }
      }
      // A run that changed files must not finalize as a success when the
      // tester never confirmed them.
      if (cfg.tester && needsEdits && !verified)
        return yield* fail(ctx, `Changes were not verified: ${testsPassed} passed, ${testsFailed} failed.`)

      // 7. Reviewer (max preset).
      if (cfg.reviewer && needsEdits) {
        ctx.record.status = "reviewing"
        yield* persist(ctx.record)
        yield* runMany(ctx, [
          {
            role: "reviewer",
            objective: `Review the applied changes for: ${filesForRepair().join(", ")}. Test summary: ${testsPassed} passed, ${testsFailed} failed, verified=${verified}.`,
          },
        ])
      }

      // 8. Finalize: one clean answer in the parent session.
      const filesChanged = [...new Set([...implementedFiles, ...ownedFiles])].slice(0, 50)
      const finalText = [
        judged.summary.slice(0, 4000),
        ``,
        `Swarm completed`,
        ``,
        `${ctx.record.agents.length} agents · ${ctx.usage.modelCalls} model calls · ${ctx.usage.toolCalls} tool calls`,
        needsEdits
          ? `${filesChanged.length} files changed · ${testsPassed} tests passed · ${testsFailed} tests failed`
          : `no code changes`,
        verified ? `verified` : `unverified — see concerns`,
      ].join("\n")
      const finalMessageID = yield* postParentMessage(ctx, finalText, userMessageID)
      ctx.finalMessageID = finalMessageID
      const agents = ctx.record.agents.map((agent) => ({
        id: agent.id,
        role: agent.role,
        model: agent.model ? `${agent.model.providerID}/${agent.model.modelID}` : undefined,
        modelCalls: 1,
        input: 0,
        output: 0,
        reasoning: 0,
        cost: 0,
        toolCalls: 0,
      }))
      ctx.record.result = {
        summary: judged.summary.slice(0, 4000),
        filesChanged,
        testsPassed,
        testsFailed,
        agentsUsed: ctx.record.agents.length,
        toolCalls: ctx.usage.toolCalls,
      }
      ctx.record.instrumentation = {
        taskDurationMs: Date.now() - startedAt,
        agents,
        modelCalls: ctx.usage.modelCalls,
        input: ctx.usage.input,
        output: ctx.usage.output,
        reasoning: ctx.usage.reasoning,
        cost: ctx.usage.cost,
        toolCalls: ctx.usage.toolCalls,
        testsPassed,
        testsFailed,
        repairRounds,
        success: true,
        verified,
      }
      ctx.record.status = "completed"
      yield* persist(ctx.record)
      yield* updateProgress(ctx, progressLine(ctx))
      return ctx.record
    })

    const withCancelScope = <A, E, R>(ctx: Ctx, effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            // Parent interruption (user cancel) propagates here: stop children.
            for (const child of ctx.children.keys()) {
              yield* prompting.cancel(child).pipe(Effect.catch(() => Effect.void))
            }
            if (!(["completed", "failed", "cancelled"] as string[]).includes(ctx.record.status)) {
              ctx.record.status = "cancelled"
              ctx.record.agents = ctx.record.agents.map((agent) =>
                ["queued", "running", "waiting_for_permission"].includes(agent.status)
                  ? { ...agent, status: "cancelled", timeUpdated: Date.now() }
                  : agent,
              )
              yield* persist(ctx.record).pipe(Effect.catch(() => Effect.void))
            }
          }),
        ),
      )

    const boot = Effect.fn("Swarm.boot")(function* (input: StartInput) {
      const parent = yield* sessions.get(input.sessionID)
      const effective = yield* loadConfig({ ...input.config, ...(input.preset ? { preset: input.preset } : {}) })
      if (!effective.enabled) return yield* Effect.fail(new Error("Swarm Mode is disabled in configuration"))
      const record = SwarmSchema.create({
        sessionID: input.sessionID,
        preset: input.preset ?? effective.preset,
        config: {
          preset: input.preset ?? effective.preset,
          workers: effective.workers,
          maxRounds: effective.maxRounds,
          maxModelCalls: effective.maxModelCalls,
          maxTokens: effective.maxTokens,
          repairAttempts: effective.repairAttempts,
          timeoutMs: effective.timeoutMs,
          stopWhenVerified: effective.stopWhenVerified,
          roleModels: effective.roleModels,
          reasoning: effective.reasoning,
        },
      })
      const parentModel = parent.model
        ? { providerID: parent.model.providerID as string, modelID: parent.model.id as string, variant: parent.model.variant ?? undefined }
        : (input.model ?? undefined)
      // Workers cannot see the parent transcript, so surface local file
      // attachments in their prompt. Data URLs (pasted images) are skipped.
      const fileAttachments = (input.parts ?? []).flatMap((part) =>
        part.type === "file" && part.url.startsWith("file:") ? [`- ${part.filename ?? "file"}: ${part.url}`] : [],
      )
      const ctx: Ctx = {
        record,
        effective,
        parent,
        parentModel: parentModel ?? input.model,
        task: input.task,
        attachmentNote: fileAttachments.length
          ? `Files attached to the task (read them from disk when relevant):\n${fileAttachments.join("\n")}`
          : undefined,
        usage: { cost: 0, input: 0, output: 0, reasoning: 0, modelCalls: 0, toolCalls: 0 },
        children: new Map(),
        progressMessageID: undefined,
        finalMessageID: undefined,
      }
      yield* dbStore.create(record)
      return ctx
    })

    const latestUserMessage = Effect.fn("Swarm.latestUserMessage")(function* (sessionID: SessionID) {
      const first = yield* pageMessages(sessionID)
      const user = [...first.items].reverse().find((msg) => msg.info.role === "user")
      return user?.info.id as MessageID | undefined
    })

    // HTTP start() must work on a fresh session: post the task as the user
    // message when it is not already the latest user message so progress has
    // something to attach to without discarding a direct-start task. A start
    // carrying parts is always a distinct submission, so it gets its own
    // message even when the text repeats.
    const ensureUserMessage = Effect.fn("Swarm.ensureUserMessage")(function* (ctx: Ctx, input: StartInput) {
      const providedParts = input.parts ?? []
      const existing = yield* latestUserMessage(ctx.record.sessionID)
      if (existing && providedParts.length === 0) {
        const messages = yield* pageMessages(ctx.record.sessionID)
        const match = messages.items.find((message) => message.info.id === existing)
        if (match && textOf(match).trim() === input.task.trim()) return existing
      }
      const model = input.model ??
        (ctx.parent.model
          ? { providerID: ctx.parent.model.providerID as string, modelID: ctx.parent.model.id as string }
          : undefined)
      if (!model) return yield* Effect.fail(new Error("Swarm needs a model: pass one or set it on the session first"))
      const id = MessageID.ascending()
      const now = Date.now()
      yield* sessions.updateMessage({
        id,
        role: "user",
        sessionID: ctx.record.sessionID,
        agent: ctx.parent.agent ?? "build",
        model: { providerID: model.providerID as never, modelID: model.modelID as never },
        time: { created: now },
      })
      if (providedParts.length > 0) {
        for (const part of providedParts) {
          yield* sessions.updatePart({
            ...part,
            id: PartID.ascending(),
            messageID: id,
            sessionID: ctx.record.sessionID,
          } as never)
        }
      } else {
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: id,
          sessionID: ctx.record.sessionID,
          type: "text",
          text: ctx.task,
        })
      }
      return id
    })

    const persistNew = Effect.fn("Swarm.persistNew")(function* (input: StartInput) {
      yield* sessions.get(input.sessionID)
      const effective = yield* loadConfig({ ...input.config, ...(input.preset ? { preset: input.preset } : {}) })
      const record = SwarmSchema.create({
        sessionID: input.sessionID,
        preset: input.preset ?? effective.preset,
        config: {
          preset: input.preset ?? effective.preset,
          workers: effective.workers,
          maxRounds: effective.maxRounds,
          maxModelCalls: effective.maxModelCalls,
          maxTokens: effective.maxTokens,
          repairAttempts: effective.repairAttempts,
          timeoutMs: effective.timeoutMs,
          stopWhenVerified: effective.stopWhenVerified,
          roleModels: effective.roleModels,
          reasoning: effective.reasoning,
        },
      })
      yield* dbStore.create(record)
      return record
    })

    return Service.of({
      create: (input) => persistNew(input),
      start: (input) =>
        Effect.gen(function* () {
          const ctx = yield* boot(input)
          const userMessageID = yield* ensureUserMessage(ctx, input).pipe(
            Effect.catch((cause) => failAndRethrow(ctx, cause, "Swarm could not start")),
          )
          const fiber = yield* Effect.forkDetach(
            withCancelScope(
              ctx,
              execute(ctx, userMessageID).pipe(
                Effect.catch((cause) => failAndRethrow(ctx, cause, "Swarm failed")),
                Effect.timeout(ctx.effective.timeoutMs),
                Effect.flatMap((completed) =>
                  Effect.gen(function* () {
                    if (!completed) {
                      ctx.record.status = "failed"
                      yield* persist(ctx.record)
                      yield* updateProgress(ctx, progressLine(ctx) + `\n\nSwarm timed out after ${ctx.effective.timeoutMs}ms.`)
                    }
                    return ctx.record
                  }),
                ),
              ),
            ).pipe(
              Effect.ensuring(
                Ref.update(runs, (map) => {
                  const next = new Map(map)
                  next.delete(ctx.record.id)
                  return next
                }),
              ),
            ),
          )
          yield* Ref.update(runs, (map) => new Map(map).set(ctx.record.id, { fiber, children: ctx.children }))
          return ctx.record
        }),
      runSync: (input) =>
        Effect.gen(function* () {
          const ctx = yield* boot(input)
          const userMessageID = yield* latestUserMessage(input.sessionID).pipe(
            Effect.flatMap((id) =>
              id ? Effect.succeed(id) : Effect.fail(new Error("Swarm needs an existing user message to attach progress to")),
            ),
            Effect.catch((cause) => failAndRethrow(ctx, cause, "Swarm could not start")),
          )
          const completed = yield* withCancelScope(
            ctx,
            execute(ctx, userMessageID).pipe(Effect.catch((cause) => failAndRethrow(ctx, cause, "Swarm failed"))),
          ).pipe(Effect.timeout(ctx.effective.timeoutMs))
          if (!completed) {
            ctx.record.status = "failed"
            yield* persist(ctx.record)
            return yield* Effect.fail(new Error(`Swarm timed out after ${ctx.effective.timeoutMs}ms`))
          }
          const record = (yield* dbStore.get(ctx.record.id)) ?? ctx.record
          if (!ctx.finalMessageID)
            return yield* Effect.fail(
              new Error(
                record.status === "failed"
                  ? "Swarm failed before producing a final message"
                  : "Swarm finished without a final message",
              ),
            )
          return { record, finalMessageID: ctx.finalMessageID }
        }),
      cancel: (id) =>
        Effect.gen(function* () {
          const running = yield* Ref.get(runs)
          const entry = running.get(id)
          if (entry) {
            for (const child of entry.children.keys()) {
              yield* prompting.cancel(child).pipe(Effect.catch(() => Effect.void))
            }
            yield* Fiber.interrupt(entry.fiber).pipe(Effect.catch(() => Effect.void))
            yield* Ref.update(runs, (map) => {
              const next = new Map(map)
              next.delete(id)
              return next
            })
          }
          const record = yield* dbStore.get(id)
          if (record && !["completed", "failed", "cancelled"].includes(record.status)) {
            yield* dbStore.update(id, {
              status: "cancelled",
              agents: record.agents.map((agent) =>
                ["queued", "running", "waiting_for_permission"].includes(agent.status)
                  ? { ...agent, status: "cancelled", timeUpdated: Date.now() }
                  : agent,
              ),
            })
          }
        }),
      get: (id) => dbStore.get(id),
      listBySession: (sessionID) => dbStore.listBySession(sessionID),
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Session.node, SessionPrompt.node, Agent.node, Config.node, Database.node],
})
