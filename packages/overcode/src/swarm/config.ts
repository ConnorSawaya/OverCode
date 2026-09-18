export * as SwarmConfig from "./config"

import { Effect } from "effect"
import { Config } from "@/config/config"
import { SwarmSchema } from "./schema"
import { resolvePreset, type ResolvedPreset } from "./preset"

export interface EffectiveConfig extends ResolvedPreset {
  roleModels: Record<string, string>
  reasoning: Record<string, string>
  enabled: boolean
}

type LegacySwarmConfig = Record<string, unknown>

const field = <T>(input: LegacySwarmConfig, camel: string, snake: string) =>
  (input[camel] ?? input[snake]) as T | undefined

/** Normalize the snake_case shape accepted by the legacy global config. */
export function normalize(input: unknown): SwarmSchema.Config | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined
  const value = input as LegacySwarmConfig
  return {
    enabled: value.enabled as boolean | undefined,
    preset: value.preset as SwarmSchema.Preset | undefined,
    workers: value.workers as number | undefined,
    maxRounds: field<number>(value, "maxRounds", "max_rounds"),
    maxModelCalls: field<number>(value, "maxModelCalls", "max_model_calls"),
    maxTokens: field<number>(value, "maxTokens", "max_tokens"),
    repairAttempts: field<number>(value, "repairAttempts", "repair_attempts"),
    timeoutMs: field<number>(value, "timeoutMs", "timeout_ms"),
    stopWhenVerified: field<boolean>(value, "stopWhenVerified", "stop_when_verified"),
    roleModels: field<Record<string, string>>(value, "roleModels", "role_models"),
    reasoning: value.reasoning as Record<string, string> | undefined,
  }
}

/** Global/project `swarm` config merged with per-run overrides. */
export function resolve(input: {
  global: SwarmSchema.Config | undefined
  override?: SwarmSchema.Config
}): EffectiveConfig {
  const merged: SwarmSchema.Config = { ...input.global, ...input.override }
  const resolved = resolvePreset(merged)
  return {
    ...resolved,
    roleModels: { ...(input.global?.roleModels ?? {}), ...(input.override?.roleModels ?? {}) },
    reasoning: { ...(input.global?.reasoning ?? {}), ...(input.override?.reasoning ?? {}) },
    enabled: input.override?.enabled ?? input.global?.enabled ?? true,
  }
}

export const load = Effect.fn("SwarmConfig.load")(function* (override?: SwarmSchema.Config) {
  const cfg = yield* Config.Service
  const global = yield* cfg.get().pipe(
     Effect.map((info) => normalize((info as { swarm?: unknown }).swarm)),
    Effect.catch(() => Effect.succeed(undefined)),
  )
  return resolve({ global, override })
})

/** "provider/model" strings keyed by role, falling back to the parent selection. */
export function roleModel(input: {
  effective: EffectiveConfig
  role: SwarmSchema.Role
  fallback?: { providerID: string; modelID: string; variant?: string }
}): { providerID: string; modelID: string; variant?: string } | undefined {
  const raw = input.effective.roleModels[input.role]
  if (!raw) return input.fallback
  const slash = raw.indexOf("/")
  if (slash === -1) {
    return input.fallback ? { ...input.fallback } : undefined
  }
  return {
    providerID: raw.slice(0, slash),
    modelID: raw.slice(slash + 1),
    variant: input.effective.reasoning[input.role] ?? input.fallback?.variant,
  }
}
