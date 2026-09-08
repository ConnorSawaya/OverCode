import { createResource, Show } from "solid-js"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { DialogBody, DialogFooter, DialogHeader, DialogTitle, DialogV2 } from "@opencode-ai/ui/v2/dialog-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import type { PastedTextPart } from "@/context/prompt"
import { formatPastedTextSize } from "@opencode-ai/session-ui/v2/prompt-input/pasted-text"

export function PastedTextViewer(props: { attachment: PastedTextPart }) {
  const dialog = useDialog()
  const [text] = createResource(
    () => props.attachment.blob.url,
    (url) => fetch(url).then((response) => response.text()),
  )

  const copy = async () => {
    const value = text()
    if (value) await navigator.clipboard.writeText(value)
  }

  return (
    <DialogV2 fit containerClass="!h-[min(calc(100vh_-_32px),760px)] !w-[min(calc(100vw_-_32px),960px)]">
      <DialogHeader closeLabel="Close">
        <DialogTitle>{props.attachment.title}</DialogTitle>
      </DialogHeader>
      <DialogBody class="min-h-0 flex-1 gap-2 overflow-hidden px-4 pb-2">
        <div class="text-[12px] text-v2-text-text-muted">
          Pasted text · {formatPastedTextSize(props.attachment.charCount)} · {props.attachment.lineCount} lines
        </div>
        <Show when={text()} fallback={<div class="text-v2-text-text-muted">Loading pasted text…</div>}>
          {(value) => (
            <textarea
              class="min-h-0 flex-1 resize-none rounded-lg border border-v2-border-border-base bg-v2-background-bg-base p-3 font-mono text-[12px] leading-5 text-v2-text-text-base outline-none"
              value={value()}
              readonly
              wrap="off"
              spellcheck={false}
              aria-label="Pasted text"
            />
          )}
        </Show>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 variant="ghost-muted" onClick={() => void copy()} disabled={!text()}>
          Copy
        </ButtonV2>
        <ButtonV2 variant="contrast" onClick={() => dialog.close()}>
          Close
        </ButtonV2>
      </DialogFooter>
    </DialogV2>
  )
}
