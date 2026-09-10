import { contextBridge, ipcRenderer, webUtils } from "electron"
import type { ElectronAPI, WslServersEvent } from "./types"
import type { MobileAccessState, SyncDevicesState } from "@opencode-ai/app"
import type { UpdaterState } from "@opencode-ai/app/updater"

const updaterCallbacks = new Set<(state: UpdaterState) => void>()
let updaterState: UpdaterState | undefined
let updaterSubscription: Promise<void> | undefined
let mobileAccessState: MobileAccessState = { status: "disabled" }
let syncDevicesState: SyncDevicesState = { status: "disabled", peers: [], projects: [] }
const updaterHandler = (_: unknown, state: UpdaterState) => {
  updaterState = state
  updaterCallbacks.forEach((callback) => callback(state))
}

const api: ElectronAPI = {
  computerUse: {
    state: () => ipcRenderer.invoke("computer-use-state"),
    start: (sessionID, serverUrl, directory) => ipcRenderer.invoke("computer-use-start", sessionID, serverUrl, directory),
    stop: (sessionID) => ipcRenderer.invoke("computer-use-stop", sessionID),
    setColor: (color) => ipcRenderer.invoke("computer-use-color", color),
    onState: (callback) => {
      const handler = (_event: unknown, state: Parameters<typeof callback>[0]) => callback(state)
      ipcRenderer.on("computer-use-state", handler)
      return () => ipcRenderer.removeListener("computer-use-state", handler)
    },
  },
  mobileAccess: {
    state: () => mobileAccessState,
    start: () => ipcRenderer.invoke("mobile-access-start"),
    stop: () => ipcRenderer.invoke("mobile-access-stop"),
    revoke: () => ipcRenderer.invoke("mobile-access-revoke"),
    newPairingCode: () => ipcRenderer.invoke("mobile-access-new-code"),
    rotate: () => ipcRenderer.invoke("mobile-access-rotate"),
    onState: (callback) => {
      const handler = (_event: unknown, state: Parameters<typeof callback>[0]) => {
        mobileAccessState = state
        callback(state)
      }
      ipcRenderer.on("mobile-access-state", handler)
      void ipcRenderer.invoke("mobile-access-subscribe")
      return () => {
        ipcRenderer.removeListener("mobile-access-state", handler)
        void ipcRenderer.invoke("mobile-access-unsubscribe")
      }
    },
  },
  syncDevices: {
    state: () => syncDevicesState,
    pair: (code, relayUrl) => ipcRenderer.invoke("sync-devices-pair", code, relayUrl),
    removePeer: (deviceId) => ipcRenderer.invoke("sync-devices-remove-peer", deviceId),
    syncNow: () => ipcRenderer.invoke("sync-devices-sync-now"),
    mapProject: (projectID, localWorktree) => ipcRenderer.invoke("sync-devices-map-project", projectID, localWorktree),
    onState: (callback) => {
      const handler = (_event: unknown, state: Parameters<typeof callback>[0]) => {
        syncDevicesState = state
        callback(state)
      }
      ipcRenderer.on("sync-devices-state", handler)
      void ipcRenderer.invoke("sync-devices-subscribe")
      return () => {
        ipcRenderer.removeListener("sync-devices-state", handler)
        void ipcRenderer.invoke("sync-devices-unsubscribe")
      }
    },
  },
  killSidecar: () => ipcRenderer.invoke("kill-sidecar"),
  installCli: () => ipcRenderer.invoke("install-cli"),
  awaitInitialization: () => ipcRenderer.invoke("await-initialization"),
  wslServers: {
    getState: () => ipcRenderer.invoke("wsl-servers-get-state"),
    subscribe: (cb) => {
      const handler = (_: unknown, event: WslServersEvent) => cb(event)
      ipcRenderer.on("wsl-servers-event", handler)
      void ipcRenderer.invoke("wsl-servers-subscribe")
      return () => {
        ipcRenderer.removeListener("wsl-servers-event", handler)
        void ipcRenderer.invoke("wsl-servers-unsubscribe")
      }
    },
    probeRuntime: () => ipcRenderer.invoke("wsl-servers-probe-runtime"),
    refreshDistros: () => ipcRenderer.invoke("wsl-servers-refresh-distros"),
    installWsl: () => ipcRenderer.invoke("wsl-servers-install-wsl"),
    installDistro: (name) => ipcRenderer.invoke("wsl-servers-install-distro", name),
    probeAddable: (distros) => ipcRenderer.invoke("wsl-servers-probe-addable", distros),
    installOpencode: (name) => ipcRenderer.invoke("wsl-servers-install-opencode", name),
    openTerminal: (name) => ipcRenderer.invoke("wsl-servers-open-terminal", name),
    addServer: (distro) => ipcRenderer.invoke("wsl-servers-add", distro),
    removeServer: (id) => ipcRenderer.invoke("wsl-servers-remove", id),
    startServer: (id) => ipcRenderer.invoke("wsl-servers-start", id),
  },
  updater: {
    subscribe: async (cb) => {
      updaterCallbacks.add(cb)
      if (updaterState) cb(updaterState)
      if (!updaterSubscription) {
        ipcRenderer.on("updater-state", updaterHandler)
        updaterSubscription = ipcRenderer.invoke("updater-subscribe")
      }
      await updaterSubscription
      return () => {
        updaterCallbacks.delete(cb)
        if (updaterCallbacks.size > 0) return
        ipcRenderer.removeListener("updater-state", updaterHandler)
        updaterSubscription = undefined
        void ipcRenderer.invoke("updater-unsubscribe")
      }
    },
    check: () => ipcRenderer.invoke("updater-check"),
    install: () => ipcRenderer.invoke("updater-install"),
  },
  speech: {
    isAvailable: () => ipcRenderer.invoke("speech-is-available"),
    prepare: () => ipcRenderer.invoke("speech-prepare"),
    transcribe: (request) => ipcRenderer.invoke("speech-transcribe", request),
    cancel: (captureID) => ipcRenderer.invoke("speech-cancel", captureID),
    onProgress: (cb) => {
      const handler = (_event: unknown, progress: Parameters<typeof cb>[0]) => cb(progress)
      ipcRenderer.on("speech-progress", handler)
      return () => ipcRenderer.removeListener("speech-progress", handler)
    },
  },
  browser: {
    snapshot: (sessionID) => ipcRenderer.invoke("browser-snapshot", sessionID),
    listChromeProfiles: () => ipcRenderer.invoke("browser-list-chrome-profiles"),
    importChromeProfile: (sessionID, profileID) => ipcRenderer.invoke("browser-import-chrome-profile", sessionID, profileID),
    attach: (sessionID, bounds) => ipcRenderer.invoke("browser-attach", sessionID, bounds),
    resize: (sessionID, bounds) => ipcRenderer.invoke("browser-resize", sessionID, bounds),
    detach: (sessionID) => ipcRenderer.invoke("browser-detach", sessionID),
    action: (input) => ipcRenderer.invoke("browser-action", input),
    control: (sessionID, controller) => ipcRenderer.invoke("browser-control", sessionID, controller),
    onEvent: (cb) => {
      const handler = (_event: unknown, value: Parameters<typeof cb>[0]) => cb(value)
      ipcRenderer.on("browser-event", handler)
      return () => ipcRenderer.removeListener("browser-event", handler)
    },
  },
  consumeInitialDeepLinks: () => ipcRenderer.invoke("consume-initial-deep-links"),
  getDefaultServerUrl: () => ipcRenderer.invoke("get-default-server-url"),
  setDefaultServerUrl: (url) => ipcRenderer.invoke("set-default-server-url", url),
  isFirstLaunchOnboardingPending: () => ipcRenderer.invoke("is-first-launch-onboarding-pending"),
  finishFirstLaunchOnboarding: (createDefaultProject) =>
    ipcRenderer.invoke("finish-first-launch-onboarding", createDefaultProject),
  isOldLayoutEligible: () => ipcRenderer.invoke("is-old-layout-eligible"),
  getDisplayBackend: () => ipcRenderer.invoke("get-display-backend"),
  setDisplayBackend: (backend) => ipcRenderer.invoke("set-display-backend", backend),
  checkAppExists: (appName) => ipcRenderer.invoke("check-app-exists", appName),
  resolveAppPath: (appName) => ipcRenderer.invoke("resolve-app-path", appName),
  storeGet: (name, key) => ipcRenderer.invoke("store-get", name, key),
  storeSet: (name, key, value) => ipcRenderer.invoke("store-set", name, key, value),
  storeDelete: (name, key) => ipcRenderer.invoke("store-delete", name, key),
  storeClear: (name) => ipcRenderer.invoke("store-clear", name),
  storeKeys: (name) => ipcRenderer.invoke("store-keys", name),
  storeLength: (name) => ipcRenderer.invoke("store-length", name),
  draftGet: (key) => ipcRenderer.invoke("draft-get", key),
  draftSet: (key, value) => ipcRenderer.invoke("draft-set", key, value),
  draftDelete: (key) => ipcRenderer.invoke("draft-delete", key),
  draftBlobPut: (data) => ipcRenderer.invoke("draft-blob-put", data),
  draftBlobGet: (id) => ipcRenderer.invoke("draft-blob-get", id),

  getWindowID: () => ipcRenderer.invoke("get-window-id"),
  openQuickChat: (options) => ipcRenderer.invoke("open-quick-chat", options),
  quickStartDirectory: () => ipcRenderer.invoke("quick-start-directory"),
  onMenuCommand: (cb) => {
    const handler = (_: unknown, id: string) => cb(id)
    ipcRenderer.on("menu-command", handler)
    return () => ipcRenderer.removeListener("menu-command", handler)
  },
  onDeepLink: (cb) => {
    const handler = (_: unknown, urls: string[]) => cb(urls)
    ipcRenderer.on("deep-link", handler)
    return () => ipcRenderer.removeListener("deep-link", handler)
  },
  onSyncProfileApplied: (cb) => {
    const handler = () => cb()
    ipcRenderer.on("sync-profile-applied", handler)
    void ipcRenderer.invoke("sync-profile-applied-subscribe")
    return () => {
      ipcRenderer.removeListener("sync-profile-applied", handler)
      void ipcRenderer.invoke("sync-profile-applied-unsubscribe")
    }
  },

  openDirectoryPicker: (opts) => ipcRenderer.invoke("open-directory-picker", opts),
  openFilePicker: (opts) => ipcRenderer.invoke("open-file-picker", opts),
  readPickedFile: (token, path) => ipcRenderer.invoke("read-picked-file", token, path),
  releasePickedFiles: (token) => ipcRenderer.invoke("release-picked-files", token),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  saveFilePicker: (opts) => ipcRenderer.invoke("save-file-picker", opts),
  openExternal: (url) => ipcRenderer.send("open-external", url),
  openLocalFile: (url) => ipcRenderer.send("open-local-file", url),
  openPath: (path, app) => ipcRenderer.invoke("open-path", path, app),
  revealPath: (path) => ipcRenderer.invoke("reveal-path", path),
  readClipboardImage: () => ipcRenderer.invoke("read-clipboard-image"),
  getWindowFocused: () => ipcRenderer.invoke("get-window-focused"),
  getWindowFullscreen: () => ipcRenderer.invoke("get-window-fullscreen"),
  onWindowFullscreenChanged: (cb) => {
    const handler = (_: unknown, fullscreen: boolean) => cb(fullscreen)
    ipcRenderer.on("window-fullscreen-changed", handler)
    return () => ipcRenderer.removeListener("window-fullscreen-changed", handler)
  },
  getWindowMaximized: () => ipcRenderer.invoke("get-window-maximized"),
  onWindowMaximizedChanged: (cb) => {
    const handler = (_: unknown, maximized: boolean) => cb(maximized)
    ipcRenderer.on("window-maximized-changed", handler)
    return () => ipcRenderer.removeListener("window-maximized-changed", handler)
  },
  setWindowFocus: () => ipcRenderer.invoke("set-window-focus"),
  showWindow: () => ipcRenderer.invoke("show-window"),
  relaunch: () => ipcRenderer.send("relaunch"),
  getZoomFactor: () => ipcRenderer.invoke("get-zoom-factor"),
  setZoomFactor: (factor) => ipcRenderer.invoke("set-zoom-factor", factor),
  getPinchZoomEnabled: () => ipcRenderer.invoke("get-pinch-zoom-enabled"),
  setPinchZoomEnabled: (enabled) => ipcRenderer.invoke("set-pinch-zoom-enabled", enabled),
  onPinchZoomEnabledChanged: (cb) => {
    const handler = (_: unknown, enabled: boolean) => cb(enabled)
    ipcRenderer.on("pinch-zoom-enabled-changed", handler)
    return () => ipcRenderer.removeListener("pinch-zoom-enabled-changed", handler)
  },
  onZoomFactorChanged: (cb) => {
    const handler = (_: unknown, factor: number) => cb(factor)
    ipcRenderer.on("zoom-factor-changed", handler)
    return () => ipcRenderer.removeListener("zoom-factor-changed", handler)
  },
  setTitlebar: (theme) => ipcRenderer.invoke("set-titlebar", theme),
  runDesktopMenuAction: (action) => ipcRenderer.invoke("run-desktop-menu-action", action),
  setBackgroundColor: (color: string) => ipcRenderer.invoke("set-background-color", color),
  exportDebugLogs: () => ipcRenderer.invoke("export-debug-logs"),
  setForceFocus: (enabled) => ipcRenderer.invoke("set-force-focus", enabled),
  recordFatalRendererError: (error) => ipcRenderer.invoke("record-fatal-renderer-error", error),
  setNativeTranslations: (bundle) => ipcRenderer.invoke("set-native-translations", bundle),
}

contextBridge.exposeInMainWorld("api", api)
