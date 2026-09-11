import { Show, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { usePlatform } from "@/context/platform"
import { parseMcpConnection } from "./tools-config"

export function SettingsToolAdd(props: { directory: Accessor<string | undefined>; onAdded: () => Promise<void>; onSkill: (url: string) => void }) {
  const language = useLanguage()
  const sdk = useServerSDK()
  const sync = useServerSync()
  const platform = usePlatform()
  const [state, setState] = createStore({ name: "", connection: "", pending: false, error: "", open: false })

  const add = async () => {
    const directory = props.directory()
    if (!directory || state.pending) return
    const name = state.name.trim()
    const config = parseMcpConnection(state.connection)
    if (!/^[a-zA-Z0-9_-]+$/.test(name) || !config) {
      setState("error", language.t("settings.tools.mcp.invalid"))
      return
    }
    if (Object.hasOwn(sync().data.config.mcp ?? {}, name)) {
      setState("error", language.t("settings.tools.mcp.duplicate"))
      return
    }
    setState({ pending: true, error: "" })
    try {
      // Persist first so a failed connection remains visible and can be retried.
      await sync().updateConfig({ mcp: { ...sync().data.config.mcp, [name]: config } })
      await sdk().client.mcp.add({ directory, name, config })
      await props.onAdded()
      setState({ name: "", connection: "", open: false })
    } catch (error) {
      setState("error", error instanceof Error ? error.message : String(error))
      await props.onAdded().catch(() => {})
    } finally {
      setState("pending", false)
    }
  }

  return (
    <section class="settings-v2-section" data-component="tools-discover">
      <h3 class="settings-v2-section-title">{language.t("settings.tools.getMore")}</h3>
      <p class="settings-v2-tools-section-description">{language.t("settings.tools.getMore.help")}</p>
      <div class="settings-v2-tools-actions">
        <ButtonV2 variant="neutral" size="normal" icon="plus" disabled={!props.directory()} onClick={() => setState("open", !state.open)}>{language.t("settings.tools.mcp.add")}</ButtonV2>
        <ButtonV2 variant="ghost" size="normal" onClick={() => platform.openExternal("https://github.com/modelcontextprotocol/servers")}>{language.t("settings.tools.browseMcp")}</ButtonV2>
        <ButtonV2 variant="ghost" size="normal" onClick={() => platform.openExternal("https://github.com/anthropics/skills/tree/main/skills")}>{language.t("settings.tools.browseSkills")}</ButtonV2>
      </div>
      <div class="settings-v2-tools-pair">
        <div class="settings-v2-tool-copy">
          <span class="settings-v2-tool-name">{language.t("settings.tools.webPair")}</span>
          <p class="settings-v2-tool-meta settings-v2-skill-description">{language.t("settings.tools.webPair.help")}</p>
        </div>
        <div class="settings-v2-tools-actions">
          <ButtonV2 variant="ghost" size="small" onClick={() => {
            props.onSkill("https://github.com/anthropics/skills/tree/main/skills/frontend-design")
            const input = document.querySelector<HTMLInputElement>('[data-component="skill-source-input"]')
            input?.scrollIntoView({ block: "center" })
            input?.focus({ preventScroll: true })
          }}>{language.t("settings.tools.chooseSkill")}</ButtonV2>
          <ButtonV2 variant="ghost" size="small" onClick={() => setState({ open: true, name: "playwright", connection: '["npx", "-y", "@playwright/mcp@latest"]' })}>{language.t("settings.tools.chooseBrowser")}</ButtonV2>
        </div>
      </div>
      <Show when={state.open}>
        <form class="settings-v2-tools-add-form" onSubmit={(event) => { event.preventDefault(); void add() }}>
          <label>{language.t("settings.tools.mcp.name")}<TextInputV2 value={state.name} onInput={(event) => setState("name", event.currentTarget.value)} required /></label>
          <label>{language.t("settings.tools.mcp.connection")}<TextInputV2 value={state.connection} onInput={(event) => setState("connection", event.currentTarget.value)} required spellcheck={false} /></label>
          <p class="settings-v2-tools-section-description">{language.t("settings.tools.mcp.connectionHelp")}</p>
          <Show when={state.error}><p role="alert" class="settings-v2-tools-error">{state.error}</p></Show>
          <div class="settings-v2-tools-actions">
            <ButtonV2 type="submit" variant="neutral" size="normal" disabled={state.pending || !props.directory()}>{language.t(state.pending ? "settings.tools.connecting" : "settings.tools.mcp.add")}</ButtonV2>
            <ButtonV2 type="button" variant="ghost" size="normal" disabled={state.pending} onClick={() => setState("open", false)}>{language.t("common.cancel")}</ButtonV2>
          </div>
        </form>
      </Show>
    </section>
  )
}
