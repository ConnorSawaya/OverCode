import { describe, expect, test } from "bun:test"
import { type Session } from "@opencode-ai/sdk/v2/client"
import { type LocalProject } from "@/context/layout"
import { resolvePinnedChats, resolvePinnedProjects } from "./helpers"

const session = (input: Partial<Session> & Pick<Session, "id" | "directory">) =>
  ({
    title: "",
    ...input,
  }) as Session

const project = (worktree: string) => ({ worktree, expanded: true }) as LocalProject

describe("resolvePinnedChats", () => {
  test("keeps only same-server pins with a live session", () => {
    const live = session({ id: "1", directory: "/a" })
    const store = new Map([["1", live]])
    const resolved = resolvePinnedChats(
      [
        { server: "local", sessionID: "1" },
        { server: "remote", sessionID: "1" },
        { server: "local", sessionID: "gone" },
      ],
      "local",
      (sessionID) => store.get(sessionID),
    )
    expect(resolved).toEqual([live])
  })

  test("returns empty when nothing resolves", () => {
    expect(resolvePinnedChats([{ server: "local", sessionID: "1" }], "local", () => undefined)).toEqual([])
  })
})

describe("resolvePinnedProjects", () => {
  test("keeps only open pinned projects", () => {
    const projects = [project("/a"), project("/b")]
    expect(resolvePinnedProjects(projects, (worktree) => worktree === "/b")).toEqual([project("/b")])
  })
})
