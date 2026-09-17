import type { Model, ModelV2Info, Part, Provider, ProviderV2Info, UserMessage } from "./client.js"

export type ProviderCatalog = {
  all: Map<string, Provider>
  defaultModel?: {
    providerID: string
    modelID: string
  } | null
  default: Record<string, string>
  connected: string[]
}

function releaseDate(value: unknown) {
  if (typeof value !== "number" || Number.isNaN(value)) return ""
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10)
}

function modelCost(costs: readonly ModelV2Info["cost"][number][]): Model["cost"] {
  const base = costs.find((item) => item.tier === undefined) ?? costs[0]
  const tiers = costs.filter((item) => item.tier !== undefined)
  return {
    input: base?.input ?? 0,
    output: base?.output ?? 0,
    cache: {
      read: base?.cache.read ?? 0,
      write: base?.cache.write ?? 0,
    },
    ...(tiers.length
      ? {
          tiers: tiers.map((item) => ({
            tier: item.tier!,
            input: item.input,
            output: item.output,
            cache: { read: item.cache.read, write: item.cache.write },
          })),
        }
      : {}),
    ...(costs.find((item) => item.tier?.size === 200_000)
      ? {
          experimentalOver200K: (() => {
            const item = costs.find((item) => item.tier?.size === 200_000)!
            return {
              input: item.input,
              output: item.output,
              cache: { read: item.cache.read, write: item.cache.write },
            }
          })(),
        }
      : {}),
  }
}

function modelInfo(model: ModelV2Info): Model {
  // Older daemons return a flat model shape (settings/package at the top
  // level, no `api`/`request` objects). Fall back field-by-field so one
  // parser serves both generations instead of throwing on `undefined.api`.
  const raw = model as ModelV2Info & {
    settings?: Record<string, unknown>
    package?: string
    modelID?: string
  }
  const api = (raw.api ?? {}) as Partial<ModelV2Info["api"]> & { package?: string }
  const request = (raw.request ?? {}) as Partial<ModelV2Info["request"]>
  const requestBody = (request.body ?? {}) as Record<string, unknown>
  const requestHeaders = (request.headers ?? {}) as Record<string, string>
  const capabilities = (raw.capabilities ?? {}) as Partial<ModelV2Info["capabilities"]> & {
    input?: string[]
    output?: string[]
    tools?: boolean
  }
  const input = capabilities.input ?? []
  const output = capabilities.output ?? []
  const variants = (raw.variants ?? []) as Array<{
    id: string
    body?: Record<string, unknown>
    settings?: Record<string, unknown>
    headers?: Record<string, string>
  }>
  const npm = api.type === "aisdk" ? api.package : (raw.package ?? api.package ?? "native")
  return {
    id: model.id,
    providerID: model.providerID,
    api: {
      id: api.id ?? raw.modelID ?? model.id,
      url: api.url ?? "",
      npm: npm ?? "native",
    },
    name: model.name,
    family: (raw.family ?? "") as string,
    capabilities: {
      temperature: false,
      reasoning: variants.length > 0,
      attachment: input.some((item) => item !== "text"),
      toolcall: capabilities.tools ?? false,
      input: {
        text: input.includes("text"),
        audio: input.includes("audio"),
        image: input.includes("image"),
        video: input.includes("video"),
        pdf: input.includes("pdf"),
      },
      output: {
        text: output.includes("text"),
        audio: output.includes("audio"),
        image: output.includes("image"),
        video: output.includes("video"),
        pdf: output.includes("pdf"),
      },
      interleaved: false,
    },
    cost: modelCost((raw.cost ?? []) as ModelV2Info["cost"]),
    limit: (raw.limit ?? { context: 0, output: 0 }) as Model["limit"],
    status: (raw.status ?? "active") as Model["status"],
    options: {
      ...((api as { settings?: Record<string, unknown> }).settings ?? {}),
      ...(raw.settings ?? {}),
      ...requestBody,
      ...(request.variant ? { variant: request.variant } : {}),
    },
    headers: { ...requestHeaders },
    release_date: releaseDate((raw.time as { released?: unknown } | undefined)?.released),
    variants: Object.fromEntries(
      variants.map((variant) => [
        variant.id,
        {
          ...(variant.body ?? variant.settings ?? {}),
          ...(Object.keys(variant.headers ?? {}).length ? { headers: { ...variant.headers } } : {}),
        },
      ]),
    ),
  }
}

/** Projects the flat V2 catalog into the embedded shape used by older selectors. */
export function normalizeProviderCatalog(
  providers: readonly ProviderV2Info[],
  models: readonly ModelV2Info[],
  defaultModel?: { providerID: string; modelID: string } | null,
): ProviderCatalog {
  const all = new Map<string, Provider>(
    providers.map((provider) => {
      // Older daemons return a flat provider shape (settings at the top
      // level, no `api`/`request` objects). Fall back the same way as models.
      const raw = provider as ProviderV2Info & { settings?: Record<string, unknown> }
      const apiSettings = ((raw.api ?? {}) as { settings?: Record<string, unknown> }).settings ?? {}
      const requestBody = ((raw.request ?? {}) as { body?: Record<string, unknown> }).body ?? {}
      const requestHeaders = ((raw.request ?? {}) as { headers?: Record<string, string> }).headers ?? {}
      return [
        provider.id,
        {
          id: provider.id,
          name: provider.name,
          source: provider.integrationID ? "api" : "custom",
          env: [],
          options: {
            ...apiSettings,
            ...(raw.settings ?? {}),
            ...requestBody,
            ...(Object.keys(requestHeaders).length ? { headers: { ...requestHeaders } } : {}),
          },
          models: {},
        },
      ] as const
    }),
  )

  for (const item of models) {
    if (item.status === "deprecated" || item.enabled === false) continue
    const provider = all.get(item.providerID)
    if (!provider) continue
    provider.models[item.id] = modelInfo(item)
  }

  const validDefault =
    defaultModel && all.get(defaultModel.providerID)?.models[defaultModel.modelID] ? defaultModel : undefined
  const defaults = Object.fromEntries(
    [...all].flatMap(([providerID, provider]) => {
      const modelID =
        validDefault?.providerID === providerID ? validDefault.modelID : Object.values(provider.models)[0]?.id
      return modelID ? [[providerID, modelID]] : []
    }),
  )

  return {
    all,
    connected: providers.map((provider) => provider.id),
    defaultModel: validDefault ?? null,
    default: defaults,
  }
}

export const message = {
  user(input: Omit<UserMessage, "role" | "time" | "id"> & { parts: Omit<Part, "id" | "sessionID" | "messageID">[] }): {
    info: UserMessage
    parts: Part[]
  } {
    const { parts: _parts, ...rest } = input

    const info: UserMessage = {
      ...rest,
      id: "asdasd",
      time: {
        created: Date.now(),
      },
      role: "user",
    }

    return {
      info,
      parts: input.parts.map(
        (part) =>
          ({
            ...part,
            id: "asdasd",
            messageID: info.id,
            sessionID: info.sessionID,
          }) as Part,
      ),
    }
  },
}
