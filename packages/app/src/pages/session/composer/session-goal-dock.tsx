import type { Todo } from "@opencode-ai/sdk/v2"
import { For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { DockTray } from "@opencode-ai/ui/dock-surface"
import { Icon } from "@opencode-ai/ui/icon"
import { Button } from "@opencode-ai/ui/button"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { useLanguage } from "@/context/language"
import { goalProgress, type SessionGoal } from "@/pages/session/session-goal"

export function SessionGoalDock(props: {
  goal: SessionGoal
  todos: Todo[]
  pending?: boolean
  onPause: () => void
  onResume: () => void
  onStop: () => void
  onComplete: () => void
  onEdit: (title: string) => void
  onDismiss: () => void
}) {
  const language = useLanguage()
  const [state, setState] = createStore({ expanded: false, editing: false, title: "" })
  const progress = () => goalProgress(props.todos)
  const terminal = () => props.goal.status === "completed" || props.goal.status === "stopped"
  const status = () => language.t(`session.goal.status.${props.goal.status}`)
  const progressValue = () => {
    if (progress().total) return Math.round((progress().done / progress().total) * 100)
    const limit = props.goal.maxIterations ?? 20
    if (!limit) return 0
    return Math.min(100, Math.round(((props.goal.iteration ?? 0) / limit) * 100))
  }
  const statusTone = () => {
    if (props.goal.status === "completed") return "bg-icon-success-base"
    if (props.goal.status === "blocked") return "bg-icon-warning-base"
    if (props.goal.status === "stopped") return "bg-text-faint"
    if (props.goal.status === "paused") return "bg-text-weak"
    return "bg-icon-info-base"
  }

  return (
    <DockTray
      data-component="session-goal-dock"
      class="mb-2 overflow-hidden rounded-[12px] border border-border-weak-base bg-background-stronger shadow-[0_6px_22px_rgba(0,0,0,0.12)]"
    >
      <div class="min-w-0">
        <div class="flex min-w-0 items-center gap-2 px-3 py-2.5">
          <button
            type="button"
            class="flex min-w-0 flex-1 items-center gap-2 rounded-md text-left outline-none focus-visible:ring-1 focus-visible:ring-border-focus"
            aria-expanded={state.expanded}
            onClick={() => setState("expanded", !state.expanded)}
          >
            <span class="relative flex size-5 shrink-0 items-center justify-center">
              <Icon
                name={props.goal.status === "completed" ? "check" : "task"}
                size="small"
                class="text-icon-base"
              />
              <span
                class={`absolute -bottom-0.5 -right-0.5 size-1.5 rounded-full ring-2 ring-background-stronger ${statusTone()}`}
              />
            </span>
            <span class="min-w-0 flex-1">
              <span class="block truncate text-13-medium text-text-strong" title={props.goal.title}>
                {props.goal.title}
              </span>
              <span class="mt-0.5 flex items-center gap-1.5 text-11-regular text-text-weak">
                <span role="status">{status()}</span>
                <span aria-hidden="true">·</span>
                <span>
                  {progress().total
                    ? language.t("session.goal.progress", { done: progress().done, total: progress().total })
                    : language.t("session.goal.activity", {
                        current: props.goal.iteration ?? 0,
                        limit: props.goal.maxIterations ?? 20,
                      })}
                </span>
              </span>
            </span>
            <Icon
              name="chevron-down"
              size="small"
              class="shrink-0 text-icon-weak transition-transform duration-150"
              classList={{ "rotate-180": state.expanded }}
            />
          </button>
          <Show
            when={!terminal()}
            fallback={
              <Tooltip value={language.t("session.goal.dismiss")}>
                <IconButton
                  icon="close"
                  size="small"
                  variant="ghost"
                  class="size-7 rounded-md"
                  aria-label={language.t("session.goal.dismiss")}
                  disabled={props.pending}
                  onClick={props.onDismiss}
                />
              </Tooltip>
            }
          >
            <Button
              size="small"
              variant="ghost"
              disabled={props.pending}
              onClick={() => (props.goal.status === "active" ? props.onPause() : props.onResume())}
            >
              {language.t(props.goal.status === "active" ? "session.goal.pause" : "session.goal.resume")}
            </Button>
            <Tooltip value={language.t("session.goal.stop")}>
              <IconButton
                icon="stop"
                size="small"
                variant="ghost"
                class="size-7 rounded-md"
                aria-label={language.t("session.goal.stop")}
                disabled={props.pending}
                onClick={props.onStop}
              />
            </Tooltip>
          </Show>
        </div>
        <div
          class="h-px w-full bg-border-weaker-base"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progressValue()}
        >
          <div
            class="h-full bg-icon-info-base transition-[width] duration-300"
            classList={{
              "bg-icon-success-base": props.goal.status === "completed",
              "bg-text-weak": props.goal.status === "paused" || props.goal.status === "stopped",
              "bg-icon-warning-base": props.goal.status === "blocked",
            }}
            style={{ width: `${progressValue()}%` }}
          />
        </div>
        <Show when={state.expanded}>
          <div class="space-y-3 border-t border-border-weaker-base px-3 pb-3 pt-3 text-13-regular text-text-base">
            <Show
              when={state.editing}
              fallback={<p class="whitespace-pre-wrap break-words text-text-strong">{props.goal.title}</p>}
            >
              <form
                onSubmit={(event) => {
                  event.preventDefault()
                  if (!state.title.trim()) return
                  props.onEdit(state.title.trim())
                  setState("editing", false)
                }}
              >
                <textarea
                  class="w-full resize-y rounded-lg border border-border-weak-base bg-background-base p-2 text-text-strong outline-none focus:border-border-strong"
                  rows={3}
                  value={state.title}
                  onInput={(event) => setState("title", event.currentTarget.value)}
                  aria-label={language.t("session.goal.edit")}
                />
                <div class="mt-2 flex gap-2">
                  <Button type="submit" size="small" disabled={props.pending || !state.title.trim()}>
                    {language.t("session.goal.save")}
                  </Button>
                  <Button type="button" size="small" variant="ghost" onClick={() => setState("editing", false)}>
                    {language.t("common.cancel")}
                  </Button>
                </div>
              </form>
            </Show>
            <Show when={props.goal.reason}>
              <p class="break-words text-text-strong">{props.goal.reason}</p>
            </Show>
            <Show when={props.todos.length}>
              <div>
                <p class="mb-1.5 text-11-medium uppercase tracking-wide text-text-weak">
                  {language.t("session.goal.steps")}
                </p>
                <ul class="max-h-40 space-y-1.5 overflow-y-auto" aria-label={language.t("session.goal.steps")}>
                  <For each={props.todos}>
                    {(todo) => (
                      <li class="flex items-start gap-2">
                        <Icon
                          name={todo.status === "completed" ? "check" : "dash"}
                          size="small"
                          class="mt-0.5 shrink-0 text-icon-weak"
                        />
                        <span class="min-w-0 break-words">{todo.content}</span>
                      </li>
                    )}
                  </For>
                </ul>
              </div>
            </Show>
            <Show when={props.goal.evidence}>
              <div>
                <p class="text-11-medium uppercase tracking-wide text-text-weak">
                  {language.t("session.goal.evidence")}
                </p>
                <p class="mt-1 whitespace-pre-wrap break-words">{props.goal.evidence}</p>
              </div>
            </Show>
            <Show when={props.goal.remaining}>
              <div>
                <p class="text-11-medium uppercase tracking-wide text-text-weak">
                  {language.t("session.goal.remaining")}
                </p>
                <p class="mt-1 whitespace-pre-wrap break-words">{props.goal.remaining}</p>
              </div>
            </Show>
            <Show when={!terminal()}>
              <div class="flex flex-wrap gap-2">
                <Button
                  size="small"
                  variant="ghost"
                  disabled={props.pending}
                  onClick={() => setState({ editing: true, title: props.goal.title })}
                >
                  {language.t("session.goal.edit")}
                </Button>
                <Button size="small" variant="ghost" disabled={props.pending} onClick={props.onComplete}>
                  {language.t("session.goal.complete")}
                </Button>
              </div>
            </Show>
          </div>
        </Show>
      </div>
    </DockTray>
  )
}

