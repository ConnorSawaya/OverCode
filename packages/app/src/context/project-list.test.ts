import { describe, expect, test } from "bun:test"
import { mergeRemoteProjects } from "./project-list"

const project = (id: string, worktree: string) => ({
  id,
  worktree,
  time: { created: 1, updated: 1 },
  sandboxes: [],
})

describe("mergeRemoteProjects", () => {
  test("imports remote worktrees while keeping local state and excluding global", () => {
    const result = mergeRemoteProjects(
      [{ worktree: "C:\\repo", expanded: false }],
      [project("global", "/"), project("remote", "C:\\other")],
      [],
    )

    expect(result).toEqual([
      { worktree: "C:\\repo", expanded: false },
      { ...project("remote", "C:\\other"), expanded: true },
    ])
  })

  test("does not re-import local or recently closed projects", () => {
    const result = mergeRemoteProjects(
      [{ worktree: "C:\\repo", expanded: true }],
      [project("same", "C:\\repo"), project("closed", "C:\\closed"), project("new", "C:\\new")],
      ["C:/closed/"],
    )

    expect(result.map((item) => item.worktree)).toEqual(["C:\\repo", "C:\\new"])
  })
})
