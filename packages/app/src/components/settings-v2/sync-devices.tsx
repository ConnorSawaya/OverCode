import { For, Show, createMemo, createSignal, onMount } from "solid-js"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { createStore } from "solid-js/store"
import { MobileAccessSettings } from "../mobile-access-settings"

export function SettingsSyncDevices() {
  const language = useLanguage()
  const platform = usePlatform()
  const sync = platform.syncDevices
  const [state, setState] = createStore(sync?.state() ?? { status: "disabled" as const, peers: [], projects: [] })
  const [busy, setBusy] = createSignal(false)
  const [code, setCode] = createSignal("")
  const [mappingBusy, setMappingBusy] = createSignal<string>()

  onMount(() => {
    if (!sync) return
    const unsubscribe = sync.onState((next) => setState(next))
    void sync.syncNow()
    return unsubscribe
  })

  const status = createMemo(() => {
    if (state.status === "online") return language.t("settings.syncDevices.status.online")
    if (state.status === "syncing") return language.t("settings.syncDevices.status.syncing")
    if (state.status === "pairing") return language.t("settings.syncDevices.status.pairing")
    if (state.status === "error") return language.t("settings.syncDevices.status.error")
    if (state.status === "offline") return language.t("settings.syncDevices.status.offline")
    return language.t("settings.syncDevices.status.disabled")
  })

  const syncNow = async () => {
    if (!sync || busy()) return
    setBusy(true)
    await sync.syncNow().catch(() => undefined)
    setBusy(false)
  }

  const connect = async () => {
    if (!sync || busy() || code().length !== 6) return
    setBusy(true)
    await sync.pair(code()).catch(() => undefined)
    setCode("")
    setBusy(false)
  }

  const removePeer = async (deviceId: string) => {
    if (!sync || busy()) return
    setBusy(true)
    await sync.removePeer(deviceId).catch(() => undefined)
    setBusy(false)
  }

  const mapProject = async (projectID: string) => {
    if (!sync || mappingBusy() || platform.platform !== "desktop") return
    const picked = await platform.openDirectoryPickerDialog({ title: language.t("settings.syncDevices.mapFolder") })
    const directory = Array.isArray(picked) ? picked[0] : picked
    if (!directory) return
    setMappingBusy(projectID)
    await sync.mapProject(projectID, directory).catch(() => undefined)
    setMappingBusy()
  }

  const error = createMemo(() => {
    if (state.error === "invalid_pairing_code") return language.t("settings.syncDevices.invalidCode")
    if (state.error === "pairing_failed") return language.t("settings.syncDevices.pairingFailed")
    return state.error ? language.t("settings.syncDevices.error") : ""
  })

  return (
    <>
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">{language.t("settings.syncDevices.title")}</h2>
      </div>
      <div class="settings-v2-tab-body">
        <Show when={platform.platform === "desktop" && sync} fallback={<p>{language.t("settings.syncDevices.desktopOnly")}</p>}>
          <MobileAccessSettings />
          <section class="settings-v2-section settings-sync-devices-overview">
            <h3 class="settings-v2-section-title">{language.t("settings.syncDevices.connectionTitle")}</h3>
            <p class="settings-sync-devices-copy">{language.t("settings.syncDevices.description")}</p>
            <div class="settings-mobile-access-status" data-status={state.status}>
              <span class="settings-mobile-access-status-dot" />
              <span>{status()}</span>
              <Show when={state.lastSynced}>
                <span class="settings-mobile-access-relay">
                  {language.t("settings.syncDevices.lastSynced", { date: new Date(state.lastSynced!).toLocaleString() })}
                </span>
              </Show>
            </div>
            <Show when={state.error}>
              <p class="settings-mobile-access-error" role="alert">{error()}</p>
            </Show>
            <Show when={state.peers.length > 0}>
              <div class="settings-mobile-access-devices">
                <strong>{language.t("settings.syncDevices.trustedTitle")}</strong>
                <For each={state.peers}>
                  {(device) => (
                    <div class="settings-mobile-access-device">
                      <div>
                        <span class="settings-mobile-access-device-name">{device.name}</span>
                        <span class="settings-mobile-access-device-meta">
                          {device.status === "online"
                            ? language.t("settings.syncDevices.deviceOnline")
                            : language.t("settings.syncDevices.deviceLastSeen", { date: new Date(device.lastSeen).toLocaleString() })}
                        </span>
                      </div>
                      <ButtonV2
                        size="normal"
                        variant="danger"
                        disabled={busy()}
                        onClick={() => void removePeer(device.id)}
                      >
                        {language.t("settings.syncDevices.remove")}
                      </ButtonV2>
                    </div>
                  )}
                </For>
              </div>
            </Show>
            <ButtonV2 size="normal" variant="neutral" disabled={busy()} onClick={() => void syncNow()}>
              {language.t("settings.syncDevices.syncNow")}
            </ButtonV2>
          </section>
          <Show when={state.projects.length > 0}>
            <section class="settings-v2-section settings-sync-devices-projects">
              <h3 class="settings-v2-section-title">{language.t("settings.syncDevices.projectsTitle")}</h3>
              <p class="settings-sync-devices-copy">{language.t("settings.syncDevices.projectsDescription")}</p>
              <For each={state.projects}>
                {(project) => (
                  <div class="settings-mobile-access-device settings-sync-devices-project">
                    <div>
                      <span class="settings-mobile-access-device-name">{project.name ?? project.projectID}</span>
                      <span class="settings-mobile-access-device-meta">
                        {project.localWorktree ?? language.t("settings.syncDevices.projectNeedsFolder")}
                      </span>
                    </div>
                    <ButtonV2
                      size="normal"
                      variant="neutral"
                      disabled={mappingBusy() === project.projectID}
                      onClick={() => void mapProject(project.projectID)}
                    >
                      {mappingBusy() === project.projectID
                        ? language.t("settings.syncDevices.mapping")
                        : language.t("settings.syncDevices.mapFolder")}
                    </ButtonV2>
                  </div>
                )}
              </For>
            </section>
          </Show>
          <section class="settings-v2-section settings-sync-devices-connect">
            <h3 class="settings-v2-section-title">{language.t("settings.syncDevices.connectTitle")}</h3>
            <p class="settings-sync-devices-copy">{language.t("settings.syncDevices.connectDescription")}</p>
            <form
              class="settings-sync-devices-connect-form"
              onSubmit={(event) => {
                event.preventDefault()
                void connect()
              }}
            >
              <input
                class="settings-sync-devices-code"
                value={code()}
                onInput={(event) => setCode(event.currentTarget.value.replace(/\D/g, "").slice(0, 6))}
                placeholder={language.t("settings.syncDevices.codePlaceholder")}
                aria-label={language.t("settings.syncDevices.codeLabel")}
                inputmode="numeric"
                autocomplete="one-time-code"
                maxlength={6}
                spellcheck={false}
              />
              <ButtonV2 type="submit" size="normal" variant="contrast" disabled={busy() || code().length !== 6}>
                {busy() ? language.t("settings.syncDevices.pairing") : language.t("settings.syncDevices.connect")}
              </ButtonV2>
            </form>
          </section>
        </Show>
      </div>
    </>
  )
}
