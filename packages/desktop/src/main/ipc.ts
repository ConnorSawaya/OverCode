import { execFile } from "node:child_process"
import { prepareQuickChatProject, prepareQuickStart } from "./quick-start"
import { stat } from "node:fs/promises"
import { basename, join } from "node:path"
import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from "electron"
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron"
import type { DesktopMenuAction } from "@opencode-ai/app/desktop-menu"
import { parseDesktopNativeBundle, type DesktopNativeBundle } from "@opencode-ai/app/i18n/desktop-native"

import type { FatalRendererError, QuickChatOptions, ServerReadyData, TitlebarTheme } from "../preload/types"
import { runDesktopMenuAction } from "./desktop-menu-actions"
import { setForceFocus } from "./debug"
import { assertAttachmentBudget, createPickedFileAuthorizations } from "./attachment-picker"
import { getStore, removeStoreFileIfEmpty } from "./store"
import {
  getPinchZoomEnabled,
  getWindowID,
  openExternalURL,
  openLocalFileURL,
  createQuickChatWindow,
  setPinchZoomEnabled,
  setTitlebar,
  updateTitlebar,
} from "./windows"
import type { UpdaterController } from "./updater-controller"
import { BrowserManager } from "./browser"
import type { ComputerUseController } from "./computer-use"
import { createUpdaterSubscriptions } from "./updater-subscriptions"
import { createDesktopDraftStore } from "./draft-store"
import { nativeT } from "./native-translations"
import { createLocalSpeech, isLocalSpeechAvailable } from "./speech-local"
import type { SpeechRequest } from "@opencode-ai/app"
import type { MobileAccessPlatform, SyncDevicesPlatform } from "@opencode-ai/app"
import { assertTrustedRendererSender } from "./renderer-security"

const pickerFilters = (ext?: string[]) => {
  if (!ext || ext.length === 0) return undefined
  return [{ name: nativeT("desktop.dialog.files"), extensions: ext }]
}

const pickedFiles = createPickedFileAuthorizations()

type Deps = {
  killSidecar: () => Promise<void> | void
  relaunch: () => void
  awaitInitialization: () => Promise<ServerReadyData>
  consumeInitialDeepLinks: () => Promise<string[]> | string[]
  getDefaultServerUrl: () => Promise<string | null> | string | null
  setDefaultServerUrl: (url: string | null) => Promise<void> | void
  isFirstLaunchOnboardingPending: () => Promise<boolean> | boolean
  finishFirstLaunchOnboarding: (createDefaultProject: boolean) => Promise<string | null> | string | null
  isOldLayoutEligible: () => Promise<boolean> | boolean
  getDisplayBackend: () => Promise<string | null>
  setDisplayBackend: (backend: string | null) => Promise<void> | void
  checkAppExists: (appName: string) => Promise<boolean> | boolean
  resolveAppPath: (appName: string) => Promise<string | null>
  updater: UpdaterController
  showUpdater: () => Promise<void> | void
  setBackgroundColor: (color: string) => void
  exportDebugLogs: () => Promise<string>
  recordFatalRendererError: (error: FatalRendererError) => Promise<void> | void
  setNativeTranslations: (bundle: DesktopNativeBundle) => void
  browser: BrowserManager
  computerUse: ComputerUseController
  mobileAccess: MobileAccessPlatform
  syncDevices: SyncDevicesPlatform
}

export function registerIpcHandlers(deps: Deps) {
  const computerOwners = new Set<number>()
  const mobileAccessSubscriptions = new Map<number, () => void>()
  const syncDevicesSubscriptions = new Map<number, () => void>()
  const syncProfileAppliedSubscriptions = new Map<number, () => void>()
  const trustedRendererSender = assertTrustedRendererSender
  const handle = <Args extends unknown[], Result>(
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: Args) => Result,
  ) => {
    ipcMain.handle(channel, (event, ...args) => {
      trustedRendererSender(event)
      return listener(event, ...(args as Args))
    })
  }
  const on = <Args extends unknown[]>(channel: string, listener: (event: IpcMainEvent, ...args: Args) => void) => {
    ipcMain.on(channel, (event, ...args) => {
      trustedRendererSender(event)
      listener(event, ...(args as Args))
    })
  }
  const computerSender = (event: IpcMainInvokeEvent) => {
    return trustedRendererSender(event)
  }
  handle("computer-use-state", (event) => {
    computerSender(event)
    return deps.computerUse.state()
  })
  handle("computer-use-start", async (event, sessionID: string, serverUrl: string, directory?: string) => {
    const win = computerSender(event)
    const owner = event.sender.id
    if (!computerOwners.has(owner)) {
      computerOwners.add(owner)
      const stop = () => { void deps.computerUse.releaseOwner(owner) }
      event.sender.on("will-navigate", stop)
      event.sender.on("render-process-gone", stop)
      event.sender.once("destroyed", () => { computerOwners.delete(owner); stop() })
    }
    return deps.computerUse.start({ window: owner, sessionID, directory }, serverUrl, async () => {
      const result = await dialog.showMessageBox(win, {
        type: "warning",
        title: nativeT("desktop.computerUse.consent.title"),
        message: nativeT("desktop.computerUse.consent.message"),
        detail: nativeT("desktop.computerUse.consent.detail"),
        buttons: [nativeT("desktop.computerUse.consent.allow"), nativeT("desktop.computerUse.consent.cancel")],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      })
      return result.response === 0 && !win.isDestroyed() && !event.sender.isDestroyed()
    })
  })
  handle("computer-use-stop", (event, sessionID?: string) => {
    computerSender(event)
    return deps.computerUse.stop(sessionID)
  })
  handle("computer-use-color", (event, color: unknown) => {
    computerSender(event)
    return deps.computerUse.setColor(color)
  })
  handle("quick-start-directory", () => prepareQuickStart(app.getPath("documents")))
  handle("quick-chat-directory", () => prepareQuickChatProject(app.getPath("documents")))
  const drafts = createDesktopDraftStore(join(app.getPath("userData"), "drafts.sqlite"))
  const updaterSubscriptions = createUpdaterSubscriptions()
  const speechOwners = new Set<number>()
  const speech = createLocalSpeech(join(app.getPath("userData"), "speech"), (progress) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (speechOwners.has(win.webContents.id) && !win.webContents.isDestroyed())
        win.webContents.send("speech-progress", progress)
    }
  })
  app.once("will-quit", updaterSubscriptions.clear)
  app.on("before-quit", () => drafts.flush())
  app.once("will-quit", () => drafts.close())
  app.once("will-quit", () => {
    speech.dispose()
  })
  app.on("browser-window-created", (_event, win) => win.on("session-end", () => drafts.flush()))

  handle("kill-sidecar", () => deps.killSidecar())
  handle("mobile-access-state", (event) => {
    trustedRendererSender(event)
    return deps.mobileAccess.state()
  })
  handle("mobile-access-start", (event) => {
    trustedRendererSender(event)
    return deps.mobileAccess.start()
  })
  handle("mobile-access-stop", (event) => {
    trustedRendererSender(event)
    return deps.mobileAccess.stop()
  })
  handle("mobile-access-revoke", (event) => {
    trustedRendererSender(event)
    return deps.mobileAccess.revoke()
  })
  handle("mobile-access-new-code", (event) => {
    trustedRendererSender(event)
    return deps.mobileAccess.newPairingCode()
  })
  handle("mobile-access-rotate", (event) => {
    trustedRendererSender(event)
    return deps.mobileAccess.rotate()
  })
  handle("mobile-access-revoke-device", (event, deviceId: string) => {
    trustedRendererSender(event)
    return deps.mobileAccess.revokeDevice?.(deviceId) ?? []
  })
  handle("mobile-access-subscribe", (event) => {
    trustedRendererSender(event)
    const id = event.sender.id
    mobileAccessSubscriptions.get(id)?.()
    const unsubscribe = deps.mobileAccess.onState((state) => {
      if (event.sender.isDestroyed()) return
      event.sender.send("mobile-access-state", state)
    })
    mobileAccessSubscriptions.set(id, unsubscribe)
    event.sender.once("destroyed", () => {
      mobileAccessSubscriptions.get(id)?.()
      mobileAccessSubscriptions.delete(id)
    })
  })
  handle("mobile-access-unsubscribe", (event) => {
    trustedRendererSender(event)
    mobileAccessSubscriptions.get(event.sender.id)?.()
    mobileAccessSubscriptions.delete(event.sender.id)
  })
  handle("sync-devices-state", (event) => {
    trustedRendererSender(event)
    return deps.syncDevices.state()
  })
  handle("sync-devices-pair", (event, code: string, relayUrl?: string) => {
    trustedRendererSender(event)
    return deps.syncDevices.pair(code, relayUrl)
  })
  handle("sync-devices-remove-peer", (event, deviceId: string) => {
    trustedRendererSender(event)
    return deps.syncDevices.removePeer(deviceId)
  })
  handle("sync-devices-sync-now", (event) => {
    trustedRendererSender(event)
    return deps.syncDevices.syncNow()
  })
  handle("sync-devices-map-project", (event, projectID: string, localWorktree: string) => {
    trustedRendererSender(event)
    return deps.syncDevices.mapProject(projectID, localWorktree)
  })
  handle("sync-devices-subscribe", (event) => {
    trustedRendererSender(event)
    const id = event.sender.id
    syncDevicesSubscriptions.get(id)?.()
    const unsubscribe = deps.syncDevices.onState((state) => {
      if (event.sender.isDestroyed()) return
      event.sender.send("sync-devices-state", state)
    })
    syncDevicesSubscriptions.set(id, unsubscribe)
    event.sender.once("destroyed", () => {
      syncDevicesSubscriptions.get(id)?.()
      syncDevicesSubscriptions.delete(id)
    })
  })
  handle("sync-devices-unsubscribe", (event) => {
    trustedRendererSender(event)
    syncDevicesSubscriptions.get(event.sender.id)?.()
    syncDevicesSubscriptions.delete(event.sender.id)
  })
  /*
   * The profile-applied event is also privileged: it can expose sync state to
   * an untrusted renderer if its sender is not checked before subscribing.
   */
  handle("sync-profile-applied-subscribe", (event) => {
    trustedRendererSender(event)
    const id = event.sender.id
    syncProfileAppliedSubscriptions.get(id)?.()
    const unsubscribe = deps.syncDevices.onProfileApplied?.(() => {
      if (event.sender.isDestroyed()) return
      event.sender.send("sync-profile-applied")
    })
    if (!unsubscribe) return
    syncProfileAppliedSubscriptions.set(id, unsubscribe)
    event.sender.once("destroyed", () => {
      syncProfileAppliedSubscriptions.get(id)?.()
      syncProfileAppliedSubscriptions.delete(id)
    })
  })
  handle("sync-profile-applied-unsubscribe", (event) => {
    trustedRendererSender(event)
    syncProfileAppliedSubscriptions.get(event.sender.id)?.()
    syncProfileAppliedSubscriptions.delete(event.sender.id)
  })
  handle("await-initialization", () => deps.awaitInitialization())
  handle("consume-initial-deep-links", () => deps.consumeInitialDeepLinks())
  handle("get-default-server-url", () => deps.getDefaultServerUrl())
  handle("set-default-server-url", (_event: IpcMainInvokeEvent, url: string | null) =>
    deps.setDefaultServerUrl(url),
  )
  handle("is-first-launch-onboarding-pending", () => deps.isFirstLaunchOnboardingPending())
  handle("finish-first-launch-onboarding", (_event: IpcMainInvokeEvent, createDefaultProject: boolean) =>
    deps.finishFirstLaunchOnboarding(createDefaultProject),
  )
  handle("is-old-layout-eligible", () => deps.isOldLayoutEligible())
  handle("get-display-backend", () => deps.getDisplayBackend())
  handle("set-display-backend", (_event: IpcMainInvokeEvent, backend: string | null) =>
    deps.setDisplayBackend(backend),
  )
  handle("check-app-exists", (_event: IpcMainInvokeEvent, appName: string) => deps.checkAppExists(appName))
  handle("resolve-app-path", (_event: IpcMainInvokeEvent, appName: string) => deps.resolveAppPath(appName))
  handle("updater-subscribe", (event) => {
    trustedRendererSender(event)
    const id = event.sender.id
    updaterSubscriptions.set(
      id,
      deps.updater.subscribe((state) => {
        if (event.sender.isDestroyed()) return updaterSubscriptions.delete(id)
        event.sender.send("updater-state", state)
      }),
    )
    event.sender.once("destroyed", () => updaterSubscriptions.delete(id))
  })
  handle("updater-unsubscribe", (event) => {
    trustedRendererSender(event)
    return updaterSubscriptions.delete(event.sender.id)
  })
  handle("updater-check", (event) => {
    trustedRendererSender(event)
    return deps.updater.check()
  })
  handle("updater-install", (event) => {
    trustedRendererSender(event)
    return deps.updater.install()
  })
  handle("speech-is-available", () => isLocalSpeechAvailable())
  handle("speech-prepare", (event) => {
    const owner = event.sender.id
    if (!speechOwners.has(owner)) {
      speechOwners.add(owner)
      event.sender.once("destroyed", () => {
        speechOwners.delete(owner)
        speech.cancel(owner)
      })
    }
    return speech.prepare()
  })
  handle("speech-transcribe", (event, request: SpeechRequest) => speech.transcribe(event.sender.id, request))
  handle("speech-cancel", (event, captureID: string) => {
    if (typeof captureID !== "string" || !/^[\w-]{1,100}$/.test(captureID)) return
    speech.cancel(event.sender.id, captureID)
  })
  handle("browser-snapshot", (event: IpcMainInvokeEvent, sessionID: string) => {
    validateBrowserSessionID(sessionID)
    return deps.browser.snapshot(sessionID)
  })
  handle("browser-list-chrome-profiles", () => deps.browser.listChromeProfiles())
  handle("browser-import-chrome-profile", (event: IpcMainInvokeEvent, sessionID: string, profileID: string) => {
    validateBrowserSessionID(sessionID)
    if (typeof profileID !== "string" || !/^[\w-]{1,100}$/.test(profileID)) throw new Error("Invalid browser profile")
    return deps.browser.importChromeProfile(sessionID, profileID)
  })
  handle("browser-attach", (event: IpcMainInvokeEvent, sessionID: string, bounds: unknown) => {
    validateBrowserSessionID(sessionID)
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new Error("Browser window not found")
    return deps.browser.attach(win, sessionID, validateBrowserBounds(bounds))
  })
  handle("browser-resize", (event: IpcMainInvokeEvent, sessionID: string, bounds: unknown) => {
    validateBrowserSessionID(sessionID)
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new Error("Browser window not found")
    deps.browser.resize(win, sessionID, validateBrowserBounds(bounds))
  })
  handle("browser-detach", (event: IpcMainInvokeEvent, sessionID?: string) => {
    if (sessionID) validateBrowserSessionID(sessionID)
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    deps.browser.detach(win, sessionID)
  })
  handle(
    "browser-action",
    (event: IpcMainInvokeEvent, input: { sessionID: string; action: string; [key: string]: unknown }) => {
      validateBrowserSessionID(input?.sessionID)
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) throw new Error("Browser window not found")
      return deps.browser.userAction(input as never)
    },
  )
  handle("browser-control", (_event: IpcMainInvokeEvent, sessionID: string, controller: string) => {
    validateBrowserSessionID(sessionID)
    if (controller !== "agent" && controller !== "user" && controller !== "none")
      throw new Error("Invalid browser controller")
    return deps.browser.setController(sessionID, controller)
  })
  handle("set-background-color", (_event: IpcMainInvokeEvent, color: string) => deps.setBackgroundColor(color))
  handle("export-debug-logs", () => deps.exportDebugLogs())
  handle("set-force-focus", (event: IpcMainInvokeEvent, enabled: boolean) =>
    setForceFocus(event.sender, enabled),
  )
  handle("record-fatal-renderer-error", (_event: IpcMainInvokeEvent, error: FatalRendererError) =>
    deps.recordFatalRendererError(error),
  )
  handle("set-native-translations", (event: IpcMainInvokeEvent, value: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed() || win.webContents !== event.sender || event.senderFrame !== event.sender.mainFrame) {
      throw new Error("Invalid native translation sender")
    }
    const bundle = parseDesktopNativeBundle(value)
    if (!bundle) throw new Error("Invalid native translation bundle")
    deps.setNativeTranslations(bundle)
  })
  handle("store-get", (_event: IpcMainInvokeEvent, name: string, key: string) => {
    try {
      const store = getStore(name)
      const value = store.get(key)
      if (value === undefined || value === null) return null
      return typeof value === "string" ? value : JSON.stringify(value)
    } catch {
      return null
    }
  })
  handle("store-set", (_event: IpcMainInvokeEvent, name: string, key: string, value: string) => {
    getStore(name).set(key, value)
  })
  handle("store-delete", (_event: IpcMainInvokeEvent, name: string, key: string) => {
    getStore(name).delete(key)
    void removeStoreFileIfEmpty(name)
  })
  handle("store-clear", (_event: IpcMainInvokeEvent, name: string) => {
    getStore(name).clear()
    void removeStoreFileIfEmpty(name)
  })
  handle("store-keys", (_event: IpcMainInvokeEvent, name: string) => {
    const store = getStore(name)
    return Object.keys(store.store)
  })
  handle("store-length", (_event: IpcMainInvokeEvent, name: string) => {
    const store = getStore(name)
    return Object.keys(store.store).length
  })
  handle("draft-get", (_event, key: string) => drafts.get(key))
  handle("draft-set", (_event, key: string, value: string) => drafts.set(key, value))
  handle("draft-delete", (_event, key: string) => drafts.set(key, null))
  handle("draft-blob-put", (_event, data: ArrayBuffer) => drafts.putBlob(new Uint8Array(data)))
  handle("draft-blob-get", (_event, id: string) => {
    const data = drafts.getBlob(id)
    return data ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : null
  })

  handle(
    "open-directory-picker",
    async (_event: IpcMainInvokeEvent, opts?: { multiple?: boolean; title?: string; defaultPath?: string }) => {
      const result = await dialog.showOpenDialog({
        properties: ["openDirectory", ...(opts?.multiple ? ["multiSelections" as const] : []), "createDirectory"],
        title: opts?.title ?? nativeT("desktop.dialog.chooseFolder"),
        defaultPath: opts?.defaultPath,
      })
      if (result.canceled) return null
      return opts?.multiple ? result.filePaths : result.filePaths[0]
    },
  )

  handle(
    "open-file-picker",
    async (
      event: IpcMainInvokeEvent,
      opts?: { multiple?: boolean; title?: string; defaultPath?: string; extensions?: string[]; allowAll?: boolean },
    ) => {
      const result = await dialog.showOpenDialog({
        properties: ["openFile", ...(opts?.multiple ? ["multiSelections" as const] : [])],
        title: opts?.title ?? nativeT("desktop.dialog.chooseFile"),
        defaultPath: opts?.defaultPath,
        filters: opts?.allowAll ? undefined : pickerFilters(opts?.extensions),
      })
      if (result.canceled) return null
      const files = await Promise.all(
        result.filePaths.map(async (filePath) => ({
          path: filePath,
          name: basename(filePath),
          size: (await stat(filePath)).size,
        })),
      )
      assertAttachmentBudget(files)
      const token = pickedFiles.add(event.sender.id, result.filePaths)
      return { token, files }
    },
  )

  handle("read-picked-file", async (event: IpcMainInvokeEvent, token: string, filePath: string) => {
    return pickedFiles.read(event.sender.id, token, filePath)
  })

  handle("release-picked-files", (event: IpcMainInvokeEvent, token: string) => {
    pickedFiles.release(event.sender.id, token)
  })

  handle(
    "save-file-picker",
    async (_event: IpcMainInvokeEvent, opts?: { title?: string; defaultPath?: string }) => {
      const result = await dialog.showSaveDialog({
        title: opts?.title ?? nativeT("desktop.dialog.saveFile"),
        defaultPath: opts?.defaultPath,
      })
      if (result.canceled) return null
      return result.filePath ?? null
    },
  )

  on("open-external", (_event, url: string) => {
    openExternalURL(url)
  })

  on("open-local-file", (_event, url: string) => {
    openLocalFileURL(url)
  })

  handle("open-path", async (_event: IpcMainInvokeEvent, path: string, app?: string) => {
    if (!app) return shell.openPath(path)
    await new Promise<void>((resolve, reject) => {
      const [cmd, args] =
        process.platform === "darwin" ? (["open", ["-a", app, path]] as const) : ([app, [path]] as const)
      execFile(cmd, args, (err) => (err ? reject(err) : resolve()))
    })
  })

  handle("reveal-path", async (_event: IpcMainInvokeEvent, path: string) => {
    const exists = await stat(path).then(
      () => true,
      () => false,
    )
    if (!exists) return false
    shell.showItemInFolder(path)
    return true
  })

  handle("read-clipboard-image", () => {
    const image = clipboard.readImage()
    if (image.isEmpty()) return null
    const buffer = image.toPNG().buffer
    const size = image.getSize()
    return { buffer, width: size.width, height: size.height }
  })

  handle("get-window-id", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new Error("Window not found")
    const id = getWindowID(win)
    if (!id) throw new Error("Window ID not found")
    return id
  })

  handle("open-quick-chat", (event: IpcMainInvokeEvent, options?: QuickChatOptions) => {
    createQuickChatWindow(options, BrowserWindow.fromWebContents(event.sender))
  })

  handle("get-window-focused", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win?.isFocused() ?? false
  })

  handle("get-window-fullscreen", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win?.isFullScreen() ?? false
  })
  handle("get-window-maximized", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win?.isMaximized() ?? false
  })

  handle("set-window-focus", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.focus()
  })

  handle("show-window", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.show()
  })

  on("relaunch", () => {
    deps.relaunch()
  })

  handle("get-zoom-factor", (event: IpcMainInvokeEvent) => event.sender.getZoomFactor())
  handle("set-zoom-factor", (event: IpcMainInvokeEvent, factor: number) => {
    event.sender.setZoomFactor(factor)
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    updateTitlebar(win)
  })
  handle("get-pinch-zoom-enabled", () => getPinchZoomEnabled())
  handle("set-pinch-zoom-enabled", (_event: IpcMainInvokeEvent, enabled: boolean) => {
    setPinchZoomEnabled(enabled)
  })
  handle("set-titlebar", (event: IpcMainInvokeEvent, theme: TitlebarTheme) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    setTitlebar(win, theme)
  })
  handle("run-desktop-menu-action", (event: IpcMainInvokeEvent, action: DesktopMenuAction) => {
    runDesktopMenuAction(BrowserWindow.fromWebContents(event.sender), action, {
      checkForUpdates: () => void deps.showUpdater(),
      relaunch: deps.relaunch,
    })
  })
}

function validateBrowserSessionID(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 200) throw new Error("Invalid browser session ID")
}

function validateBrowserBounds(value: unknown) {
  if (!value || typeof value !== "object") throw new Error("Invalid browser bounds")
  const input = value as Record<string, unknown>
  const valid = [input.x, input.y, input.width, input.height].every(
    (item) => typeof item === "number" && Number.isFinite(item),
  )
  if (!valid) throw new Error("Invalid browser bounds")
  return {
    x: Math.max(0, Math.round(input.x as number)),
    y: Math.max(0, Math.round(input.y as number)),
    width: Math.max(1, Math.round(input.width as number)),
    height: Math.max(1, Math.round(input.height as number)),
  }
}

export function sendMenuCommand(win: BrowserWindow, id: string) {
  win.webContents.send("menu-command", id)
}

export function sendDeepLinks(win: BrowserWindow, urls: string[]) {
  win.webContents.send("deep-link", urls)
}
