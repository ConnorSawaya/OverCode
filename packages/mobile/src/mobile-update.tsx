import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { ButtonV2 } from "@overcode-ai/ui/v2/button-v2"
import { useLanguage } from "@overcode-ai/app"
import { Capacitor } from "@capacitor/core"
import { checkForMobileUpdate, installMobileUpdate, OvercodeUpdater, type MobileUpdateManifest } from "./update"
import pkg from "../../app/package.json"

const UPDATE_CHECK_INTERVAL = 6 * 60 * 60 * 1000
const UPDATE_STARTED_KEY = "overcode.mobile.update.started"

function startedVersion() {
  try {
    return localStorage.getItem(UPDATE_STARTED_KEY)
  } catch {
    return null
  }
}

function markStarted(version: string) {
  try {
    localStorage.setItem(UPDATE_STARTED_KEY, version)
  } catch {
    return
  }
}

function clearStarted(version: string | null) {
  if (!version) return
  try {
    if (localStorage.getItem(UPDATE_STARTED_KEY) === version) localStorage.removeItem(UPDATE_STARTED_KEY)
  } catch {
    return
  }
}

type UpdateListener = { remove: () => Promise<void> }

type UpdaterPlugin = {
  addListener(
    eventName: "updateDownloadFailed" | "updateInstallPermissionRequired",
    listener: (event: { reason?: string }) => void,
  ): Promise<UpdateListener>
}

export function MobileUpdateNotice() {
  const language = useLanguage()
  const [update, setUpdate] = createSignal<MobileUpdateManifest>()
  const [dismissed, setDismissed] = createSignal(false)
  const [status, setStatus] = createSignal<"idle" | "checking" | "downloading" | "started" | "error">("idle")

  const check = async () => {
    if (!navigator.onLine) return
    setStatus("checking")
    try {
      const next = await checkForMobileUpdate(pkg.version)
      setUpdate(next)
      setDismissed(false)
      setStatus("idle")
      if (next && Capacitor.isNativePlatform() && startedVersion() !== next.version) {
        void install(next)
      }
    } catch {
      // Update checks are best-effort. An offline or unavailable manifest must
      // never block the remote Overcode client.
      setStatus("error")
    }
  }

  const install = async (candidate = update()) => {
    const next = candidate
    if (!next) return
    setStatus("downloading")
    try {
      await installMobileUpdate(next)
      markStarted(next.version)
      setStatus("started")
    } catch {
      setStatus("error")
    }
  }

  onMount(() => {
    let disposed = false
    let listeners: UpdateListener[] = []
    const setupListeners = async () => {
      if (!Capacitor.isNativePlatform()) return
      const updater = OvercodeUpdater as unknown as UpdaterPlugin
      const next = await Promise.all([
        updater.addListener("updateDownloadFailed", () => {
          clearStarted(update()?.version ?? startedVersion())
          setStatus("error")
        }),
        updater.addListener("updateInstallPermissionRequired", () => setStatus("started")),
      ])
      if (disposed) {
        await Promise.all(next.map((listener) => listener.remove()))
        return
      }
      listeners = next
    }
    void setupListeners()
    const initial = window.setTimeout(() => void check(), 1000)
    const interval = window.setInterval(() => void check(), UPDATE_CHECK_INTERVAL)
    const onVisibilityChange = () => {
      if (!document.hidden) void check()
    }
    document.addEventListener("visibilitychange", onVisibilityChange)
    window.addEventListener("online", check)
    onCleanup(() => {
      disposed = true
      window.clearTimeout(initial)
      window.clearInterval(interval)
      document.removeEventListener("visibilitychange", onVisibilityChange)
      window.removeEventListener("online", check)
      void Promise.all(listeners.map((listener) => listener.remove()))
    })
  })

  return (
    <Show when={update() && !dismissed()}>
      <aside class="mobile-update-notice" aria-live="polite">
        <div class="mobile-update-copy">
          <strong>{language.t("mobile.update.available")}</strong>
          <span>
            {language.t("mobile.update.version")} {update()?.version}
          </span>
          <Show when={update()?.notes}>
            <span class="mobile-update-notes">{update()?.notes}</span>
          </Show>
          <Show when={status() === "started"}>
            <span class="mobile-update-status">{language.t("mobile.update.downloadStarted")}</span>
          </Show>
          <Show when={status() === "error"}>
            <span class="mobile-update-status mobile-update-status--error">{language.t("mobile.update.failed")}</span>
          </Show>
        </div>
        <div class="mobile-update-actions">
          <ButtonV2
            variant="contrast"
            size="small"
            disabled={status() === "checking" || status() === "downloading" || status() === "started"}
            onClick={() => void install()}
          >
            {status() === "downloading" ? language.t("mobile.update.downloading") : language.t("mobile.update.install")}
          </ButtonV2>
          <button class="mobile-update-later" type="button" onClick={() => setDismissed(true)}>
            {language.t("mobile.update.later")}
          </button>
        </div>
      </aside>
    </Show>
  )
}
