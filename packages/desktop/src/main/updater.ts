import { app } from "electron"
import { createUpdaterController } from "./updater-controller"

/**
 * The custom desktop build deliberately has no connection to OpenCode's
 * release feed. Keep the disabled controller shape so older UI integrations
 * remain safe while the desktop package stays self-contained.
 */
export function setupAutoUpdater(stop: () => Promise<void>) {
  return createUpdaterController({
    enabled: false,
    currentVersion: app.getVersion(),
    backend: {
      checkForUpdates: async () => undefined,
      downloadUpdate: async () => undefined,
      quitAndInstall: () => undefined,
    },
    persistence: {
      get: () => undefined,
      set: () => undefined,
      clear: () => undefined,
    },
    stop,
  })
}

export function showUpdaterDialog(_controller: ReturnType<typeof setupAutoUpdater>, _alertOnFail: boolean) {
  // Compatibility no-op: this build does not check or install OpenCode releases.
}
