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

export type BrowserTab = {
  tabId: string
  title: string
  url: string
  favicon?: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  error?: string
}

export type BrowserAction = {
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

export type ImportedBrowserProfile = {
  name: string
  browser: "chrome"
  importedAt: number
  bookmarks: boolean
  history: boolean
  bookmarkItems?: BrowserBookmark[]
  historyItems?: BrowserHistoryItem[]
  passwords: false
  cookies: false
}

export type BrowserSnapshot = {
  browserSessionId?: string
  ownerSessionId: string
  status: BrowserStatus
  controller: BrowserController
  tabs: BrowserTab[]
  activeTabId?: string
  currentUrl?: string
  currentAction?: BrowserAction
  profile?: ImportedBrowserProfile
  error?: string
  updatedAt: number
}

export type BrowserEvent = {
  type: string
  key?: string
  sessionId: string
  browserSessionId?: string
  tabId?: string
  action?: BrowserAction
  snapshot?: BrowserSnapshot
  tab?: BrowserTab
  controller?: BrowserController
  status?: BrowserStatus
  message?: string
  url?: string
  title?: string
}

export type BrowserBounds = { x: number; y: number; width: number; height: number }

export type BrowserPlatform = {
  snapshot: (sessionID: string) => Promise<BrowserSnapshot>
  listChromeProfiles: () => Promise<BrowserProfileCandidate[]>
  importChromeProfile: (sessionID: string, profileID: string) => Promise<BrowserSnapshot>
  attach: (sessionID: string, bounds: BrowserBounds) => Promise<BrowserSnapshot>
  resize: (sessionID: string, bounds: BrowserBounds) => Promise<void>
  detach: (sessionID?: string) => Promise<void>
  action: (input: {
    sessionID: string
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
  }) => Promise<BrowserSnapshot>
  control: (sessionID: string, controller: BrowserController) => Promise<BrowserSnapshot>
  onEvent: (cb: (event: BrowserEvent) => void) => () => void
  openExternal?: (url: string) => void
}
