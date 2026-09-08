import { createEffect, createMemo, createRoot, For } from "solid-js"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { useCommand } from "@/context/command"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { createTabPromptState } from "@/context/prompt"
import { ServerConnection, useServer } from "@/context/server"
import { tabKey, useTabs, type SessionTab } from "@/context/tabs"
import type { PromptSession } from "@/context/prompt"
import { adjacentTabKey } from "./titlebar-tab-order"
import { useTabModel } from "./tab-model"

// Invisible per-tab upkeep formerly done by the top tab strip: session
// resolution (warms the titles the sidebar shows), prompt-state creation
// (preserves composer models for new tabs), and one-time message prefetch.
function SessionTabWarmer(props: { tab: SessionTab }) {
  const tabs = useTabs()
  const global = useGlobal()
  const serverCtx = createMemo(() => {
    const conn = global.servers.list().find((item) => ServerConnection.key(item) === props.tab.server)
    if (conn) return global.ensureServerCtx(conn)
  })
  const session = createMemo(() => serverCtx()?.sync.session.peek(props.tab.sessionId))
  let warmed = false

  createEffect(() => {
    const ctx = serverCtx()
    if (!ctx) return
    void ctx.sync.session.resolve(props.tab.sessionId).catch(() => {})
  })

  createEffect(() => {
    const ctx = serverCtx()
    const value = session()
    if (!ctx || !value) return
    tabs.rememberSessionInfo(props.tab, value)
    createTabPromptState(tabs, props.tab, ctx.sdk.scope, {
      dir: base64Encode(value.directory),
      id: value.id,
    })
  })

  createEffect(() => {
    const ctx = serverCtx()
    const value = session()
    if (!ctx || !value || warmed) return
    warmed = true
    createRoot((dispose) => {
      try {
        void ctx.sync
          .ensureDirSyncContext(value.directory)
          .session.sync(value.id)
          .catch(() => {})
          .finally(dispose)
      } catch {
        dispose()
      }
    })
  })

  return null
}

// Owns tab creation and tab shortcuts in the new shell, independent of the
// top tab strip UI. Mounted once in layout-new so shortcuts survive the
// strip's removal.
export function TabCommands() {
  const command = useCommand()
  const language = useLanguage()
  const layout = useLayout()
  const global = useGlobal()
  const server = useServer()
  const tabs = useTabs()
  const { currentTab, session } = useTabModel()
  const sessionTabs = createMemo(() => tabs.store.filter((tab): tab is SessionTab => tab.type === "session"))

  const selectAdjacentTab = (offset: -1 | 1) => {
    const ids = visibleTabIds()
    const current = currentTab()
    const key = adjacentTabKey(ids, current ? tabKey(current) : undefined, offset)
    const next = tabs.store.find((tab) => tabKey(tab) === key)
    if (next) tabs.select(next)
  }

  // Tabs the UI can actually show, mirroring the old strip: drafts always,
  // sessions only with a cached session or a persisted title.
  const visibleTabIds = () =>
    tabs.store.flatMap((tab) => {
      const id = tabKey(tab)
      if (tab.type === "draft") return [id]
      const conn = global.servers.list().find((item) => ServerConnection.key(item) === tab.server)
      const sync = conn ? global.ensureServerCtx(conn).sync : undefined
      if (sync?.session.peek(tab.sessionId) || tabs.info[id]?.title) return [id]
      return []
    })

  const openNewTab = () => {
    const route = layout.route()
    const activeSession = session()
    if (route.type === "session" && activeSession) {
      const sessionTab = {
        type: "session" as const,
        server: route.server ?? server.key,
        sessionId: activeSession.id,
      }
      const model = tabs.stateValue<PromptSession>(sessionTab, "prompt")?.model.current()
      tabs.newDraft({ server: sessionTab.server, directory: activeSession.directory }, "", model)
      return
    }

    const activeTab = currentTab()
    if (activeTab?.type === "draft") {
      const model = tabs.stateValue<PromptSession>(activeTab, "prompt")?.model.current()
      tabs.newDraft({ server: activeTab.server, directory: activeTab.directory }, "", model)
      return
    }

    if (route.type === "home") {
      const selection = layout.home.selection()
      const conn = global.servers.list().find((item) => ServerConnection.key(item) === selection.server)
      const project = conn
        ? global
            .ensureServerCtx(conn)
            .projects.list()
            .find((item) => item.worktree === selection.directory)
        : undefined
      if (conn && project) {
        tabs.newDraft({ server: ServerConnection.key(conn), directory: project.worktree }, "")
        return
      }
    }

    const current = layout.projects.list()[0]
    if (current) {
      tabs.newDraft({ server: server.key, directory: current.worktree }, "")
      return
    }

    const fallback = global.servers.list().flatMap((conn) => {
      const project = global.ensureServerCtx(conn).projects.list()[0]
      return project ? [{ server: ServerConnection.key(conn), project }] : []
    })[0]
    if (!fallback) return

    tabs.newDraft({ server: fallback.server, directory: fallback.project.worktree }, "")
  }

  command.register("tabs", () => {
    const current = currentTab()

    return [
      {
        id: "tab.new",
        category: "tab",
        title: language.t("command.session.new"),
        keybind: "mod+t,mod+n",
        hidden: true,
        onSelect: openNewTab,
      },
      current && {
        id: "tab.close",
        category: "tab",
        title: language.t("command.tab.close"),
        keybind: "mod+w",
        hidden: true,
        onSelect: () => {
          tabs.closeTab(tabs.store.findIndex((tab) => current === tab))
        },
      },
      {
        id: "tab.reopenClosed",
        category: language.t("command.category.file"),
        title: language.t("command.tab.reopenClosed"),
        keybind: "mod+shift+t",
        onSelect: () => tabs.reopenClosedTab(),
      },
    ].filter((v) => v !== undefined)
  })

  command.register("sidebar-tab-cycle", () => [
    {
      id: "tab.prev",
      category: "tab",
      title: "",
      keybind: "mod+option+ArrowLeft,ctrl+shift+tab",
      hidden: true,
      onSelect: () => selectAdjacentTab(-1),
    },
    {
      id: "tab.next",
      category: "tab",
      title: "",
      keybind: "mod+option+ArrowRight,ctrl+tab",
      hidden: true,
      onSelect: () => selectAdjacentTab(1),
    },
  ])

  command.register("sidebar-tab-numbers", () => {
    const ids = visibleTabIds()
    return tabs.store.flatMap((tab) => {
      const index = ids.indexOf(tabKey(tab))
      if (index === -1 || index > 8) return []
      return [
        {
          id: `tab.${index + 1}`,
          category: "tab",
          title: "",
          keybind: `mod+${index + 1}`,
          hidden: true,
          onSelect: () => tabs.select(tab),
        },
      ]
    })
  })

  return (
    <For each={sessionTabs()}>{(tab) => <SessionTabWarmer tab={tab} />}</For>
  )
}
