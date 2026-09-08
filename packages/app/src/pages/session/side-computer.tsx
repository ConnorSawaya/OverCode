import { createEffect, For, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Icon } from "@opencode-ai/ui/icon"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import type { ComputerFrame, ComputerStatus } from "@/context/computer"

export function ComputerPanel(props: { sessionID?: string }) {
  const language = useLanguage()
  const api = usePlatform().browser?.computer
  const [state, setState] = createStore({
    status: undefined as ComputerStatus | undefined,
    frame: undefined as ComputerFrame | undefined,
    error: "", pending: false, display: 0,
  })
  let disposed = false
  const owned = () => !!props.sessionID && state.status?.ownerSessionId === props.sessionID
  const active = () => owned() && state.status?.controller !== "off"
  const agent = () => active() && state.status?.controller === "agent"
  const apply = (status: ComputerStatus) => {
    if (disposed || (state.status && status.updatedAt < state.status.updatedAt)) return
    setState("status", status)
    if (status.ownerSessionId !== props.sessionID || status.controller === "off") setState("frame", undefined)
  }
  onMount(() => {
    if (!api) return
    void api.status().then(apply).catch(() => setState("error", language.t("computer.connectionError")))
    const stop = api.onEvent(apply)
    onCleanup(stop)
  })
  onCleanup(() => { disposed = true })
  const control = async (controller: ComputerStatus["controller"]) => {
    if (!api || !props.sessionID) return
    setState({ pending: true, error: "" })
    try { apply(await api.control(props.sessionID, controller)) }
    catch { if (!disposed) setState("error", language.t("computer.controlError")) }
    finally { if (!disposed) setState("pending", false) }
  }
  createEffect(() => {
    const sessionID = props.sessionID
    const display = state.display
    if (!api || !sessionID || !active()) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async () => {
      try {
        const frame = await api.frame(sessionID, display)
        if (!cancelled && !disposed && props.sessionID === sessionID) setState({ frame, error: "" })
      } catch { if (!cancelled && !disposed) setState("error", language.t("computer.captureError")) }
      if (!cancelled) timer = setTimeout(refresh, 1200)
    }
    void refresh()
    onCleanup(() => { cancelled = true; clearTimeout(timer) })
  })
  return (
    <div data-component="side-computer" class="flex min-h-0 min-w-0 flex-1 flex-col bg-background-base">
      <Show when={active()} fallback={
        <div class="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 overflow-auto px-6 py-8 text-center">
          <Icon name="window-cursor" size="large" class="text-text-weak" />
          <div class="text-16-medium text-text-strong">{language.t("computer.title")}</div>
          <p class="max-w-80 text-13-regular text-text-weak">{language.t("computer.description")}</p>
          <button type="button" disabled={!props.sessionID || !state.status?.available || state.pending || !!state.status?.ownerSessionId}
            onClick={() => void control("user")}
            class="rounded-lg bg-text-strong px-4 py-2 text-12-medium text-background-base disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-border-focus">
            {language.t(state.pending ? "computer.connecting" : "computer.share")}
          </button>
          <Show when={!!state.status?.ownerSessionId && !owned()}>
            <p class="text-12-regular text-text-weak">{language.t("computer.otherSession")}</p>
          </Show>
          <Show when={state.status && !state.status.available}>
            <p class="text-12-regular text-text-weak">{language.t("computer.unavailable")}</p>
          </Show>
        </div>
      }>
        <div class="flex shrink-0 flex-wrap items-center gap-2 border-b border-border-weak-base px-3 py-2">
          <span class="flex min-w-0 flex-1 items-center gap-2 text-12-medium text-text-strong" role="status">
            <span class="size-1.5 shrink-0 rounded-full" classList={{ "bg-icon-warning-base": agent(), "bg-icon-success-base": !agent() }} />
            {language.t(agent() ? "computer.agent" : "computer.user")}
          </span>
          <button type="button" disabled={state.pending} onClick={() => void control(agent() ? "user" : "agent")}
            class="rounded-md bg-surface-weak px-3 py-1.5 text-12-medium text-text-strong hover:bg-surface-raised-base focus-visible:outline-2 focus-visible:outline-border-focus">
            {language.t(agent() ? "side.browser.takeControl" : "computer.allow")}
          </button>
          <button type="button" onClick={() => void control("off")}
            class="rounded-md px-2 py-1.5 text-12-medium text-text-weak hover:bg-surface-weak hover:text-text-strong focus-visible:outline-2 focus-visible:outline-border-focus">
            {language.t("computer.stop")}
          </button>
        </div>
        <div class="flex min-h-0 flex-1 flex-col justify-center gap-4 overflow-auto p-3">
          <Show when={state.frame} fallback={<p class="text-center text-13-regular text-text-weak">{language.t("computer.capturing")}</p>}>
            {(frame) => <>
              <div class="relative w-full overflow-hidden rounded-lg border border-border-weak-base" style={{ "aspect-ratio": `${frame().width} / ${frame().height}` }}>
                <img src={`data:${frame().mime};base64,${frame().data}`} alt={language.t("computer.preview")} class="block h-full w-full object-contain" draggable={false} />
                <Show when={frame().cursor.x >= 0 && frame().cursor.y >= 0 && frame().cursor.x < frame().width && frame().cursor.y < frame().height}>
                  <svg aria-hidden="true" class="pointer-events-none absolute h-5 w-5" style={{ left: `${frame().cursor.x / frame().width * 100}%`, top: `${frame().cursor.y / frame().height * 100}%` }} viewBox="0 0 20 20">
                    <path d="M2 1v15l4-4 3 7 3-1-3-7 6-1Z" fill="white" stroke="#151515" stroke-width="1.5" />
                  </svg>
                </Show>
              </div>
              <div class="flex items-center justify-between gap-3 text-11-regular text-text-weak">
                <span>{language.t("computer.live")}</span>
                <select aria-label={language.t("computer.display")} value={state.display} disabled={agent()}
                  onChange={(event) => setState({ display: Number(event.currentTarget.value), frame: undefined })}
                  class="max-w-40 rounded-md bg-surface-weak px-2 py-1 text-text-strong">
                  <For each={Array.from({ length: frame().displays }, (_, i) => i)}>{(display) =>
                    <option value={display}>{language.t("computer.displayNumber", { number: display + 1 })}</option>}
                  </For>
                </select>
              </div>
            </>}
          </Show>
          <p class="mx-auto max-w-80 text-center text-12-regular text-text-weak">{language.t(agent() ? "computer.agentHelp" : "computer.userHelp")}</p>
        </div>
        <div class="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border-weak-base px-3 py-2 text-11-regular text-text-weak">
          <span>{language.t(state.status?.busy ? "computer.working" : "side.browser.ready")}</span>
          <span>{language.t("computer.emergency")} <kbd class="rounded bg-surface-weak px-1.5 py-0.5 font-sans">Ctrl Alt Shift F12</kbd></span>
        </div>
      </Show>
      <Show when={state.error}><p role="alert" class="shrink-0 border-t border-border-weak-base px-3 py-2 text-12-regular text-text-strong">{state.error}</p></Show>
    </div>
  )
}
