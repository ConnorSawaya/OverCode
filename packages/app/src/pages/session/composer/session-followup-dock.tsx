import { For, Show, createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { DockTray } from "@opencode-ai/ui/dock-surface"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { useLanguage } from "@/context/language"

export function SessionFollowupDock(props: {
  items: { id: string; text: string }[]
  sending?: string
  onSend: (id: string) => void
  onEdit: (id: string) => void
  onRemove: (id: string) => void
}) {
  const language = useLanguage()
  const [store, setStore] = createStore({
    collapsed: false,
  })

  const toggle = () => setStore("collapsed", (value) => !value)
  const total = createMemo(() => props.items.length)
  const label = createMemo(() => language.plural("session.followupDock.summary", total()))
  const preview = createMemo(() => props.items[0]?.text ?? "")

  return (
    <DockTray
      data-component="session-followup-dock"
      style={{
        "margin-bottom": "-0.875rem",
        "border-bottom-left-radius": 0,
        "border-bottom-right-radius": 0,
      }}
    >
      <div
        class="flex items-center gap-2 px-3 py-2"
        role="button"
        tabIndex={0}
        aria-expanded={!store.collapsed}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return
          event.preventDefault()
          toggle()
        }}
      >
        <span class="shrink-0 text-13-medium text-text-strong cursor-default">{label()}</span>
        <Show when={store.collapsed && preview()}>
          <span class="min-w-0 flex-1 truncate text-13-regular text-text-base cursor-default">{preview()}</span>
        </Show>
        <div class="ml-auto shrink-0">
          <IconButton
            data-collapsed={store.collapsed ? "true" : "false"}
            icon="chevron-down"
            size="normal"
            variant="ghost"
            style={{ transform: `rotate(${store.collapsed ? 180 : 0}deg)` }}
            onMouseDown={(event) => {
              event.preventDefault()
              event.stopPropagation()
            }}
            onClick={(event) => {
              event.stopPropagation()
              toggle()
            }}
            aria-label={
              store.collapsed ? language.t("session.followupDock.expand") : language.t("session.followupDock.collapse")
            }
          />
        </div>
      </div>

      <Show when={store.collapsed}>
        <div class="h-5" aria-hidden="true" />
      </Show>

      <Show when={!store.collapsed}>
        <div class="px-3 pb-7 flex flex-col gap-1.5 max-h-42 overflow-y-auto no-scrollbar">
          <For each={props.items}>
            {(item) => (
              <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 py-1">
                <span class="min-w-0 basis-full truncate text-13-regular text-text-strong md:flex-1 md:basis-auto">
                  {item.text}
                </span>
                <div class="ml-auto flex max-w-full flex-wrap justify-end gap-1">
                  <Button
                    size="small"
                    variant="secondary"
                    class="shrink-0"
                    disabled={!!props.sending}
                    onClick={() => props.onSend(item.id)}
                  >
                    {language.t("session.followupDock.sendNow")}
                  </Button>
                  <Tooltip value={language.t("session.followupDock.edit")} placement="top">
                    <IconButton
                      icon="edit"
                      size="small"
                      variant="ghost"
                      class="shrink-0 rounded-md"
                      disabled={!!props.sending}
                      aria-label={language.t("session.followupDock.edit")}
                      onClick={() => props.onEdit(item.id)}
                    />
                  </Tooltip>
                  <Tooltip value={language.t("session.followupDock.remove")} placement="top">
                    <IconButton
                      icon="trash"
                      size="small"
                      variant="ghost"
                      class="shrink-0 rounded-md"
                      disabled={!!props.sending}
                      aria-label={language.t("session.followupDock.remove")}
                      onClick={() => props.onRemove(item.id)}
                    />
                  </Tooltip>
                </div>
              </div>
            )}
          </For>
        </div>
      </Show>
    </DockTray>
  )
}
