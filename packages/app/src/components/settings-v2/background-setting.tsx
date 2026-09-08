import { For, Show, type Component } from "solid-js"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { useLanguage } from "@/context/language"
import { useSettings } from "@/context/settings"
import { BACKGROUND_PRESETS, type BackgroundPreset } from "@/utils/background"
import { SettingsRowV2 } from "./parts/row"

const MAX_BACKGROUND_BYTES = 4 * 1024 * 1024

const options: Array<{ id: BackgroundPreset; label: string; description: string; preview: string }> = [
  { id: "none", label: "Clean", description: "Solid surfaces", preview: "#171717" },
  { id: "aurora", label: "Aurora", description: "Indigo + teal", preview: BACKGROUND_PRESETS.aurora },
  { id: "ember", label: "Ember", description: "Warm sunset", preview: BACKGROUND_PRESETS.ember },
  { id: "ocean", label: "Ocean", description: "Deep blue", preview: BACKGROUND_PRESETS.ocean },
  { id: "forest", label: "Forest", description: "Quiet green", preview: BACKGROUND_PRESETS.forest },
]

export const BackgroundSetting: Component = () => {
  const language = useLanguage()
  const settings = useSettings()
  let input: HTMLInputElement | undefined

  const chooseFile = () => input?.click()

  const onFile = (event: Event) => {
    const file = (event.currentTarget as HTMLInputElement).files?.[0]
    if (!file) return
    if (!file.type.startsWith("image/") || file.size > MAX_BACKGROUND_BYTES) {
      ;(event.currentTarget as HTMLInputElement).value = ""
      return
    }

    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result !== "string") return
      settings.appearance.setBackgroundImage(reader.result)
      settings.appearance.setBackgroundPreset("custom")
    }
    reader.readAsDataURL(file)
  }

  const reset = () => {
    settings.appearance.setBackgroundImage("")
    settings.appearance.setBackgroundPreset("none")
    if (input) input.value = ""
  }

  return (
    <SettingsRowV2
      title={language.t("settings.general.row.background.title")}
      description={language.t("settings.general.row.background.description")}
    >
      <div class="flex w-full flex-col items-stretch gap-2 sm:w-[320px] sm:items-end">
        <div class="grid w-full grid-cols-3 gap-1.5">
          <For each={options}>
            {(option) => (
              <button
                type="button"
                class="group relative flex min-h-[58px] flex-col justify-end overflow-hidden rounded-md border border-v2-border-border-muted p-2 text-left transition-[border-color,transform] hover:-translate-y-px hover:border-v2-border-border-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-border-border-focus motion-reduce:transition-none"
                classList={{ "border-v2-border-border-focus": settings.appearance.backgroundPreset() === option.id }}
                style={{ background: option.preview }}
                aria-pressed={settings.appearance.backgroundPreset() === option.id}
                onClick={() => settings.appearance.setBackgroundPreset(option.id)}
              >
                <span class="relative z-10 text-[11px] font-[530] leading-4 text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]">
                  {option.label}
                </span>
                <span class="relative z-10 text-[10px] leading-3 text-white/75 drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]">
                  {option.description}
                </span>
              </button>
            )}
          </For>
          <Show when={settings.appearance.backgroundPreset() === "custom" && settings.appearance.backgroundImage()}>
            <button
              type="button"
              class="group relative flex min-h-[58px] flex-col justify-end overflow-hidden rounded-md border border-v2-border-border-focus bg-v2-background-bg-layer-02 p-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-v2-border-border-focus"
              style={{ "background-image": `url("${settings.appearance.backgroundImage()}")`, "background-size": "cover" }}
              aria-pressed="true"
              onClick={chooseFile}
            >
              <span class="relative z-10 text-[11px] font-[530] leading-4 text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]">
                {language.t("settings.general.row.background.custom")}
              </span>
            </button>
          </Show>
        </div>
        <div class="flex items-center gap-2">
          <input ref={input} class="hidden" type="file" accept="image/*" onChange={onFile} />
          <ButtonV2 size="small" variant="outline" icon="outline-share" onClick={chooseFile}>
            {language.t("settings.general.row.background.upload")}
          </ButtonV2>
          <Show when={settings.appearance.backgroundPreset() === "custom"}>
            <ButtonV2 size="small" variant="ghost-muted" onClick={reset}>
              {language.t("settings.general.row.background.remove")}
            </ButtonV2>
          </Show>
        </div>
      </div>
    </SettingsRowV2>
  )
}
