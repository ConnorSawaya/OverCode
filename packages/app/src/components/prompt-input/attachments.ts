import { onMount } from "solid-js"
import { makeEventListener } from "@solid-primitives/event-listener"
import { showToast } from "@/utils/toast"
import {
  type ContentPart,
  type FileAttachmentPart,
  type ImageAttachmentPart,
  type PastedTextPart,
  type usePrompt,
} from "@/context/prompt"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { uuid } from "@/utils/uuid"
import { getCursorPosition } from "./editor-dom"
import { createBlobReference, type DraftStore } from "@/utils/draft-store"
import { attachmentMime } from "./files"
import { normalizePaste, pasteMode } from "./paste"
import {
  pastedTextStats,
  pastedTextTitle,
  releaseLocalPastedTextBlob,
  shouldCreatePastedTextAttachment,
} from "@opencode-ai/session-ui/v2/prompt-input/pasted-text"
import { LOCAL_FILE_REFERENCE_MIME } from "@opencode-ai/core/file"

type PromptTarget = Pick<ReturnType<ReturnType<typeof usePrompt>["capture"]>, "current" | "cursor" | "set">
type AttachmentTarget = { prompt: PromptTarget; cursor: number | undefined }

type PromptAttachmentsCoreInput = {
  capture: () => PromptTarget
  editor: () => HTMLDivElement | undefined
  focusEditor?: () => void
  addPart?: (part: ContentPart) => boolean
  warn?: () => void
  readClipboardImage?: () => Promise<File | null>
  getPathForFile?: (file: File) => string
  draftStore?: DraftStore
  onPastedTextError?: (error: unknown) => void
}

export type PromptAttachmentsInput = {
  prompt: ReturnType<typeof usePrompt>
  editor: () => HTMLDivElement | undefined
  isDialogActive: () => boolean
  setDraggingType: (type: "image" | "@mention" | null) => void
  focusEditor: () => void
  addPart: (part: ContentPart) => boolean
  readClipboardImage?: () => Promise<File | null>
  getPathForFile?: (file: File) => string
  onPastedTextError?: (error: unknown) => void
}

export function createPromptAttachmentsCore(input: PromptAttachmentsCoreInput) {
  const capture = (): AttachmentTarget | undefined => {
    const prompt = input.capture()
    const editor = input.editor()
    return { prompt, cursor: prompt.cursor() ?? (editor ? getCursorPosition(editor) : 0) }
  }

  const add = async (file: File, toast = true, target = capture()) => {
    if (!target) return false
    const mime = await attachmentMime(file)
    if (!mime) {
      if (toast) input.warn?.()
      return false
    }

    const sourcePath = input.getPathForFile?.(file)
    if (mime === LOCAL_FILE_REFERENCE_MIME) {
      if (!sourcePath) {
        if (toast) input.warn?.()
        return false
      }

      const content = `@${file.name}`
      const attachment: FileAttachmentPart = {
        type: "file",
        path: sourcePath,
        filename: file.name,
        mime,
        content,
        start: target.cursor ?? 0,
        end: (target.cursor ?? 0) + content.length,
      }
      if (input.addPart?.(attachment)) return true
      target.prompt.set([...target.prompt.current(), attachment], target.cursor)
      return true
    }

    const attachment: ImageAttachmentPart = {
      type: "image",
      id: uuid(),
      filename: file.name,
      sourcePath: sourcePath || undefined,
      mime,
      blob: input.draftStore ? await input.draftStore.putBlob(file) : await createBlobReference(file),
    }
    target.prompt.set([...target.prompt.current(), attachment], target.cursor)
    return true
  }

  const addAttachment = (file: File) => add(file)

  const addAttachments = async (files: File[], toast = true, target = capture()) => {
    let found = false

    for (const file of files) {
      const ok = await add(file, false, target)
      if (ok) found = true
    }

    if (!found && files.length > 0 && toast) input.warn?.()
    return found
  }

  const addClipboardAttachment = async (pending: Promise<File | null>, target = capture()) => {
    const file = await pending
    if (!file) return false
    return add(file, true, target)
  }

  const removeAttachment = (id: string) => {
    const target = input.capture()
    const current = target.current()
    const next = current.filter((part) => part.type !== "image" || part.id !== id)
    target.set(next, target.cursor())
  }

  const pastedText = (id: string) => {
    return input
      .capture()
      .current()
      .find((part): part is PastedTextPart => part.type === "pasted_text" && part.id === id)
  }

  const loadPastedText = (part: PastedTextPart) => fetch(part.blob.url).then((response) => response.text())

  const removePastedText = (id: string) => {
    const target = input.capture()
    const part = target.current().find((item): item is PastedTextPart => item.type === "pasted_text" && item.id === id)
    if (part) releaseLocalPastedTextBlob(part.blob)
    target.set(
      target.current().filter((part) => part.type !== "pasted_text" || part.id !== id),
      target.cursor(),
    )
  }

  const movePastedText = async (id: string) => {
    const part = pastedText(id)
    if (!part) return
    try {
      const text = await loadPastedText(part)
      removePastedText(id)
      input.focusEditor?.()
      input.addPart?.({ type: "text", content: text, start: 0, end: 0 })
    } catch (error) {
      input.onPastedTextError?.(error)
    }
  }

  const copyPastedText = async (part: PastedTextPart) => {
    try {
      await navigator.clipboard.writeText(await loadPastedText(part))
    } catch (error) {
      input.onPastedTextError?.(error)
    }
  }

  const handlePaste = async (event: ClipboardEvent) => {
    const clipboardData = event.clipboardData
    if (!clipboardData) return
    const target = capture()
    if (!target) return

    event.preventDefault()
    event.stopPropagation()

    const files = Array.from(clipboardData.items).flatMap((item) => {
      if (item.kind !== "file") return []
      const file = item.getAsFile()
      return file ? [file] : []
    })

    if (files.length > 0) {
      await addAttachments(files, true, target)
      return
    }

    const plainText = clipboardData.getData("text/plain") ?? ""

    // Desktop: Browser clipboard has no images and no text, try platform's native clipboard for images
    if (input.readClipboardImage && !plainText) {
      if (await addClipboardAttachment(input.readClipboardImage(), target)) return
    }

    if (!plainText) return

    const stats = pastedTextStats(plainText)
    if (shouldCreatePastedTextAttachment(plainText, stats)) {
      const source = new Blob([plainText], { type: "text/plain" })
      const attachment: PastedTextPart = {
        type: "pasted_text",
        id: uuid(),
        title: pastedTextTitle(plainText),
        charCount: stats.charCount,
        lineCount: stats.lineCount,
        blob: { id: `paste_local_${uuid()}`, url: URL.createObjectURL(source) },
      }
      target.prompt.set([...target.prompt.current(), attachment], target.cursor)
      if (input.draftStore) {
        void input.draftStore.putBlob(source).then((blob) => {
          releaseLocalPastedTextBlob(attachment.blob)
          const latest = input.capture()
          if (!latest) return
          const current = latest.current()
          if (!current.some((part) => part.type === "pasted_text" && part.id === attachment.id)) return
          latest.set(
            current.map((part) =>
              part.type === "pasted_text" && part.id === attachment.id ? { ...part, blob } : part,
            ),
            latest.cursor(),
          )
        }, input.onPastedTextError)
      }
      return
    }

    const text = normalizePaste(plainText)

    const put = () => {
      if (input.addPart?.({ type: "text", content: text, start: 0, end: 0 })) return true
      input.focusEditor?.()
      return input.addPart?.({ type: "text", content: text, start: 0, end: 0 }) ?? false
    }

    if (pasteMode(text) === "manual") {
      put()
      return
    }

    const inserted = typeof document.execCommand === "function" && document.execCommand("insertText", false, text)
    if (inserted) return

    put()
  }

  return {
    addAttachment,
    addAttachments,
    addClipboardAttachment,
    removeAttachment,
    removePastedText,
    movePastedText,
    copyPastedText,
    handlePaste,
  }
}

export function createPromptAttachments(input: PromptAttachmentsInput) {
  const language = useLanguage()
  const platform = usePlatform()
  const attachments = createPromptAttachmentsCore({
    ...input,
    draftStore: platform.draftStore,
    capture: input.prompt.capture,
    warn: () => {
      showToast({
        title: language.t("prompt.toast.pasteUnsupported.title"),
        description: language.t("prompt.toast.pasteUnsupported.description"),
      })
    },
  })

  const handleGlobalDragOver = (event: DragEvent) => {
    if (input.isDialogActive()) return

    event.preventDefault()
    const hasFiles = event.dataTransfer?.types.includes("Files")
    const hasText = event.dataTransfer?.types.includes("text/plain")
    if (hasFiles) {
      input.setDraggingType("image")
    } else if (hasText) {
      input.setDraggingType("@mention")
    }
  }

  const handleGlobalDragLeave = (event: DragEvent) => {
    if (input.isDialogActive()) return
    if (!event.relatedTarget) {
      input.setDraggingType(null)
    }
  }

  const handleGlobalDrop = async (event: DragEvent) => {
    if (input.isDialogActive()) return

    event.preventDefault()
    input.setDraggingType(null)

    const plainText = event.dataTransfer?.getData("text/plain")
    const filePrefix = "file:"
    if (plainText?.startsWith(filePrefix)) {
      const filePath = plainText.slice(filePrefix.length)
      input.focusEditor()
      input.addPart({ type: "file", path: filePath, content: "@" + filePath, start: 0, end: 0 })
      return
    }

    const dropped = event.dataTransfer?.files
    if (!dropped) return

    await attachments.addAttachments(Array.from(dropped))
  }

  onMount(() => {
    makeEventListener(document, "dragover", handleGlobalDragOver)
    makeEventListener(document, "dragleave", handleGlobalDragLeave)
    makeEventListener(document, "drop", handleGlobalDrop)
  })

  return attachments
}
