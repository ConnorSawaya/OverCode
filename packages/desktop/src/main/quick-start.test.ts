import { expect, test } from "bun:test"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { prepareQuickChatProject, prepareQuickStart } from "./quick-start"

test("quick start has a stable workspace across concurrent opens and restarts", async () => {
  const documents = await mkdtemp(join(tmpdir(), "opencode-quick-start-test-"))
  const directories = await Promise.all(Array.from({ length: 3 }, () => prepareQuickStart(documents)))
  expect(new Set(directories).size).toBe(1)
  expect(await prepareQuickStart(documents)).toBe(directories[0])
  const instructions = await readFile(join(directories[0], "AGENTS.md"), "utf8")
  expect(instructions).toContain("descriptive, unique subdirectory")
  expect(instructions).toContain("For conversation, do not create a project")
  await writeFile(join(directories[0], "AGENTS.md"), "User workspace instructions")
  await prepareQuickStart(documents)
  expect(await readFile(join(directories[0], "AGENTS.md"), "utf8")).toBe("User workspace instructions")
})

test("quick chat has a stable local project directory", async () => {
  const documents = await mkdtemp(join(tmpdir(), "overcode-quick-chat-test-"))
  const directories = await Promise.all(
    Array.from({ length: 3 }, () => prepareQuickChatProject(documents)),
  )
  expect(new Set(directories).size).toBe(1)
  expect(directories[0]).toBe(join(documents, "OpenCode", "Quick Chat"))
})
