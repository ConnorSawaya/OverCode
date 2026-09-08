import { For, Show } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import type { PastedTextPart } from "@/context/prompt"
import { formatPastedTextSize } from "@opencode-ai/session-ui/v2/prompt-input/pasted-text"

export function PastedTextAttachments(props: {
  attachments: PastedTextPart[]
  onOpen: (attachment: PastedTextPart) => void
  onMove: (attachment: PastedTextPart) => void
  onCopy: (attachment: PastedTextPart) => void
  onRemove: (id: string) => void
}) {
  return (
    <Show when={props.attachments.length > 0}>
      <div class="flex flex-wrap gap-2 px-3 pt-3">
        <For each={props.attachments}>
          {(attachment) => (
            <div class="group relative flex h-14 max-w-[280px] min-w-[220px] items-center gap-2 rounded-lg border border-border-base bg-surface-raised-base px-2">
              <button
                type="button"
                class="flex min-w-0 flex-1 items-center gap-2 text-left"
                onClick={() => props.onOpen(attachment)}
                title={attachment.title}
              >
                <span class="grid size-8 shrink-0 place-items-center rounded bg-surface-raised-stronger text-icon-weak-base">
                  <Icon name="folder" class="size-4" />
                </span>
                <span class="min-w-0">
                  <span class="block truncate text-12-medium text-text-strong">{attachment.title}</span>
                  <span class="block text-11-regular text-text-weak">
                    Pasted text · {formatPastedTextSize(attachment.charCount)}
                  </span>
                </span>
              </button>
              <div class="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                <button
                  type="button"
                  class="grid size-6 place-items-center rounded text-icon-weak-base hover:bg-surface-raised-base-hover hover:text-icon-strong-base"
                  onClick={() => props.onMove(attachment)}
                  aria-label="Move pasted text to text field"
                  title="Move to text field"
                >
                  <Icon name="enter" class="size-3.5" />
                </button>
                <button
                  type="button"
                  class="grid size-6 place-items-center rounded text-icon-weak-base hover:bg-surface-raised-base-hover hover:text-icon-strong-base"
                  onClick={() => props.onCopy(attachment)}
                  aria-label="Copy pasted text"
                  title="Copy"
                >
                  <Icon name="copy" class="size-3.5" />
                </button>
                <button
                  type="button"
                  class="grid size-6 place-items-center rounded text-icon-weak-base hover:bg-surface-raised-base-hover hover:text-icon-strong-base"
                  onClick={() => props.onRemove(attachment.id)}
                  aria-label="Remove pasted text"
                  title="Remove"
                >
                  <Icon name="close" class="size-3.5" />
                </button>
              </div>
            </div>
          )}
        </For>
      </div>
    </Show>
  )
}
