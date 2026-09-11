import { createEffect, createMemo, createResource } from "solid-js"
import { makeEventListener } from "@solid-primitives/event-listener"
import { useGlobal } from "@/context/global"
import { type LayoutRoute, useLayout } from "@/context/layout"
import { ServerConnection, useServer } from "@/context/server"
import { useTabs, type Tab } from "@/context/tabs"
import { readSessionTabsRemovedDetail, SESSION_TABS_REMOVED_EVENT } from "@/components/titlebar-session-events"
import { normalizeSessionInfo } from "@/utils/session"

// Route → open-tab resolution plus the tab lifecycle side effects that used to
// live in the titlebar. Shared (module singleton) so the top tab strip and its
// future sidebar replacement never run duplicate session fetches or effects.
function createTabModel() {
  const layout = useLayout()
  const global = useGlobal()
  const server = useServer()
  const tabs = useTabs()
  const tabsStore = tabs.store
  const tabsStoreActions = tabs

  const [session] = createResource(
    () => {
      const route = layout.route()
      if (route.type !== "session") return undefined
      const conn = global.servers
        .list()
        .find((item) => ServerConnection.key(item) === (route.server ?? server.key))
      return conn ? { route, sdk: global.ensureServerCtx(conn).sdk } : undefined
    },
    ({ route, sdk }) =>
      sdk.api.session
        .get({ sessionID: route.sessionId })
        .then(normalizeSessionInfo)
        .catch(() => {}),
  )

  const matchRoute = (route: LayoutRoute) => {
    if (route.type === "home") return
    if (route.type === "draft") {
      return tabsStore.find((item) => item.type === "draft" && item.draftID === route.draftID)
    }
    if (route.type === "session") {
      const main = tabsStore.find(
        (item) => item.type === "session" && item.server === route.server && item.sessionId === route.sessionId,
      )
      if (main) return main
      const s = session()
      if (s?.parentID) {
        const parentID = s.parentID
        const parent = tabsStore.find(
          (item) => item.type === "session" && item.server === route.server && item.sessionId === parentID,
        )
        if (parent) return parent
      }
    }
  }

  const currentTab = (): Tab | undefined => matchRoute(layout.route())

  createEffect(() => {
    const route = layout.route()
    if (!tabs.ready()) return
    const tab = currentTab()
    if (tab) {
      tabs.remember(tab)
      return
    }

    if (route.type === "session") {
      const s = session()
      if (!s) return
      const sessionId = s.parentID ?? s.id
      const next = { server: route.server ?? server.key, sessionId }
      tabsStoreActions.addSessionTab(next)
    }
  })

  makeEventListener(window, SESSION_TABS_REMOVED_EVENT, (event) => {
    const detail = readSessionTabsRemovedDetail(event)
    if (!detail) return
    tabsStoreActions.removeSessions(detail)
  })

  return { currentTab, session }
}

let shared: ReturnType<typeof createTabModel> | undefined

export function useTabModel() {
  if (!shared) shared = createTabModel()
  return shared
}
