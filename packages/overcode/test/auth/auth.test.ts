import { describe, expect } from "bun:test"
import { LayerNode } from "@overcode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { Auth } from "../../src/auth"
import { testEffect } from "../lib/effect"
import { Global } from "@overcode-ai/core/global"
import path from "path"
import fs from "fs/promises"

const it = testEffect(LayerNode.compile(Auth.node))

describe("Auth", () => {
  it.instance("reads OpenCode credentials as a fallback without copying them", () =>
    Effect.acquireUseRelease(
      Effect.promise(async () => {
        const legacyFile = path.join(path.dirname(Global.Path.data), "opencode", "auth.json")
        const currentFile = path.join(Global.Path.data, "auth.json")
        const [legacy, current] = await Promise.all([
          fs.readFile(legacyFile, "utf8").catch(() => undefined),
          fs.readFile(currentFile, "utf8").catch(() => undefined),
        ])
        await fs.mkdir(path.dirname(legacyFile), { recursive: true })
        await fs.writeFile(legacyFile, JSON.stringify({ imported: { type: "api", key: "legacy-secret" } }))
        await fs.rm(currentFile, { force: true })
        return { legacyFile, currentFile, legacy, current }
      }),
      ({ legacyFile, currentFile }) =>
        Effect.gen(function* () {
          const auth = yield* Auth.Service
          expect((yield* auth.get("imported"))?.type).toBe("api")
          yield* auth.set("local", { type: "api", key: "local-secret" })

          const written = JSON.parse(yield* Effect.promise(() => fs.readFile(currentFile, "utf8"))) as Record<
            string,
            unknown
          >
          expect(written.imported).toBeUndefined()
          expect(written.local).toEqual({ type: "api", key: "local-secret" })
        }),
      ({ legacyFile, currentFile, legacy, current }) =>
        Effect.promise(async () => {
          if (legacy === undefined) await fs.rm(legacyFile, { force: true })
          else await fs.writeFile(legacyFile, legacy)
          if (current === undefined) await fs.rm(currentFile, { force: true })
          else await fs.writeFile(currentFile, current)
        }),
    ),
  )

  it.instance("set normalizes trailing slashes in keys", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("https://example.com/", {
        type: "wellknown",
        key: "TOKEN",
        token: "abc",
      })
      const data = yield* auth.all()
      expect(data["https://example.com"]).toBeDefined()
      expect(data["https://example.com/"]).toBeUndefined()
    }),
  )

  it.instance("set cleans up pre-existing trailing-slash entry", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("https://example.com/", {
        type: "wellknown",
        key: "TOKEN",
        token: "old",
      })
      yield* auth.set("https://example.com", {
        type: "wellknown",
        key: "TOKEN",
        token: "new",
      })
      const data = yield* auth.all()
      const keys = Object.keys(data).filter((key) => key.includes("example.com"))
      expect(keys).toEqual(["https://example.com"])
      const entry = data["https://example.com"]!
      expect(entry.type).toBe("wellknown")
      if (entry.type === "wellknown") expect(entry.token).toBe("new")
    }),
  )

  it.instance("remove deletes both trailing-slash and normalized keys", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("https://example.com", {
        type: "wellknown",
        key: "TOKEN",
        token: "abc",
      })
      yield* auth.remove("https://example.com/")
      const data = yield* auth.all()
      expect(data["https://example.com"]).toBeUndefined()
      expect(data["https://example.com/"]).toBeUndefined()
    }),
  )

  it.instance("set and remove are no-ops on keys without trailing slashes", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("anthropic", {
        type: "api",
        key: "sk-test",
      })
      const data = yield* auth.all()
      expect(data["anthropic"]).toBeDefined()
      yield* auth.remove("anthropic")
      const after = yield* auth.all()
      expect(after["anthropic"]).toBeUndefined()
    }),
  )
})
