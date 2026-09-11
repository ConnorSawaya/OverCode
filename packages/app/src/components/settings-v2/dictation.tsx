import { createEffect, createMemo, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { useLanguage } from "@/context/language"
import { useSettings } from "@/context/settings"
import { showToast } from "@/utils/toast"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"

export function DictationSettings() {
  const language = useLanguage()
  const settings = useSettings()
  const [state, setState] = createStore({ devices: [] as MediaDeviceInfo[], testing: false, level: 0, heard: false })
  let stream: MediaStream | undefined
  let context: AudioContext | undefined
  let frame = 0
  let generation = 0
  const refresh = async () => {
    const devices = await navigator.mediaDevices?.enumerateDevices().catch(() => [])
    setState(
      "devices",
      (devices ?? []).filter(
        (device) => device.kind === "audioinput" && device.deviceId && device.deviceId !== "default",
      ),
    )
  }
  const stop = () => {
    generation++
    cancelAnimationFrame(frame)
    stream?.getTracks().forEach((track) => track.stop())
    stream = undefined
    if (context) void context.close().catch(() => undefined)
    context = undefined
    setState({ testing: false, level: 0, heard: false })
  }
  const test = async () => {
    stop()
    const attempt = generation
    setState("testing", true)
    try {
      const selected = settings.general.dictationDevice()
      const input = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: selected ? { exact: selected } : undefined,
          noiseSuppression: true,
          echoCancellation: true,
          autoGainControl: true,
        },
      })
      if (attempt !== generation) {
        input.getTracks().forEach((track) => track.stop())
        return
      }
      stream = input
      await refresh()
      if (attempt !== generation) return
      context = new AudioContext()
      const analyser = context.createAnalyser()
      analyser.fftSize = 512
      context.createMediaStreamSource(input).connect(analyser)
      await context.resume()
      const samples = new Float32Array(512)
      const tick = () => {
        if (attempt !== generation) return
        analyser.getFloatTimeDomainData(samples)
        const rms = Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length)
        setState({ level: Math.min(1, Math.sqrt(rms) * 2.5), heard: state.heard || rms > 0.004 })
        frame = requestAnimationFrame(tick)
      }
      tick()
    } catch {
      if (attempt !== generation) return
      stop()
      showToast({
        variant: "error",
        title: language.t("prompt.voice.error"),
        description: language.t("prompt.voice.deviceMissing"),
      })
    }
  }
  void refresh()
  navigator.mediaDevices?.addEventListener("devicechange", refresh)
  createEffect(() => {
    settings.general.dictationDevice()
    stop()
  })
  onCleanup(() => {
    stop()
    navigator.mediaDevices?.removeEventListener("devicechange", refresh)
  })
  const devices = createMemo(() => [
    { id: "default", name: language.t("settings.dictation.default") },
    ...state.devices.map((device, index) => ({
      id: device.deviceId,
      name: device.label || language.t("settings.dictation.device", { number: index + 1 }),
    })),
  ])
  const languages = () => [
    { id: "auto", name: language.t("settings.dictation.auto") },
    { id: "en-US", name: "English" },
    { id: "es", name: "Español" },
    { id: "fr", name: "Français" },
    { id: "de", name: "Deutsch" },
    { id: "it", name: "Italiano" },
    { id: "pt", name: "Português" },
    { id: "ja", name: "日本語" },
    { id: "zh", name: "中文" },
    { id: "ko", name: "한국어" },
    { id: "ar", name: "العربية" },
    { id: "hi", name: "हिन्दी" },
  ]
  return (
    <div class="settings-v2-section">
      <h3 class="settings-v2-section-title">{language.t("settings.dictation.title")}</h3>
      <p class="mb-3 text-12-regular text-v2-text-text-subtle">{language.t("settings.dictation.description")}</p>
      <SettingsListV2>
        <SettingsRowV2 title={language.t("settings.dictation.microphone")} description="">
          <SelectV2
            appearance="inline"
            options={devices()}
            current={
              devices().find((item) => item.id === (settings.general.dictationDevice() || "default")) ?? devices()[0]
            }
            value={(item) => item.id}
            label={(item) => item.name}
            onSelect={(item) => {
              if (item) settings.general.setDictationDevice(item.id === "default" ? "" : item.id)
            }}
          />
        </SettingsRowV2>
        <SettingsRowV2 title={language.t("settings.dictation.language")} description="">
          <SelectV2
            appearance="inline"
            options={languages()}
            current={languages().find((item) => item.id === settings.general.dictationLanguage()) ?? languages()[0]}
            value={(item) => item.id}
            label={(item) => item.name}
            onSelect={(item) => {
              if (item) settings.general.setDictationLanguage(item.id)
            }}
          />
        </SettingsRowV2>
        <SettingsRowV2 title={language.t("settings.dictation.test")} description="">
          <ButtonV2 variant="outline" onClick={() => (state.testing ? stop() : void test())}>
            {language.t(state.testing ? "settings.dictation.stop" : "settings.dictation.test")}
          </ButtonV2>
        </SettingsRowV2>
      </SettingsListV2>
      <Show when={state.testing}>
        <div
          role="meter"
          aria-label={language.t("settings.dictation.microphone")}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(state.level * 100)}
          class="mt-3 h-1.5 overflow-hidden rounded-full bg-v2-overlay-simple-overlay-hover"
        >
          <div class="h-full origin-left bg-v2-text-text-accent" style={{ transform: `scaleX(${state.level})` }} />
        </div>
        <p role="status" class="mt-2 text-12-regular text-v2-text-text-subtle">
          {language.t(state.heard ? "settings.dictation.signal" : "settings.dictation.silent")}
        </p>
      </Show>
    </div>
  )
}
