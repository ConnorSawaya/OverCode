import type { Project } from "@overcode-ai/sdk/v2/client"
import { pathKey } from "@/utils/path-key"

export type ProjectListEntry = Partial<Project> & {
  worktree: string
  expanded: boolean
}

export function mergeRemoteProjects(
  local: ProjectListEntry[],
  remote: Project[],
  recentlyClosed: string[],
): ProjectListEntry[] {
  const closed = new Set(recentlyClosed.map(pathKey))
  const seen = new Set(local.map((project) => pathKey(project.worktree)))
  const imported = remote.flatMap((project) => {
    if (!project.worktree || project.id === "global") return []
    const key = pathKey(project.worktree)
    if (closed.has(key) || seen.has(key)) return []
    seen.add(key)
    return [{ ...project, expanded: true }]
  })
  return [...local, ...imported]
}
