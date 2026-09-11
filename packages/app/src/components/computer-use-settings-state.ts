import { createStore, reconcile } from "solid-js/store"
import type { ComputerUsePlatform, ComputerUseState } from "@/computer-use"

export const COMPUTER_USE_COLORS = ["#38BDF8", "#A78BFA", "#34D399", "#FBBF24", "#FB7185"] as const

export function computerUseColor(value: string) {
  return /^#[0-9a-f]{6}$/i.test(value.trim()) ? value.trim().toUpperCase() : undefined
}

export function createComputerUseSettings(computer: ComputerUsePlatform) {
  const [state, setState] = createStore({
    value: undefined as ComputerUseState | undefined,
    color: "",
    loading: true,
    saving: false,
    stopping: false,
    dirty: false,
    invalid: false,
    error: undefined as "load" | "save" | "stop" | undefined,
  })
  let revision = 0
  let disposed = false
  const update = (value: ComputerUseState) => {
    setState("value", reconcile(value))
    if (!state.dirty) setState("color", computerUseColor(value.color) ?? COMPUTER_USE_COLORS[0])
  }
  const unsubscribe = computer.onState((value) => {
    if (disposed) return
    revision++
    update(value)
    setState({ loading: false, error: state.error === "load" ? undefined : state.error })
  })
  const refresh = async () => {
    const request = ++revision
    setState({ loading: true, error: undefined })
    await computer.state().then(
      (value) => {
        if (disposed || request !== revision) return
        update(value)
      },
      () => {
        if (!disposed && request === revision) setState("error", "load")
      },
    )
    if (!disposed && request === revision) setState("loading", false)
  }
  const colorDisabled = () =>
    state.loading || state.saving || state.stopping || state.value?.phase === "stopping" || !state.value
  const saveColor = async (value = state.color) => {
    if (colorDisabled()) return false
    const color = computerUseColor(value)
    setState("invalid", !color)
    if (!color) return false
    const request = revision
    setState({ saving: true, error: undefined })
    return computer.setColor(color).then(
      (value) => {
        if (disposed) return false
        if (request === revision) update(value)
        setState({ color: computerUseColor(value.color) ?? color, dirty: false, saving: false })
        return true
      },
      () => {
        if (!disposed) setState({ error: "save", saving: false })
        return false
      },
    )
  }
  const stop = async () => {
    if (state.stopping || state.value?.phase !== "active") return
    const request = revision
    setState({ stopping: true, error: undefined })
    await computer.stop(state.value.sessionID).then(
      (value) => {
        if (disposed) return
        if (request === revision) update(value)
        if (value.phase === "active" || value.phase === "starting") setState("error", "stop")
      },
      () => {
        if (!disposed) setState("error", "stop")
      },
    )
    if (!disposed) setState("stopping", false)
  }
  void refresh()
  return {
    state,
    refresh,
    colorDisabled,
    saveColor,
    stop,
    editColor(value: string) {
      if (colorDisabled()) return
      setState({ color: value, dirty: true, invalid: !computerUseColor(value) })
    },
    dispose() {
      disposed = true
      unsubscribe()
    },
  }
}
