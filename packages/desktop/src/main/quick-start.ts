import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

// Stable across restarts: native sessions retain their own IDs and histories.
export async function prepareQuickStart(documents: string) {
  const directory = join(documents, "OpenCode", "Quick start")
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, "AGENTS.md"), `# Quick start workspace

These are standalone chats, not a preselected repository. For conversation, do not create a project.
When asked to build something new, choose a descriptive, unique subdirectory here for that task.
Check whether the name exists before creating it; do not overwrite another task's files.
Keep all commands for that project scoped to its subdirectory and tell the user its full path.
If the user identifies an existing project, inspect that exact location instead; ask if ambiguous.
Do not move existing repositories, change other sessions, or initialize git unless the task needs it.
This instruction does not grant permission to modify unrelated files or bypass approval settings.
`, { flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error
  })
  return directory
}

/** Stable local project used when Quick Chat is opened without a selection. */
export async function prepareQuickChatProject(documents: string) {
  const directory = join(documents, "OpenCode", "Quick Chat")
  await mkdir(directory, { recursive: true })
  return directory
}
