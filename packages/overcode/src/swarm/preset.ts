/** Swarm presets: data, not code paths. The engine interprets these. */
import type { SwarmSchema } from "./schema"
import { RoleDefinitions } from "./roles"

export type Role = SwarmSchema.Role
export type Preset = SwarmSchema.Preset

export interface ResolvedPreset {
  preset: Preset
  /** Solver workers to fan out in parallel. */
  workers: number
  planner: boolean
  critic: boolean
  reviewer: boolean
  tester: boolean
  maxRounds: number
  maxModelCalls: number
  maxTokens: number
  repairAttempts: number
  timeoutMs: number
  stopWhenVerified: boolean
}

const BASE = {
  maxRounds: 2,
  maxTokens: 200_000,
  timeoutMs: 10 * 60_000,
  stopWhenVerified: true,
} as const

export const Presets: Record<Exclude<Preset, "custom">, Omit<ResolvedPreset, "preset">> = {
  fast: { ...BASE, workers: 2, planner: false, critic: false, reviewer: false, tester: true, maxModelCalls: 8, maxTokens: 80_000, repairAttempts: 1, timeoutMs: 5 * 60_000 },
  balanced: { ...BASE, workers: 4, planner: true, critic: true, reviewer: false, tester: true, maxModelCalls: 20, maxTokens: 200_000, repairAttempts: 2 },
  max: { ...BASE, workers: 8, planner: true, critic: true, reviewer: true, tester: true, maxModelCalls: 40, maxTokens: 500_000, repairAttempts: 3, timeoutMs: 20 * 60_000 },
  deep: { ...BASE, workers: 1, planner: true, critic: true, reviewer: false, tester: false, maxModelCalls: 8, maxTokens: 120_000, repairAttempts: 1 },
}

const clamp = (value: number | undefined, min: number, max: number, fallback: number) => {
  // Below-minimum values (including 0) mean "use the default"; above-maximum
  // values are capped so a typo cannot spawn a runaway swarm.
  if (value === undefined || !Number.isFinite(value) || value < min) return fallback
  return Math.min(max, Math.floor(value))
}

/** Merge preset defaults with explicit config overrides. Bounds are enforced here, not in schemas. */
export function resolvePreset(input: SwarmSchema.Config): ResolvedPreset {
  const preset = input.preset ?? "balanced"
  const base = preset === "custom"
    ? { ...BASE, workers: 4, planner: true, critic: true, reviewer: false, tester: true, maxModelCalls: 20, repairAttempts: 2 }
    : Presets[preset]
  return {
    preset,
    workers: clamp(input.workers, 1, 16, base.workers),
    planner: base.planner,
    critic: base.critic,
    reviewer: base.reviewer,
    tester: base.tester,
    maxRounds: clamp(input.maxRounds, 1, 5, base.maxRounds),
    maxModelCalls: clamp(input.maxModelCalls, 1, 500, base.maxModelCalls),
    maxTokens: clamp(input.maxTokens, 1_000, 5_000_000, base.maxTokens),
    repairAttempts: clamp(input.repairAttempts, 0, 5, base.repairAttempts),
    timeoutMs: clamp(input.timeoutMs, 10_000, 3_600_000, base.timeoutMs),
    stopWhenVerified: input.stopWhenVerified ?? base.stopWhenVerified,
  }
}

/** Roles in spawn order for one round. */
export function roundRoles(resolved: ResolvedPreset): Role[] {
  const roles: Role[] = []
  if (resolved.planner) roles.push("planner")
  for (let i = 0; i < resolved.workers; i++) roles.push("solver")
  if (resolved.critic) roles.push("critic")
  return roles
}

export function roleLabel(role: Role): string {
  return RoleDefinitions[role].label
}
