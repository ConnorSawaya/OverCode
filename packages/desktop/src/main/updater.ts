import { app, dialog, shell } from "electron"
import { createWriteStream } from "node:fs"
import { chmod, mkdir, unlink } from "node:fs/promises"
import { spawn } from "node:child_process"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import { basename, join } from "node:path"
import { randomUUID } from "node:crypto"
import { UPDATE_MANIFEST_URL, UPDATER_ENABLED } from "./constants"
import { getStore } from "./store"
import { UPDATER_READY_KEY } from "./store-keys"
import { createUpdaterController } from "./updater-controller"
import { write as writeLog } from "./logging"

export type { UpdaterState } from "./updater-controller"

type DesktopUpdateManifest = {
  version: string
  notes?: string
  url?: string
  assets?: Partial<Record<DesktopAssetKey, string>>
}

type DesktopAssetKey =
  | "win-x64"
  | "win-arm64"
  | "mac-x64"
  | "mac-arm64"
  | "linux-x64"
  | "linux-arm64"

type SelectedUpdate = {
  version: string
  url: string
}

const MAX_UPDATE_BYTES = 500 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 30_000
const UPDATE_DIR = "overcode-updates"

/**
 * Overcode uses a tiny manifest instead of a vendor-specific update service.
 * The installer is downloaded only after the manifest reports a newer version;
 * the normal platform installer then handles the replacement on restart.
 */
export function setupAutoUpdater(stop: () => Promise<void>) {
  let selected: SelectedUpdate | undefined
  let downloadedPath: string | undefined

  const controller = createUpdaterController({
    enabled: UPDATER_ENABLED,
    currentVersion: app.getVersion(),
    backend: {
      async checkForUpdates() {
        selected = undefined
        downloadedPath = undefined

        const manifest = await fetchManifest()
        if (compareVersions(manifest.version, app.getVersion()) <= 0) {
          return { isUpdateAvailable: false, updateInfo: { version: manifest.version } }
        }

        const url = resolveAssetUrl(manifest)
        if (!url) throw new Error("The update manifest has no installer for this computer")
        selected = { version: manifest.version, url }
        return { isUpdateAvailable: true, updateInfo: { version: manifest.version } }
      },
      async downloadUpdate() {
        if (!selected) throw new Error("No desktop update selected")
        downloadedPath = await downloadInstaller(selected)
      },
      quitAndInstall() {
        if (!downloadedPath) throw new Error("The desktop update was not downloaded")
        launchInstaller(downloadedPath)
      },
    },
    persistence: {
      get: () => {
        const value = getStore().get(UPDATER_READY_KEY) as unknown
        if (!value || typeof value !== "object") return undefined
        const version = (value as { version?: unknown }).version
        return typeof version === "string" ? { version } : undefined
      },
      set: (value) => getStore().set(UPDATER_READY_KEY, value),
      clear: () => getStore().delete(UPDATER_READY_KEY),
    },
    stop,
    log: (message, data) => writeLog("updater", message, data as Record<string, unknown> | undefined),
  })

  // Production builds check in the background. Dev builds stay quiet until
  // the user presses “Check for updates” or supplies an explicit feed URL.
  if (app.isPackaged || process.env.OVERCODE_UPDATE_URL) void controller.start()

  return controller
}

export async function showUpdaterDialog(controller: ReturnType<typeof setupAutoUpdater>, alertOnFail: boolean) {
  const state = await controller.check()
  if (state.status === "ready") {
    const result = await dialog.showMessageBox({
      type: "info",
      title: "Overcode update ready",
      message: `Overcode ${state.version} is ready to install.`,
      buttons: ["Restart and install", "Later"],
      defaultId: 0,
      cancelId: 1,
    })
    if (result.response === 0) await controller.install()
    return
  }

  if (!alertOnFail) return
  if (state.status === "up-to-date") {
    await dialog.showMessageBox({
      type: "info",
      title: "Overcode is up to date",
      message: `You are running Overcode ${app.getVersion()}.`,
    })
    return
  }
  if (state.status === "error") {
    await dialog.showMessageBox({ type: "error", title: "Overcode update failed", message: state.message })
  }
}

async function fetchManifest(): Promise<DesktopUpdateManifest> {
  const response = await fetch(UPDATE_MANIFEST_URL, {
    headers: { accept: "application/json", "user-agent": "Overcode-Updater" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`Update manifest returned HTTP ${response.status}`)

  const value = (await response.json()) as unknown
  if (!value || typeof value !== "object") throw new Error("Update manifest is not valid JSON")
  const manifest = value as Partial<DesktopUpdateManifest>
  if (typeof manifest.version !== "string" || !/^\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.version)) {
    throw new Error("Update manifest has an invalid version")
  }
  return manifest as DesktopUpdateManifest
}

function resolveAssetUrl(manifest: DesktopUpdateManifest) {
  const value = manifest.assets?.[assetKey()] ?? manifest.url
  if (typeof value !== "string") return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined
    return url.toString()
  } catch {
    return undefined
  }
}

async function downloadInstaller(update: SelectedUpdate) {
  const response = await fetch(update.url, {
    headers: { "user-agent": "Overcode-Updater" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    redirect: "follow",
  })
  if (!response.ok || !response.body) throw new Error(`Update download returned HTTP ${response.status}`)

  const contentLength = Number(response.headers.get("content-length") ?? 0)
  if (contentLength > MAX_UPDATE_BYTES) throw new Error("Update installer is too large")

  const directory = join(app.getPath("temp"), UPDATE_DIR)
  await mkdir(directory, { recursive: true })
  const extension = installerExtension(update.url)
  const destination = join(directory, `overcode-${update.version}-${randomUUID()}${extension}`)
  let bytes = 0
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length
      if (bytes > MAX_UPDATE_BYTES) {
        callback(new Error("Update installer is too large"))
        return
      }
      callback(null, chunk)
    },
  })

  try {
    await pipeline(Readable.fromWeb(response.body as never), limiter, createWriteStream(destination))
    if (extension === ".AppImage") await chmod(destination, 0o755)
    return destination
  } catch (error) {
    await unlink(destination).catch(() => undefined)
    throw error
  }
}

function launchInstaller(path: string) {
  if (process.platform === "win32") {
    spawn(path, [], { detached: true, stdio: "ignore", windowsHide: false }).unref()
    setTimeout(() => app.quit(), 250)
    return
  }

  void shell.openPath(path)
  setTimeout(() => app.quit(), 250)
}

function assetKey(): DesktopAssetKey {
  const arch = process.arch === "arm64" ? "arm64" : "x64"
  if (process.platform === "win32") return `win-${arch}`
  if (process.platform === "darwin") return `mac-${arch}`
  return `linux-${arch}`
}

function installerExtension(value: string) {
  const pathname = new URL(value).pathname.toLowerCase()
  if (pathname.endsWith(".dmg")) return ".dmg"
  if (pathname.endsWith(".appimage")) return ".AppImage"
  if (pathname.endsWith(".deb")) return ".deb"
  if (pathname.endsWith(".rpm")) return ".rpm"
  return process.platform === "win32"
    ? ".exe"
    : basename(pathname).includes(".")
      ? `.${basename(pathname).split(".").pop()}`
      : ".bin"
}

function compareVersions(left: string, right: string) {
  const a = left.replace(/^v/i, "").split(/[.+-]/)[0].split(".").map(Number)
  const b = right.replace(/^v/i, "").split(/[.+-]/)[0].split(".").map(Number)
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}
