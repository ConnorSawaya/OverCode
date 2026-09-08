import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { useNavigate } from "@solidjs/router"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { Button } from "@opencode-ai/ui/button"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Icon } from "@opencode-ai/ui/icon"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { Spinner } from "@opencode-ai/ui/spinner"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { showToast } from "@/utils/toast"
import { useDirectoryPicker } from "@/components/directory-picker"
import { DialogConnectProvider } from "@/components/dialog-connect-provider"
import { useProviderConnectController } from "@/components/dialog-connect-provider"
import { useSettingsCommand } from "@/components/settings-dialog"
import { useCommand } from "@/context/command"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { type LocalProject, useLayout } from "@/context/layout"
import { usePins } from "@/context/pins"
import { usePlatform } from "@/context/platform"
import { ServerConnection, useServer } from "@/context/server"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { useSettings } from "@/context/settings"
import { useTabs } from "@/context/tabs"
import { pathKey } from "@/utils/path-key"
import { normalizeSessionInfo } from "@/utils/session"
import { Binary } from "@opencode-ai/core/util/binary"
import { addHomeProjects } from "../home/home-project-add"
import { homeProjectDirectories, projectForSession } from "./helpers"
import { CodexSidebarPanel, type CodexSidebarContext } from "./sidebar-codex-panel"

type ChatGPTAccount = { type: "credential"; id: string; label: string; methodID?: string }

function ChatGPTAccountSwitcher() {
  const dialog = useDialog()
  const language = useLanguage()
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()
  const connectController = useProviderConnectController()
  const [switching, setSwitching] = createSignal<string>()
  // The integration endpoint returns the active credential first, but keep a
  // local selection after a successful update so the trigger and radio group
  // stay correct while the provider cache is being refreshed.
  const [selectedID, setSelectedID] = createSignal<string>()
  const [integration, { refetch }] = createResource(() =>
    serverSDK()
      .client.v2.integration.get({ integrationID: "openai" })
      .then((result) => result.data?.data)
      .catch(() => undefined),
  )
  const accounts = createMemo<ChatGPTAccount[]>(() =>
    (integration.latest?.connections ?? []).filter(
      (connection): connection is ChatGPTAccount =>
        connection.type === "credential" &&
        (connection.methodID === "chatgpt-browser" || connection.methodID === "chatgpt-headless"),
    ),
  )
  const active = createMemo(() => {
    const selected = selectedID()
    return accounts().find((account) => account.id === selected) ?? accounts()[0]
  })
  const label = createMemo(() => {
    const account = active()
    if (!account) return language.t("account.chatgpt.title")
    return account.label.trim() && account.label !== "default"
      ? account.label
      : language.t("account.chatgpt.account", { index: 1 })
  })
  const initial = createMemo(() => label().trim().charAt(0).toUpperCase() || "C")

  const accountLabel = (account: ChatGPTAccount, index: number) => {
    const value = account.label.trim()
    return value && value !== "default"
      ? value
      : language.t("account.chatgpt.account", { index: index + 1 })
  }

  const select = async (value: unknown) => {
    if (typeof value !== "string") return
    const account = accounts().find((item) => item.id === value)
    if (!account || account.id === active()?.id || switching()) return

    setSwitching(account.id)
    try {
      await serverSDK().client.v2.credential.update({ credentialID: account.id, active: true })
      setSelectedID(account.id)
      await Promise.resolve(refetch()).catch(() => undefined)
      await serverSync().refreshProviders().catch(() => undefined)
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("account.chatgpt.switched"),
        description: accountLabel(account, accounts().findIndex((item) => item.id === account.id)),
      })
    } catch (error) {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setSwitching(undefined)
    }
  }

  const addAccount = () => {
    connectController.select("openai")
    void dialog.show(() => (
      <DialogConnectProvider
        controller={connectController}
        onConnected={() => {
          // A newly connected ChatGPT credential becomes active on the
          // server, so let the refreshed integration order choose it.
          setSelectedID(undefined)
          void refetch()
          void serverSync().refreshProviders()
        }}
      />
    ))
  }

  return (
    <DropdownMenu gutter={4} placement="top-start">
      <DropdownMenu.Trigger
        as={Button}
        variant="ghost"
        size="normal"
        class="h-7 w-full min-w-0 justify-start gap-1.5 rounded-md px-1.5 text-left data-[expanded]:bg-surface-raised-base-active"
        aria-label={language.t("account.chatgpt.switch")}
      >
        <span class="flex size-4 shrink-0 items-center justify-center rounded-full bg-surface-raised-base text-10-medium text-text-strong ring-1 ring-border-weak-base">
          {initial()}
        </span>
        <span class="min-w-0 flex-1 truncate text-12-medium text-text-strong">{label()}</span>
        <Icon name="chevron-down" size="small" class="size-3 shrink-0 text-icon-weak" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content class="mb-1 w-[272px]">
          <DropdownMenu.Group>
            <DropdownMenu.GroupLabel class="px-2 py-1 text-10-medium uppercase tracking-[0.08em] text-text-weak">
              {language.t("account.chatgpt.title")}
            </DropdownMenu.GroupLabel>
            <Show
              when={accounts().length > 0}
              fallback={<div class="px-2 py-2 text-12-regular text-text-weak">{language.t("account.chatgpt.none")}</div>}
            >
              <DropdownMenu.RadioGroup value={active()?.id ?? ""} onChange={(value) => void select(value)}>
                <For each={accounts()}>
                  {(account, index) => (
                    <DropdownMenu.RadioItem value={account.id} class="gap-1.5 px-2" disabled={switching() !== undefined}>
                      <span class="flex size-4 shrink-0 items-center justify-center rounded-full bg-surface-raised-base text-10-medium text-text-strong">
                        {accountLabel(account, index())
                          .trim()
                          .charAt(0)
                          .toUpperCase() || "C"}
                      </span>
                      <DropdownMenu.ItemLabel class="min-w-0 flex-1 truncate">
                        {accountLabel(account, index())}
                      </DropdownMenu.ItemLabel>
                      <Show when={switching() === account.id}>
                        <Spinner class="size-3.5 shrink-0 text-icon-weak" />
                      </Show>
                      <DropdownMenu.ItemIndicator>
                        <Icon name="check-small" size="small" class="text-icon-weak" />
                      </DropdownMenu.ItemIndicator>
                    </DropdownMenu.RadioItem>
                  )}
                </For>
              </DropdownMenu.RadioGroup>
            </Show>
          </DropdownMenu.Group>
          <DropdownMenu.Separator />
          <DropdownMenu.Item onSelect={addAccount} class="gap-1.5 px-2">
            <Icon name="plus-small" size="small" class="text-icon-weak" />
            <DropdownMenu.ItemLabel>{language.t("account.chatgpt.add")}</DropdownMenu.ItemLabel>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
  )
}

// Mounts the Codex sidebar inside the default (new) shell. Legacy keeps its own
// host, so exactly one sidebar is mounted per shell. Project expansion only
// changes selection/expansion state; it never navigates away on its own.
export function NewCodexSidebarHost() {
  const command = useCommand()
  const dialog = useDialog()
  const global = useGlobal()
  const language = useLanguage()
  const layout = useLayout()
  const navigate = useNavigate()
  const pins = usePins()
  const platform = usePlatform()
  const server = useServer()
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()
  const settings = useSettings()
  const tabs = useTabs()
  const pickDirectory = useDirectoryPicker()
  const openSettings = useSettingsCommand()

  // No default keybind: mod+b already toggles home in the new shell. A custom
  // user keybind for sidebar.toggle is still honored through settings.
  command.register("new-sidebar", () => [
    {
      id: "sidebar.toggle",
      title: language.t("command.sidebar.toggle"),
      category: language.t("command.category.view"),
      onSelect: () => layout.sidebar.toggle(),
    },
  ])

  const projects = () => layout.projects.list()
  const projectByID = createMemo(
    () => new Map(projects().flatMap((project) => (project.id ? [[project.id, project] as const] : []))),
  )
  const activeSession = createMemo(() => {
    const route = layout.route()
    if (route.type !== "session") return undefined
    return serverSync().session.get(route.sessionId)
  })
  const currentProject = createMemo(() => {
    const session = activeSession()
    if (session) return projectForSession(session, projects(), projectByID())
    const directory = layout.home.selection().directory
    if (!directory) return undefined
    return projects().find((project) => pathKey(project.worktree) === pathKey(directory))
  })

  const openQuickChat = () => {
    const session = activeSession()
    const directory = session?.directory ?? currentProject()?.worktree
    void platform.openQuickChat?.({
      directory,
      sessionID: session?.id,
      serverKey: server.current ? ServerConnection.key(server.current) : undefined,
    })
  }

  const storedProject = (directory: string) =>
    server.projects.list().find((project) => pathKey(project.worktree) === pathKey(directory))

  const selectProject = (directory: string, options?: { limit?: number; exact?: boolean }) => {
    const conn = server.current
    if (!conn) return
    server.projects.touch(directory)
    layout.home.setSelection({ server: ServerConnection.key(conn), directory })
    layout.mobileSidebar.hide()
    void serverSync().project.loadSessions(directory, options).catch(() => {})
  }

  const openNewSession = (directory: string) => {
    const conn = server.current
    if (!conn) return
    server.projects.open(directory)
    selectProject(directory)
    void serverSDK()
      .api.session.create({ location: { directory } })
      .then(normalizeSessionInfo)
      .then((session) => {
        serverSync().session.remember(session)
        const [, setChild] = serverSync().child(directory)
        setChild("session", (list: Session[] = []) => {
          const result = Binary.search(list, session.id, (item) => item.id)
          const next = [...list]
          if (result.found) next[result.index] = session
          if (!result.found) next.splice(result.index, 0, session)
          return next
        })
        const tab = tabs.addSessionTab({ server: ServerConnection.key(conn), sessionId: session.id })
        tabs.select(tab)
      })
      .catch((error) =>
        showToast({
          variant: "error",
          title: language.t("prompt.toast.sessionCreateFailed.title"),
          description: error instanceof Error ? error.message : language.t("common.requestFailed"),
        }),
      )
  }

  const closeProject = (directory: string) => {
    const closing = projects().find((project) => pathKey(project.worktree) === pathKey(directory))
    const session = activeSession()
    const closesActive =
      !!session &&
      !!closing &&
      (pathKey(session.directory) === pathKey(closing.worktree) ||
        closing.sandboxes?.some((sandbox) => pathKey(sandbox) === pathKey(session.directory)))
    pins.unpinProject(directory)
    layout.projects.close(directory)
    const selection = layout.home.selection()
    if (selection.directory && pathKey(selection.directory) === pathKey(directory)) {
      layout.home.setSelection({ server: selection.server })
    }
    if (closesActive) navigate("/")
  }

  const showEditProjectDialog = (project: LocalProject) => {
    const conn = server.current
    if (!conn) return
    void import("@/components/dialog-edit-project-v2").then(({ DialogEditProjectV2 }) => {
      void dialog.show(() => <DialogEditProjectV2 server={conn} project={project} />)
    })
  }

  const prefetchSession = (session: Session, priority: "high" | "low" = "low") => {
    void serverSync().session.prefetch(session.id, priority === "high" ? 200 : 25).catch(() => {})
  }

  const openSession = (session: Session) => {
    const conn = server.current
    if (!conn) return

    // Project session rows previously used the legacy `/:dir/session/:id`
    // link. Select the canonical server/session tab directly so opening a
    // session does not depend on route-time server inference.
    const tab = tabs.addSessionTab({
      server: ServerConnection.key(conn),
      sessionId: session.id,
    })
    tabs.select(tab)
  }

  const ctx: CodexSidebarContext = {
    navList: () => [],
    sidebarExpanded: layout.sidebar.opened,
    clearHoverProjectSoon: () => {},
    prefetchSession,
    openSession,
    currentSessionID: () => activeSession()?.id,
    workspaceExpanded: (directory, local) => storedProject(directory)?.expanded ?? local,
    setWorkspaceExpanded: (directory, value) => {
      if (value) server.projects.expand(directory)
      else server.projects.collapse(directory)
    },
  }

  const chooseProjects = () => {
    const conn = server.current
    if (!conn) return
    pickDirectory({
      server: conn,
      title: language.t("command.project.open"),
      multiple: true,
      onSelect: (result) => {
        const directory = addHomeProjects(global, conn, homeProjectDirectories(result))
        if (!directory) return
        layout.home.setSelection({ server: ServerConnection.key(conn), directory })
      },
    })
  }

  const toggleLabel = () => language.t("command.sidebar.toggle")
  const sidebarWidth = createMemo(() => Math.min(layout.sidebar.width(), 280))
  const mobileSidebarStyle = () => {
    const bottom = settings.general.mobileTitlebarPosition() === "bottom"
    return {
      top: bottom ? "0" : "36px",
      bottom: bottom ? "36px" : "0",
    }
  }
  const panelProps = {
    projects,
    currentProject,
    sortNow: () => 0,
    wsCtx: ctx,
    navigateToProject: (directory: string) => selectProject(directory, { limit: 3, exact: true }),
    navigateToNewSession: openNewSession,
    closeProject,
    showEditProjectDialog,
    onToggleSidebar: () => layout.sidebar.toggle(),
  }

  return (
    <>
      <Show
        when={layout.sidebar.opened()}
        fallback={
          <div class="hidden min-h-0 w-12 shrink-0 flex-col items-center border-e border-border-weaker-base bg-background-base py-2 lg:flex">
            <Tooltip value={toggleLabel()} placement="right">
              <IconButton
                icon="sidebar"
                variant="ghost"
                class="size-8 rounded-md"
                aria-label={toggleLabel()}
                aria-expanded={false}
                onClick={() => layout.sidebar.toggle()}
              />
            </Tooltip>
            <Show when={platform.openQuickChat && settings.general.quickChatEnabled()}>
              <Tooltip value={language.t("quickChat.open")} placement="right">
                <IconButton
                  icon="open-file"
                  variant="ghost"
                  class="size-8 rounded-md"
                  aria-label={language.t("quickChat.open")}
                  onClick={openQuickChat}
                />
              </Tooltip>
            </Show>
          </div>
        }
      >
        <aside
          aria-label={language.t("sidebar.nav.projectsAndSessions")}
          data-component="sidebar-nav-new"
          class="hidden min-h-0 shrink-0 flex-col border-e border-border-weaker-base bg-background-base lg:flex"
          style={{ width: `${sidebarWidth()}px` }}
        >
          <div class="min-h-0 flex-1">
            <CodexSidebarPanel {...panelProps} />
          </div>
          <div class="shrink-0 border-t border-border-weaker-base px-1.5 py-1.5">
            <ChatGPTAccountSwitcher />
            <div class="mt-0.5 flex items-center gap-0.5">
              <Show when={platform.openQuickChat && settings.general.quickChatEnabled()}>
                <Tooltip value={language.t("quickChat.open")} placement="top">
                  <IconButton
                    icon="open-file"
                    variant="ghost"
                    class="size-6 rounded-md text-icon-weak hover:bg-surface-raised-base-hover hover:text-text-strong"
                    aria-label={language.t("quickChat.open")}
                    onClick={openQuickChat}
                  />
                </Tooltip>
              </Show>
              <Tooltip value={language.t("home.project.add")} placement="top">
                <IconButton
                  icon="plus"
                  variant="ghost"
                  class="size-6 rounded-md text-icon-weak hover:bg-surface-raised-base-hover hover:text-text-strong"
                  aria-label={language.t("home.project.add")}
                  onClick={chooseProjects}
                />
              </Tooltip>
              <div class="flex-1" />
              <Tooltip value={language.t("sidebar.settings")} placement="top">
                <IconButton
                  icon="sliders"
                  variant="ghost"
                  class="size-6 rounded-md text-icon-weak hover:bg-surface-raised-base-hover hover:text-text-strong"
                  aria-label={language.t("sidebar.settings")}
                  onClick={() => openSettings()}
                />
              </Tooltip>
              <Tooltip value={toggleLabel()} placement="top">
                <IconButton
                  icon="sidebar"
                  variant="ghost"
                  class="size-6 rounded-md text-icon-weak hover:bg-surface-raised-base-hover hover:text-text-strong"
                  aria-label={toggleLabel()}
                  aria-expanded={true}
                  onClick={() => layout.sidebar.toggle()}
                />
              </Tooltip>
            </div>
          </div>
        </aside>
      </Show>
      <Show when={layout.mobileSidebar.opened()}>
        <div
          class="fixed inset-x-0 z-40 bg-black/30 lg:hidden"
          style={mobileSidebarStyle()}
          onClick={() => layout.mobileSidebar.hide()}
        />
        <aside
          aria-label={language.t("sidebar.nav.projectsAndSessions")}
          data-component="sidebar-nav-mobile-new"
          class="fixed start-0 z-50 flex w-[min(400px,calc(100vw-24px))] flex-col overflow-hidden border-e border-border-weaker-base bg-background-base shadow-xl lg:hidden"
          style={mobileSidebarStyle()}
          onClick={(event) => event.stopPropagation()}
        >
          <div class="flex shrink-0 items-center justify-end border-b border-border-weaker-base px-3 py-2">
            <Tooltip value={toggleLabel()} placement="right">
              <IconButton
                icon="close-small"
                variant="ghost"
                class="size-8 rounded-md"
                aria-label={language.t("sidebar.menu.toggle")}
                aria-expanded={true}
                onClick={() => layout.mobileSidebar.hide()}
              />
            </Tooltip>
          </div>
          <div class="min-h-0 flex-1">
            <CodexSidebarPanel {...panelProps} />
          </div>
        </aside>
      </Show>
    </>
  )
}
