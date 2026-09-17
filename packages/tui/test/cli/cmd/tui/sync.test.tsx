/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { tmpdir } from "../../../fixture/fixture"
import { directory, json, mount, wait, worktree } from "./sync-fixture"
import type { GlobalEvent } from "@overcode-ai/sdk/v2"

function branchEvent(branch: string, workspace?: string): GlobalEvent {
  return {
    directory: "/tmp/other",
    project: "proj_test",
    workspace,
    payload: {
      id: `evt_vcs_${branch}`,
      type: "vcs.branch.updated",
      properties: { branch },
    },
  }
}

describe("tui sync", () => {
  test("refresh scopes sessions by default and lists project sessions when disabled", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, kv, sync, session } = await mount(undefined, tmp.path)

    try {
      expect(kv.get("session_directory_filter_enabled", true)).toBe(true)
      expect(session.at(-1)?.searchParams.get("roots")).toBeNull()
      expect(session.at(-1)?.searchParams.get("scope")).toBeNull()
      expect(session.at(-1)?.searchParams.get("path")).toBe("packages/tui")

      kv.set("session_directory_filter_enabled", false)
      await sync.session.refresh()

      expect(session.at(-1)?.searchParams.get("scope")).toBe("project")
      expect(session.at(-1)?.searchParams.get("path")).toBeNull()
      expect(session.at(-1)?.searchParams.get("roots")).toBeNull()
    } finally {
      app.renderer.destroy()
    }
  })

  test("vcs branch updates only apply for the active workspace", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, project, sync } = await mount(undefined, tmp.path)

    try {
      expect(sync.data.vcs?.branch).toBe("main")

      project.workspace.set("ws_a")
      emit(branchEvent("other", "ws_b"))
      await Bun.sleep(30)

      expect(sync.data.vcs?.branch).toBe("main")

      emit(branchEvent("feature", "ws_a"))
      await wait(() => sync.data.vcs?.branch === "feature")

      expect(sync.data.vcs?.branch).toBe("feature")
    } finally {
      app.renderer.destroy()
    }
  })

  test("survives legacy provider-endpoint failures via the V2 catalog", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, sync } = await mount((url) => {
      if (url.pathname === "/config/providers" || url.pathname === "/provider")
        return json({ error: "gone" }, { status: 410 })
      if (url.pathname === "/api/provider")
        return json({
          location: { directory, project: { id: "proj_test", directory: worktree } },
          data: [
            {
              id: "custom",
              name: "Custom",
              api: { type: "native", settings: {} },
              request: { headers: {}, body: {} },
            },
          ],
        })
      if (url.pathname === "/api/model")
        return json({
          location: { directory, project: { id: "proj_test", directory: worktree } },
          data: [
            {
              id: "model",
              providerID: "custom",
              name: "Custom Model",
              api: { type: "native", id: "model", settings: {} },
              capabilities: { tools: true, input: ["text"], output: ["text"] },
              request: { headers: {}, body: {} },
              variants: [],
              time: { released: 0 },
              cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
              status: "active",
              enabled: true,
              limit: { context: 128_000, output: 8_192 },
            },
          ],
        })
    }, tmp.path)

    try {
      expect(sync.status).toBe("complete")
      expect(sync.data.provider).toHaveLength(1)
      expect(sync.data.provider[0]?.id).toBe("custom")
      expect(sync.data.provider_default).toEqual({ custom: "model" })
    } finally {
      app.renderer.destroy()
    }
  })

  test("uses the flat V2 catalog for model selection", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, sync } = await mount((url) => {
      if (url.pathname === "/api/provider")
        return json({
          location: { directory, project: { id: "proj_test", directory: worktree } },
          data: [
            {
              id: "custom",
              name: "Custom",
              api: { type: "native", settings: {} },
              request: { headers: {}, body: {} },
            },
          ],
        })
      if (url.pathname === "/api/model")
        return json({
          location: { directory, project: { id: "proj_test", directory: worktree } },
          data: [
            {
              id: "model",
              providerID: "custom",
              name: "Custom Model",
              api: { type: "native", id: "model", settings: {} },
              capabilities: { tools: true, input: ["text"], output: ["text"] },
              request: { headers: {}, body: {} },
              variants: [],
              time: { released: 0 },
              cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
              status: "active",
              enabled: true,
              limit: { context: 128_000, output: 8_192 },
            },
          ],
        })
    }, tmp.path)

    try {
      expect(sync.data.provider).toHaveLength(1)
      expect(sync.data.provider[0]?.id).toBe("custom")
      expect(sync.data.provider[0]?.models.model).toMatchObject({
        id: "model",
        name: "Custom Model",
        release_date: "1970-01-01",
      })
    } finally {
      app.renderer.destroy()
    }
  })
})
