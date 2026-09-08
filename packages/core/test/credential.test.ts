import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Credential } from "@opencode-ai/core/credential"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Integration } from "@opencode-ai/core/integration"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(Credential.node))

describe("Credential", () => {
  it.effect("stores, updates, lists, and removes credentials", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const integrationID = Integration.ID.make("openai")
      const created = yield* credentials.create({
        integrationID,
        label: "Work",
        value: Credential.Key.make({ type: "key", key: "secret" }),
      })

      expect(yield* credentials.list(integrationID)).toEqual([created])
      yield* credentials.update(created.id, { label: "Personal" })
      expect((yield* credentials.list(integrationID))[0]?.label).toBe("Personal")

      const replacement = yield* credentials.create({
        integrationID,
        label: "Replacement",
        value: Credential.Key.make({ type: "key", key: "replacement" }),
      })
      expect((yield* credentials.list(integrationID)).map(({ id, label, active }) => ({ id, label, active }))).toEqual([
        { id: created.id, label: "Personal", active: false },
        { id: replacement.id, label: "Replacement", active: true },
      ])
      expect((yield* credentials.list(integrationID)).map((item) => item.active)).toEqual([false, true])

      yield* credentials.update(created.id, { active: true })
      expect((yield* credentials.list(integrationID)).map((item) => item.active)).toEqual([true, false])

      yield* credentials.remove(replacement.id)
      expect((yield* credentials.list(integrationID)).map((item) => item.id)).toEqual([created.id])
      yield* credentials.remove(created.id)
      expect(yield* credentials.list(integrationID)).toEqual([])
    }),
  )
})
