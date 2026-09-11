import { app, BrowserWindow } from "electron"
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron"
import { getWindowID } from "./windows"

/** Only the app's own top-level renderer may use privileged desktop IPC. */
export function assertTrustedRendererSender(event: IpcMainEvent | IpcMainInvokeEvent) {
  const win = BrowserWindow.fromWebContents(event.sender)
  const url = event.senderFrame?.url ?? ""
  const dev = !app.isPackaged && process.env.ELECTRON_RENDERER_URL
  let trusted = url.startsWith("oc://renderer/")
  if (!trusted && dev) {
    try {
      trusted = new URL(url).origin === new URL(dev).origin
    } catch {
      trusted = false
    }
  }
  if (
    !trusted ||
    !win ||
    win.isDestroyed() ||
    !getWindowID(win) ||
    win.webContents !== event.sender ||
    event.senderFrame !== event.sender.mainFrame
  ) {
    throw new Error("invalid_renderer_sender")
  }
  return win
}
