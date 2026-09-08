import { createEffect, createMemo, For, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import type { BrowserBookmark, BrowserHistoryItem, BrowserProfileCandidate, BrowserSnapshot } from "@/context/browser"
import { showToast } from "@/utils/toast"
import { browserAddress } from "./side-panel-url"
import { ComputerPanel } from "./side-computer"

export function BrowserPanel(props: { sessionID?: string }) {
  const language = useLanguage()
  const platform = usePlatform()
  const api = platform.browser
  const [state, setState] = createStore({
    snapshot: undefined as BrowserSnapshot | undefined,
    address: "",
    editing: false,
    overlay: false,
    profiles: [] as BrowserProfileCandidate[],
    importing: false,
    selectedProfile: "",
    importedView: "bookmarks" as "bookmarks" | "history",
    view: "browser" as "browser" | "computer",
    showImport: false,
  })
  let viewport!: HTMLDivElement
  let input!: HTMLInputElement
  let disposed = false
  onCleanup(() => { disposed = true })
  const currentTab = createMemo(() => state.snapshot?.tabs.find((tab) => tab.tabId === state.snapshot?.activeTabId))
  const manual = () => state.snapshot?.controller === "user"
  const controlled = () => state.snapshot?.controller === "agent"
  const apply = (next: BrowserSnapshot) => {
    if (disposed || next.ownerSessionId !== props.sessionID) return
    if (state.snapshot && next.updatedAt < state.snapshot.updatedAt) return
    setState("snapshot", next)
    if (!state.editing) setState("address", next.currentUrl ?? "")
  }
  const fail = (error: unknown) => {
    if (disposed) return
    showToast({ title: language.t("common.requestFailed"), description: error instanceof Error ? error.message : String(error) })
  }
  const action = async (value: { action: string; url?: string; tabId?: string }) => {
    const sessionID = props.sessionID
    if (!api || !sessionID) return
    try { apply(await api.action({ ...value, sessionID })) } catch (error) { fail(error) }
  }
  const focusAddress = () => { input?.focus(); input?.select() }
  const navigate = (value: string) => {
    const url = browserAddress(value)
    if (!url) return
    setState({ address: url, editing: false })
    input?.blur()
    void action({ action: "navigate", url })
  }
  const navigateImported = (item: BrowserBookmark | BrowserHistoryItem) => {
    if (controlled()) return
    navigate(item.url)
  }
  const importedHost = (url: string) => {
    try { return new URL(url).hostname.replace(/^www\./, "") } catch { return url }
  }
  const importedTime = (timestamp?: number) => timestamp
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(timestamp)
    : ""
  const shortcut = (key: string) => {
    if (state.view !== "browser") return
    if (key === "l") focusAddress()
    if (key === "t" && !controlled()) void action({ action: "newTab" }).then(focusAddress)
    if (key === "w" && !controlled()) void action({ action: "closeTab" })
    if (key === "r" && !controlled()) void action({ action: "reload" })
  }
  onMount(() => {
    if (!api) return
    void api.listChromeProfiles().then((profiles) => { if (!disposed) setState("profiles", profiles) }).catch(() => {})
    const stop = api.onEvent((event) => {
      if (event.sessionId !== props.sessionID) return
      if (event.type === "browser.shortcut" && event.key) shortcut(event.key)
      if (event.snapshot) apply(event.snapshot)
    })
    const keydown = (event: KeyboardEvent) => {
      if ((!event.ctrlKey && !event.metaKey) || !["l", "t", "w", "r"].includes(event.key.toLowerCase())) return
      if (!(event.target instanceof Element) || !event.target.closest('[data-component="side-browser"]')) return
      event.preventDefault()
      event.stopPropagation()
      shortcut(event.key.toLowerCase())
    }
    document.addEventListener("keydown", keydown, true)
    // Native pages paint above DOM dialogs; detach while a modal is open.
    const overlays = new MutationObserver(() => setState("overlay", !!document.querySelector('[role="dialog"],[role="alertdialog"]')))
    overlays.observe(document.body, { subtree: true, childList: true })
    onCleanup(() => { stop(); overlays.disconnect(); document.removeEventListener("keydown", keydown, true) })
  })
  createEffect(() => {
    const sessionID = props.sessionID
    setState({ snapshot: undefined, address: "", editing: false })
    if (api && sessionID) void api.snapshot(sessionID).then(apply).catch(fail)
  })
  createEffect(() => {
    const sessionID = props.sessionID
    if (!api || !sessionID || !viewport || state.overlay || state.view !== "browser") return
    const bounds = () => {
      const box = viewport.getBoundingClientRect()
      return { x: box.left, y: box.top, width: box.width, height: box.height }
    }
    let active = true
    void api.attach(sessionID, bounds()).then((snapshot) => { if (active) apply(snapshot) }).catch(fail)
    const resize = () => { if (active) void api.resize(sessionID, bounds()).catch(fail) }
    const observer = new ResizeObserver(resize)
    observer.observe(viewport)
    if (viewport.parentElement) observer.observe(viewport.parentElement)
    window.addEventListener("resize", resize)
    onCleanup(() => {
      active = false
      observer.disconnect()
      window.removeEventListener("resize", resize)
      void api.detach(sessionID).catch(() => {})
    })
  })
  const control = async () => {
    if (!api || !props.sessionID) return
    try { apply(await api.control(props.sessionID, manual() ? "none" : "user")) } catch (error) { fail(error) }
  }
  const editAddress = () => {
    setState("editing", true)
    if (api && props.sessionID && !manual()) void api.control(props.sessionID, "user").then(apply).catch(fail)
  }
  const importChrome = async () => {
    const sessionID = props.sessionID
    const profileID = state.selectedProfile
    if (!api || !sessionID || !profileID || state.importing) return
    setState("importing", true)
    try {
      apply(await api.importChromeProfile(sessionID, profileID))
      showToast({ title: "Chrome data imported", description: "Bookmarks and history were copied. Passwords and cookies stayed in Chrome." })
    } catch (error) {
      fail(error)
    } finally {
      setState("importing", false)
    }
  }
  const available = () => !!api && !!props.sessionID
  const blank = () => !currentTab()?.url
  const error = () => currentTab()?.error
  return (
    <section data-component="side-browser" class="flex h-full min-h-0 flex-1 flex-col bg-background-base">
      <div class="flex shrink-0 items-center gap-1 border-b border-border-weak-base px-2 py-1.5" aria-label={language.t("side.tabs.browser")}>
        <For each={["browser", "computer"] as const}>{(view) =>
          <button type="button" aria-pressed={state.view === view} onClick={() => setState("view", view)}
            class="rounded-md px-3 py-1.5 text-12-medium text-text-weak hover:text-text-strong focus-visible:outline-2 focus-visible:outline-border-focus"
            classList={{ "bg-surface-weak !text-text-strong": state.view === view }}>
            {language.t(view === "browser" ? "side.tabs.browser" : "computer.tab")}
          </button>}
        </For>
        <Show when={state.view === "browser"}>
          <IconButton icon="settings-gear" variant="ghost" class="ml-auto size-7 rounded-md"
            aria-label={language.t("side.browser.importSettings")} aria-expanded={state.showImport}
            onClick={() => setState("showImport", !state.showImport)} />
        </Show>
      </div>
      <Show when={state.view === "computer"}><ComputerPanel sessionID={props.sessionID} /></Show>
      <div style={{ display: state.view === "browser" ? "contents" : "none" }}>
      <div class="flex shrink-0 items-center gap-1 border-b border-border-weak-base px-2 pt-1" role="tablist" aria-label={language.t("side.tabs.browser")}>
        <div class="flex min-w-0 flex-1 gap-1 overflow-x-auto">
          <For each={state.snapshot?.tabs ?? []}>
            {(tab) => (
              <div class="group flex min-w-24 max-w-48 flex-1 items-center rounded-t-md border border-b-0 border-transparent"
                classList={{ "bg-surface-weak !border-border-weak-base": tab.tabId === state.snapshot?.activeTabId }}>
                <button type="button" role="tab" aria-selected={tab.tabId === state.snapshot?.activeTabId}
                  class="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-2 text-12-regular text-text-base"
                  onClick={() => void action({ action: "switchTab", tabId: tab.tabId })} disabled={controlled()}>
                  <Icon name={tab.loading ? "reset" : "window-cursor"} size="small" class="shrink-0 text-text-weak" classList={{ "animate-spin": tab.loading }} />
                  <span class="truncate">{tab.title && tab.title !== "New tab" ? tab.title : language.t("side.browser.newTab")}</span>
                </button>
                <IconButton icon="close-small" variant="ghost" class="mr-1 size-5 shrink-0 rounded"
                  aria-label={language.t("side.browser.closeTab")} disabled={controlled()}
                  onClick={() => void action({ action: "closeTab", tabId: tab.tabId })} />
              </div>
            )}
          </For>
        </div>
        <IconButton icon="plus-small" variant="ghost" class="size-7 shrink-0 rounded-md"
          aria-label={language.t("side.browser.newTab")} disabled={!available() || controlled()}
          onClick={() => void action({ action: "newTab" }).then(focusAddress)} />
      </div>
      <div class="flex shrink-0 items-center gap-1 border-b border-border-weak-base px-2 py-2">
        <IconButton icon="arrow-left" variant="ghost" class="size-7 shrink-0 rounded-md"
          aria-label={language.t("side.browser.back")} disabled={!currentTab()?.canGoBack || controlled()}
          onClick={() => void action({ action: "back" })} />
        <IconButton icon="arrow-right" variant="ghost" class="size-7 shrink-0 rounded-md"
          aria-label={language.t("side.browser.forward")} disabled={!currentTab()?.canGoForward || controlled()}
          onClick={() => void action({ action: "forward" })} />
        <IconButton icon={currentTab()?.loading ? "close-small" : "reset"} variant="ghost" class="size-7 shrink-0 rounded-md"
          aria-label={language.t(currentTab()?.loading ? "prompt.action.stop" : "side.browser.reload")}
          disabled={!currentTab() || controlled()}
          onClick={() => void action({ action: currentTab()?.loading ? "stop" : "reload" })} />
        <form class="min-w-0 flex-1" onSubmit={(event) => { event.preventDefault(); navigate(state.address) }}>
          <input ref={input} value={state.address} onInput={(event) => setState("address", event.currentTarget.value)}
            onFocus={editAddress} onBlur={() => setState("editing", false)}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return
              setState({ address: state.snapshot?.currentUrl ?? "", editing: false })
              input.blur()
            }}
            placeholder={language.t("side.browser.searchAddress")} aria-label={language.t("side.browser.searchAddress")}
            disabled={!available()} spellcheck={false} autocomplete="off"
            class="h-8 w-full rounded-lg border border-transparent bg-surface-weak px-3 text-12-regular text-text-strong outline-none focus:border-border-focus placeholder:text-text-weak" />
        </form>
        <IconButton icon="square-arrow-top-right" variant="ghost" class="size-7 shrink-0 rounded-md"
          aria-label={language.t("side.browser.openExternal")} disabled={!currentTab()?.url}
          onClick={() => { const url = currentTab()?.url; if (url) platform.openExternal(url) }} />
      </div>
      <Show when={api && props.sessionID && state.showImport}>
        <div class="flex shrink-0 items-center gap-2 border-b border-border-weak-base px-3 py-1.5">
          <select
            aria-label="Chrome profile"
            value={state.selectedProfile}
            onChange={(event) => setState("selectedProfile", event.currentTarget.value)}
            class="min-w-0 flex-1 rounded-md bg-surface-weak px-2 py-1 text-11-regular text-text-weak outline-none focus:ring-1 focus:ring-border-focus"
          >
            <option value="">Isolated OpenCode profile</option>
            <For each={state.profiles}>{(profile) => <option value={profile.id}>{profile.name}</option>}</For>
          </select>
          <button
            type="button"
            disabled={!state.selectedProfile || state.importing}
            onClick={() => void importChrome()}
            class="shrink-0 rounded-md border border-border-weak-base px-2 py-1 text-11-medium text-text-strong hover:bg-surface-weak disabled:opacity-45"
          >
            {state.importing ? "Importing…" : "Import safe data"}
          </button>
        </div>
        <Show when={state.profiles.length > 0 && !state.snapshot?.profile}>
          <div class="shrink-0 border-b border-border-weak-base px-3 py-1 text-10-regular text-text-weak">
            Bookmarks and history only. Passwords and cookies stay in Chrome.
          </div>
        </Show>
        <Show when={state.snapshot?.profile}>
          <div class="flex shrink-0 items-center gap-2 border-b border-border-weak-base px-3 py-1.5 text-11-regular">
            <Icon name="check" size="small" class="shrink-0 text-icon-success-base" />
            <span class="min-w-0 flex-1 truncate text-text-strong">Imported {state.snapshot?.profile?.name}</span>
            <span class="shrink-0 text-text-weak">
              {(state.snapshot?.profile?.bookmarkItems?.length ?? 0).toLocaleString()} bookmarks · {(state.snapshot?.profile?.historyItems?.length ?? 0).toLocaleString()} history
            </span>
          </div>
        </Show>
      </Show>
      <div ref={viewport} class="relative min-h-0 flex-1 overflow-hidden bg-background-base">
        <Show when={state.snapshot?.profile && blank() && !error()}>
            <div class="flex h-full min-h-0 flex-col overflow-auto px-4 py-5">
              <div class="mb-4">
                <div class="mb-1 text-15-medium text-text-strong">Your imported browser</div>
                <div class="text-12-regular text-text-weak">Choose a bookmark or revisit a page from {state.snapshot?.profile?.name}.</div>
              </div>
              <div class="mb-3 flex items-center gap-1 rounded-lg bg-surface-weak p-1">
                <button type="button" class="flex-1 rounded-md px-2 py-1.5 text-12-medium text-text-weak hover:text-text-strong"
                  classList={{ "bg-background-base text-text-strong shadow-sm": state.importedView === "bookmarks" }}
                  onClick={() => setState("importedView", "bookmarks")}>Bookmarks</button>
                <button type="button" class="flex-1 rounded-md px-2 py-1.5 text-12-medium text-text-weak hover:text-text-strong"
                  classList={{ "bg-background-base text-text-strong shadow-sm": state.importedView === "history" }}
                  onClick={() => setState("importedView", "history")}>History</button>
              </div>
              <Show when={state.importedView === "bookmarks"} fallback={
                <Show when={(state.snapshot?.profile?.historyItems?.length ?? 0) > 0} fallback={<div class="rounded-lg border border-border-weak-base px-3 py-4 text-12-regular text-text-weak">No browser history could be read from this profile.</div>}>
                  <div class="flex flex-col gap-1">
                    <For each={state.snapshot?.profile?.historyItems}>
                      {(item) => (
                        <button type="button" disabled={controlled()} onClick={() => navigateImported(item)}
                          class="flex min-w-0 flex-col items-start rounded-lg px-3 py-2 text-left hover:bg-surface-weak disabled:opacity-45">
                          <span class="w-full truncate text-12-medium text-text-strong">{item.title}</span>
                          <span class="w-full truncate text-11-regular text-text-weak">{importedHost(item.url)}{item.lastVisitedAt ? ` · ${importedTime(item.lastVisitedAt)}` : ""}</span>
                        </button>
                      )}
                    </For>
                  </div>
                </Show>
              }>
                <Show when={(state.snapshot?.profile?.bookmarkItems?.length ?? 0) > 0} fallback={<div class="rounded-lg border border-border-weak-base px-3 py-4 text-12-regular text-text-weak">No browser bookmarks could be read from this profile.</div>}>
                  <div class="flex flex-col gap-1">
                    <For each={state.snapshot?.profile?.bookmarkItems}>
                      {(item) => (
                        <button type="button" disabled={controlled()} onClick={() => navigateImported(item)}
                          class="flex min-w-0 flex-col items-start rounded-lg px-3 py-2 text-left hover:bg-surface-weak disabled:opacity-45">
                          <span class="w-full truncate text-12-medium text-text-strong">{item.title}</span>
                          <span class="w-full truncate text-11-regular text-text-weak">{item.folder ? `${item.folder} · ` : ""}{importedHost(item.url)}</span>
                        </button>
                      )}
                    </For>
                  </div>
                </Show>
              </Show>
            </div>
        </Show>
        <Show when={!available() || (!state.snapshot?.profile && blank()) || error()}>
          <div class="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <Icon name={error() ? "warning" : "window-cursor"} size="large" class="text-text-weak" />
            <h3 class="text-16-medium text-text-strong">{language.t(error() ? "side.browser.failed" : "side.browser.newTab")}</h3>
            <p class="max-w-72 break-words text-13-regular text-text-weak">
              {!api ? language.t("side.browser.desktopOnly") : !props.sessionID ? language.t("side.browser.sessionRequired") :
                error() || language.t("side.browser.start")}
            </p>
            <Show when={error()}>
              <button type="button" class="rounded-md border border-border-weak-base px-3 py-1.5 text-13-medium text-text-strong"
                onClick={() => void action({ action: "reload" })}>{language.t("side.browser.reload")}</button>
            </Show>
            <Show when={available() && blank()}>
              <button type="button" class="rounded-md border border-border-weak-base px-3 py-1.5 text-13-medium text-text-strong"
                onClick={focusAddress}>{language.t("side.browser.searchAddress")}</button>
            </Show>
          </div>
        </Show>
      </div>
      <div role="status" class="flex h-7 shrink-0 items-center gap-2 border-t border-border-weak-base px-3 text-11-regular text-text-weak">
        <span class="size-1.5 rounded-full" classList={{ "bg-icon-error-base": !!error(), "bg-icon-warning-base": !!currentTab()?.loading, "bg-icon-success-base": !error() && !currentTab()?.loading }} />
        <span class="min-w-0 flex-1 truncate">{state.snapshot?.currentAction?.label ??
          language.t(controlled() ? "side.browser.agent" : manual() ? "side.browser.manual" : currentTab()?.loading ? "side.browser.loading" : "side.browser.ready")}</span>
        <Show when={available()}>
          <button type="button" class="shrink-0 rounded px-2 py-1 hover:bg-surface-weak hover:text-text-strong" onClick={() => void control()}>{language.t(manual() ? "side.browser.returnAgent" : "side.browser.takeControl")}</button>
        </Show>
      </div>
      </div>
    </section>
  )
}
