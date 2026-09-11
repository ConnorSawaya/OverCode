import { createEffect, Show, Suspense, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"
import { DebugBar } from "@/components/debug-bar"
import { Titlebar, type TitlebarUpdate } from "@/components/titlebar"
import { TabCommands } from "@/components/tab-commands"
import { NewCodexSidebarHost } from "./layout/sidebar-new-host"
import { usePlatform } from "@/context/platform"
import { setV2Toast, ToastRegion } from "@/utils/toast"

export default function NewLayout(props: ParentProps) {
  const platform = usePlatform()
  const [state, setState] = createStore({ debugTools: false })
  const compact = typeof document !== "undefined" && document.documentElement.dataset.opencodeWindow === "quick-chat"

  createEffect(() => setV2Toast(true))

  const update: TitlebarUpdate = {
    version: () => {
      const state = platform.updater?.state()
      if (state?.status !== "ready") return
      return state.version
    },
    installing: () => platform.updater?.state().status === "installing",
    install: () => void platform.updater?.install(),
  }

  return (
    <div
      class="relative bg-v2-background-bg-deep flex-1 min-h-0 min-w-0 flex flex-col select-none [&_input]:select-text [&_textarea]:select-text [&_[contenteditable]]:select-text"
      style={{
        "padding-top": "env(safe-area-inset-top, 0px)",
        "padding-bottom": "env(safe-area-inset-bottom, 0px)",
      }}
    >
      <Titlebar
        compact={compact}
        update={update}
        debugTools={
          import.meta.env.DEV
            ? { visible: state.debugTools, toggle: () => setState("debugTools", (value) => !value) }
            : undefined
        }
      />
      <TabCommands />
      <div class="flex min-h-0 min-w-0 flex-1">
        <Show when={!compact}>
          <NewCodexSidebarHost />
        </Show>
        <main
          class="flex-1 min-h-0 min-w-0 overflow-x-hidden flex flex-col items-start contain-strict"
          classList={{ "w-full": compact }}
        >
          <Suspense
            fallback={
              <div class="flex size-full items-center justify-center bg-v2-background-bg-deep text-13-regular text-v2-text-text-muted">
                <div class="flex items-center gap-2" aria-busy="true">
                  <span class="size-3 animate-pulse rounded-full bg-v2-icon-icon-accent" />
                  Loading…
                </div>
              </div>
            }
          >
            {props.children}
          </Suspense>
        </main>
      </div>
      {import.meta.env.DEV && state.debugTools && <DebugBar inline />}
      <ToastRegion v2 />
    </div>
  )
}
