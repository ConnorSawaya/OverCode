import { ServerConnection } from "@/context/server"
import type { useGlobal } from "@/context/global"

// Shared onboarding mutation used by the home project list and the new-shell
// sidebar: opens directories as projects, associates their backend project IDs,
// touches the most recent one, and returns it for selection.
export function addHomeProjects(
  global: ReturnType<typeof useGlobal>,
  conn: ServerConnection.Any,
  directories: string[],
) {
  const directory = directories[0]
  if (!directory) return undefined
  const ctx = global.ensureServerCtx(conn)
  directories.forEach((item) => {
    if (ctx.projects.list().some((project) => project.worktree === item)) return
    const location = { directory: item }
    void ctx.sdk.api.file
      .list({ path: ".", location })
      .then(async (files) => {
        if (files.data.length > 0) return ctx.sdk.api.project.current({ location })
        const result = await ctx.sdk.client.project.initGit({ directory: item })
        return result.data ?? ctx.sdk.api.project.current({ location })
      })
      .then((project) => ctx.sync.child(item, { bootstrap: false })[1]("project", project.id))
      .catch(() => undefined)
    ctx.projects.open(item)
  })
  ctx.projects.touch(directory)
  return directory
}
