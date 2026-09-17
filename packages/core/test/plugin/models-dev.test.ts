import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Catalog } from "@overcode-ai/core/catalog"
import { Integration } from "@overcode-ai/core/integration"
import { AppNodeBuilder } from "@overcode-ai/core/effect/app-node-builder"
import { LayerNode } from "@overcode-ai/core/effect/layer-node"
import { EventV2 } from "@overcode-ai/core/event"
import { Flag } from "@overcode-ai/core/flag/flag"
import { Location } from "@overcode-ai/core/location"
import { ModelV2 } from "@overcode-ai/core/model"
import { ModelsDev } from "@overcode-ai/core/models-dev"
import { ModelsDevPlugin } from "@overcode-ai/core/plugin/models-dev"
import { ProviderV2 } from "@overcode-ai/core/provider"
import { AbsolutePath } from "@overcode-ai/core/schema"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"
import { catalogHost, host, integrationHost } from "./host"

const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make(import.meta.dir) })),
)
const layer = AppNodeBuilder.build(LayerNode.group([Catalog.node, Integration.node, EventV2.node]), [
  [Location.node, locationLayer],
])
const it = testEffect(layer)

describe("ModelsDevPlugin", () => {
  it.effect("projects models.dev modes as separate models instead of variants", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const catalog = yield* Catalog.Service
      const models = ModelsDev.Service.of({
        get: () =>
          Effect.succeed({
            acme: {
              id: "acme",
              name: "Acme",
              env: [],
              npm: "@ai-sdk/openai-compatible",
              api: "https://api.acme.test/v1",
              models: {
                "gpt-5.4": {
                  id: "gpt-5.4",
                  name: "GPT-5.4",
                  family: "gpt",
                  release_date: "2026-01-01",
                  attachment: false,
                  reasoning: true,
                  temperature: true,
                  tool_call: true,
                  cost: {
                    input: 2.5,
                    output: 15,
                    tiers: [
                      {
                        tier: { type: "context", size: 272_000 },
                        input: 3,
                        output: 18,
                        cache_read: 0.25,
                      },
                    ],
                    context_over_200k: { input: 5, output: 22.5, cache_read: 0.5 },
                  },
                  limit: { context: 1_050_000, input: 922_000, output: 128_000 },
                  experimental: {
                    modes: {
                      fast: {
                        cost: { input: 5, output: 30, cache_read: 0.5 },
                        provider: {
                          headers: { "x-mode": "fast" },
                          body: { service_tier: "priority" },
                        },
                      },
                    },
                  },
                },
              },
            },
          } satisfies Record<string, ModelsDev.Provider>),
        refresh: () => Effect.void,
      })

      yield* ModelsDevPlugin.effect(
        host({
          catalog: catalogHost(catalog),
          integration: integrationHost(integrations),
        }),
      ).pipe(Effect.provideService(ModelsDev.Service, models))

      const providerID = ProviderV2.ID.make("acme")
      const base = yield* catalog.model.get(providerID, ModelV2.ID.make("gpt-5.4"))
      const fast = yield* catalog.model.get(providerID, ModelV2.ID.make("gpt-5.4-fast"))

      expect(base?.variants).toEqual([])
      expect(base?.request.body).toEqual({})
      expect(fast).toMatchObject({
        id: "gpt-5.4-fast",
        providerID: "acme",
        name: "GPT-5.4 Fast",
        api: { id: "gpt-5.4" },
        request: {
          headers: { "x-mode": "fast" },
          body: { service_tier: "priority" },
        },
        variants: [],
      })
      expect(fast?.cost).toEqual([
        { input: 5, output: 30, cache: { read: 0.5, write: 0 } },
        {
          tier: { type: "context", size: 272_000 },
          input: 3,
          output: 18,
          cache: { read: 0.25, write: 0 },
        },
        {
          tier: { type: "context", size: 200_000 },
          input: 5,
          output: 22.5,
          cache: { read: 0.5, write: 0 },
        },
      ])
    }),
  )

  it.effect("inherits provider endpoints and projects supported reasoning variants", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const catalog = yield* Catalog.Service
      const models = ModelsDev.Service.of({
        get: () =>
          Effect.succeed({
            acme: {
              id: "acme",
              name: "Acme",
              env: [],
              npm: "@ai-sdk/openai-compatible",
              api: "https://api.acme.test/v1",
              models: {
                override: {
                  id: "override",
                  name: "Override",
                  release_date: "2026-01-01",
                  attachment: false,
                  reasoning: true,
                  temperature: true,
                  tool_call: true,
                  reasoning_options: [{ type: "effort", values: ["minimal", "high"] }],
                  provider: { npm: "@ai-sdk/openai" },
                  limit: { context: 128_000, output: 8_192 },
                },
                inherited: {
                  id: "inherited",
                  name: "Inherited",
                  release_date: "2026-01-01",
                  attachment: false,
                  reasoning: true,
                  temperature: true,
                  tool_call: true,
                  reasoning_options: [{ type: "effort", values: [null, "high"] }],
                  limit: { context: 128_000, output: 8_192 },
                },
              },
            },
          } satisfies Record<string, ModelsDev.Provider>),
        refresh: () => Effect.void,
      })

      yield* ModelsDevPlugin.effect(
        host({
          catalog: catalogHost(catalog),
          integration: integrationHost(integrations),
        }),
      ).pipe(Effect.provideService(ModelsDev.Service, models))

      const providerID = ProviderV2.ID.make("acme")
      const override = yield* catalog.model.get(providerID, ModelV2.ID.make("override"))
      const inherited = yield* catalog.model.get(providerID, ModelV2.ID.make("inherited"))

      expect(override).toMatchObject({
        api: {
          type: "aisdk",
          package: "@ai-sdk/openai",
          url: "https://api.acme.test/v1",
        },
        variants: [
          {
            id: "minimal",
            body: { reasoning: { effort: "minimal", summary: "auto" }, include: ["reasoning.encrypted_content"] },
          },
          {
            id: "high",
            body: { reasoning: { effort: "high", summary: "auto" }, include: ["reasoning.encrypted_content"] },
          },
        ],
      })
      expect(inherited).toMatchObject({
        api: {
          type: "aisdk",
          package: "@ai-sdk/openai-compatible",
          url: "https://api.acme.test/v1",
        },
        variants: [
          { id: "none", body: { reasoning_effort: "none" } },
          { id: "high", body: { reasoning_effort: "high" } },
        ],
      })
    }),
  )

  it.effect("keeps upstream and rebranded public provider IDs available", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const catalog = yield* Catalog.Service
      const models = ModelsDev.Service.of({
        get: () =>
          Effect.succeed({
            opencode: {
              id: "opencode",
              name: "Zen",
              env: [],
              npm: "@ai-sdk/openai-compatible",
              api: "https://zen.example.test/v1",
              models: {
                "zen-model": {
                  id: "zen-model",
                  name: "Zen Model",
                  release_date: "2026-01-01",
                  attachment: false,
                  reasoning: false,
                  temperature: false,
                  tool_call: true,
                  limit: { context: 128_000, output: 8_192 },
                },
              },
            },
          } satisfies Record<string, ModelsDev.Provider>),
        refresh: () => Effect.void,
      })

      yield* ModelsDevPlugin.effect(
        host({
          catalog: catalogHost(catalog),
          integration: integrationHost(integrations),
        }),
      ).pipe(Effect.provideService(ModelsDev.Service, models))

      const upstream = yield* catalog.model.get(ProviderV2.ID.make("opencode"), ModelV2.ID.make("zen-model"))
      const branded = yield* catalog.model.get(ProviderV2.ID.overcode, ModelV2.ID.make("zen-model"))

      expect(upstream).toMatchObject({ providerID: "opencode", api: { url: "https://zen.example.test/v1" } })
      expect(branded).toMatchObject({ providerID: "overcode", api: { url: "https://zen.example.test/v1" } })
    }),
  )

  it.effect("registers key methods for providers with environment variables", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const previous = {
          path: Flag.OVERCODE_MODELS_PATH,
          disabled: Flag.OVERCODE_DISABLE_MODELS_FETCH,
        }
        Flag.OVERCODE_MODELS_PATH = path.join(import.meta.dir, "fixtures", "models-dev.json")
        Flag.OVERCODE_DISABLE_MODELS_FETCH = true
        return previous
      }),
      () =>
        Effect.gen(function* () {
          const integrations = yield* Integration.Service
          const catalog = yield* Catalog.Service
          yield* ModelsDevPlugin.effect(
            host({
              catalog: catalogHost(catalog),
              integration: integrationHost(integrations),
            }),
          )
          expect(yield* integrations.list()).toEqual([
            new Integration.Info({
              id: Integration.ID.make("acme"),
              name: "Acme",
              methods: [
                { type: "key" },
                {
                  type: "env",
                  names: ["ACME_API_KEY"],
                },
              ],
              connections: [],
            }),
          ])
        }).pipe(Effect.provide(AppNodeBuilder.build(ModelsDev.node))),
      (previous) =>
        Effect.sync(() => {
          Flag.OVERCODE_MODELS_PATH = previous.path
          Flag.OVERCODE_DISABLE_MODELS_FETCH = previous.disabled
        }),
    ),
  )
})
