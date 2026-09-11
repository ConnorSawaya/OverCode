import { For, Show, onCleanup, type JSX } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { TextField } from "@opencode-ai/ui/text-field"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { COMPUTER_USE_COLORS, computerUseColor, createComputerUseSettings } from "./computer-use-settings-state"
import "./computer-use-settings.css"

export function ComputerUseSettings(props: { v2?: boolean }) {
  const platform = usePlatform()
  const language = useLanguage()
  if (platform.platform !== "desktop" || !platform.computerUse) return null
  const controller = createComputerUseSettings(platform.computerUse)
  const state = controller.state
  onCleanup(controller.dispose)
  const color = () =>
    computerUseColor(state.color) ?? computerUseColor(state.value?.color ?? "") ?? COMPUTER_USE_COLORS[0]
  const status = () => {
    if (state.stopping || state.value?.phase === "stopping") return "computerUse.settings.stoppingStatus"
    if (state.loading) return "computerUse.settings.loading"
    if (!state.value?.available || state.value.phase === "error") return "computerUse.settings.error"
    if (state.value.phase === "active") return "computerUse.settings.active"
    if (state.value.phase === "starting") return "computerUse.settings.starting"
    return "computerUse.settings.inactive"
  }
  const Action = (button: { disabled?: boolean; onClick: () => void; children: JSX.Element }) => (
    <Show when={props.v2} fallback={<Button size="small" variant="secondary" {...button} />}>
      <ButtonV2 size="normal" variant="neutral" {...button} />
    </Show>
  )
  return (
    <section data-component="computer-use-settings" data-v2={props.v2 ? "true" : undefined}>
      <h3 class={props.v2 ? "settings-v2-section-title" : "text-14-medium text-text-strong"}>
        {language.t("computerUse.title")}
      </h3>
      <p data-slot="description">{language.t("computerUse.settings.description")}</p>
      <div data-slot="status-row">
        <p role="status" aria-live="polite">
          {language.t(status())}
        </p>
        <Show when={state.value?.phase === "active"}>
          <Action disabled={state.stopping} onClick={() => void controller.stop()}>
            {language.t(state.stopping ? "computerUse.settings.stopping" : "desktop.computerUse.overlay.stop")}
          </Action>
        </Show>
      </div>
      <Show when={state.error || (!state.loading && (!state.value?.available || state.value.phase === "error"))}>
        <div data-slot="error" role="alert">
          <Show when={state.error}>
            <p>
              {language.t(
                state.error === "save"
                  ? "computerUse.settings.colorFailed"
                  : state.error === "stop"
                    ? "computerUse.stopFailed"
                    : "computerUse.settings.error",
              )}
            </p>
          </Show>
          <Action disabled={state.loading} onClick={() => void controller.refresh()}>
            {language.t("computerUse.settings.refresh")}
          </Action>
        </div>
      </Show>
      <div data-slot="color-row">
        <div data-slot="color-label">
          <span>{language.t("computerUse.settings.color")}</span>
          <p data-slot="description">{language.t("computerUse.settings.colorDescription")}</p>
        </div>
        <div data-slot="color-input">
          <TextField
            label={language.t("computerUse.settings.color")}
            hideLabel
            value={state.color}
            placeholder={language.t("computerUse.settings.colorPlaceholder")}
            onChange={controller.editColor}
            disabled={controller.colorDisabled()}
            validationState={state.invalid ? "invalid" : "valid"}
            error={state.invalid ? language.t("computerUse.settings.colorInvalid") : undefined}
            spellcheck={false}
            autocomplete="off"
            onKeyDown={(event: KeyboardEvent) => {
              if (event.key !== "Enter") return
              event.preventDefault()
              void controller.saveColor()
            }}
          />
          <Action
            disabled={controller.colorDisabled() || !state.dirty || state.invalid}
            onClick={() => void controller.saveColor()}
          >
            {language.t(state.saving ? "computerUse.settings.colorSaving" : "computerUse.settings.colorSave")}
          </Action>
        </div>
      </div>
      <div data-slot="swatches" role="group" aria-label={language.t("computerUse.settings.color")}>
        <For each={COMPUTER_USE_COLORS}>
          {(swatch) => (
            <button
              type="button"
              data-slot="swatch"
              style={{ "--swatch": swatch }}
              aria-label={language.t("computerUse.settings.swatch", { color: swatch })}
              aria-pressed={color() === swatch}
              disabled={controller.colorDisabled()}
              onClick={() => {
                controller.editColor(swatch)
                void controller.saveColor(swatch)
              }}
            />
          )}
        </For>
      </div>
      <div
        data-slot="preview"
        role="img"
        aria-label={language.t("computerUse.settings.preview")}
        style={{ "--indicator": color() }}
      >
        <div data-slot="preview-frame" aria-hidden="true">
          <div data-slot="preview-pill">
            <span data-slot="preview-dot" />
            <span>{language.t("desktop.computerUse.overlay.active")}</span>
            <span data-slot="preview-stop">{language.t("desktop.computerUse.overlay.stop")}</span>
            <span>{language.t("desktop.computerUse.overlay.escape")}</span>
          </div>
        </div>
      </div>
      <p data-slot="description">{language.t("computerUse.settings.preview")}</p>
    </section>
  )
}
