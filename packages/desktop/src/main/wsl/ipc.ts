import { app, ipcMain } from "electron"
import type { IpcMainInvokeEvent } from "electron"
import type { WslServersController } from "./servers"
import { requireWslIpcString, requireWslIpcStrings } from "./policy"
import type { WslServersState } from "../../preload/types"
import { nativeT } from "../native-translations"
import { assertTrustedRendererSender } from "../renderer-security"

function registerWslIpcHandler<Args extends unknown[], Result>(
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: Args) => Result,
) {
  ipcMain.handle(channel, (event, ...args) => {
    assertTrustedRendererSender(event)
    return listener(event, ...(args as Args))
  })
}

export function registerWslIpcHandlers(controller: WslServersController) {
  if (process.platform !== "win32") {
    registerUnavailableWslIpcHandlers()
    return
  }

  const subscriptions = new Map<number, () => void>()
  const unsubscribe = (id: number) => {
    const off = subscriptions.get(id)
    if (!off) return
    off()
    subscriptions.delete(id)
  }

  app.once("will-quit", () => {
    subscriptions.forEach((off) => off())
    subscriptions.clear()
  })

  registerWslIpcHandler("wsl-servers-subscribe", (event) => {
    const id = event.sender.id
    if (subscriptions.has(id)) return
    subscriptions.set(
      id,
      controller.subscribe((payload) => {
        if (event.sender.isDestroyed()) {
          unsubscribe(id)
          return
        }
        event.sender.send("wsl-servers-event", payload)
      }),
    )
    event.sender.once("destroyed", () => unsubscribe(id))
  })
  registerWslIpcHandler("wsl-servers-unsubscribe", (event) => unsubscribe(event.sender.id))
  registerWslIpcHandler("wsl-servers-get-state", () => controller.getState())
  registerWslIpcHandler("wsl-servers-probe-runtime", () => controller.probeRuntime())
  registerWslIpcHandler("wsl-servers-refresh-distros", () => controller.refreshDistros())
  registerWslIpcHandler("wsl-servers-install-wsl", () => controller.installWsl())
  registerWslIpcHandler("wsl-servers-install-distro", (_event: IpcMainInvokeEvent, name: string) =>
    controller.installDistro(requireWslIpcString("distro", name)),
  )
  registerWslIpcHandler("wsl-servers-probe-addable", (_event: IpcMainInvokeEvent, distros: string[]) =>
    controller.probeAddable(requireWslIpcStrings("distro", distros)),
  )
  registerWslIpcHandler("wsl-servers-install-opencode", (_event: IpcMainInvokeEvent, name: string) =>
    controller.installOpencode(requireWslIpcString("distro", name)),
  )
  registerWslIpcHandler("wsl-servers-open-terminal", (_event: IpcMainInvokeEvent, name: string) =>
    controller.openTerminal(requireWslIpcString("distro", name)),
  )
  registerWslIpcHandler("wsl-servers-add", (_event: IpcMainInvokeEvent, distro: string) =>
    controller.addServer(requireWslIpcString("distro", distro)),
  )
  registerWslIpcHandler("wsl-servers-remove", (_event: IpcMainInvokeEvent, id: string) =>
    controller.removeServer(requireWslIpcString("server id", id)),
  )
  registerWslIpcHandler("wsl-servers-start", (_event: IpcMainInvokeEvent, id: string) =>
    controller.startServer(requireWslIpcString("server id", id)),
  )
}

function registerUnavailableWslIpcHandlers() {
  const unavailable = () => {
    throw new Error(nativeT("desktop.wsl.error.windowsOnly"))
  }
  const state = (): WslServersState => ({
    runtime: {
      available: false,
      version: null,
      error: nativeT("desktop.wsl.error.windowsOnly"),
    },
    installed: [],
    online: [],
    distroProbes: {},
    opencodeChecks: {},
    pendingRestart: false,
    servers: [],
    job: null,
  })

  registerWslIpcHandler("wsl-servers-subscribe", (event) => {
    event.sender.send("wsl-servers-event", { type: "state", state: state() })
  })
  registerWslIpcHandler("wsl-servers-unsubscribe", () => undefined)
  registerWslIpcHandler("wsl-servers-get-state", () => state())
  registerWslIpcHandler("wsl-servers-probe-runtime", unavailable)
  registerWslIpcHandler("wsl-servers-refresh-distros", unavailable)
  registerWslIpcHandler("wsl-servers-install-wsl", unavailable)
  registerWslIpcHandler("wsl-servers-install-distro", unavailable)
  registerWslIpcHandler("wsl-servers-probe-addable", unavailable)
  registerWslIpcHandler("wsl-servers-install-opencode", unavailable)
  registerWslIpcHandler("wsl-servers-open-terminal", unavailable)
  registerWslIpcHandler("wsl-servers-add", unavailable)
  registerWslIpcHandler("wsl-servers-remove", unavailable)
  registerWslIpcHandler("wsl-servers-start", unavailable)
}
