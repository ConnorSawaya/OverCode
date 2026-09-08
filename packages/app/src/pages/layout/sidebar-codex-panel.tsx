import { createEffect, createMemo, createSignal, For, Show, onMount, type Accessor, type JSX } from "solid-js"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { Button } from "@opencode-ai/ui/button"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { useIsFetching } from "@tanstack/solid-query"
import { type Session } from "@opencode-ai/sdk/v2/client"
import { type LocalProject } from "@/context/layout"
import { useLanguage } from "@/context/language"
import { usePins } from "@/context/pins"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { useQueryOptions, useServerSync } from "@/context/server-sync"
import { pathKey } from "@/utils/path-key"
import { createStore } from "solid-js/store"
import { displayName, filterSessionsByQuery, resolvePinnedChats, resolvePinnedProjects, sortedRootSessions } from "./helpers"
import { ProjectIcon, SessionItem } from "./sidebar-items"
import { WorkspaceSessionList, type SessionListSidebarContext } from "./sidebar-workspace"

const PROJECT_SESSION_PAGE_SIZE = 3

const StandaloneChats = (props: { directory: string; query: Accessor<string>; ctx: CodexSidebarContext; now: Accessor<number> }) => {
  const language = useLanguage()
  const sync = useServerSync()
  const [store, setStore] = sync().child(props.directory, { bootstrap: false })
  const [state, setState] = createStore({ limit: 3, loading: false, failed: false })
  const sessions = createMemo(() => filterSessionsByQuery(sortedRootSessions(store, props.now()), props.query()))
  const load = async () => {
    setState({ loading: true, failed: false })
    try {
      await sync().project.loadSessions(props.directory, { limit: state.limit, exact: true })
    } catch {
      setState("failed", true)
    } finally {
      setState("loading", false)
    }
  }
  onMount(() => void load())
  return <div data-component="sidebar-standalone-chats">
    <SectionLabel icon="speech-bubble">{language.t("sidebar.standaloneChats")}</SectionLabel>
    <WorkspaceSessionList
      slug={() => base64Encode(props.directory)} ctx={props.ctx} showNew={() => false} dense
      loading={() => state.loading} sessions={() => sessions().slice(0, state.limit)}
      hasMore={() => state.failed || store.sessionTotal > state.limit || sessions().length > state.limit}
      loadMore={async () => {
        if (state.loading) return
        if (!state.failed) setState("limit", state.limit + 3)
        setStore("limit", state.limit)
        await load()
      }} language={language}
    />
  </div>
}

// Minimal capabilities needed by the Codex panel. Legacy passes its full workspace
// context; the new shell provides a lightweight adapter with the same shape.
export type CodexSidebarContext = SessionListSidebarContext & {
  workspaceExpanded: (directory: string, local: boolean) => boolean
  setWorkspaceExpanded: (directory: string, value: boolean) => void
}

const SectionLabel = (props: { children: JSX.Element; icon?: "folder" | "pin" | "speech-bubble" }) => (
  <div class="flex items-center gap-1 px-1 pt-2.5 pb-0.5 text-10-medium uppercase tracking-[0.08em] text-text-weak">
    <Show when={props.icon}>
      {(icon) => <Icon name={icon()} size="small" class="size-3 shrink-0" />}
    </Show>
    <span>{props.children}</span>
  </div>
)

type ProjectSearchState = {
  visible: boolean
  loading: boolean
}

const ProjectGroup = (props: {
  project: LocalProject
  query: Accessor<string>
  active: Accessor<boolean>
  wsCtx: CodexSidebarContext
  sortNow: Accessor<number>
  navigateToProject: (directory: string) => void
  navigateToNewSession: (directory: string) => void
  closeProject: (directory: string) => void
  showEditProjectDialog: (project: LocalProject) => void
  onSearchState: (state: ProjectSearchState) => void
}): JSX.Element => {
  const language = useLanguage()
  const pins = usePins()
  const serverSync = useServerSync()
  const queryOptions = useQueryOptions()
  const project = () => props.project
  const [store, setStore] = serverSync().child(project().worktree, { bootstrap: false })
  const sessions = createMemo(() => sortedRootSessions(store, props.sortNow()))
  const [sessionLimit, setSessionLimit] = createSignal(PROJECT_SESSION_PAGE_SIZE)
  const count = createMemo(() => sessions().length)
  const fetching = useIsFetching(() => queryOptions().sessions(pathKey(project().worktree)))
  const loading = () => fetching() > 0 && count() === 0
  const name = createMemo(() => displayName(project()))
  const query = createMemo(() => props.query().trim().toLowerCase())
  const nameMatches = createMemo(() => query().length === 0 || name().toLowerCase().includes(query()))
  const shownSessions = createMemo(() => {
    const matching = nameMatches() ? sessions() : filterSessionsByQuery(sessions(), query())
    return matching.slice(0, sessionLimit())
  })
  const hasMoreShownSessions = createMemo(() => store.sessionTotal > shownSessions().length || count() > shownSessions().length)
  const visible = createMemo(() => nameMatches() || shownSessions().length > 0)
  const expanded = createMemo(() => props.active() || props.wsCtx.workspaceExpanded(project().worktree, true))
  const pinned = createMemo(() => pins.isProjectPinned(project().worktree))
  const pinLabel = createMemo(() =>
    pinned() ? language.t("sidebar.unpin.project") : language.t("sidebar.pin.project"),
  )

  createEffect(() => props.onSearchState({ visible: visible(), loading: loading() }))

  return (
    <Show when={visible()}>
      <div class="group/codex-project">
        <div
          classList={{
            "flex items-center gap-1 rounded-md pr-1": true,
            "bg-surface-base-active": props.active(),
          }}
        >
          <button
            type="button"
            class="min-w-0 flex flex-1 items-center gap-1.5 rounded-md py-1 pl-1.5 pr-1 text-left hover:bg-surface-raised-base-hover"
            aria-expanded={expanded()}
            onClick={() => {
              if (!expanded()) {
                props.navigateToProject(project().worktree)
                props.wsCtx.setWorkspaceExpanded(project().worktree, true)
                return
              }
              props.wsCtx.setWorkspaceExpanded(project().worktree, false)
            }}
          >
            <span class="shrink-0 text-icon-weak">
              <Icon name={expanded() ? "chevron-down" : "chevron-right"} size="small" />
            </span>
            <ProjectIcon project={project()} compact notify />
            <span class="min-w-0 flex-1 truncate text-13-medium text-text-strong">{name()}</span>
          </button>
          <div class="flex shrink-0 items-center opacity-0 transition-opacity group-hover/codex-project:opacity-100 group-focus-within/codex-project:opacity-100">
            <Tooltip value={language.t("command.session.new")} placement="top">
              <IconButton
                icon="plus-small"
                variant="ghost"
                class="size-5 rounded-md"
                aria-label={language.t("command.session.new")}
                onClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  props.navigateToNewSession(project().worktree)
                }}
              />
            </Tooltip>
            <DropdownMenu>
              <DropdownMenu.Trigger
                as={IconButton}
                icon="dot-grid"
                variant="ghost"
                class="size-5 rounded-md"
                aria-label={language.t("common.moreOptions")}
              />
              <DropdownMenu.Portal>
                <DropdownMenu.Content class="mt-1">
                  <DropdownMenu.Item onSelect={() => props.navigateToNewSession(project().worktree)}>
                    <DropdownMenu.ItemLabel>{language.t("command.session.new")}</DropdownMenu.ItemLabel>
                  </DropdownMenu.Item>
                  <DropdownMenu.Item onSelect={() => pins.toggleProject(project().worktree)}>
                    <DropdownMenu.ItemLabel>{pinLabel()}</DropdownMenu.ItemLabel>
                  </DropdownMenu.Item>
                  <DropdownMenu.Item onSelect={() => props.showEditProjectDialog(project())}>
                    <DropdownMenu.ItemLabel>{language.t("common.rename")}</DropdownMenu.ItemLabel>
                  </DropdownMenu.Item>
                  <DropdownMenu.Separator />
                  <DropdownMenu.Item onSelect={() => props.closeProject(project().worktree)}>
                    <DropdownMenu.ItemLabel>{language.t("common.close")}</DropdownMenu.ItemLabel>
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu>
          </div>
        </div>
        <Show when={expanded()}>
          <div
            class="relative ms-5 mt-0.5 mb-1 border-s border-border-weaker-base ps-2.5"
            data-component="sidebar-project-chats"
            role="group"
            aria-label={name()}
          >
            <WorkspaceSessionList
              slug={() => base64Encode(project().worktree)}
              ctx={props.wsCtx}
              showNew={() => false}
              dense
              loading={loading}
              sessions={shownSessions}
              hasMore={hasMoreShownSessions}
              loadMore={async () => {
                const nextLimit = sessionLimit() + PROJECT_SESSION_PAGE_SIZE
                setSessionLimit(nextLimit)
                setStore("limit", nextLimit)
                await serverSync().project.loadSessions(project().worktree, { limit: nextLimit, exact: true })
              }}
              language={language}
            />
          </div>
        </Show>
      </div>
    </Show>
  )
}

const PinnedChats = (props: {
  sessions: Accessor<Session[]>
  wsCtx: CodexSidebarContext
}): JSX.Element => {
  const list = () => props.sessions()

  return (
    <Show when={list().length > 0}>
      <div class="flex flex-col gap-1" data-component="sidebar-pinned-chats">
        <For each={list()}>
          {(session) => (
            <SessionItem
              session={session}
              list={list()}
              slug={base64Encode(session.directory)}
              dense
              navList={props.wsCtx.navList}
              sidebarExpanded={props.wsCtx.sidebarExpanded}
              clearHoverProjectSoon={props.wsCtx.clearHoverProjectSoon}
              prefetchSession={props.wsCtx.prefetchSession}
              openSession={props.wsCtx.openSession}
              currentSessionID={props.wsCtx.currentSessionID}
            />
          )}
        </For>
      </div>
    </Show>
  )
}

const PinnedProjects = (props: {
  projects: Accessor<LocalProject[]>
  navigateToProject: (directory: string) => void
}): JSX.Element => {
  const language = useLanguage()
  const pins = usePins()
  const list = () => props.projects()

  return (
    <Show when={list().length > 0}>
      <div class="flex flex-col gap-0.5 pt-0.5" data-component="sidebar-pinned-projects">
        <For each={list()}>
          {(project) => (
            <div class="group/codex-pinned-project flex items-center gap-1 rounded-md pr-1 hover:bg-surface-raised-base-hover">
              <button
                type="button"
                class="min-w-0 flex flex-1 items-center gap-1.5 rounded-md py-1 pl-1.5 pr-1 text-left"
                onClick={() => props.navigateToProject(project.worktree)}
              >
                <ProjectIcon project={project} compact />
                <span class="min-w-0 flex-1 truncate text-13-regular text-text-base">
                  {displayName(project)}
                </span>
              </button>
              <span class="shrink-0 opacity-0 transition-opacity group-hover/codex-pinned-project:opacity-100 group-focus-within/codex-pinned-project:opacity-100">
                <Tooltip value={language.t("sidebar.unpin.project")} placement="top">
                  <IconButton
                    icon="pin"
                    variant="ghost"
                    class="size-5 rounded-md"
                    aria-label={language.t("sidebar.unpin.project")}
                    aria-pressed={true}
                    onClick={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      pins.toggleProject(project.worktree)
                    }}
                  />
                </Tooltip>
              </span>
            </div>
          )}
        </For>
      </div>
    </Show>
  )
}

export const CodexSidebarPanel = (props: {
  projects: Accessor<LocalProject[]>
  currentProject: Accessor<LocalProject | undefined>
  sortNow: Accessor<number>
  wsCtx: CodexSidebarContext
  navigateToProject: (directory: string) => void
  navigateToNewSession: (directory: string) => void
  closeProject: (directory: string) => void
  showEditProjectDialog: (project: LocalProject) => void
  onToggleSidebar?: () => void
}): JSX.Element => {
  const language = useLanguage()
  const platform = usePlatform()
  const pins = usePins()
  const server = useServer()
  const serverSync = useServerSync()
  const [quick, setQuick] = createStore({ directory: "", loading: false, failed: false })
  const prepareQuick = async () => {
    if (!platform.quickStartDirectory || quick.loading) return
    setQuick({ loading: true, failed: false })
    try {
      const directory = await platform.quickStartDirectory()
      setQuick("directory", directory)
      return directory
    } catch {
      setQuick("failed", true)
    } finally {
      setQuick("loading", false)
    }
  }
  onMount(() => { if (server.isLocal()) void prepareQuick() })
  const projects = createMemo(() => props.projects().filter((project) => !server.isLocal() || !quick.directory || pathKey(project.worktree) !== pathKey(quick.directory)))
  const [query, setQuery] = createSignal("")
  const [projectSearch, setProjectSearch] = createStore<Record<string, ProjectSearchState>>({})
  const newChatDir = createMemo(() => props.currentProject()?.worktree ?? props.projects()[0]?.worktree)
  const pinnedChats = createMemo(() =>
    resolvePinnedChats(pins.chats(), server.key, (sessionID) => serverSync().session.get(sessionID)),
  )
  const pinnedProjects = createMemo(() => resolvePinnedProjects(projects(), (worktree) =>
    pins.isProjectPinned(worktree),
  ))
  const queryText = createMemo(() => query().trim().toLowerCase())
  const matchingPinnedChats = createMemo(() =>
    queryText().length === 0 ? pinnedChats() : filterSessionsByQuery(pinnedChats(), queryText()),
  )
  const matchingPinnedProjects = createMemo(() =>
    queryText().length === 0
      ? pinnedProjects()
      : pinnedProjects().filter((project) => displayName(project).toLowerCase().includes(queryText())),
  )
  const hasPins = createMemo(() => matchingPinnedChats().length > 0 || matchingPinnedProjects().length > 0)
  const hasVisibleProjects = createMemo(() =>
    projects().some((project) => projectSearch[pathKey(project.worktree)]?.visible === true),
  )
  const projectSearchLoading = createMemo(() =>
    projects().some((project) => projectSearch[pathKey(project.worktree)]?.loading === true),
  )
  const projectSearchReady = createMemo(() =>
    projects().every((project) => projectSearch[pathKey(project.worktree)] !== undefined),
  )
  const searchEmpty = createMemo(
    () =>
      queryText().length > 0 &&
      projectSearchReady() &&
      !hasPins() &&
      !(server.isLocal() && quick.directory) &&
      !hasVisibleProjects() &&
      !projectSearchLoading(),
  )

  return (
    <div data-component="codex-sidebar-panel" class="flex h-full min-h-0 min-w-0 flex-col">
      <div class="shrink-0 px-3 pt-3">
        <div class="flex h-9 items-center gap-2 rounded-md bg-surface-weak px-2">
          <Icon name="magnifying-glass" size="small" class="size-3.5 shrink-0 text-icon-weak" />
          <input
            type="text"
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
            placeholder={language.t("sidebar.search.placeholder")}
            aria-label={language.t("sidebar.search.placeholder")}
            class="min-w-0 flex-1 bg-transparent text-13-regular text-text-strong outline-none placeholder:text-text-weak"
          />
          <Show when={query().length > 0}>
            <button
              type="button"
              class="shrink-0 text-icon-weak hover:text-icon-strong"
              aria-label={language.t("common.clear")}
              onClick={() => setQuery("")}
            >
              <Icon name="close-small" size="small" class="size-3.5" />
            </button>
          </Show>
        </div>
        <div class="py-1.5">
          <Button
            variant="ghost"
            size="normal"
            data-component="sidebar-new-chat"
            class="h-8 w-full justify-center gap-1.5 rounded-md border border-border-weak-base bg-surface-base px-2 text-13-medium hover:bg-surface-weak"
            disabled={!newChatDir()}
            onClick={() => {
              const dir = newChatDir()
              if (!dir) return
              props.navigateToNewSession(dir)
            }}
          >
            <IconV2 name="edit" size="small" class="size-3.5" />
            {language.t("command.session.new")}
          </Button>
          <Show when={platform.quickStartDirectory && server.isLocal()}>
            <Button variant="ghost" size="normal" data-component="sidebar-quick-start"
              class="mt-1 h-8 w-full justify-center gap-1.5 rounded-md text-13-medium"
              title={language.t("sidebar.quickStart.help")} disabled={quick.loading}
              onClick={async () => {
                const directory = quick.directory || await prepareQuick()
                if (directory && server.isLocal()) props.navigateToNewSession(directory)
              }}>
              <Icon name="speech-bubble" size="small" />
              {language.t("sidebar.quickStart")}
            </Button>
            <Show when={quick.failed}>
              <div role="alert" class="px-2 py-1 text-12-regular text-text-weak">{language.t("sidebar.quickStart.error")}</div>
            </Show>
          </Show>
        </div>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto px-3 pb-3 no-scrollbar">
        <Show when={server.isLocal() && quick.directory} keyed>
          {(directory) => <StandaloneChats directory={directory} query={query} ctx={props.wsCtx} now={props.sortNow} />}
        </Show>
        <Show when={hasPins()}>
          <SectionLabel icon="pin">{language.t("sidebar.pinned")}</SectionLabel>
          <PinnedProjects projects={matchingPinnedProjects} navigateToProject={props.navigateToProject} />
          <PinnedChats sessions={matchingPinnedChats} wsCtx={props.wsCtx} />
        </Show>
        <Show when={queryText().length === 0 || hasVisibleProjects()}>
          <SectionLabel icon="folder">{language.t("sidebar.projects")}</SectionLabel>
        <div class="flex flex-col gap-0.5">
            <For each={projects()}>
              {(project) => (
                <ProjectGroup
                  project={project}
                  query={query}
                  active={() => props.currentProject()?.worktree === project.worktree}
                  wsCtx={props.wsCtx}
                  sortNow={props.sortNow}
                  navigateToProject={props.navigateToProject}
                  navigateToNewSession={props.navigateToNewSession}
                  closeProject={props.closeProject}
                  showEditProjectDialog={props.showEditProjectDialog}
                  onSearchState={(state) => setProjectSearch(pathKey(project.worktree), state)}
                />
              )}
            </For>
          </div>
        </Show>
        <Show when={searchEmpty()}>
          <div
            role="status"
            data-component="sidebar-search-empty"
            class="flex flex-col items-center gap-2 px-2 py-8 text-center"
          >
            <Icon name="magnifying-glass" size="small" class="text-icon-weak" />
            <div class="text-13-regular text-text-weak">{language.t("palette.empty")}</div>
          </div>
        </Show>
        <Show when={queryText().length === 0 && props.projects().length === 0 && !hasPins()}>
          <div class="px-2 py-6 text-center">
            <div class="text-14-medium text-text-strong">{language.t("sidebar.empty.title")}</div>
            <div class="text-13-regular text-text-base">{language.t("sidebar.empty.description")}</div>
          </div>
        </Show>
      </div>
    </div>
  )
}
