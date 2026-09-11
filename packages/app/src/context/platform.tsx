import { createSimpleContext } from "@opencode-ai/ui/context"
import type { AsyncStorage, SyncStorage } from "@solid-primitives/storage"
import type { Accessor } from "solid-js"
import type { DesktopMenuAction } from "../desktop-menu"
import { ServerConnection } from "./server"
import type { WslServersPlatform } from "../wsl/types"
import type { UpdaterPlatform } from "../updater"
import type { DraftStore } from "@/utils/draft-store"
import type { BrowserPlatform } from "./browser"
import type { SpeechPlatform } from "@/utils/speech-types"
import type { ComputerUsePlatform } from "../computer-use"

type PickerPaths = string | string[] | null
type OpenDirectoryPickerOptions = { title?: string; multiple?: boolean }
type OpenAttachmentPickerOptions = {
  title?: string
  multiple?: boolean
  accept?: string[]
  extensions?: string[]
  /** Allow selecting files whose extension is not in the normal attachment list. */
  allowAll?: boolean
  defaultPath?: string
}
type SaveFilePickerOptions = { title?: string; defaultPath?: string }
type PlatformName = "web" | "desktop"
type DesktopOS = "macos" | "windows" | "linux"

export type MobileAccessStatus = "disabled" | "starting" | "online" | "stopping" | "error"
export type MobileAccessState = {
  status: MobileAccessStatus
  relayUrl?: string
  pairUri?: string
  pairCode?: string
  pairExpiresAt?: number
  deviceId?: string
  devices?: MobileDevice[]
  error?: string
}
export type MobileDevice = {
  id: string
  name: string
  deviceType?: string
  pairedAt: string
  lastSeen: string
  status?: "online" | "offline"
}
export type MobileAccessPlatform = {
  state(): MobileAccessState
  start(): Promise<MobileAccessState>
  stop(): Promise<MobileAccessState>
  revoke(): Promise<MobileAccessState>
  newPairingCode(): Promise<MobileAccessState>
  rotate(): Promise<MobileAccessState>
  revokeDevice?(deviceId: string): Promise<MobileDevice[]>
  onState(callback: (state: MobileAccessState) => void): () => void
}

export type SyncDeviceStatus = "disabled" | "pairing" | "syncing" | "online" | "offline" | "error"
export type SyncPeer = MobileDevice & {
  status?: "online" | "offline"
}
export type SyncProjectMapping = {
  projectID: string
  name?: string
  sourceWorktree: string
  localWorktree?: string
}
export type SyncDevicesState = {
  status: SyncDeviceStatus
  deviceId?: string
  peers: SyncPeer[]
  projects: SyncProjectMapping[]
  /** Provider IDs used by synced model preferences that are not connected locally. */
  missingProviders?: string[]
  lastSynced?: number
  error?: string
}
export type SyncDevicesPlatform = {
  state(): SyncDevicesState
  pair(code: string, relayUrl?: string): Promise<SyncDevicesState>
  removePeer(deviceId: string): Promise<SyncDevicesState>
  syncNow(): Promise<SyncDevicesState>
  mapProject(projectID: string, localWorktree: string): Promise<SyncDevicesState>
  onState(callback: (state: SyncDevicesState) => void): () => void
  onProfileApplied?(callback: () => void): () => void
}

export type QuickChatOptions = {
  directory?: string
  sessionID?: string
  serverKey?: ServerConnection.Key
}

export type FatalRendererErrorLog = {
  error: string
  url: string
  version?: string
  platform: PlatformName
  os?: DesktopOS
}

type PlatformBase = {
  /** Persistent local workspace for chats without a selected project. */
  quickStartDirectory?(): Promise<string>
  /** Persistent local project for the native Quick Chat window. */
  quickChatDirectory?(): Promise<string>
  /** App version */
  version?: string

  /** Open a web or mail URL in the default system application */
  openExternal(url: string): void

  /** Open a local path in a local app (desktop only) */
  openPath?(path: string, app?: string): Promise<void>

  /** Open a local file URL in its default app (desktop only) */
  openLocalFile?(url: string): void

  /** Reveal a local path in the system file manager; false when the path does not exist (desktop only) */
  revealPath?(path: string): Promise<boolean>

  /** Restart the app  */
  restart(): Promise<void>

  /** Send a system notification */
  notify(title: string, description?: string, onClick?: () => void): Promise<void>

  /** Open a native attachment picker and read selected files sequentially (desktop only) */
  openAttachmentPickerDialog?(
    opts: OpenAttachmentPickerOptions,
    onFile: (file: File) => Promise<unknown>,
  ): Promise<void>

  /** Resolve the native source path for a desktop File. */
  getPathForFile?(file: File): string

  /** Open a native save file picker dialog (desktop only) */
  saveFilePickerDialog?(opts?: SaveFilePickerOptions): Promise<string | null>

  /** Storage mechanism, defaults to localStorage */
  storage?: (name?: string) => SyncStorage | AsyncStorage

  /** Prompt drafts, history, and their blobs. */
  draftStore?: DraftStore

  /** Stable platform window identity for window-scoped persistence */
  windowID?: string

  /** Open the compact desktop quick-chat window. */
  openQuickChat?(options?: QuickChatOptions): Promise<void>

  /** Session-owned Chromium browser control surface (desktop only). */
  browser?: BrowserPlatform
  speech?: SpeechPlatform

  /** Secure PC connector for the Overcode Mobile app (desktop only). */
  mobileAccess?: MobileAccessPlatform

  /** Cross-device sync status for the trusted-device settings surface. */
  syncDevices?: SyncDevicesPlatform

  /** Opt-in native desktop input, independent of the embedded browser. */
  computerUse?: ComputerUsePlatform

  /** Application-global desktop updater */
  updater?: UpdaterPlatform

  /** Fetch override */
  fetch?: typeof fetch

  /** Get the configured default server URL (platform-specific) */
  getDefaultServer?(): Promise<ServerConnection.Key | null>

  /** Set the default server URL to use on app startup (platform-specific) */
  setDefaultServer?(url: ServerConnection.Key | null): Promise<void> | void

  /** Manage WSL sidecar servers (Electron on Windows only) */
  wslServers?: WslServersPlatform

  /** Get the preferred display backend (desktop only) */
  getDisplayBackend?(): Promise<DisplayBackend | null> | DisplayBackend | null

  /** Set the preferred display backend (desktop only) */
  setDisplayBackend?(backend: DisplayBackend): Promise<void>

  /** Webview zoom level (desktop only) */
  webviewZoom?: Accessor<number>

  /** Whether the native desktop window is fullscreen */
  windowFullscreen?: Accessor<boolean>

  /** Get whether native pinch/Ctrl-scroll zoom gestures are enabled (desktop only) */
  getPinchZoomEnabled?(): Promise<boolean> | boolean

  /** Allow native pinch/Ctrl-scroll zoom gestures (desktop only) */
  setPinchZoomEnabled?(enabled: boolean): Promise<void> | void

  /** Run a desktop-only menu action from the app chrome */
  runDesktopMenuAction?(action: DesktopMenuAction): Promise<void> | void

  /** Check if an editor app exists (desktop only) */
  checkAppExists?(appName: string): Promise<boolean>

  /** Read image from clipboard (desktop only) */
  readClipboardImage?(): Promise<File | null>

  /** Export collected diagnostic logs (desktop only) */
  exportDebugLogs?(): Promise<string>

  /** Force focus styles on interactive elements through desktop devtools (desktop only) */
  setForceFocus?(enabled: boolean): Promise<void>

  /** Record a fatal renderer error in platform logs (desktop only) */
  recordFatalRendererError?(error: FatalRendererErrorLog): Promise<void>
}

export type Platform = PlatformBase &
  (
    | { platform: "web"; os?: never }
    | {
        platform: "desktop"
        os?: DesktopOS
        openDirectoryPickerDialog(opts?: OpenDirectoryPickerOptions): Promise<PickerPaths>
      }
  )

export type DisplayBackend = "auto" | "wayland"

export const { use: usePlatform, provider: PlatformProvider } = createSimpleContext({
  name: "Platform",
  init: (props: { value: Platform }) => {
    return props.value
  },
})
