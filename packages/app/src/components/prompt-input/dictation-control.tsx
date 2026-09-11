import { createEffect, on, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import type { PromptInputV2Prompt } from "@opencode-ai/session-ui/v2/prompt-input"
import type { PromptInputV2ComposerController } from "../prompt-input-v2"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useSettings } from "@/context/settings"
import { getSpeechRecognitionCtor } from "@/utils/runtime-adapters"
import { startDictationCapture } from "@/utils/dictation-capture"
import { createDictationQueue } from "@/utils/dictation-queue"
import { showToast } from "@/utils/toast"

type BrowserRecognition = {
  continuous: boolean
  interimResults: boolean
  lang: string
  maxAlternatives: number
  onresult:
    | ((event: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0?: { transcript: string } }> }) => void)
    | null
  onerror: ((event: { error?: string }) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
  abort(): void
}
const promptText = (parts: PromptInputV2Prompt) => parts.map((part) => ("content" in part ? part.content : "")).join("")
type Capture = {
  id: string
  abort: AbortController
  capture?: Awaited<ReturnType<typeof startDictationCapture>>
  queue?: ReturnType<typeof createDictationQueue>
  browser?: BrowserRecognition
}

type DictationControlProps = {
  controller?: PromptInputV2ComposerController
  getText?: () => string
  onText?: (text: string) => void
  restoreFocus?: () => void
  sessionID?: string
}

export function DictationControl(props: DictationControlProps) {
  const language = useLanguage()
  const settings = useSettings()
  const platform = usePlatform()
  const speech = platform.speech
  // Chromium exposes recognition in Electron even when its cloud service is
  // unavailable. Never race the native availability check into that fallback.
  const ctor = speech ? undefined : getSpeechRecognitionCtor<BrowserRecognition>(window)
  const [state, setState] = createStore({
    phase: "idle" as "idle" | "loading" | "downloading" | "listening" | "finishing",
    percent: 0,
    level: 0,
    available: false,
  })
  let current: Capture | undefined
  if (speech)
    void speech
      .isAvailable()
      .then((available) => setState("available", available))
      .catch(() => undefined)
  const progressCleanup = speech?.onProgress((progress) => {
    if (!current || !["loading", "downloading"].includes(state.phase) || progress.phase === "ready") return
    setState({ phase: progress.phase, percent: progress.percent ?? 0 })
  })
  const cancel = () => {
    const previous = current
    current = undefined
    previous?.abort.abort()
    previous?.queue?.cancel()
    previous?.browser?.abort()
    if (previous) void speech?.cancel(previous.id)
    setState({ phase: "idle", level: 0 })
  }
  const fail = (error: unknown) => {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    const permission = /NotAllowedError|PermissionDenied|not-allowed/i.test(message)
    cancel()
    showToast({
      variant: "error",
      title: language.t(permission ? "prompt.voice.permission" : "prompt.voice.error"),
      description: language.t(
        permission
          ? "prompt.voice.permission.description"
          : /NotFoundError|OverconstrainedError|device-lost/.test(message)
            ? "prompt.voice.deviceMissing"
            : /download|fetch|network/i.test(message)
              ? "prompt.voice.downloadError"
              : "prompt.voice.error.description",
      ),
    })
  }
  const targetParts = () => {
    if (props.controller) return props.controller.parts()
    const text = props.getText?.() ?? ""
    return [{ type: "text", content: text, start: 0, end: text.length }] as PromptInputV2Prompt
  }
  const restoreFocus = () => props.controller?.restoreFocus() ?? props.restoreFocus?.()
  const stop = async () => {
    const active = current
    if (!active) return
    if (state.phase !== "listening") {
      cancel()
      return
    }
    setState({ phase: "finishing", level: 0 })
    if (active.browser) {
      active.browser.stop()
      return
    }
    try {
      await active.capture?.stop()
      await active.queue?.drain()
      if (current === active) cancel()
    } catch (error) {
      if (current === active) fail(error)
    }
  }
  const start = async () => {
    if (current) return
    const active: Capture = { id: crypto.randomUUID(), abort: new AbortController() }
    current = active
    const base = targetParts().map((part) => ({ ...part })) as PromptInputV2Prompt
    const attachments = props.controller ? JSON.stringify(base.filter((part) => part.type !== "text")) : ""
    let lastText = promptText(base)
    const update = (text: string) => {
      if (current !== active) return
      // Typing, sending, or clearing the composer wins over pending recognition.
      if (
        promptText(targetParts()) !== lastText ||
        (props.controller
          ? JSON.stringify(targetParts().filter((part) => part.type !== "text")) !== attachments
          : false)
      ) {
        cancel()
        return
      }
      const next = base.map((part) => ({ ...part })) as PromptInputV2Prompt
      const appended = (lastText && promptText(base).trim() && text ? " " : "") + text
      const last = next.at(-1)
      if (last?.type === "text") {
        last.content += appended
        last.end = last.start + last.content.length
      } else next.push({ type: "text", content: appended, start: 0, end: appended.length })
      lastText = promptText(next)
      if (props.controller) props.controller.onInput(lastText, next, lastText.length)
      else props.onText?.(lastText)
    }
    const spokenLanguage = settings.general.dictationLanguage() || navigator.language || "en-US"
    if (speech && state.available) {
      setState("phase", "loading")
      try {
        await speech.prepare()
        if (current !== active) return
        const segments = new Map<number, string>()
        active.queue = createDictationQueue({
          transcribe: async (chunk) => {
            const result = await speech.transcribe({
              captureID: active.id,
              requestID: chunk.revision,
              audio: chunk.audio,
              language: spokenLanguage,
            })
            if (result.captureID !== active.id || result.requestID !== chunk.revision)
              throw new Error("speech-wrong-capture")
            return result.text
          },
          onResult: (chunk, text) => {
            if (current !== active) return
            segments.set(chunk.segment, text)
            update(
              [...segments.entries()]
                .sort(([a], [b]) => a - b)
                .map(([, text]) => text)
                .filter(Boolean)
                .join(" "),
            )
          },
          onError: (error) => {
            if (current === active) fail(error)
          },
        })
        active.capture = await startDictationCapture({
          deviceID: settings.general.dictationDevice(),
          signal: active.abort.signal,
          onChunk: active.queue.add,
          onLevel: (level) => {
            if (current === active) setState("level", level)
          },
          onDeviceLost: () => {
            if (current === active) fail(new Error("device-lost"))
          },
        })
        if (current !== active) {
          void active.capture.stop()
          return
        }
        setState("phase", "listening")
        restoreFocus()
      } catch (error) {
        if (current === active) fail(error)
      }
      return
    }
    if (!ctor) {
      cancel()
      return
    }
    // Web-only fallback; packaged Windows builds use the local engine above.
    const recognition = new ctor()
    active.browser = recognition
    recognition.continuous = true
    recognition.interimResults = true
    recognition.maxAlternatives = 1
    recognition.lang = spokenLanguage === "auto" ? navigator.language : spokenLanguage
    let committed = ""
    const segments = new Map<number, { text: string; final: boolean }>()
    const text = () =>
      [...segments.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, value]) => value.text.trim())
        .join(" ")
    recognition.onresult = (event) => {
      if (current !== active) return
      for (let index = event.resultIndex; index < event.results.length; index++) {
        const result = event.results[index]
        if (result?.[0]) segments.set(index, { text: result[0].transcript, final: result.isFinal })
      }
      update([committed, text()].filter(Boolean).join(" "))
    }
    recognition.onerror = (event) => {
      if (current !== active || event.error === "no-speech" || event.error === "aborted") return
      fail(new Error(event.error))
    }
    recognition.onend = () => {
      if (current !== active) return
      if (state.phase === "finishing") {
        cancel()
        return
      }
      const final = [...segments.entries()]
        .sort(([a], [b]) => a - b)
        .filter(([, value]) => value.final)
        .map(([, value]) => value.text.trim())
        .join(" ")
      committed = [committed, final].filter(Boolean).join(" ")
      segments.clear()
      try {
        recognition.start()
      } catch (error) {
        fail(error)
      }
    }
    try {
      recognition.start()
      setState("phase", "listening")
      restoreFocus()
    } catch (error) {
      fail(error)
    }
  }
  createEffect(on(() => props.sessionID, cancel, { defer: true }))
  onCleanup(() => {
    cancel()
    progressCleanup?.()
  })
  const busy = () => state.phase !== "idle"
  const label = () => {
    if (state.phase === "downloading") return language.t("prompt.voice.downloading", { percent: state.percent })
    if (state.phase === "loading") return language.t("prompt.voice.loading")
    if (state.phase === "finishing") return language.t("prompt.voice.finishing")
    if (!state.available && !ctor) return language.t("prompt.voice.unavailable")
    return language.t(state.phase === "listening" ? "prompt.voice.stop" : "prompt.voice.start")
  }
  return (
    <div class="flex items-center gap-1 min-w-0">
      <Show when={busy()}>
        <span role="status" class="max-w-40 truncate text-11-regular text-v2-text-text-subtle">
          {state.phase === "listening" ? language.t("prompt.voice.listening") : label()}
        </span>
      </Show>
      <TooltipV2 placement="top" gutter={4} value={label()}>
        <button
          type="button"
          disabled={!state.available && !ctor}
          aria-label={label()}
          aria-pressed={busy()}
          class="relative flex size-7 shrink-0 items-center justify-center rounded-md text-v2-icon-icon-muted transition-colors hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base focus-visible:outline focus-visible:outline-2 focus-visible:outline-v2-text-text-accent disabled:opacity-45"
          classList={{ "bg-v2-overlay-simple-overlay-hover text-v2-text-text-accent": busy() }}
          onClick={() => void (busy() ? stop() : start())}
        >
          <Icon name="microphone" size="small" />
          <span
            aria-hidden="true"
            class="pointer-events-none absolute inset-[4px] rounded-full border border-v2-text-text-accent transition-[opacity,transform] duration-75 motion-reduce:transition-none"
            style={{
              opacity: state.phase === "listening" ? 0.15 + state.level * 0.85 : 0,
              transform: `scale(${0.65 + state.level * 0.6})`,
            }}
          />
        </button>
      </TooltipV2>
    </div>
  )
}
