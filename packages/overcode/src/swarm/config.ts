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
    enabled: input.global?.enabled ?? true,
  }
}

export const load = Effect.fn("SwarmConfig.load")(function* (override?: SwarmSchema.Config) {
  const cfg = yield* Config.Service
  const global = yield* cfg.get().pipe(
    Effect.map((info) => (info as { swarm?: SwarmSchema.Config }).swarm),
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
