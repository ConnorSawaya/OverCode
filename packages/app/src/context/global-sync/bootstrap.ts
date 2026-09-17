import type {
  Config,
  OpencodeClient,
  Path,
  PermissionRequest,
  Project,
  ProviderAuthResponse,
  QuestionRequest,
  ReferenceInfo,
  Session,
} from "@overcode-ai/sdk/v2/client"
import type {
  AgentListInput,
  AgentListOutput,
  CatalogApi,
  CommandInfo,
  CommandListInput,
  CommandListOutput,
  ProjectCurrentInput,
  ProjectCurrentOutput,
  ProjectListOutput,
  ReferenceListInput,
  ReferenceListOutput,
  SessionApi,
} from "@overcode-ai/client/promise"
import { showToast } from "@/utils/toast"
import { getFilename } from "@overcode-ai/core/util/path"
import { retry } from "@overcode-ai/core/util/retry"
import { batch } from "solid-js"
import { produce, reconcile, type SetStoreFunction, type Store } from "solid-js/store"
import type { State, VcsCache } from "./types"
import type { ServerSession } from "../server-session"
import {
  cmp,
  normalizeAgentList,
  normalizePermissionRequest,
  normalizeProjectInfo,
  normalizeProviderList,
  normalizeV2ProviderList,
} from "./utils"
import { formatServerError } from "@/utils/server-errors"
import { QueryClient, queryOptions } from "@tanstack/solid-query"
import { loadMcpQuery, loadMcpResourcesQuery } from "../server-sync"
import { NormalizedProviderListResponse } from "@overcode-ai/session-ui/context"
import { ScopedKey, type ServerScope } from "@/utils/server-scope"
import { normalizeSessionInfo } from "@/utils/session"
import type { ServerProtocol } from "@/utils/server-protocol"
import type { ServerApi } from "@/utils/server"

type GlobalStore = {
  ready: boolean
  path: Path
  project: Project[]
  provider: NormalizedProviderListResponse
  provider_auth: ProviderAuthResponse
  config: Config
  reload: undefined | "pending" | "complete"
}

function waitForPaint() {
  return new Promise<void>((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      resolve()
    }
    const timer = setTimeout(finish, 50)
    if (typeof requestAnimationFrame !== "function") return
    requestAnimationFrame(() => {
      setTimeout(() => {
        clearTimeout(timer)
        finish()
      }, 0)
    })
  })
}

function errors(list: PromiseSettledResult<unknown>[]) {
  return list.filter((item): item is PromiseRejectedResult => item.status === "rejected").map((item) => item.reason)
}

const providerRev = new Map<string, number>()
// Provider/model catalogs are large on current servers. Keep a warm catalog
// fresh for a short window, while explicit provider refreshes still bypass it.
export const PROVIDER_CATALOG_STALE_TIME_MS = 60_000

export function clearProviderRev(scope: ServerScope, directory: string) {
  providerRev.delete(ScopedKey.from(scope, directory))
}

function runAll(list: Array<() => Promise<unknown>>) {
  return Promise.allSettled(list.map((item) => item()))
}

function showErrors(input: {
  errors: unknown[]
  title: string
  translate: (key: string, vars?: Record<string, string | number>) => string
  formatMoreCount: (count: number) => string
}) {
  if (input.errors.length === 0) return
  const message = formatServerError(input.errors[0], input.translate)
  const more = input.errors.length > 1 ? input.formatMoreCount(input.errors.length - 1) : ""
  showToast({
    variant: "error",
    title: input.title,
    description: message + more,
  })
}

export const loadGlobalConfigQuery = (scope: ServerScope, sdk: OpencodeClient, protocol?: Promise<ServerProtocol>) =>
  queryOptions({
    queryKey: [scope, "config"],
    queryFn: async () => {
      if ((await protocol) !== "v1") return {}
      return retry(() => sdk.global.config.get().then((x) => x.data!))
    },
  })

type ProjectApi = {
  readonly list: () => Promise<ProjectListOutput>
  readonly current: (input?: ProjectCurrentInput) => Promise<ProjectCurrentOutput>
}

type CurrentProjectApi = Pick<OpencodeClient["project"], "list" | "current">

type McpApi = ServerApi["mcp"]
type PermissionApi = ServerApi["permission"]
type QuestionApi = ServerApi["question"]
type VcsApi = ServerApi["vcs"]

export const loadProjectsQuery = (
  scope: ServerScope,
  api: ProjectApi,
  current?: CurrentProjectApi,
  protocol?: Promise<ServerProtocol>,
) =>
  queryOptions({
    queryKey: [scope, "project"],
    staleTime: 30_000,
    gcTime: 10 * 60_000,
    queryFn: () =>
      retry(async () => {
        const projects =
          (await protocol) === "v2" && current ? ((await current.list()).data ?? []) : await api.list()
        return projects
          .filter((p) => !!p?.id)
          .filter((p) => !!p.worktree && !p.worktree.includes("overcode-test"))
          .map(normalizeProjectInfo)
          .slice()
          .sort((a, b) => cmp(a.id, b.id))
      }),
  })

export async function bootstrapGlobal(input: {
  serverSDK: OpencodeClient
  serverAPI: CatalogApi & { readonly project: ProjectApi }
  protocol?: Promise<ServerProtocol>
  scope: ServerScope
  requestFailedTitle: string
  translate: (key: string, vars?: Record<string, string | number>) => string
  formatMoreCount: (count: number) => string
  setGlobalStore: SetStoreFunction<GlobalStore>
  queryClient: QueryClient
}) {
  const slow = [
    () => input.queryClient.fetchQuery(loadGlobalConfigQuery(input.scope, input.serverSDK, input.protocol)),
    () =>
      input.queryClient.fetchQuery(
        loadProvidersQuery(input.scope, null, input.serverAPI, input.serverSDK, input.protocol),
      ),
    () => input.queryClient.fetchQuery(loadPathQuery(input.scope, null, input.serverSDK, input.protocol)),
    () =>
      input.queryClient
        .fetchQuery(loadProjectsQuery(input.scope, input.serverAPI.project, input.serverSDK.project, input.protocol))
        .then((data) => input.setGlobalStore("project", data)),
  ]
  await runAll(slow)
  // showErrors({
  //   errors: errors(),
  //   title: input.requestFailedTitle,
  //   translate: input.translate,
  //   formatMoreCount: input.formatMoreCount,
  // })
}

function groupBySession<T extends { id: string; sessionID: string }>(input: T[]) {
  return input.reduce<Record<string, T[]>>((acc, item) => {
    if (!item?.id || !item.sessionID) return acc
    const list = acc[item.sessionID]
    if (list) list.push(item)
    if (!list) acc[item.sessionID] = [item]
    return acc
  }, {})
}

function projectID(directory: string, projects: Project[]) {
  return projects.find((project) => project.worktree === directory || project.sandboxes?.includes(directory))?.id
}

function mergeSession(setStore: SetStoreFunction<State>, session: Session) {
  setStore("session", (list) => {
    const next = list.slice()
    const idx = next.findIndex((item) => item.id >= session.id)
    if (idx === -1) return [...next, session]
    if (next[idx]?.id === session.id) {
      next[idx] = session
      return next
    }
    next.splice(idx, 0, session)
    return next
  })
}

function warmSessions(input: {
  ids: string[]
  store: Store<State>
  setStore: SetStoreFunction<State>
  api: Pick<SessionApi, "get">
}) {
  const known = new Set(input.store.session.map((item) => item.id))
  const ids = [...new Set(input.ids)].filter((id) => !!id && !known.has(id))
  if (ids.length === 0) return Promise.resolve()
  return Promise.all(
    ids.map((sessionID) =>
      retry(() => input.api.get({ sessionID })).then((session) =>
        mergeSession(input.setStore, normalizeSessionInfo(session)),
      ),
    ),
  ).then(() => undefined)
}

export const loadProvidersQuery = (
  scope: ServerScope,
  directory: string | null,
  sdk: CatalogApi,
  legacy?: OpencodeClient,
  protocol?: Promise<ServerProtocol>,
) =>
  queryOptions({
    queryKey: [scope, directory, "providers"],
    staleTime: PROVIDER_CATALOG_STALE_TIME_MS,
    queryFn: () =>
      retry(async () => {
        if ((await protocol) === "v1" && legacy) {
          const result = await legacy.provider.list()
          return normalizeProviderList(result.data!)
        }
        if ((await protocol) === "v2" && legacy) {
          const location = directory ? { location: { directory } } : undefined
          const [providers, models] = await Promise.all([
            legacy.v2.provider.list(location),
            legacy.v2.model.list(location),
          ])
          return normalizeV2ProviderList(providers.data?.data ?? [], models.data?.data ?? [])
        }
        const location = directory ? { location: { directory } } : undefined
        // Older and newer servers disagree on whether a default-model route
        // exists, so a missing default must not reject the whole catalog.
        const [providers, models, defaultModel] = await Promise.all([
          sdk.provider.list(location),
          sdk.model.list(location),
          sdk.model.default(location).catch(() => ({ data: undefined })),
        ])
        return normalizeProviderList(providers.data, models.data, defaultModel.data)
      }),
  })

type AgentListApi = {
  readonly list: (input?: AgentListInput) => Promise<AgentListOutput>
}

type CommandListApi = {
  readonly list: (input?: CommandListInput) => Promise<CommandListOutput>
}

type ReferenceListApi = {
  readonly list: (input?: ReferenceListInput) => Promise<ReferenceListOutput>
}

export const loadAgentsQuery = (
  scope: ServerScope,
  directory: string,
  sdk: AgentListApi,
  legacy?: OpencodeClient,
  protocol?: Promise<ServerProtocol>,
) =>
  queryOptions({
    queryKey: [scope, directory, "agents"],
    queryFn: () =>
      retry(async () => {
        if ((await protocol) === "v1" && legacy) return normalizeAgentList((await legacy.app.agents()).data ?? [])
        if ((await protocol) === "v2" && legacy) {
          const result = await legacy.v2.agent.list({ location: { directory } })
          return normalizeAgentList(result.data?.data ?? [])
        }
        return sdk.list({ location: { directory } }).then((result) => normalizeAgentList(result.data))
      }),
  })

export const loadCommands = (
  directory: string,
  api: CommandListApi,
  legacy?: OpencodeClient,
  protocol?: Promise<ServerProtocol>,
): Promise<CommandInfo[]> =>
  retry(async () => {
    if ((await protocol) === "v1" && legacy) {
      return ((await legacy.command.list()).data ?? []).map((command) => {
        const [providerID, id] = command.model?.split("/") ?? []
        return {
          name: command.name,
          template: command.template,
          description: command.description,
          agent: command.agent,
          model: providerID && id ? { providerID, id } : undefined,
          subtask: command.subtask,
          // source: command.source === "skill" ? undefined : command.source,
        }
      })
    }
    return api.list({ location: { directory } }).then((result) => result.data)
  })

export const loadPathQuery = (
  scope: ServerScope,
  directory: string | null,
  sdk: OpencodeClient,
  protocol?: Promise<ServerProtocol>,
) =>
  queryOptions<Path>({
    queryKey: [scope, directory, "path"],
    queryFn: () =>
      retry(async () => {
        // The legacy `/path` route does not exist on V2-only daemons (404 +
        // retries). Resolve through `v2.location.get` and project it onto the
        // legacy Path shape instead.
        if ((await protocol) === "v2") {
          try {
            const location = await (sdk as unknown as OpencodeClient & {
              v2: { location: { get: (input?: unknown) => Promise<{ data?: unknown }> } }
            }).v2.location.get(directory ? { location: { directory } } : undefined)
            const raw = (location as { data?: unknown }).data as
              | { directory?: string; project?: { directory?: string }; data?: unknown }
              | undefined
            // Tolerate both the bare Location.Info shape and a
            // Location.response envelope around it.
            const info = (
              raw && typeof raw === "object" && "data" in raw && raw.data && typeof raw.data === "object" ?
                (raw.data as { directory?: string; project?: { directory?: string } })
              : (raw as { directory?: string; project?: { directory?: string } } | undefined)
            )
            return {
              state: "",
              config: "",
              worktree: info?.project?.directory ?? directory ?? "",
              directory: info?.directory ?? directory ?? "",
              home: "",
            } satisfies Path
          } catch {
            return {
              state: "",
              config: "",
              worktree: directory ?? "",
              directory: directory ?? "",
              home: "",
            } satisfies Path
          }
        }
        return sdk.path.get({ directory: directory ?? undefined }).then((result) => result.data!)
      }),
  })

export const loadReferencesQuery = (
  scope: ServerScope,
  directory: string,
  api: ReferenceListApi,
  legacy?: OpencodeClient,
  protocol?: Promise<ServerProtocol>,
) =>
  queryOptions<ReferenceInfo[]>({
    queryKey: [scope, directory, "references"] as const,
    queryFn: () =>
      retry(async () => {
        if ((await protocol) === "v1" && legacy) return (await legacy.v2.reference.list()).data?.data ?? []
        return api.list({ location: { directory } }).then((result) => result.data)
      }).catch(() => []),
    placeholderData: [],
  })

export async function bootstrapDirectory(input: {
  directory: string
  scope: ServerScope
  mcp: boolean
  sdk: OpencodeClient
  api: CatalogApi & {
    readonly agent: AgentListApi
    readonly command: CommandListApi
    readonly mcp: McpApi
    readonly permission: PermissionApi
    readonly project: ProjectApi
    readonly question: QuestionApi
    readonly reference: ReferenceListApi
    readonly session: Pick<SessionApi, "get">
    readonly vcs: VcsApi
  }
  store: Store<State>
  setStore: SetStoreFunction<State>
  vcsCache: VcsCache
  loadSessions: (directory: string) => Promise<void> | void
  translate: (key: string, vars?: Record<string, string | number>) => string
  global: {
    config: Config
    path: Path
    project: Project[]
    provider: NormalizedProviderListResponse
  }
  queryClient: QueryClient
  session?: ServerSession
  protocol?: Promise<ServerProtocol>
}) {
  const loading = input.store.status !== "complete"
  const seededProject = projectID(input.directory, input.global.project)
  const seededPath = input.global.path.directory === input.directory ? input.global.path : undefined
  if (seededProject) input.setStore("project", seededProject)
  if (seededPath) input.setStore("path", seededPath)
  if (Object.keys(input.store.config).length === 0 && Object.keys(input.global.config).length > 0) {
    input.setStore("config", reconcile(input.global.config, { merge: false }))
  }
  if (loading) input.setStore("status", "partial")

  const revKey = ScopedKey.from(input.scope, input.directory)
  const rev = (providerRev.get(revKey) ?? 0) + 1
  providerRev.set(revKey, rev)
  ;(async () => {
    const slow = [
      () => Promise.resolve(input.loadSessions(input.directory)),
      () =>
        input.queryClient
          .ensureQueryData(loadAgentsQuery(input.scope, input.directory, input.api.agent, input.sdk, input.protocol))
          .then((data) => input.setStore("agent", data)),
      () =>
        retry(async () => {
          if ((await input.protocol) !== "v1") return
          return input.sdk.config.get().then((x) => input.setStore("config", reconcile(x.data!, { merge: false })))
        }),
      () =>
        retry(() =>
          (async () => {
            if ((await input.protocol) !== "v1") return
            const x = await input.sdk.session.status()
            if (!input.session) {
              input.setStore("session_status", x.data!)
              return
            }
            const statuses = x.data ?? {}
            input.session.set(
              "session_status",
              produce((draft) => {
                for (const sessionID of Object.keys(draft)) {
                  if (statuses[sessionID]) continue
                  if (input.session?.get(sessionID)?.directory === input.directory) delete draft[sessionID]
                }
              }),
            )
            for (const [sessionID, status] of Object.entries(statuses)) {
              input.session.set("session_status", sessionID, reconcile(status))
            }
            await Promise.all(
              Object.keys(statuses).map((sessionID) => input.session!.resolve(sessionID).catch(() => undefined)),
            )
          })(),
        ),
      !seededProject &&
        (() =>
          retry(async () => {
            const project =
              (await input.protocol) === "v2"
                ? (await input.sdk.project.current({ directory: input.directory })).data
                : await input.api.project.current({ location: { directory: input.directory } })
            if (project) input.setStore("project", project.id)
          })),
      !seededPath &&
        (() =>
          input.queryClient
            .ensureQueryData(loadPathQuery(input.scope, input.directory, input.sdk, input.protocol))
            .then((data) => {
              const next = projectID(data.directory ?? input.directory, input.global.project)
              if (next) input.setStore("project", next)
            })),
      () =>
        retry(async () => {
          if ((await input.protocol) !== "v1") return
          return input.sdk.vcs.get().then((result) => {
            const next = { branch: result.data?.branch, default_branch: result.data?.default_branch }
            input.setStore("vcs", next)
            if (next) input.vcsCache.setStore("value", next)
          })
        }),
      input.mcp &&
        (() =>
          loadCommands(input.directory, input.api.command, input.sdk, input.protocol).then((commands) =>
            input.setStore("command", commands),
          )),
      () =>
        input.queryClient.fetchQuery(
          loadReferencesQuery(input.scope, input.directory, input.api.reference, input.sdk, input.protocol),
        ),
      () =>
        retry(() =>
          (async () => {
            if ((await input.protocol) === "v1") return (await input.sdk.permission.list()).data ?? []
            return input.api.permission.request
              .list({ location: { directory: input.directory } })
              .then((result) => result.data.map(normalizePermissionRequest))
          })().then((permissions) => {
            const ids = permissions.map((permission) => permission.sessionID)
            const grouped = groupBySession(
              permissions.filter((permission) => !!permission.id && !!permission.sessionID),
            )
            const warm = input.session
              ? Promise.all(ids.map((sessionID) => input.session!.resolve(sessionID))).then(() => undefined)
              : warmSessions({ ids, store: input.store, setStore: input.setStore, api: input.api.session })
            return warm.then(() =>
              batch(() => {
                const current = input.session?.data.permission ?? input.store.permission
                for (const sessionID of Object.keys(current)) {
                  if (grouped[sessionID]) continue
                  if (input.session?.get(sessionID)?.directory !== input.directory) continue
                  if (input.session) input.session.set("permission", sessionID, [])
                  if (!input.session) input.setStore("permission", sessionID, [])
                }
                for (const [sessionID, permissions] of Object.entries(grouped)) {
                  const value = reconcile(
                    permissions.filter((p) => !!p?.id).sort((a, b) => cmp(a.id, b.id)),
                    { key: "id" },
                  )
                  if (input.session) input.session.set("permission", sessionID, value)
                  if (!input.session) input.setStore("permission", sessionID, value)
                }
              }),
            )
          }),
        ),
      () =>
        retry(() =>
          (async () => {
            if ((await input.protocol) === "v1") return (await input.sdk.question.list()).data ?? []
            return input.api.question.request
              .list({ location: { directory: input.directory } })
              .then((result) => result.data)
          })().then((questions) => {
            const ids = questions.map((question) => question.sessionID)
            const grouped = groupBySession(
              questions.filter((question) => !!question.id && !!question.sessionID) as QuestionRequest[],
            )
            const warm = input.session
              ? Promise.all(ids.map((sessionID) => input.session!.resolve(sessionID))).then(() => undefined)
              : warmSessions({ ids, store: input.store, setStore: input.setStore, api: input.api.session })
            return warm.then(() =>
              batch(() => {
                const current = input.session?.data.question ?? input.store.question
                for (const sessionID of Object.keys(current)) {
                  if (grouped[sessionID]) continue
                  if (input.session?.get(sessionID)?.directory !== input.directory) continue
                  if (input.session) input.session.set("question", sessionID, [])
                  if (!input.session) input.setStore("question", sessionID, [])
                }
                for (const [sessionID, questions] of Object.entries(grouped)) {
                  const value = reconcile(
                    questions.filter((q) => !!q?.id).sort((a, b) => cmp(a.id, b.id)),
                    { key: "id" },
                  )
                  if (input.session) input.session.set("question", sessionID, value)
                  if (!input.session) input.setStore("question", sessionID, value)
                }
              }),
            )
          }),
        ),
      input.mcp &&
        (() =>
          input.queryClient.fetchQuery(
            loadMcpQuery(input.scope, input.directory, input.api.mcp, input.sdk, input.protocol),
          )),
      input.mcp &&
        (() =>
          input.queryClient.fetchQuery(
            loadMcpResourcesQuery(input.scope, input.directory, input.api.mcp, input.sdk, input.protocol),
          )),
      () =>
        input.queryClient
          .fetchQuery(loadProvidersQuery(input.scope, input.directory, input.api, input.sdk, input.protocol))
          .catch((err) => {
            const project = getFilename(input.directory)
            showToast({
              variant: "error",
              title: input.translate("toast.project.reloadFailed.title", { project }),
              description: formatServerError(err, input.translate),
            })
          }),
    ].filter(Boolean) as (() => Promise<any>)[]

    await waitForPaint()
    const slowErrs = errors(await runAll(slow))
    if (slowErrs.length > 0) {
      console.error("Failed to finish bootstrap instance", slowErrs[0])
      const project = getFilename(input.directory)
      showToast({
        variant: "error",
        title: input.translate("toast.project.reloadFailed.title", { project }),
        description: formatServerError(slowErrs[0], input.translate),
      })
    }

    if (loading && slowErrs.length === 0) input.setStore("status", "complete")
  })()
}
