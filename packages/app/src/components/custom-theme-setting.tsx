import { For, Show, type Component } from "solid-js"
import { createStore } from "solid-js/store"
import { ButtonV2 } from "@overcode-ai/ui/v2/button-v2"
import { TextInputV2 } from "@overcode-ai/ui/v2/text-input-v2"
import { loadThemeFromUrl, parseDesktopTheme, useTheme } from "@overcode-ai/ui/theme"
import { useLanguage } from "@/context/language"
import { SettingsRowV2 } from "./settings-v2/parts/row"

const MAX_THEME_BYTES = 256 * 1024

export const CustomThemeSetting: Component<{ legacy?: boolean }> = (props) => {
  const language = useLanguage()
  const theme = useTheme()
  const [state, setState] = createStore({ url: "", pending: false, error: "" })
  let fileInput: HTMLInputElement | undefined

  const install = (value: unknown) => {
    const parsed = parseDesktopTheme(value)
    if (!theme.registerTheme(parsed)) {
      throw new Error("Theme id is already used by a built-in theme.")
    }
    theme.setTheme(parsed.id)
    setState({ url: "", error: "" })
  }

  const importUrl = async () => {
    const url = state.url.trim()
    if (!url || state.pending) return
    setState({ pending: true, error: "" })
    try {
      install(await loadThemeFromUrl(url))
    } catch (error) {
      setState("error", error instanceof Error ? error.message : String(error))
    } finally {
      setState("pending", false)
    }
  }

  const chooseFile = () => fileInput?.click()

  const importFile = async (event: Event) => {
    const input = event.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    input.value = ""
    if (!file || state.pending) return
    if (file.size > MAX_THEME_BYTES) {
      setState("error", "Theme files must be 256 KB or smaller.")
      return
    }
    setState({ pending: true, error: "" })
    try {
      install(JSON.parse(await file.text()))
    } catch (error) {
      setState("error", error instanceof Error ? error.message : "Theme JSON is invalid.")
    } finally {
      setState("pending", false)
    }
  }

  const controls = () => (
    <div class={props.legacy ? "flex w-full flex-col items-stretch gap-2 sm:w-[360px]" : "settings-v2-theme-import"}>
      <form
        class="flex w-full flex-wrap items-center justify-end gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          void importUrl()
        }}
      >
        <TextInputV2
          class="min-w-[220px] flex-1"
          data-action="settings-theme-url"
          value={state.url}
          onInput={(event) => setState("url", event.currentTarget.value)}
          placeholder={language.t("settings.general.row.theme.urlPlaceholder")}
          aria-label={language.t("settings.general.row.theme.urlPlaceholder")}
          type="url"
          spellcheck={false}
          autocorrect="off"
          autocomplete="off"
          autocapitalize="off"
          disabled={state.pending}
        />
        <ButtonV2 type="submit" size="small" variant="outline" disabled={state.pending || !state.url.trim()}>
          {language.t("settings.general.row.theme.import")}
        </ButtonV2>
        <input ref={fileInput} class="hidden" type="file" accept="application/json,.json" onChange={importFile} />
        <ButtonV2 type="button" size="small" variant="ghost-muted" disabled={state.pending} onClick={chooseFile}>
          {language.t("settings.general.row.theme.file")}
        </ButtonV2>
      </form>
      <Show when={state.error}>
        <p class="settings-v2-tools-error" role="alert">
          {state.error}
        </p>
      </Show>
      <Show when={theme.customThemeIds().length > 0}>
        <div
          class="flex flex-wrap items-center justify-end gap-1.5"
          aria-label={language.t("settings.general.row.theme.customTitle")}
        >
          <For each={theme.customThemeIds()}>
            {(id) => (
              <span class="inline-flex items-center gap-1 rounded-md border border-v2-border-border-muted bg-v2-background-bg-layer-02 px-2 py-1 text-[11px] text-v2-text-text-base">
                {theme.name(id)}
                <button
                  type="button"
                  class="rounded px-1 text-v2-text-text-muted hover:bg-v2-background-bg-layer-03 hover:text-v2-text-text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-border-border-focus"
                  aria-label={`${language.t("settings.general.row.theme.remove")} ${theme.name(id)}`}
                  onClick={() => theme.removeCustomTheme(id)}
                >
                  ×
                </button>
              </span>
            )}
          </For>
        </div>
      </Show>
    </div>
  )

  if (props.legacy) return controls()
  return (
    <SettingsRowV2
      title={language.t("settings.general.row.theme.customTitle")}
      description={language.t("settings.general.row.theme.customDescription")}
    >
      {controls()}
    </SettingsRowV2>
  )
}
