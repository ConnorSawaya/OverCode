import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { For, Show, createEffect, createMemo, createSignal, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import "./settings-v2/settings-v2.css"

const statusLabels = {
  disabled: "settings.mobileAccess.status.disabled",
  starting: "settings.mobileAccess.status.starting",
  online: "settings.mobileAccess.status.online",
  stopping: "settings.mobileAccess.status.stopping",
  error: "settings.mobileAccess.status.error",
} as const

const errorLabels = {
  relay_not_configured: "settings.mobileAccess.error.relayNotConfigured",
  secure_storage_unavailable: "settings.mobileAccess.error.secureStorage",
  local_server_unavailable: "settings.mobileAccess.error.localServer",
  relay_connection_failed: "settings.mobileAccess.error.connection",
} as const

export function MobileAccessSettings() {
  const language = useLanguage()
  const platform = usePlatform()
  const access = platform.mobileAccess
  const [state, setState] = createStore(access?.state() ?? { status: "disabled" as const })
  const [busy, setBusy] = createStore({ value: false })
  const [clock, setClock] = createSignal(Date.now())
  let qrCanvas: HTMLCanvasElement | undefined

  onMount(() => {
    if (!access) return
    const unsubscribe = access.onState((next) => setState(next))
    const timer = setInterval(() => setClock(Date.now()), 1000)
    return () => {
      unsubscribe()
      clearInterval(timer)
    }
  })

  createEffect(() => {
    const value = state.pairUri
    if (!value || !qrCanvas) return
    void import("qrcode").then((module) => {
      if (!qrCanvas || state.pairUri !== value) return
      void module.toCanvas(qrCanvas, value, {
        width: 192,
        margin: 1,
        color: { dark: "#211e1e", light: "#ffffff" },
      })
    })
  })

  const status = createMemo(() => language.t(statusLabels[state.status]))
  const error = createMemo(() => (state.error ? language.t(errorLabels[state.error as keyof typeof errorLabels] ?? "settings.mobileAccess.error.unknown") : ""))
  const pairingSeconds = createMemo(() => Math.max(0, Math.ceil(((state.pairExpiresAt ?? 0) - clock()) / 1000)))
  const pairingActive = createMemo(() => !!state.pairUri && !!state.pairCode && pairingSeconds() > 0)
  const pairingCountdown = createMemo(() => {
    const seconds = pairingSeconds()
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
  })

  const run = async (action: () => Promise<unknown>) => {
    if (busy.value) return
    setBusy("value", true)
    await action().catch(() => undefined)
    setBusy("value", false)
  }

  const copyPairingUri = () => {
    if (!state.pairUri) return
    void navigator.clipboard?.writeText(state.pairUri)
  }

  const copyPairingCode = () => {
    if (!state.pairCode) return
    void navigator.clipboard?.writeText(state.pairCode)
  }

  return (
    <Show when={access}>
      <section class="settings-v2-section settings-mobile-access" data-component="mobile-access-settings">
        <h3 class="settings-v2-section-title">{language.t("settings.mobileAccess.title")}</h3>
        <SettingsMobileAccessIntro />
        <div class="settings-mobile-access-status" data-status={state.status}>
          <span class="settings-mobile-access-status-dot" />
          <span>{status()}</span>
          <Show when={state.relayUrl}>
            <span class="settings-mobile-access-relay">{state.relayUrl}</span>
          </Show>
        </div>
        <Show when={error()}>
          <p class="settings-mobile-access-error" role="alert">
            {error()}
          </p>
        </Show>
        <Show
          when={state.status !== "disabled"}
          fallback={
            <ButtonV2
              size="normal"
              variant="contrast"
              disabled={busy.value}
              data-action="settings-mobile-access-start"
              onClick={() => void run(() => access!.start())}
            >
              {language.t("settings.mobileAccess.start")}
            </ButtonV2>
          }
        >
          <Show
            when={pairingActive()}
            fallback={
              <div class="settings-mobile-access-expired">
                <p>{language.t("settings.mobileAccess.codeExpired")}</p>
                <ButtonV2 size="normal" variant="contrast" disabled={busy.value} onClick={() => void run(() => access!.newPairingCode())}>
                  {language.t("settings.mobileAccess.newCode")}
                </ButtonV2>
              </div>
            }
          >
            <div class="settings-mobile-access-pairing">
              <div class="settings-mobile-access-qr-wrap">
                <canvas ref={qrCanvas} class="settings-mobile-access-qr" aria-label={language.t("settings.mobileAccess.qrLabel")} />
              </div>
              <div class="settings-mobile-access-pairing-copy">
                <strong>{language.t("settings.mobileAccess.pairingTitle")}</strong>
                <p>{language.t("settings.mobileAccess.pairingDescription")}</p>
                <Show when={state.pairCode}>
                  <div class="settings-mobile-access-code-row">
                    <span class="settings-mobile-access-code" aria-label={language.t("settings.mobileAccess.codeLabel")}>{state.pairCode}</span>
                    <ButtonV2 size="normal" variant="neutral" onClick={copyPairingCode}>
                      {language.t("settings.mobileAccess.copyCode")}
                    </ButtonV2>
                  </div>
                  <span class="settings-mobile-access-expiry" aria-live="polite">
                    {language.t("settings.mobileAccess.codeCountdown", { time: pairingCountdown() })}
                  </span>
                </Show>
                <TextInputV2
                  type="text"
                  value={state.pairUri ?? ""}
                  readOnly
                  spellcheck={false}
                  aria-label={language.t("settings.mobileAccess.pairingUri")}
                />
                <div class="settings-mobile-access-actions">
                  <ButtonV2 size="normal" variant="neutral" onClick={copyPairingUri}>
                    {language.t("settings.mobileAccess.copy")}
                  </ButtonV2>
                  <ButtonV2
                    size="normal"
                    variant="neutral"
                    disabled={busy.value}
                    onClick={() => void run(() => access!.newPairingCode())}
                  >
                    {language.t("settings.mobileAccess.newCode")}
                  </ButtonV2>
                  <ButtonV2
                    size="normal"
                    variant="neutral"
                    disabled={busy.value}
                    onClick={() => void run(() => access!.rotate())}
                  >
                    {language.t("settings.mobileAccess.rotate")}
                  </ButtonV2>
                </div>
              </div>
            </div>
          </Show>
          <Show when={(state.devices?.length ?? 0) > 0}>
            <div class="settings-mobile-access-devices">
              <strong>{language.t("settings.mobileAccess.devicesTitle")}</strong>
              <For each={state.devices}>
                {(device) => (
                  <div class="settings-mobile-access-device">
                    <div>
                      <span class="settings-mobile-access-device-name">{device.name}</span>
                      <span class="settings-mobile-access-device-meta">{language.t("settings.mobileAccess.deviceLastSeen", { date: new Date(device.lastSeen).toLocaleString() })}</span>
                    </div>
                    <Show when={access?.revokeDevice}>
                      <ButtonV2
                        size="normal"
                        variant="danger"
                        disabled={busy.value}
                        onClick={() => void run(() => access!.revokeDevice!(device.id))}
                      >
                        {language.t("settings.mobileAccess.removeDevice")}
                      </ButtonV2>
                    </Show>
                  </div>
                )}
              </For>
            </div>
          </Show>
          <div class="settings-mobile-access-actions">
            <ButtonV2
              size="normal"
              variant="neutral"
              disabled={busy.value}
              onClick={() => void run(() => access!.stop())}
            >
              {language.t("settings.mobileAccess.stop")}
            </ButtonV2>
            <ButtonV2
              size="normal"
              variant="danger"
              disabled={busy.value}
              onClick={() => void run(() => access!.revoke())}
            >
              {language.t("settings.mobileAccess.revoke")}
            </ButtonV2>
          </div>
        </Show>
      </section>
    </Show>
  )
}

function SettingsMobileAccessIntro() {
  const language = useLanguage()
  return <p class="settings-mobile-access-description">{language.t("settings.mobileAccess.description")}</p>
}
