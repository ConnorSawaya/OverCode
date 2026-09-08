import { createEffect, createMemo, For, Show, type Accessor, type JSX } from "solid-js"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { PromptFrame } from "@opencode-ai/ui/prompt-frame"
import { Icon } from "@opencode-ai/ui/icon"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { KeybindV2 } from "@opencode-ai/ui/v2/keybind-v2"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { AttachmentCardV2 } from "../attachment-card-v2"
import { CommentCardV2 } from "../comment-card-v2"
import { typeLabel } from "../../../components/message-file"
import { formatPastedTextSize } from "./pasted-text"
import type {
  PromptInputV2Attachment,
  PromptInputV2Comment,
  PromptInputV2Option,
  PromptInputV2PersistedState,
  PromptInputV2PastedText,
  PromptInputV2Prompt,
  PromptInputV2Suggestion,
} from "./types"
import type { PromptInputV2Interaction, PromptInputV2SelectControl } from "./interaction"
import "./attachments.css"
import "./editor.css"

export type {
  PromptInputV2Attachment,
  PromptInputV2Comment,
  PromptInputV2Option,
  PromptInputV2PersistedState,
  PromptInputV2PastedText,
  PromptInputV2Suggestion,
  PromptInputV2Prompt,
} from "./types"

export type PromptInputV2Mode = "normal" | "shell"

export type PromptInputV2Props = {
  controller: PromptInputV2Interaction
  disabled?: boolean
  readOnly?: boolean
  borderUnderlay?: boolean
  working?: Accessor<boolean>
  frameEffects?: boolean
  class?: string
  modelControl?: JSX.Element
  permissionControl?: JSX.Element
  voiceControl?: JSX.Element
  variantControlVisible?: boolean
  attachKeybind?: string[]
  attachShortcut?: string
}

export function PromptInputV2(props: PromptInputV2Props) {
  const i18n = useI18n()
  const state = props.controller.state
  const view = props.controller.view
  let editor: HTMLDivElement | undefined
  let localInput = false
  const updateCursor = () => {
    if (!editor || !window.getSelection()?.isCollapsed) return
    props.controller.onCursor(promptInputV2Cursor(editor))
  }
  const mode = createMemo(() => state.mode)
  const buttons = createMemo(() => ({
    opacity: mode() === "normal" ? 1 : 0,
    "pointer-events": mode() === "normal" ? ("auto" as const) : ("none" as const),
    transition: "opacity 200ms ease",
  }))

  createEffect(() => {
    const parts = props.controller.parts()
    if (!editor) return
    if (localInput) {
      localInput = false
      return
    }
    renderPromptInputV2Editor(editor, parts)
  })

  return (
    <div class={`relative size-full flex flex-col gap-0 ${props.class ?? ""}`}>
      <input
        ref={props.controller.setFileInput}
        type="file"
        multiple
        class="hidden"
        onChange={(event) => {
          const list = event.currentTarget.files
          if (list) props.controller.addAttachments(Array.from(list))
          event.currentTarget.value = ""
        }}
      />
      <Show when={state.popover.type !== "closed"}>
        <PromptInputV2Popover
          emptyLabel={i18n.t("ui.promptInput.noMatchingItems")}
          items={props.controller.suggestions()}
          activeID={state.popover.type === "closed" ? undefined : state.popover.activeID}
          search={
            state.popover.type === "command-menu"
              ? {
                  value: state.popover.query,
                  label: i18n.t("ui.promptInput.commands"),
                  placeholder: "/",
                  onValueChange: props.controller.setQuery,
                  onKeyDown: props.controller.onKeyDown,
                }
              : undefined
          }
          onActiveChange={(item) => props.controller.dispatch({ type: "popover.active", id: item.id })}
          onSelect={(item) => props.controller.dispatch({ type: "popover.select", item })}
        />
      </Show>
      <form
        data-component="prompt-input-v2"
        data-dock-border-underlay={props.borderUnderlay ? "v2" : undefined}
        data-prompt-agent={view.agent?.current()?.toLowerCase()}
        data-working={props.working?.() ? "true" : "false"}
        class="group/prompt-input relative min-h-[98px] w-full overflow-clip rounded-[18px] border border-v2-border-border-base bg-v2-background-bg-base"
        classList={{
          "shadow-[var(--v2-elevation-raised)]": !props.borderUnderlay,
          "border border-v2-icon-icon-info border-dashed": state.drag === "active",
        }}
        onSubmit={(event) => {
          event.preventDefault()
          if (!props.disabled) props.controller.submit()
        }}
        onDragEnter={props.controller.onDragEnter}
        onDragOver={props.controller.onDragOver}
        onDragLeave={props.controller.onDragLeave}
        onDrop={props.controller.onDrop}
      >
        <PromptFrame
          enabled={props.frameEffects ?? true}
          working={props.working?.() ?? view.submit.working?.() ?? false}
          agent={view.agent?.current()}
          dragging={state.drag === "active"}
        />
        <Show when={state.drag === "active"}>
          <div class="pointer-events-none absolute inset-0 z-20 grid place-items-center rounded-xl bg-v2-background-bg-base/90 text-v2-text-text-base">
            {i18n.t("ui.promptInput.dropFiles")}
          </div>
        </Show>

        <Show when={state.mode === "normal"}>
          <PromptInputV2Attachments
            attachments={props.controller.attachments()}
            pastedTexts={props.controller.pastedTexts()}
            comments={props.controller.comments()}
            activeCommentID={state.activeContextID}
            removeLabel={i18n.t("ui.promptInput.removeAttachment")}
            onAttachmentClick={props.controller.openAttachment}
            onAttachmentRemove={(attachment) => props.controller.removeAttachment(attachment.id)}
            onPastedTextClick={props.controller.openPastedText}
            onPastedTextMove={(attachment) => void props.controller.movePastedText(attachment.id)}
            onPastedTextCopy={(attachment) => void props.controller.copyPastedText(attachment)}
            onPastedTextRemove={(attachment) => props.controller.removePastedText(attachment.id)}
            onCommentClick={(comment) => props.controller.toggleContext(comment.key)}
            onCommentRemove={(comment) => props.controller.removeContext(comment.key)}
          />
        </Show>

        <div class="relative min-h-[57px]">
          <div
            ref={(element) => {
              editor = element
              props.controller.setEditor(element)
              renderPromptInputV2Editor(element, props.controller.parts())
            }}
            data-component="prompt-input"
            role="textbox"
            aria-multiline="true"
            aria-label={i18n.t("ui.promptInput.label")}
            contenteditable={!props.disabled && !props.readOnly}
            autocapitalize={state.mode === "normal" ? "sentences" : "off"}
            autocorrect={state.mode === "normal" ? "on" : "off"}
            spellcheck={state.mode === "normal"}
            // @ts-expect-error
            autocomplete="off"
            class="prompt-input-v2-editor relative z-10 block min-h-[57px] max-h-[180px] w-full overflow-y-auto whitespace-pre-wrap bg-transparent px-3 pt-3 pb-1 text-[13px] font-[440] leading-5 text-v2-text-text-base focus:outline-none [&_[data-mention=file]]:text-syntax-property [&_[data-mention=agent]]:text-syntax-type [&_[data-mention=reference]]:text-syntax-keyword"
            classList={{ "font-mono!": state.mode === "shell", "opacity-50": props.disabled }}
            onInput={(event) => {
              const cursor = promptInputV2Cursor(event.currentTarget)
              const prompt = parsePromptInputV2Editor(event.currentTarget)
              const attachments = props.controller
                .parts()
                .filter((part) => part.type === "image" || part.type === "pasted_text")
              localInput = true
              props.controller.onInput(prompt.map((part) => part.content).join(""), [...prompt, ...attachments], cursor)
            }}
            onKeyDown={(event) => {
              if (props.controller.onKeyDown(event)) return
              if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
                event.preventDefault()
                if (event.repeat) return
                props.controller.submit()
              }
            }}
            onKeyUp={updateCursor}
            onPointerUp={updateCursor}
            onPaste={props.controller.onPaste}
            onFocus={() => props.controller.dispatch({ type: "focus.editor" })}
          />
          <Show when={!props.controller.value()}>
            <div
              data-component="prompt-placeholder"
              aria-hidden="true"
              class="pointer-events-none absolute inset-x-0 top-0 px-3 pt-3 text-[13px] font-[440] leading-5 text-v2-text-text-faint"
              classList={{ "font-mono!": state.mode === "shell" }}
            >
              {view.placeholder?.() ??
                (state.mode === "shell"
                  ? i18n.t("ui.promptInput.placeholder.shell")
                  : i18n.t("ui.promptInput.placeholder.normal", { slash: "/", at: "@" }))}
            </div>
          </Show>
        </div>

        <div class="flex h-10 items-center gap-2 px-2 pb-1">
          <div
            class="flex min-w-0 items-center gap-0.5"
            aria-hidden={state.mode === "shell"}
            inert={state.mode === "shell" ? true : undefined}
            style={buttons()}
          >
            <PromptInputV2AddMenu
              disabled={state.mode === "shell"}
              title={i18n.t("ui.promptInput.add")}
              keybind={props.attachKeybind ?? ["Mod", "U"]}
              attachLabel={i18n.t("ui.promptInput.attachments")}
              attachShortcut={props.attachShortcut ?? "Mod+U"}
              commandsLabel={i18n.t("ui.promptInput.commands")}
              contextLabel={i18n.t("ui.promptInput.context")}
              shellLabel={i18n.t("ui.promptInput.shell")}
              onAttach={props.controller.attach}
              onCommands={props.controller.openCommands}
              onContext={props.controller.openContext}
              onShell={props.controller.openShell}
            />
            <Show when={props.permissionControl}>{props.permissionControl}</Show>
            <Show when={view.agent} keyed>
              {(control) => (
                <div data-component="prompt-agent-control" data-action="prompt-agent">
                  <PromptInputV2ConfiguredSelect
                    title={i18n.t("ui.promptInput.chooseAgent")}
                    keybind={control.keybind?.()}
                    control={control}
                  />
                </div>
              )}
            </Show>
          </div>
          <div
            class="ml-auto flex min-w-0 items-center justify-end gap-0.5"
            aria-hidden={state.mode === "shell"}
            inert={state.mode === "shell" ? true : undefined}
            style={buttons()}
          >
            <Show
              when={props.modelControl}
              fallback={
                <Show when={view.model} keyed>
                  {(control) => (
                    <PromptInputV2ConfiguredSelect
                      title={i18n.t("ui.promptInput.chooseModel")}
                      keybind={["Mod", "M"]}
                      control={control}
                      model
                    />
                  )}
                </Show>
              }
            >
              {props.modelControl}
            </Show>
            <Show when={(props.variantControlVisible ?? true) && view.variant} keyed>
              {(control) => (
                <Show when={control.options().length > 1}>
                  <PromptInputV2ConfiguredSelect
                    title={i18n.t("ui.promptInput.chooseVariant")}
                    keybind={["Shift", "Mod", "D"]}
                    control={control}
                  />
                </Show>
              )}
            </Show>
            <Show when={props.voiceControl} fallback={<PromptInputV2VoiceButton />}>
              {props.voiceControl}
            </Show>
          </div>
          <PromptInputV2SubmitButton
            mode={state.mode}
            stopping={view.submit.stopping()}
            disabled={!props.controller.canSubmit()}
            sendLabel={i18n.t("ui.promptInput.send")}
            stopLabel={i18n.t("ui.promptInput.stop")}
            onSubmit={props.controller.submit}
            onStop={props.controller.stop}
          />
        </div>
      </form>
    </div>
  )
}

function renderPromptInputV2Editor(editor: HTMLDivElement, prompt: PromptInputV2Prompt) {
  const active = document.activeElement === editor
  editor.replaceChildren(
    ...prompt.flatMap<Node>((part) => {
      if (part.type === "image" || part.type === "pasted_text") return []
      if (part.type === "text") return [document.createTextNode(part.content)]
      const mention = document.createElement("span")
      mention.textContent = part.content
      mention.contentEditable = "false"
      mention.dataset.mention =
        part.type === "file" && part.mime === "application/x-directory" ? "reference" : part.type
      if (part.type === "agent") mention.dataset.name = part.name
      if (part.type === "file") {
        mention.dataset.path = part.path
        if (part.mime) mention.dataset.mime = part.mime
        if (part.filename) mention.dataset.filename = part.filename
      }
      return [mention]
    }),
  )
  if (!active) return
  const selection = window.getSelection()
  const range = document.createRange()
  range.selectNodeContents(editor)
  range.collapse(false)
  selection?.removeAllRanges()
  selection?.addRange(range)
}

function parsePromptInputV2Editor(editor: HTMLDivElement) {
  const parts: Exclude<PromptInputV2Prompt[number], PromptInputV2Attachment | PromptInputV2PastedText>[] = []
  let buffer = ""
  let position = 0

  const flush = () => {
    if (!buffer) return
    parts.push({ type: "text", content: buffer, start: position, end: position + buffer.length })
    position += buffer.length
    buffer = ""
  }
  const mention = (element: HTMLElement) => {
    flush()
    const content = element.textContent ?? ""
    if (element.dataset.mention === "agent") {
      parts.push({
        type: "agent",
        name: element.dataset.name ?? content.slice(1),
        content,
        start: position,
        end: position + content.length,
      })
      position += content.length
      return
    }
    parts.push({
      type: "file",
      path: element.dataset.path ?? content.slice(1),
      content,
      start: position,
      end: position + content.length,
      ...(element.dataset.mime ? { mime: element.dataset.mime } : {}),
      ...(element.dataset.filename ? { filename: element.dataset.filename } : {}),
    })
    position += content.length
  }
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      buffer += node.textContent ?? ""
      return
    }
    if (!(node instanceof HTMLElement)) return
    if (node.dataset.mention) {
      mention(node)
      return
    }
    if (node.tagName === "BR") {
      buffer += "\n"
      return
    }
    Array.from(node.childNodes).forEach(visit)
  }

  Array.from(editor.childNodes).forEach((node, index, nodes) => {
    visit(node)
    if (node instanceof HTMLElement && ["DIV", "P"].includes(node.tagName) && index < nodes.length - 1) buffer += "\n"
  })
  flush()
  if (
    parts.every((part) => part.type === "text") &&
    parts.every((part) => part.content.replace(/[\n\u200B]/g, "") === "")
  ) {
    return [{ type: "text" as const, content: "", start: 0, end: 0 }]
  }
  if (parts.length > 0) return parts
  return [{ type: "text" as const, content: "", start: 0, end: 0 }]
}

function promptInputV2Cursor(editor: HTMLDivElement) {
  const selection = window.getSelection()
  if (!selection?.rangeCount || !editor.contains(selection.anchorNode)) return editor.textContent?.length ?? 0
  const range = selection.getRangeAt(0).cloneRange()
  range.selectNodeContents(editor)
  range.setEnd(selection.anchorNode!, selection.anchorOffset)
  return range.toString().length
}

export function PromptInputV2Attachments(props: {
  attachments: PromptInputV2Attachment[]
  pastedTexts?: PromptInputV2PastedText[]
  comments?: PromptInputV2Comment[]
  activeCommentID?: string
  removeLabel: string
  onAttachmentClick?: (attachment: PromptInputV2Attachment) => void
  onAttachmentRemove: (attachment: PromptInputV2Attachment) => void
  onPastedTextClick?: (attachment: PromptInputV2PastedText) => void
  onPastedTextMove?: (attachment: PromptInputV2PastedText) => void
  onPastedTextCopy?: (attachment: PromptInputV2PastedText) => void
  onPastedTextRemove?: (attachment: PromptInputV2PastedText) => void
  onCommentClick?: (comment: PromptInputV2Comment) => void
  onCommentRemove?: (comment: PromptInputV2Comment) => void
}) {
  const i18n = useI18n()
  return (
    <Show
      when={props.attachments.length > 0 || (props.pastedTexts?.length ?? 0) > 0 || (props.comments?.length ?? 0) > 0}
    >
      <div data-component="prompt-input-v2-attachments" data-slot="prompt-attachments" class="relative">
        <div
          data-slot="prompt-attachments-scroll"
          class="flex flex-nowrap gap-2 overflow-x-auto no-scrollbar px-2 pt-2 pb-1"
        >
          <For each={props.comments ?? []}>
            {(comment) => (
              <div class="relative group shrink-0">
                <TooltipV2
                  value={comment.comment}
                  placement="top"
                  openDelay={800}
                  contentClass="max-w-[300px] break-words"
                >
                  <CommentCardV2
                    comment={comment.comment ?? ""}
                    path={comment.path}
                    selection={comment.selection}
                    active={comment.key === props.activeCommentID}
                    onClick={() => props.onCommentClick?.(comment)}
                  />
                </TooltipV2>
                <button
                  type="button"
                  onClick={() => props.onCommentRemove?.(comment)}
                  class="absolute -top-1 -end-1 size-4 rounded-full bg-v2-icon-icon-muted outline-solid outline-1 outline-v2-icon-icon-contrast flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                  aria-label={props.removeLabel}
                >
                  <IconV2 name="outline-xmark" class="text-v2-icon-icon-contrast" />
                </button>
              </div>
            )}
          </For>
          <For each={props.pastedTexts ?? []}>
            {(attachment) => (
              <div
                data-component="prompt-input-v2-pasted-text"
                class="group relative flex h-[46px] w-[220px] shrink-0 items-center gap-2 rounded-[7px] border border-v2-border-border-base bg-v2-background-bg-elevated px-2"
              >
                <button
                  type="button"
                  class="flex min-w-0 flex-1 items-center gap-2 text-start"
                  onClick={() => props.onPastedTextClick?.(attachment)}
                  title={attachment.title}
                >
                  <span class="grid size-7 shrink-0 place-items-center rounded bg-v2-overlay-simple-overlay-hover text-v2-text-text-muted">
                    <IconV2 name="filetree" />
                  </span>
                  <span class="min-w-0">
                    <span class="block truncate text-[12px] leading-4 text-v2-text-text-base">{attachment.title}</span>
                    <span class="block text-[11px] leading-4 text-v2-text-text-muted">
                      Pasted text · {formatPastedTextSize(attachment.charCount)}
                    </span>
                  </span>
                </button>
                <div class="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                  <button
                    type="button"
                    class="grid size-6 place-items-center rounded text-v2-text-text-muted hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base"
                    onClick={() => props.onPastedTextMove?.(attachment)}
                    aria-label="Move pasted text to text field"
                    title="Move to text field"
                  >
                    <IconV2 name="expand" />
                  </button>
                  <button
                    type="button"
                    class="grid size-6 place-items-center rounded text-v2-text-text-muted hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base"
                    onClick={() => props.onPastedTextCopy?.(attachment)}
                    aria-label="Copy pasted text"
                    title="Copy"
                  >
                    <IconV2 name="outline-copy" />
                  </button>
                  <button
                    type="button"
                    class="grid size-6 place-items-center rounded text-v2-text-text-muted hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base"
                    onClick={() => props.onPastedTextRemove?.(attachment)}
                    aria-label="Remove pasted text"
                    title="Remove"
                  >
                    <IconV2 name="outline-xmark" />
                  </button>
                </div>
              </div>
            )}
          </For>
          <For each={props.attachments}>
            {(attachment) => (
              <div class="relative group shrink-0">
                <TooltipV2 value={attachment.filename} placement="top" contentClass="break-all">
                  <Show
                    when={attachment.mime.startsWith("image/")}
                    fallback={
                      <AttachmentCardV2 title={attachment.filename}>
                        {typeLabel(attachment.filename, attachment.mime, i18n.t("ui.common.file"))}
                      </AttachmentCardV2>
                    }
                  >
                    <img
                      src={attachment.blob.url}
                      alt={attachment.filename}
                      class="w-[58px] h-[46px] rounded-[6px] object-cover"
                      onClick={() => props.onAttachmentClick?.(attachment)}
                    />
                    <div class="absolute inset-0 rounded-[6px] shadow-[inset_0_0_0_0.5px_var(--v2-border-border-base)] pointer-events-none" />
                  </Show>
                </TooltipV2>
                <button
                  type="button"
                  onClick={() => props.onAttachmentRemove(attachment)}
                  class="absolute -top-1 -end-1 size-4 rounded-full bg-v2-icon-icon-muted outline-solid outline-1 outline-v2-icon-icon-contrast flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                  aria-label={props.removeLabel}
                >
                  <IconV2 name="outline-xmark" class="text-v2-icon-icon-contrast" />
                </button>
              </div>
            )}
          </For>
        </div>
        <div
          data-slot="prompt-attachments-fade-left"
          class="pointer-events-none absolute inset-y-0 start-0 z-10 w-6 bg-[linear-gradient(to_right,var(--v2-background-bg-base),transparent)] rtl:bg-[linear-gradient(to_left,var(--v2-background-bg-base),transparent)]"
        />
        <div
          data-slot="prompt-attachments-fade-right"
          class="pointer-events-none absolute inset-y-0 end-0 z-10 w-6 bg-[linear-gradient(to_left,var(--v2-background-bg-base),transparent)] rtl:bg-[linear-gradient(to_right,var(--v2-background-bg-base),transparent)]"
        />
      </div>
    </Show>
  )
}

export function PromptInputV2AddMenu(props: {
  disabled?: boolean
  title: string
  keybind?: string[]
  attachLabel: string
  attachShortcut?: string
  commandsLabel: string
  contextLabel: string
  shellLabel: string
  onAttach: () => void
  onCommands: () => void
  onContext: () => void
  onShell: () => void
}) {
  return (
    <TooltipV2
      placement="top"
      value={
        <>
          {props.title}
          <KeybindV2 keys={props.keybind ?? []} variant="neutral" />
        </>
      }
    >
      <MenuV2 gutter={6} modal={false} placement="top-start">
        <MenuV2.Trigger
          as={IconButtonV2}
          data-action="prompt-attach"
          type="button"
          icon={<IconV2 name="plus" />}
          variant="ghost-muted"
          size="large"
          disabled={props.disabled}
          aria-label={props.title}
        />
        <MenuV2.Portal>
          <MenuV2.Content style={{ "min-width": "180px" }}>
            <MenuV2.Item onSelect={props.onAttach} shortcut={props.attachShortcut}>
              {props.attachLabel}
            </MenuV2.Item>
            <MenuV2.Separator />
            <MenuV2.Item onSelect={props.onCommands} shortcut="/">
              {props.commandsLabel}
            </MenuV2.Item>
            <MenuV2.Item onSelect={props.onContext} shortcut="@">
              {props.contextLabel}
            </MenuV2.Item>
            <MenuV2.Item onSelect={props.onShell} shortcut="!">
              {props.shellLabel}
            </MenuV2.Item>
          </MenuV2.Content>
        </MenuV2.Portal>
      </MenuV2>
    </TooltipV2>
  )
}

function PromptInputV2ConfiguredSelect(props: {
  title: string
  keybind?: string[]
  control: PromptInputV2SelectControl
  model?: boolean
}) {
  const current = () => props.control.current()
  const providerID = () => props.control.options().find((option) => option.id === current())?.providerID
  return (
    <PromptInputV2Select
      title={props.title}
      keybind={props.control.keybind?.() ?? props.keybind}
      options={props.control.options()}
      current={current()}
      currentIcon={
        <Show when={props.model && providerID()}>
          <ProviderIcon id={providerID()!} class="size-4 shrink-0 opacity-60" />
        </Show>
      }
      onSelect={props.control.onSelect}
    />
  )
}

export function PromptInputV2Select(props: {
  title: string
  keybind?: string[]
  options: PromptInputV2Option[]
  current: string
  currentIcon?: JSX.Element
  class?: string
  onOpenChange?: (open: boolean) => void
  onSelect: (id: string) => void
}) {
  return (
    <TooltipV2
      placement="top"
      value={
        <>
          {props.title}
          <KeybindV2 keys={props.keybind ?? []} variant="neutral" />
        </>
      }
    >
      <MenuV2 gutter={6} modal={false} placement="top-start" onOpenChange={props.onOpenChange}>
        <MenuV2.Trigger
          as={ButtonV2}
          variant="ghost-muted"
          size="normal"
          class={`max-w-[220px] justify-start ![font-weight:440] ${props.class ?? ""}`}
          aria-label={props.title}
        >
          {props.currentIcon}
          <span class="truncate capitalize leading-5">
            {props.options.find((option) => option.id === props.current)?.label ?? props.current}
          </span>
          <span class="-ms-0.5 -me-1 flex shrink-0">
            <IconV2 name="chevron-down" />
          </span>
        </MenuV2.Trigger>
        <MenuV2.Portal>
          <MenuV2.Content>
            <MenuV2.RadioGroup value={props.current} onChange={props.onSelect}>
              <For each={props.options}>
                {(option) => (
                  <MenuV2.RadioItem value={option.id} class="capitalize" closeOnSelect>
                    {option.label}
                  </MenuV2.RadioItem>
                )}
              </For>
            </MenuV2.RadioGroup>
          </MenuV2.Content>
        </MenuV2.Portal>
      </MenuV2>
    </TooltipV2>
  )
}

export function PromptInputV2Popover(props: {
  emptyLabel: string
  items: PromptInputV2Suggestion[]
  activeID?: string
  search?: {
    value: string
    label: string
    placeholder: string
    onValueChange: (value: string) => void
    onKeyDown: (event: KeyboardEvent) => void
  }
  onActiveChange: (item: PromptInputV2Suggestion) => void
  onSelect: (item: PromptInputV2Suggestion) => void
}) {
  return (
    <div
      class="absolute inset-x-0 -top-2 z-40 flex max-h-80 -translate-y-full flex-col overflow-auto rounded-xl bg-v2-background-bg-base p-2 shadow-[var(--v2-elevation-raised)] no-scrollbar"
      onMouseDown={(event) => event.preventDefault()}
    >
      <Show when={props.search}>
        {(search) => (
          <div class="px-2 py-1">
            <input
              ref={(element) => requestAnimationFrame(() => element.focus())}
              value={search().value}
              aria-label={search().label}
              placeholder={search().placeholder}
              class="w-full bg-transparent text-[13px] leading-5 text-v2-text-text-base outline-none placeholder:text-v2-text-text-faint"
              onInput={(event) => search().onValueChange(event.currentTarget.value)}
              onKeyDown={(event) => search().onKeyDown(event)}
              onMouseDown={(event) => event.stopPropagation()}
            />
          </div>
        )}
      </Show>
      <Show
        when={props.items.length > 0}
        fallback={<div class="px-2 py-1 text-v2-text-text-muted">{props.emptyLabel}</div>}
      >
        <For each={props.items}>
          {(item) => (
            <button
              type="button"
              data-suggestion-id={item.id}
              class="flex w-full items-center gap-2 rounded-md px-2 py-1 text-start hover:bg-v2-overlay-simple-overlay-hover"
              classList={{ "bg-v2-overlay-simple-overlay-hover": props.activeID === item.id }}
              onPointerMove={() => props.onActiveChange(item)}
              onClick={() => props.onSelect(item)}
            >
              <div class="flex min-w-0 flex-1 items-center gap-2">
                <PromptInputV2SuggestionIcon item={item} />
                <span class="shrink-0 text-v2-text-text-base">{item.label}</span>
                <Show when={item.description}>
                  <span class="min-w-0 truncate text-v2-text-text-muted">{item.description}</span>
                </Show>
              </div>
              <Show when={item.keybind?.length}>
                <span class="shrink-0 text-v2-text-text-muted">{item.keybind?.join("+")}</span>
              </Show>
            </button>
          )}
        </For>
      </Show>
    </div>
  )
}

function PromptInputV2VoiceButton() {
  return (
    <button
      type="button"
      disabled
      class="flex size-7 shrink-0 items-center justify-center rounded-md text-v2-icon-icon-muted opacity-90"
      aria-label="Voice input unavailable"
    >
      <Icon name="microphone" size="small" />
    </button>
  )
}

export function PromptInputV2SubmitButton(props: {
  mode: PromptInputV2Mode
  stopping: boolean
  disabled: boolean
  sendLabel: string
  stopLabel: string
  onSubmit: () => void
  onStop: () => void
}) {
  return (
    <TooltipV2
      placement="top"
      inactive={!props.stopping && props.disabled}
      value={props.stopping ? props.stopLabel : props.sendLabel}
    >
      <Show
        when={!props.disabled || props.stopping}
        fallback={
          <button
            data-action="prompt-submit"
            type="button"
            disabled
            tabIndex={props.mode === "normal" ? undefined : -1}
            class="flex size-7 shrink-0 items-center justify-center rounded-full bg-v2-background-bg-contrast text-v2-text-text-contrast shadow-[var(--v2-elevation-button-contrast)]"
            aria-label={props.sendLabel}
          >
            <Icon name="arrow-up" size="small" />
          </button>
        }
      >
        <IconButtonV2
          data-action="prompt-submit"
          type="button"
          disabled={!props.stopping && props.disabled}
          tabIndex={props.mode === "normal" ? undefined : -1}
          size="large"
          variant="contrast"
          icon={
            <Icon
              name={props.stopping ? "stop" : props.mode === "shell" ? "arrow-undo-down" : "arrow-up"}
              size="small"
            />
          }
          class="size-7 shrink-0 rounded-full transition-transform active:scale-[0.94]"
          aria-label={props.stopping ? props.stopLabel : props.sendLabel}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            if (props.stopping) {
              props.onStop()
              return
            }
            props.onSubmit()
          }}
        />
      </Show>
    </TooltipV2>
  )
}

function PromptInputV2SuggestionIcon(props: { item: PromptInputV2Suggestion }) {
  if (props.item.kind === "agent") return <Icon name="brain" size="small" class="shrink-0 text-icon-info-active" />
  if (props.item.kind === "command") return null
  return (
    <FileIcon
      node={{ path: props.item.path ?? props.item.label, type: props.item.kind === "reference" ? "directory" : "file" }}
      class="size-4 shrink-0"
    />
  )
}
