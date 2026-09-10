import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { useLanguage } from "@opencode-ai/app"
import { Capacitor } from "@capacitor/core"
import { checkForMobileUpdate, installMobileUpdate, type MobileUpdateManifest } from "./update"
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
        markStarted(next.version)
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
    const initial = window.setTimeout(() => void check(), 1000)
    const interval = window.setInterval(() => void check(), UPDATE_CHECK_INTERVAL)
    const onVisibilityChange = () => {
      if (!document.hidden) void check()
    }
    document.addEventListener("visibilitychange", onVisibilityChange)
    window.addEventListener("online", check)
    onCleanup(() => {
      window.clearTimeout(initial)
      window.clearInterval(interval)
      document.removeEventListener("visibilitychange", onVisibilityChange)
      window.removeEventListener("online", check)
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
