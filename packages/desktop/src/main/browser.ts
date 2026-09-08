import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { copyFile, mkdir, readFile, readdir, stat } from "node:fs/promises"
import { DatabaseSync } from "node:sqlite"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import {
  app,
  BrowserWindow,
  session as electronSession,
  WebContentsView,
  type Rectangle,
  type Session,
} from "electron"
import { getStore } from "./store"
import { ComputerManager } from "./computer"
import type { ComputerAction } from "@opencode-ai/app/context/computer"

export type BrowserStatus =
  | "not_created"
  | "starting"
  | "ready"
  | "navigating"
  | "interacting"
  | "waiting"
  | "user_controlled"
  | "agent_controlled"
  | "error"
  | "disconnected"
  | "closed"

export type BrowserController = "agent" | "user" | "none"

export type BrowserTabSnapshot = {
  tabId: string
  title: string
  url: string
  favicon?: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  error?: string
}

export type BrowserActionSnapshot = {
  actionId: string
  type: string
  status: "started" | "completed" | "failed"
  label: string
  target?: string
  startedAt: number
  completedAt?: number
  error?: string
}

export type BrowserProfileCandidate = {
  id: string
  name: string
  browser: "chrome"
  hasBookmarks: boolean
  hasHistory: boolean
}

export type ImportedBrowserProfile = {
  name: string
  browser: "chrome"
  importedAt: number
  bookmarks: boolean
  history: boolean
  bookmarkItems?: BrowserBookmark[]
  historyItems?: BrowserHistoryItem[]
  // Secrets are intentionally never imported from another browser profile.
  passwords: false
  cookies: false
}

export type BrowserBookmark = {
  id: string
  title: string
  url: string
  folder?: string
}

export type BrowserHistoryItem = {
  id: string
  title: string
  url: string
  lastVisitedAt?: number
}

export type BrowserSessionSnapshot = {
  browserSessionId?: string
  ownerSessionId: string
  status: BrowserStatus
  controller: BrowserController
  tabs: BrowserTabSnapshot[]
  activeTabId?: string
  currentUrl?: string
  currentAction?: BrowserActionSnapshot
  profile?: ImportedBrowserProfile
  error?: string
  updatedAt: number
}

export type BrowserEvent =
  | { type: "browser.shortcut"; sessionId: string; key: string }
  | { type: "browser.snapshot"; sessionId: string; snapshot: BrowserSessionSnapshot }
  | { type: "browser.action.started"; sessionId: string; browserSessionId: string; tabId?: string; action: BrowserActionSnapshot }
  | { type: "browser.action.completed"; sessionId: string; browserSessionId: string; tabId?: string; action: BrowserActionSnapshot }
  | { type: "browser.action.failed"; sessionId: string; browserSessionId: string; tabId?: string; action: BrowserActionSnapshot }
  | { type: "browser.navigation.started"; sessionId: string; browserSessionId: string; tabId: string; url: string }
  | { type: "browser.navigation.completed"; sessionId: string; browserSessionId: string; tabId: string; url: string; title: string }
  | { type: "browser.tab.created"; sessionId: string; browserSessionId: string; tab: BrowserTabSnapshot }
  | { type: "browser.tab.closed"; sessionId: string; browserSessionId: string; tabId: string }
  | { type: "browser.tab.selected"; sessionId: string; browserSessionId: string; tabId: string }
  | { type: "browser.control.changed"; sessionId: string; browserSessionId: string; controller: BrowserController }
  | { type: "browser.status"; sessionId: string; browserSessionId: string; status: BrowserStatus; message?: string }
  | { type: "browser.console.error"; sessionId: string; browserSessionId: string; tabId: string; message: string }
  | { type: "browser.error"; sessionId: string; browserSessionId: string; tabId?: string; message: string }

type BrowserBounds = { x: number; y: number; width: number; height: number }

type ManagedTab = BrowserTabSnapshot & {
  view: WebContentsView
}

type ManagedBrowser = {
  snapshot: BrowserSessionSnapshot
  partition: Session
  tabs: Map<string, ManagedTab>
  attached: Map<number, { window: BrowserWindow; bounds: BrowserBounds }>
  restored: boolean
  action?: BrowserActionSnapshot
  actionTabId?: string
}

type StoredBrowser = {
  browserSessionId: string
  ownerSessionId: string
  tabs: BrowserTabSnapshot[]
  activeTabId?: string
  updatedAt: number
  profile?: ImportedBrowserProfile
}

type ChromeProfilePath = BrowserProfileCandidate & { path: string }

type BrowserActionRequest = {
  sessionID: string
  runID?: string
  action: string
  url?: string
  tabId?: string
  target?: string
  text?: string
  key?: string
  x?: number
  y?: number
  direction?: "up" | "down" | "left" | "right"
  amount?: number
  option?: string
  timeoutMs?: number
}

const STORE_NAME = "opencode.browser"
const STORE_KEY = "sessions"
const BRIDGE_TOKEN_HEADER = "x-opencode-browser-token"
const MAX_TABS = 12
const MAX_OUTPUT = 24_000

const safeUrl = (value?: string) => {
  if (!value) return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined
    return url.toString()
  } catch {
    return undefined
  }
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function copySafeProfileFile(sourceDirectory: string, destinationDirectory: string, filename: "Bookmarks" | "History") {
  try {
    await copyFile(join(sourceDirectory, filename), join(destinationDirectory, filename))
    return true
  } catch {
    return false
  }
}

async function copyOptionalProfileFile(sourceDirectory: string, destinationDirectory: string, filename: "History-wal" | "History-shm") {
  try {
    await copyFile(join(sourceDirectory, filename), join(destinationDirectory, filename))
  } catch {
    // Chrome may not have a sidecar file, or it may remove it between reads.
  }
}

const readChromeBookmarks = async (filename: string): Promise<BrowserBookmark[]> => {
  try {
    const raw = JSON.parse(await readFile(filename, "utf8")) as { roots?: Record<string, unknown> }
    const items: BrowserBookmark[] = []
    const visit = (node: unknown, folder?: string) => {
      if (!node || typeof node !== "object" || items.length >= 200) return
      const value = node as { type?: string; name?: string; url?: string; children?: unknown[] }
      if (value.type === "url" && safeUrl(value.url)) {
        items.push({
          id: randomUUID(),
          title: (value.name || value.url!).slice(0, 240),
          url: safeUrl(value.url)!,
          folder: folder?.slice(0, 120),
        })
        return
      }
      const nextFolder = value.type === "folder" && value.name ? value.name : folder
      for (const child of value.children ?? []) visit(child, nextFolder)
    }
    for (const root of Object.values(raw.roots ?? {})) visit(root)
    return items
  } catch {
    return []
  }
}

const readChromeHistory = async (filename: string): Promise<BrowserHistoryItem[]> => {
  let database: DatabaseSync | undefined
  try {
    database = new DatabaseSync(filename, { readOnly: true })
    const rows = database.prepare(
      "SELECT id, url, title, last_visit_time FROM urls WHERE url LIKE 'http://%' OR url LIKE 'https://%' ORDER BY last_visit_time DESC LIMIT 200",
    ).all() as Array<{ id?: number; url?: string; title?: string; last_visit_time?: number | bigint }>
    const chromeEpoch = 11_644_473_600_000_000
    return rows.flatMap((row) => {
      const url = safeUrl(row.url)
      if (!url) return []
      const lastVisitTime = typeof row.last_visit_time === "bigint" ? Number(row.last_visit_time) : row.last_visit_time
      const lastVisitedAt = typeof lastVisitTime === "number" && lastVisitTime > chromeEpoch
        ? Math.round((lastVisitTime - chromeEpoch) / 10)
        : undefined
      return [{
        id: `history-${row.id ?? randomUUID()}`,
        title: (row.title || url).slice(0, 240),
        url,
        lastVisitedAt,
      }]
    })
  } catch {
    return []
  } finally {
    database?.close()
  }
}

const json = (res: ServerResponse, status: number, value: unknown) => {
  const body = JSON.stringify(value)
  res.statusCode = status
  res.setHeader("content-type", "application/json; charset=utf-8")
  res.setHeader("cache-control", "no-store")
  res.end(body)
}

const readBody = async (req: IncomingMessage) => {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>
}

const normalizeBounds = (value: unknown): BrowserBounds | undefined => {
  if (!value || typeof value !== "object") return undefined
  const input = value as Record<string, unknown>
  const values = [input.x, input.y, input.width, input.height]
  if (!values.every((item) => typeof item === "number" && Number.isFinite(item))) return undefined
  return {
    x: Math.max(0, Math.round(input.x as number)),
    y: Math.max(0, Math.round(input.y as number)),
    width: Math.max(1, Math.round(input.width as number)),
    height: Math.max(1, Math.round(input.height as number)),
  }
}

const statusLabel = (action: string, target?: string, text?: string) => {
  const name = target ? ` “${target}”` : ""
  switch (action) {
    case "open":
    case "navigate":
      return "Opening page…"
    case "newTab":
      return "Opening a new tab…"
    case "closeTab":
      return "Closing tab…"
    case "switchTab":
      return "Switching tabs…"
    case "back":
      return "Going back…"
    case "forward":
      return "Going forward…"
    case "reload":
      return "Reloading page…"
    case "click":
      return `Clicking${name}`
    case "type":
    case "fill":
      return target?.toLowerCase().includes("password") ? "Entering password…" : `Typing${name}`
    case "press":
      return `Pressing ${text || "key"}…`
    case "scroll":
    case "scrollTo":
      return target ? `Scrolling to “${target}”…` : "Scrolling…"
    case "hover":
      return `Looking at${name}`
    case "move":
      return "Moving cursor…"
    case "select":
      return `Selecting${name}`
    case "waitFor":
    case "waitForNavigation":
      return "Waiting for page…"
    case "read":
    case "getText":
      return "Reading page…"
    case "screenshot":
      return "Taking screenshot…"
    default:
      return "Working in browser…"
  }
}

export class BrowserManager {
  readonly computer = new ComputerManager((status) => {
    for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send("computer-event", status)
  })
  private readonly browsers = new Map<string, ManagedBrowser>()
  private readonly ownerToBrowser = new Map<string, string>()
  private readonly windows = new Set<BrowserWindow>()
  private readonly attachments = new Map<number, { owner: string; token: symbol }>()
  private readonly restoring = new Map<ManagedBrowser, Promise<void>>()
  private bridge?: ReturnType<typeof createServer>
  private bridgeToken = randomUUID()
  private bridgeUrl?: string
  private readonly chromeProfiles = new Map<string, ChromeProfilePath>()

  async start() {
    const saved = getStore(STORE_NAME).get(STORE_KEY) as StoredBrowser[] | undefined
    if (Array.isArray(saved)) {
      for (const entry of saved) {
        if (!entry?.ownerSessionId || !entry.browserSessionId) continue
        this.ownerToBrowser.set(entry.ownerSessionId, entry.browserSessionId)
        this.browsers.set(entry.browserSessionId, {
          snapshot: {
            browserSessionId: entry.browserSessionId,
            ownerSessionId: entry.ownerSessionId,
            status: "disconnected",
            controller: "none",
            tabs: entry.tabs ?? [],
            activeTabId: entry.activeTabId,
            currentUrl: entry.tabs?.find((tab) => tab.tabId === entry.activeTabId)?.url,
            profile: entry.profile,
            updatedAt: entry.updatedAt ?? Date.now(),
          },
          partition: electronSession.fromPartition(`persist:opencode-browser-${entry.browserSessionId}`),
          tabs: new Map(),
          attached: new Map(),
          restored: true,
        })
      }
    }

    this.bridge = createServer((req, res) => void this.handleRequest(req, res))
    await new Promise<void>((resolve, reject) => {
      const server = this.bridge!
      const onError = (error: Error) => {
        server.off("listening", onListening)
        reject(error)
      }
      const onListening = () => {
        server.off("error", onError)
        resolve()
      }
      server.once("error", onError)
      server.once("listening", onListening)
      server.listen(0, "127.0.0.1")
    })
    const address = this.bridge.address()
    if (!address || typeof address === "string") throw new Error("Browser bridge failed to bind")
    this.bridgeUrl = `http://127.0.0.1:${address.port}`
    process.env.OPENCODE_BROWSER_BRIDGE_URL = this.bridgeUrl
    process.env.OPENCODE_BROWSER_BRIDGE_TOKEN = this.bridgeToken
  }

  async stop() {
    this.computer.release()
    for (const browser of this.browsers.values()) this.destroyBrowser(browser)
    this.browsers.clear()
    this.ownerToBrowser.clear()
    if (this.bridge) await new Promise<void>((resolve) => this.bridge!.close(() => resolve()))
    this.bridge = undefined
  }

  getBridgeUrl() {
    return this.bridgeUrl
  }

  private save() {
    const entries: StoredBrowser[] = [...this.browsers.values()].map((browser) => ({
      browserSessionId: browser.snapshot.browserSessionId!,
      ownerSessionId: browser.snapshot.ownerSessionId,
      tabs: browser.snapshot.tabs,
      activeTabId: browser.snapshot.activeTabId,
      profile: browser.snapshot.profile,
      updatedAt: Date.now(),
    }))
    getStore(STORE_NAME).set(STORE_KEY, entries)
  }

  private emit(event: BrowserEvent) {
    for (const win of this.windows) {
      if (win.isDestroyed()) {
        this.windows.delete(win)
        continue
      }
      win.webContents.send("browser-event", event)
    }
  }

  private rememberWindow(win: BrowserWindow) {
    if (this.windows.has(win)) return
    this.windows.add(win)
    win.once("closed", () => {
      this.detach(win)
      this.windows.delete(win)
    })
  }

  private getByOwner(ownerSessionId: string, create: boolean) {
    const browserSessionId = this.ownerToBrowser.get(ownerSessionId)
    if (browserSessionId) return this.browsers.get(browserSessionId)
    if (!create) return undefined
    const id = randomUUID()
    const browser: ManagedBrowser = {
      snapshot: {
        browserSessionId: id,
        ownerSessionId,
        status: "ready",
        controller: "none",
        tabs: [],
        updatedAt: Date.now(),
      },
      partition: electronSession.fromPartition(`persist:opencode-browser-${id}`),
      tabs: new Map(),
      attached: new Map(),
      restored: false,
    }
    this.ownerToBrowser.set(ownerSessionId, id)
    this.browsers.set(id, browser)
    this.save()
    return browser
  }

  snapshot(ownerSessionId: string): BrowserSessionSnapshot {
    return this.getByOwner(ownerSessionId, false)?.snapshot ?? {
      ownerSessionId,
      status: "not_created",
      controller: "none",
      tabs: [],
      updatedAt: Date.now(),
    }
  }

  /**
   * Find local Chrome profiles without returning their filesystem paths to the
   * renderer. The path stays in the main process until an explicit import.
   */
  async listChromeProfiles(): Promise<BrowserProfileCandidate[]> {
    this.chromeProfiles.clear()
    const roots = [
      process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Google", "Chrome", "User Data") : undefined,
      join(app.getPath("home"), "AppData", "Local", "Google", "Chrome", "User Data"),
    ].filter((value): value is string => Boolean(value))
    const result: BrowserProfileCandidate[] = []
    for (const root of [...new Set(roots)]) {
      const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        if (!entry.isDirectory() || (entry.name !== "Default" && !entry.name.startsWith("Profile "))) continue
        const path = join(root, entry.name)
        const [bookmarks, history] = await Promise.all([
          stat(join(path, "Bookmarks")).then(() => true).catch(() => false),
          stat(join(path, "History")).then(() => true).catch(() => false),
        ])
        if (!bookmarks && !history) continue
        const candidate = {
          id: randomUUID(),
          name: entry.name === "Default" ? "Chrome · Default" : `Chrome · ${entry.name.replace(/^Profile /, "Profile ")}`,
          browser: "chrome" as const,
          hasBookmarks: bookmarks,
          hasHistory: history,
          path,
        }
        this.chromeProfiles.set(candidate.id, candidate)
        result.push({
          id: candidate.id,
          name: candidate.name,
          browser: candidate.browser,
          hasBookmarks: candidate.hasBookmarks,
          hasHistory: candidate.hasHistory,
        })
      }
    }
    return result
  }

  /**
   * Import only safe, non-secret Chrome data into an app-owned directory.
   * Cookies, Login Data/passwords, Web Data, tokens, and session databases are
   * deliberately excluded; they must never be copied into app storage.
   */
  async importChromeProfile(ownerSessionId: string, candidateID: string) {
    const candidate = this.chromeProfiles.get(candidateID)
    if (!candidate) throw new Error("Chrome profile is no longer available; refresh the profile list")
    const browser = this.getByOwner(ownerSessionId, true)!
    const destination = join(app.getPath("userData"), "browser-profile-imports", browser.snapshot.browserSessionId!, candidate.id)
    await mkdir(destination, { recursive: true })
    const bookmarks = await copySafeProfileFile(candidate.path, destination, "Bookmarks")
    const history = await copySafeProfileFile(candidate.path, destination, "History")
    if (history) {
      await copyOptionalProfileFile(candidate.path, destination, "History-wal")
      await copyOptionalProfileFile(candidate.path, destination, "History-shm")
    }
    const bookmarkItems = bookmarks ? await readChromeBookmarks(join(destination, "Bookmarks")) : []
    const historyItems = history ? await readChromeHistory(join(destination, "History")) : []
    browser.snapshot.profile = {
      name: candidate.name,
      browser: "chrome",
      importedAt: Date.now(),
      bookmarks,
      history,
      bookmarkItems,
      historyItems,
      passwords: false,
      cookies: false,
    }
    this.save()
    this.syncSnapshot(browser)
    return browser.snapshot
  }

  async attach(win: BrowserWindow, ownerSessionId: string, bounds: BrowserBounds) {
    const browser = this.getByOwner(ownerSessionId, true)!
    this.rememberWindow(win)
    this.detach(win)
    const token = Symbol(ownerSessionId)
    this.attachments.set(win.id, { owner: ownerSessionId, token })
    await this.restoreTabs(browser)
    // A slow restore must never attach over a newer task or a closed panel.
    if (win.isDestroyed() || this.attachments.get(win.id)?.token !== token) return browser.snapshot
    browser.attached.set(win.id, { window: win, bounds })
    await this.updateAttachedViews(browser)
    this.syncSnapshot(browser)
    return browser.snapshot
  }

  resize(win: BrowserWindow, ownerSessionId: string, bounds: BrowserBounds) {
    const browser = this.getByOwner(ownerSessionId, false)
    const attachment = browser?.attached.get(win.id)
    if (!browser || !attachment || this.attachments.get(win.id)?.owner !== ownerSessionId) return
    attachment.bounds = bounds
    this.activeTab(browser)?.view.setBounds(bounds)
  }

  detach(win: BrowserWindow, ownerSessionId?: string) {
    if (!ownerSessionId || this.attachments.get(win.id)?.owner === ownerSessionId) this.attachments.delete(win.id)
    for (const browser of this.browsers.values()) {
      if (ownerSessionId && browser.snapshot.ownerSessionId !== ownerSessionId) continue
      if (!browser.attached.has(win.id)) continue
      for (const tab of browser.tabs.values()) {
        tab.view.setVisible(false)
        if (!win.isDestroyed()) win.contentView.removeChildView(tab.view)
      }
      browser.attached.delete(win.id)
    }
  }

  async userAction(input: BrowserActionRequest) {
    const browser = this.getByOwner(input.sessionID, false)
    if (browser?.snapshot.controller === "agent") this.setController(input.sessionID, "user")
    return this.performAction(input, "user")
  }

  async agentAction(input: BrowserActionRequest) {
    return this.performAction(input, "agent")
  }

  setController(ownerSessionId: string, controller: BrowserController) {
    const browser = this.getByOwner(ownerSessionId, true)!
    if (controller === "user") {
      browser.action = undefined
      for (const tab of browser.tabs.values()) if (tab.loading) tab.view.webContents.stop()
    }
    if (controller === "agent" && browser.action?.status === "started") {
      throw new Error("Browser is already performing an action")
    }
    browser.snapshot.controller = controller
    browser.snapshot.status = controller === "user" ? "user_controlled" : controller === "agent" ? "agent_controlled" : "ready"
    this.syncSnapshot(browser)
    this.emit({
      type: "browser.control.changed",
      sessionId: ownerSessionId,
      browserSessionId: browser.snapshot.browserSessionId!,
      controller,
    })
    return browser.snapshot
  }

  async delete(ownerSessionId: string) {
    this.computer.release(ownerSessionId)
    const browser = this.getByOwner(ownerSessionId, false)
    if (!browser) return
    this.destroyBrowser(browser)
    this.browsers.delete(browser.snapshot.browserSessionId!)
    this.ownerToBrowser.delete(ownerSessionId)
    this.save()
  }

  private destroyBrowser(browser: ManagedBrowser) {
    for (const win of BrowserWindow.getAllWindows()) this.detach(win, browser.snapshot.ownerSessionId)
    for (const tab of browser.tabs.values()) {
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close()
    }
    browser.tabs.clear()
    browser.snapshot.status = "closed"
  }

  private activeTab(browser: ManagedBrowser) {
    const id = browser.snapshot.activeTabId
    return id ? browser.tabs.get(id) : undefined
  }

  private async restoreTabs(browser: ManagedBrowser) {
    const pending = this.restoring.get(browser)
    if (pending) return pending
    if (!browser.restored) return
    const saved = [...browser.snapshot.tabs]
    const selected = browser.snapshot.activeTabId
    browser.restored = false
    const restore = (async () => {
      for (const entry of saved.slice(0, MAX_TABS)) {
        const tab = await this.createTab(browser, undefined, entry.tabId, false)
        if (safeUrl(entry.url)) void this.navigateTab(browser, tab, entry.url).catch(() => {})
      }
      browser.snapshot.activeTabId = browser.tabs.has(selected ?? "") ? selected : browser.tabs.keys().next().value
      this.syncSnapshot(browser)
    })()
    this.restoring.set(browser, restore)
    try {
      await restore
    } finally {
      this.restoring.delete(browser)
    }
  }

  private async createTab(browser: ManagedBrowser, url?: string, requestedId?: string, announce = true) {
    if (browser.tabs.size >= MAX_TABS) throw new Error(`Browser supports at most ${MAX_TABS} tabs`)
    const tabId = requestedId ?? randomUUID()
    const view = new WebContentsView({
      webPreferences: {
        session: browser.partition,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    })
    const tab: ManagedTab = {
      tabId,
      title: "New tab",
      url: "",
      loading: false,
      canGoBack: false,
      canGoForward: false,
      view,
    }
    view.setVisible(false)
    browser.tabs.set(tabId, tab)
    if (!browser.snapshot.activeTabId) browser.snapshot.activeTabId = tabId
    this.wireTab(browser, tab)
    if (url) await this.navigateTab(browser, tab, url)
    this.syncSnapshot(browser)
    if (announce) {
      this.emit({
        type: "browser.tab.created",
        sessionId: browser.snapshot.ownerSessionId,
        browserSessionId: browser.snapshot.browserSessionId!,
        tab: this.tabSnapshot(tab),
      })
    }
    return tab
  }

  private wireTab(browser: ManagedBrowser, tab: ManagedTab) {
    const webContents = tab.view.webContents
    webContents.setWindowOpenHandler(({ url }) => {
      const target = safeUrl(url)
      if (target) void this.performAction({ sessionID: browser.snapshot.ownerSessionId, action: "newTab", url: target },
        browser.snapshot.controller === "agent" ? "agent" : "user")
        .catch((error) => this.emitError(browser, String(error)))
      return { action: "deny" }
    })
    webContents.on("will-navigate", (event, url) => {
      if (!safeUrl(url)) event.preventDefault()
    })
    webContents.on("will-redirect", (event, url) => {
      if (!safeUrl(url)) event.preventDefault()
    })
    webContents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown") return
      const key = input.key.toLowerCase()
      if (!(input.control || input.meta) || !["l", "t", "w", "r"].includes(key)) return
      event.preventDefault()
      for (const attachment of browser.attached.values()) attachment.window.webContents.focus()
      this.emit({ type: "browser.shortcut", sessionId: browser.snapshot.ownerSessionId, key })
    })
    webContents.on("page-favicon-updated", (_event, favicons) => {
      tab.favicon = favicons.find((value) => safeUrl(value))
      this.syncSnapshot(browser)
    })
    webContents.on("did-start-loading", () => {
      tab.loading = true
      tab.error = undefined
      this.syncSnapshot(browser)
      void this.updateAttachedViews(browser)
      browser.snapshot.status = "navigating"
      this.syncSnapshot(browser)
      this.emit({
        type: "browser.navigation.started",
        sessionId: browser.snapshot.ownerSessionId,
        browserSessionId: browser.snapshot.browserSessionId!,
        tabId: tab.tabId,
        url: tab.url,
      })
    })
    webContents.on("did-stop-loading", () => {
      tab.loading = false
      browser.snapshot.status = browser.snapshot.controller === "user" ? "user_controlled" : "ready"
      this.syncSnapshot(browser)
    })
    webContents.on("did-navigate", (_event, url) => {
      tab.url = url
      tab.error = undefined
      tab.canGoBack = webContents.navigationHistory.canGoBack()
      tab.canGoForward = webContents.navigationHistory.canGoForward()
      this.syncSnapshot(browser)
      this.emit({
        type: "browser.navigation.completed",
        sessionId: browser.snapshot.ownerSessionId,
        browserSessionId: browser.snapshot.browserSessionId!,
        tabId: tab.tabId,
        url,
        title: tab.title,
      })
    })
    webContents.on("did-navigate-in-page", (_event, url) => {
      tab.url = url
      tab.canGoBack = webContents.navigationHistory.canGoBack()
      tab.canGoForward = webContents.navigationHistory.canGoForward()
      this.syncSnapshot(browser)
    })
    webContents.on("page-title-updated", (_event, title) => {
      tab.title = title || tab.url || "New tab"
      this.syncSnapshot(browser)
    })
    webContents.on("console-message", (event) => {
      if (event.level !== "error" && event.level !== "warning") return
      this.emit({
        type: "browser.console.error",
        sessionId: browser.snapshot.ownerSessionId,
        browserSessionId: browser.snapshot.browserSessionId!,
        tabId: tab.tabId,
        message: event.message.slice(0, 4000),
      })
    })
    webContents.on("render-process-gone", (_event, details) => {
      browser.snapshot.status = "disconnected"
      tab.error = `Browser page crashed: ${details.reason}`
      browser.snapshot.error = tab.error
      this.syncSnapshot(browser)
      this.emitError(browser, browser.snapshot.error, tab.tabId)
    })
    webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return
      tab.loading = false
      tab.error = `${errorDescription} (${errorCode})`
      if (validatedURL) tab.url = validatedURL
      this.syncSnapshot(browser)
      void this.updateAttachedViews(browser)
      this.emitError(browser, tab.error, tab.tabId)
    })
  }

  private tabSnapshot(tab: ManagedTab): BrowserTabSnapshot {
    const { view, ...snapshot } = tab
    return snapshot
  }

  private syncSnapshot(browser: ManagedBrowser) {
    const tab = this.activeTab(browser)
    browser.snapshot.tabs = [...browser.tabs.values()].map((item) => this.tabSnapshot(item))
    browser.snapshot.currentUrl = tab?.url || undefined
    browser.snapshot.currentAction = browser.action
    browser.snapshot.error = tab?.error
    browser.snapshot.status = tab?.error ? "error" : tab?.loading ? "navigating" :
      browser.action?.status === "started" ? "interacting" :
      browser.snapshot.controller === "user" ? "user_controlled" :
      browser.snapshot.controller === "agent" ? "agent_controlled" : "ready"
    browser.snapshot.updatedAt = Math.max(Date.now(), browser.snapshot.updatedAt + 1)
    this.save()
    this.emit({ type: "browser.snapshot", sessionId: browser.snapshot.ownerSessionId, snapshot: browser.snapshot })
  }

  private emitError(browser: ManagedBrowser, message: string, tabId?: string) {
    this.emit({
      type: "browser.error",
      sessionId: browser.snapshot.ownerSessionId,
      browserSessionId: browser.snapshot.browserSessionId!,
      tabId,
      message,
    })
  }

  private async navigateTab(browser: ManagedBrowser, tab: ManagedTab, value: string) {
    const url = safeUrl(value)
    if (!url) throw new Error("Only http:// and https:// URLs are allowed")
    tab.url = url
    tab.error = undefined
    browser.snapshot.status = "navigating"
    this.syncSnapshot(browser)
    await this.updateAttachedViews(browser)
    await tab.view.webContents.loadURL(url)
    tab.error = undefined
    tab.loading = tab.view.webContents.isLoading()
    this.syncSnapshot(browser)
    await this.updateAttachedViews(browser)
    return this.snapshot(browser.snapshot.ownerSessionId)
  }

  private async performAction(input: BrowserActionRequest, source: "agent" | "user") {
    const browser = this.getByOwner(input.sessionID, true)!
    if (source === "agent" && browser.snapshot.controller === "user") {
      throw new Error("Browser is under user control. Wait until the user gives control back.")
    }
    if (source === "user" && browser.snapshot.controller === "agent") {
      throw new Error("Take control of the browser before interacting with it.")
    }
    if (source === "agent" && browser.snapshot.controller === "none") {
      browser.snapshot.controller = "agent"
      browser.snapshot.status = "agent_controlled"
      this.emit({
        type: "browser.control.changed",
        sessionId: input.sessionID,
        browserSessionId: browser.snapshot.browserSessionId!,
        controller: "agent",
      })
    }
    await this.restoreTabs(browser)
    if (input.action === "getTabs") return this.snapshot(input.sessionID)
    if (input.action === "stop") {
      const active = this.activeTab(browser)
      if (active) {
        active.view.webContents.stop()
        active.loading = false
      }
      if (active?.tabId === browser.actionTabId) browser.action = undefined
      this.syncSnapshot(browser)
      return browser.snapshot
    }
    if (input.action === "newTab") {
      if (input.url && !safeUrl(input.url)) throw new Error("A valid http(s) URL is required")
      const created = await this.createTab(browser)
      browser.snapshot.activeTabId = created.tabId
      this.syncSnapshot(browser)
      await this.updateAttachedViews(browser)
      if (input.url) await this.navigateTab(browser, created, input.url)
      return browser.snapshot
    }
    const tab = await this.resolveTab(browser, input.tabId)
    await this.updateAttachedViews(browser)
    if (["open", "navigate"].includes(input.action)) {
      const url = safeUrl(input.url)
      if (!url) throw new Error("A valid http(s) URL is required")
      return this.runAction(browser, tab, input, `Opening ${url}`, () => this.navigateTab(browser, tab, url))
    }
    if (input.action === "closeTab") {
      const close = async () => {
        if (tab.tabId === browser.actionTabId) browser.action = undefined
        await this.closeTab(browser, tab.tabId)
        return this.snapshot(browser.snapshot.ownerSessionId)
      }
      return source === "user" ? close() : this.runAction(browser, tab, input, "Closing tab…", close)
    }
    if (input.action === "switchTab") {
      const target = browser.tabs.get(input.tabId ?? "")
      if (!target) throw new Error("Tab not found")
      const select = async () => {
        browser.snapshot.activeTabId = target.tabId
        await this.updateAttachedViews(browser)
        this.syncSnapshot(browser)
        this.emit({
          type: "browser.tab.selected",
          sessionId: input.sessionID,
          browserSessionId: browser.snapshot.browserSessionId!,
          tabId: target.tabId,
        })
        return this.snapshot(input.sessionID)
      }
      return source === "user" ? select() : this.runAction(browser, target, input, "Switching tabs…", select)
    }
    return this.runAction(browser, tab, input, statusLabel(input.action, input.target, input.key), async () => {
      switch (input.action) {
        case "back":
          if (tab.view.webContents.navigationHistory.canGoBack()) tab.view.webContents.navigationHistory.goBack()
          break
        case "forward":
          if (tab.view.webContents.navigationHistory.canGoForward()) tab.view.webContents.navigationHistory.goForward()
          break
        case "reload":
          await tab.view.webContents.reload()
          break
        case "click":
          await this.click(browser, tab, input.target)
          break
        case "type":
        case "fill":
          await this.type(browser, tab, input.target, input.text ?? "", input.action === "fill")
          break
        case "press":
          await this.press(browser, tab, input.target, input.key ?? "Enter")
          break
        case "scroll":
          await this.scroll(tab, input.direction ?? "down", input.amount ?? 560)
          break
        case "scrollTo":
          await this.scrollTo(browser, tab, input.target)
          break
        case "hover":
          await this.hover(browser, tab, input.target)
          break
        case "move":
          await this.moveCursor(tab, input.x, input.y)
          break
        case "select":
          await this.select(browser, tab, input.target, input.option)
          break
        case "check":
        case "uncheck":
          await this.check(browser, tab, input.target, input.action === "check")
          break
        case "waitFor":
          await this.waitFor(browser, tab, input.target, input.timeoutMs)
          break
        case "waitForNavigation":
          await this.waitForNavigation(tab, input.timeoutMs)
          break
        case "read":
          return this.readPage(tab)
        case "getText":
          return this.getText(browser, tab, input.target)
        case "screenshot":
          return this.screenshot(browser, tab)
        case "getTabs":
          return this.snapshot(input.sessionID)
        case "currentUrl":
          return tab.url
        default:
          throw new Error(`Unknown browser action: ${input.action}`)
      }
      return this.snapshot(input.sessionID)
    })
  }

  private async runAction(browser: ManagedBrowser, tab: ManagedTab, input: BrowserActionRequest, label: string, work: () => Promise<unknown>) {
    if (browser.action?.status === "started") throw new Error("A browser action is already in progress")
    const action: BrowserActionSnapshot = {
      actionId: randomUUID(),
      type: input.action,
      status: "started",
      label,
      target: input.target,
      startedAt: Date.now(),
    }
    browser.action = action
    browser.actionTabId = tab.tabId
    browser.snapshot.status = ["open", "navigate", "back", "forward", "reload"].includes(input.action)
      ? "navigating"
      : input.action.startsWith("wait")
        ? "waiting"
        : "interacting"
    this.syncSnapshot(browser)
    this.emit({
      type: "browser.action.started",
      sessionId: input.sessionID,
      browserSessionId: browser.snapshot.browserSessionId!,
      tabId: tab.tabId,
      action,
    })
    try {
      const result = await work()
      action.status = "completed"
      action.completedAt = Date.now()
      if (browser.action !== action) return result
      browser.action = undefined
      browser.snapshot.status = browser.snapshot.controller === "user" ? "user_controlled" : browser.snapshot.controller === "agent" ? "agent_controlled" : "ready"
      this.syncSnapshot(browser)
      this.emit({
        type: "browser.action.completed",
        sessionId: input.sessionID,
        browserSessionId: browser.snapshot.browserSessionId!,
        tabId: tab.tabId,
        action,
      })
      return result
    } catch (error) {
      action.status = "failed"
      action.completedAt = Date.now()
      action.error = error instanceof Error ? error.message : String(error)
      if (browser.action !== action) return this.snapshot(input.sessionID)
      browser.action = undefined
      browser.snapshot.status = "error"
      browser.snapshot.error = action.error
      this.syncSnapshot(browser)
      this.emit({
        type: "browser.action.failed",
        sessionId: input.sessionID,
        browserSessionId: browser.snapshot.browserSessionId!,
        tabId: tab.tabId,
        action,
      })
      throw error
    }
  }

  private async resolveTab(browser: ManagedBrowser, tabId?: string) {
    const tab = tabId ? browser.tabs.get(tabId) : this.activeTab(browser)
    if (tab) return tab
    if (tabId) throw new Error("Tab not found")
    return this.createTab(browser, undefined, undefined, true)
  }

  private async closeTab(browser: ManagedBrowser, tabId: string) {
    const tab = browser.tabs.get(tabId)
    if (!tab) return
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        win.contentView.removeChildView(tab.view)
      } catch {}
    }
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close()
    browser.tabs.delete(tabId)
    if (browser.snapshot.activeTabId === tabId) browser.snapshot.activeTabId = browser.tabs.keys().next().value
    await this.updateAttachedViews(browser)
    this.syncSnapshot(browser)
    this.emit({
      type: "browser.tab.closed",
      sessionId: browser.snapshot.ownerSessionId,
      browserSessionId: browser.snapshot.browserSessionId!,
      tabId,
    })
  }

  private async updateAttachedViews(browser: ManagedBrowser) {
    const active = this.activeTab(browser)
    for (const attachment of browser.attached.values()) {
      const win = attachment.window
      if (win.isDestroyed()) continue
      for (const tab of browser.tabs.values()) {
        if (tab === active && tab.url && !tab.error) continue
        tab.view.setVisible(false)
        win.contentView.removeChildView(tab.view)
      }
      // Blank and failed pages use the renderer's new-tab/error surface.
      if (!active?.url || active.error) continue
      win.contentView.addChildView(active.view)
      active.view.setBounds(attachment.bounds)
      active.view.setVisible(true)
    }
  }

  private async highlight(tab: ManagedTab, target?: string) {
    if (!target) return undefined
    return this.page(tab, "highlight", target)
  }

  private page(tab: ManagedTab, action: string, target?: string, value?: string | boolean) {
    return tab.view.webContents.executeJavaScript(
      `(${browserPage.toString()})(${JSON.stringify(action)}, ${JSON.stringify(target)}, ${JSON.stringify(value)})`, true,
    )
  }

  private async click(browser: ManagedBrowser, tab: ManagedTab, target?: string) {
    const action = browser.action
    const resolved = await this.highlight(tab, target)
    this.assertAction(browser, action)
    if (!resolved?.found) throw new Error(`Element not found: ${target ?? "target"}`)
    const x = Math.round(resolved.rect.x + resolved.rect.width / 2)
    const y = Math.round(resolved.rect.y + resolved.rect.height / 2)
    tab.view.webContents.focus()
    tab.view.webContents.sendInputEvent({ type: "mouseMove", x, y })
    await delay(70)
    this.assertAction(browser, action)
    tab.view.webContents.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 })
    tab.view.webContents.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 })
    await delay(120)
  }

  private async type(browser: ManagedBrowser, tab: ManagedTab, target: string | undefined, text: string, clear: boolean) {
    const action = browser.action
    const resolved = await this.highlight(tab, target)
    this.assertAction(browser, action)
    if (!resolved?.found) throw new Error(`Input not found: ${target ?? "target"}`)
    const focused = await this.page(tab, "focus", target, clear)
    this.assertAction(browser, action)
    if (!focused?.found) throw new Error(`Input not found: ${target}`)
    await tab.view.webContents.insertText(text)
    await delay(80)
  }

  private async press(browser: ManagedBrowser, tab: ManagedTab, target: string | undefined, key: string) {
    const action = browser.action
    if (target) await this.highlight(tab, target)
    this.assertAction(browser, action)
    if (target) await this.page(tab, "focus", target, false)
    this.assertAction(browser, action)
    tab.view.webContents.sendInputEvent({ type: "keyDown", keyCode: key })
    tab.view.webContents.sendInputEvent({ type: "keyUp", keyCode: key })
    await delay(120)
  }

  private async hover(browser: ManagedBrowser, tab: ManagedTab, target?: string) {
    const action = browser.action
    const resolved = await this.highlight(tab, target)
    this.assertAction(browser, action)
    if (!resolved?.found) throw new Error(`Element not found: ${target ?? "target"}`)
    tab.view.webContents.focus()
    tab.view.webContents.sendInputEvent({
      type: "mouseMove",
      x: Math.round(resolved.rect.x + resolved.rect.width / 2),
      y: Math.round(resolved.rect.y + resolved.rect.height / 2),
    })
    await delay(120)
  }

  private async moveCursor(tab: ManagedTab, x?: number, y?: number) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("Cursor move requires finite x and y coordinates")
    const bounds = tab.view.getBounds()
    const width = bounds.width
    const height = bounds.height
    const nextX = Math.min(Math.max(Math.round(x!), 0), Math.max(width - 1, 0))
    const nextY = Math.min(Math.max(Math.round(y!), 0), Math.max(height - 1, 0))
    tab.view.webContents.focus()
    tab.view.webContents.sendInputEvent({ type: "mouseMove", x: nextX, y: nextY })
    await delay(80)
  }

  private async scroll(tab: ManagedTab, direction: string, amount: number) {
    const delta = ["up", "left"].includes(direction) ? -Math.abs(amount) : Math.abs(amount)
    const x = direction === "left" || direction === "right" ? delta : 0
    const y = direction === "up" || direction === "down" ? delta : 0
    await tab.view.webContents.executeJavaScript(`window.scrollBy({ left: ${x}, top: ${y}, behavior: "smooth" })`, true)
    await delay(180)
  }

  private async scrollTo(browser: ManagedBrowser, tab: ManagedTab, target?: string) {
    const resolved = await this.highlight(tab, target)
    if (!resolved?.found) throw new Error(`Element not found: ${target ?? "target"}`)
    await this.page(tab, "scroll", target)
    await delay(180)
  }

  private async select(browser: ManagedBrowser, tab: ManagedTab, target?: string, option?: string) {
    const action = browser.action
    const resolved = await this.highlight(tab, target)
    this.assertAction(browser, action)
    if (!resolved?.found) throw new Error(`Select not found: ${target ?? "target"}`)
    const selected = await this.page(tab, "select", target, option ?? "")
    if (!selected?.found) throw new Error(`Option not found: ${option}`)
  }

  private async check(browser: ManagedBrowser, tab: ManagedTab, target?: string, checked = true) {
    const action = browser.action
    const resolved = await this.highlight(tab, target)
    this.assertAction(browser, action)
    if (!resolved?.found) throw new Error(`Checkbox not found: ${target ?? "target"}`)
    const changed = await this.page(tab, "check", target, checked)
    if (!changed?.found) throw new Error(`Checkbox not found: ${target}`)
  }

  private async waitFor(browser: ManagedBrowser, tab: ManagedTab, target?: string, timeoutMs = 15000) {
    const action = browser.action
    const timeout = Math.min(Math.max(timeoutMs, 250), 30_000)
    const end = Date.now() + timeout
    while (Date.now() < end) {
      this.assertAction(browser, action)
      const result = target
        ? await this.page(tab, "find", target)
        : await tab.view.webContents.executeJavaScript("Boolean(document.body)", true)
      if (target ? result?.found : result) return
      await delay(180)
    }
    throw new Error(`Timed out waiting for ${target ? `“${target}”` : "the page"}`)
  }

  private async waitForNavigation(tab: ManagedTab, timeoutMs = 15000) {
    if (!tab.loading) return
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        tab.view.webContents.off("did-stop-loading", done)
        reject(new Error("Timed out waiting for navigation"))
      }, Math.min(Math.max(timeoutMs, 250), 30_000))
      const done = () => {
        clearTimeout(timeout)
        resolve()
      }
      tab.view.webContents.once("did-stop-loading", done)
    })
  }

  private async readPage(tab: ManagedTab) {
    const result = await this.page(tab, "read")
    return JSON.stringify(result).slice(0, MAX_OUTPUT)
  }

  private async getText(browser: ManagedBrowser, tab: ManagedTab, target?: string) {
    if (!target) return this.readPage(tab)
    const result = await this.page(tab, "text", target)
    if (!result?.found) throw new Error(`Element not found: ${target}`)
    return String(result.text ?? "").slice(0, MAX_OUTPUT)
  }

  private async screenshot(browser: ManagedBrowser, tab: ManagedTab) {
    const image = await tab.view.webContents.capturePage()
    const size = image.getSize()
    const scaled = size.width > 1280 ? image.resize({ width: 1280 }) : image
    return { id: randomUUID(), data: scaled.toJPEG(70).toString("base64"), mime: "image/jpeg", ...scaled.getSize(),
      viewport: { width: size.width, height: size.height } }
  }

  private assertAction(browser: ManagedBrowser, action?: BrowserActionSnapshot) {
    if (browser.action !== action) throw Error("Browser action interrupted by user takeover")
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse) {
    if (req.headers[BRIDGE_TOKEN_HEADER] !== this.bridgeToken) return json(res, 401, { error: "Unauthorized" })
    if (req.method === "OPTIONS") {
      res.statusCode = 204
      res.end()
      return
    }
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1")
      const body = req.method === "POST" ? await readBody(req) : {}
      const sessionID = String(body.sessionID ?? url.searchParams.get("sessionId") ?? "")
      if (!sessionID) return json(res, 400, { error: "sessionID is required" })
      if (url.pathname === "/computer/status" && req.method === "GET") return json(res, 200, this.computer.status())
      if (url.pathname === "/computer/action" && req.method === "POST") {
        res.once("close", () => {
          if (!res.writableEnded) this.computer.cancel(sessionID, typeof body.runID === "string" ? body.runID : undefined)
        })
        const result = await this.computer.action({ ...(body as unknown as ComputerAction), sessionID })
        return json(res, 200, { result })
      }
      if (url.pathname === "/snapshot" && req.method === "GET") return json(res, 200, this.snapshot(sessionID))
      if (url.pathname === "/control" && req.method === "POST") {
        return json(res, 200, this.setController(sessionID, body.controller as BrowserController))
      }
      if (url.pathname === "/action" && req.method === "POST") {
        const result = await this.agentAction({ ...(body as unknown as BrowserActionRequest), sessionID })
        return json(res, 200, { result, snapshot: this.snapshot(sessionID) })
      }
      if (url.pathname === "/delete" && req.method === "POST") {
        await this.delete(sessionID)
        return json(res, 200, { ok: true })
      }
      return json(res, 404, { error: "Not found" })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return json(res, 409, { error: message })
    }
  }
}
// Serialized into the page: all helpers must live inside this closure.
function browserPage(action: string, target = "", value: string | boolean = "") {
  const clean = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase()
  const visible = (el: Element) => {
    const rect = el.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== "hidden"
  }
  const find = () => {
    const wanted = clean(target.replace(/^(text|label|placeholder|css)=/i, ""))
    if (/^css=/i.test(target) || /^[#.[]/.test(target)) {
      try { return document.querySelector(target.replace(/^css=/i, "")) } catch { return null }
    }
    if (/^label=/i.test(target)) {
      const label = [...document.querySelectorAll("label")].find((el) => clean(el.textContent ?? "").includes(wanted))
      return label?.control ?? null
    }
    if (/^placeholder=/i.test(target))
      return [...document.querySelectorAll("input,textarea")].find((el) => visible(el) && clean(el.getAttribute("placeholder") ?? "").includes(wanted))
    const role = target.match(/^role=([^\s]+)\s+name=(.*)$/i)
    const selectors: Record<string, string> = { button: "button,[role=button]", link: "a,[role=link]", textbox: "input,textarea,[role=textbox]", checkbox: "input[type=checkbox],[role=checkbox]" }
    const candidates = document.querySelectorAll(role ? selectors[role[1]] ?? "[role]" : "button,a,input,textarea,select,[role=button],[tabindex],[contenteditable=true],h1,h2,h3,p")
    const name = role ? clean(role[2].replace(/^['"]|['"]$/g, "")) : wanted
    return [...candidates].find((el) => visible(el) && clean(el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.textContent || "").includes(name))
  }
  if (action === "read") {
    const interactives = [...document.querySelectorAll("button,a,input,textarea,select,[role=button]")]
      .filter(visible).slice(0, 120).map((el) => ({
        role: el.getAttribute("role") || el.tagName.toLowerCase(),
        name: clean(el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.textContent || "").slice(0, 160),
        type: el.getAttribute("type") || undefined,
        disabled: (el as HTMLButtonElement).disabled || undefined,
      }))
    return { title: document.title, url: location.href, text: (document.body?.innerText || "").slice(0, 24_000), interactives }
  }
  const el = find() as HTMLElement | undefined
  if (!el || !visible(el)) return { found: false }
  if (action === "focus") {
    el.focus()
    if (value && "value" in el) {
      (el as HTMLInputElement).value = ""
      el.dispatchEvent(new Event("input", { bubbles: true }))
    }
  }
  if (action === "select") {
    if (!(el instanceof HTMLSelectElement)) return { found: false }
    const option = [...el.options].find((item) => clean(item.text) === clean(String(value)) || item.value === value)
    if (!option) return { found: false }
    el.value = option.value
    el.dispatchEvent(new Event("input", { bubbles: true }))
    el.dispatchEvent(new Event("change", { bubbles: true }))
  }
  if (action === "check") {
    if (!(el instanceof HTMLInputElement) || !["checkbox", "radio"].includes(el.type)) return { found: false }
    if (el.checked !== value) el.click()
  }
  if (action === "highlight" || action === "scroll") el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" as ScrollBehavior })
  const rect = el.getBoundingClientRect()
  if (action === "highlight") {
    const overlay = document.createElement("div")
    overlay.dataset.opencodeBrowserOverlay = "true"
    overlay.style.cssText = `position:fixed;left:${rect.left - 3}px;top:${rect.top - 3}px;width:${rect.width + 6}px;height:${rect.height + 6}px;border:2px solid #9a8cff;border-radius:6px;pointer-events:none;z-index:2147483647;`
    document.querySelectorAll("[data-opencode-browser-overlay]").forEach((item) => item.remove())
    document.documentElement.appendChild(overlay)
    window.setTimeout(() => overlay.remove(), 700)
  }
  return { found: true, rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height }, text: el.textContent?.trim() ?? "" }
}
