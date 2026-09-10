import type { Message, Session } from "@opencode-ai/sdk/v2/client"
import { showToast } from "@/utils/toast"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { Binary } from "@opencode-ai/core/util/binary"
import { useNavigate, useParams, useSearchParams } from "@solidjs/router"
import { batch, startTransition, type Accessor } from "solid-js"
import { useTabs } from "@/context/tabs"
import { useServerSync, type ServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useLocal, type ModelSelection } from "@/context/local"
import { usePermission } from "@/context/permission"
import { usePlatform } from "@/context/platform"
import type { ComputerUsePlatform } from "@/computer-use"
import {
  type ContextItem,
  type ImageAttachmentPart,
  type PastedTextPart,
  type Prompt,
  type usePrompt,
} from "@/context/prompt"
import { useSDK, type DirectorySDK } from "@/context/sdk"
import { useSync, type DirectorySync } from "@/context/sync"
import { Identifier } from "@/utils/id"
import { Worktree as WorktreeState } from "@/utils/worktree"
import { buildRequestParts } from "./build-request-parts"
import { setCursorPosition } from "./editor-dom"
import { formatServerError } from "@/utils/server-errors"
import { ScopedKey } from "@/utils/server-scope"
import { createPromptSubmissionState } from "./submission-state"
import { normalizeSessionInfo } from "@/utils/session"
import { Event } from "@opencode-ai/schema/event"
import { blobDataUrl } from "@/utils/draft-store"
import { parseGoalCommand } from "@/pages/session/session-goal"
import { COMPUTER_USE_INSTRUCTIONS, parseComputerUseCommand } from "./computer-use"

type PendingPrompt = {
  abort: AbortController
  cleanup: VoidFunction
}

const pending = new Map<string, PendingPrompt>()

export type FollowupDraft = {
  sessionID: string
  sessionDirectory: string
  goalID?: string
  synthetic?: boolean
  prompt: Prompt
  context: (ContextItem & { key: string })[]
  agent: string
  model: { providerID: string; modelID: string }
  variant?: string
}

type FollowupSendInput = {
  api: DirectorySDK["api"]["session"]
  serverSync: ServerSync
  sync: DirectorySync
  draft: FollowupDraft
  messageID?: string
  delivery?: "steer" | "queue"
  optimisticBusy?: boolean
  before?: () => Promise<boolean> | boolean
  loadPastedText?: (part: PastedTextPart) => Promise<string>
  instructions?: string
}

const draftText = (prompt: Prompt) => prompt.map((part) => ("content" in part ? part.content : "")).join("")

const draftImages = (prompt: Prompt) => prompt.filter((part): part is ImageAttachmentPart => part.type === "image")
const draftPastedTexts = (prompt: Prompt) =>
  prompt.filter((part): part is PastedTextPart => part.type === "pasted_text")

export async function sendFollowupDraft(input: FollowupSendInput) {
  const text = draftText(input.draft.prompt)
  const images = draftImages(input.draft.prompt)
  const pastedTextParts = draftPastedTexts(input.draft.prompt)
  const pastedTexts = await Promise.all(
    pastedTextParts.map(async (part) => ({
      part,
      text: await (input.loadPastedText
        ? input.loadPastedText(part)
        : fetch(part.blob.url).then((response) => response.text())),
    })),
  )
  const queued = input.delivery === "queue"
  let markedBusy = false
  const setBusy = () => {
    if (!input.optimisticBusy || queued) return
    markedBusy = true
    input.serverSync.session.set("session_status", input.draft.sessionID, { type: "busy" })
  }

  const setIdle = () => {
    if (!markedBusy) return
    input.serverSync.session.set("session_status", input.draft.sessionID, { type: "idle" })
  }

  const wait = async () => {
    const ok = await input.before?.()
    if (ok === false) return false
    return true
  }

  const [head, ...tail] = text.split(" ")
  const cmd = head?.startsWith("/") ? head.slice(1) : undefined
  if (
    !input.instructions &&
    cmd &&
    pastedTextParts.length === 0 &&
    input.sync.data.command.find((item) => item.name === cmd)
  ) {
    setBusy()
    try {
      if (!(await wait())) {
        setIdle()
        return false
      }

      const messageID = Identifier.ascending("message")
      await input.api.command({
        sessionID: input.draft.sessionID,
        id: messageID,
        command: cmd,
        arguments: tail.join(" "),
        agent: input.draft.agent,
        model: {
          id: input.draft.model.modelID,
          providerID: input.draft.model.providerID,
          variant: input.draft.variant,
        },
        files: await Promise.all(
          images.map(async (attachment) => ({
            uri: await blobDataUrl(attachment.blob, attachment.mime),
            name: attachment.filename,
          })),
        ),
      })
      return true
    } catch (err) {
      setIdle()
      throw err
    }
  }

  const messageID = input.messageID ?? Identifier.ascending("message")
  const encodedImages = await Promise.all(
    images.map(async (attachment) => ({
      ...attachment,
      dataUrl: await blobDataUrl(attachment.blob, attachment.mime),
    })),
  )
  const { requestParts, optimisticParts } = buildRequestParts({
    prompt: input.draft.prompt,
    context: input.draft.context,
    images: encodedImages,
    text,
    sessionID: input.draft.sessionID,
    messageID,
    sessionDirectory: input.draft.sessionDirectory,
    synthetic: input.draft.synthetic,
    instructions: input.instructions,
    pastedTexts,
  })

  const message: Message = {
    id: messageID,
    sessionID: input.draft.sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: input.draft.agent,
    model: { ...input.draft.model, variant: input.draft.variant },
  }

  const add = () =>
    input.sync.session.optimistic.add({
      directory: input.draft.sessionDirectory,
      sessionID: input.draft.sessionID,
      message,
      parts: optimisticParts,
    })

  const remove = () =>
    input.sync.session.optimistic.remove({
      directory: input.draft.sessionDirectory,
      sessionID: input.draft.sessionID,
      messageID,
    })

  const addOptimistic = () =>
    batch(() => {
      setBusy()
      add()
    })

  // Computer-use admission checks must see real activity, not our optimistic busy state.
  if (!queued && !input.instructions) addOptimistic()

  try {
    if (!(await wait())) {
      batch(() => {
        setIdle()
        if (!queued) remove()
      })
      return false
    }

    if (!queued && input.instructions) addOptimistic()

    await input.api.prompt({
      sessionID: input.draft.sessionID,
      directory: input.instructions ? input.draft.sessionDirectory : undefined,
      id: messageID,
      agent: input.draft.agent,
      model: input.draft.model,
      variant: input.draft.variant,
      delivery: input.delivery,
      legacyParts: requestParts,
      text: requestParts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
      files: requestParts.flatMap((part) => {
        if (part.type !== "file") return []
        const text = part.source?.text
        return [
          {
            uri: part.url,
            name: part.filename,
            mention: text ? { start: text.start, end: text.end, text: text.value } : undefined,
          },
        ]
      }),
      agents: requestParts.flatMap((part) =>
        part.type === "agent"
          ? [
              {
                name: part.name,
                mention: part.source
                  ? { start: part.source.start, end: part.source.end, text: part.source.value }
                  : undefined,
              },
            ]
          : [],
      ),
    })
    if (queued) await input.serverSync.session.pending.sync(input.draft.sessionID, { force: true })
    return true
  } catch (err) {
    batch(() => {
      setIdle()
      if (!queued) remove()
    })
    throw err
  }
}

type PromptSubmitInput = {
  prompt: ReturnType<typeof usePrompt>
  info: Accessor<{ id: string } | undefined>
  imageAttachments: Accessor<ImageAttachmentPart[]>
  commentCount: Accessor<number>
  autoAccept: Accessor<boolean>
  mode: Accessor<"normal" | "shell">
  working: Accessor<boolean>
  editor: () => HTMLDivElement | undefined
  queueScroll: () => void
  promptLength: (prompt: Prompt) => number
  addToHistory: (prompt: Prompt, mode: "normal" | "shell") => void
  resetHistoryNavigation: () => void
  setMode: (mode: "normal" | "shell") => void
  setPopover: (popover: "at" | "slash" | null) => void
  newSessionWorktree?: Accessor<string | undefined>
  onNewSessionWorktreeReset?: () => void
  shouldQueue?: Accessor<boolean>
  onQueue?: (draft: FollowupDraft) => Promise<boolean> | boolean
  onGoal?: (title: string, session: { id: string; directory: string }) => Promise<boolean> | boolean
  onAbort?: () => void
  onSubmit?: () => void
  model?: ModelSelection
  loadPastedText?: (part: PastedTextPart) => Promise<string>
}

export function createPromptSubmit(input: PromptSubmitInput) {
  const navigate = useNavigate()
  const sdk = useSDK()
  const sync = useSync()
  const serverSync = useServerSync()
  const local = useLocal()
  const permission = usePermission()
  const platform = usePlatform()
  const prompt = input.prompt
  const layout = useLayout()
  const language = useLanguage()
  const params = useParams()
  const [search] = useSearchParams<{ draftId?: string }>()
  const tabs = useTabs()
  const pendingKey = (sessionID: string) => ScopedKey.from(sdk().scope, sessionID)
  type ComputerSubmission = { platform: ComputerUsePlatform; abort: AbortController; sessionID?: string }
  let computerSubmission: ComputerSubmission | undefined

  const stopComputerUse = async (sessionID?: string) => {
    if (!platform.computerUse) return "idle" as const
    return platform.computerUse.stop(sessionID).then(
      (state) => {
        if (state.phase === "idle" || state.phase === "stopping") return state.phase
        if (!state.sessionID && state.phase === "error") return "idle" as const
        if (sessionID && state.sessionID !== sessionID) return "idle" as const
        showToast({ title: language.t("computerUse.title"), description: language.t("computerUse.stopFailed") })
        return false
      },
      () => {
        showToast({ title: language.t("computerUse.title"), description: language.t("computerUse.stopFailed") })
        return false
      },
    )
  }

  const errorMessage = (err: unknown) => {
    if (err && typeof err === "object" && "message" in err && typeof err.message === "string") return err.message
    if (err && typeof err === "object" && "data" in err) {
      const data = (err as { data?: { message?: string } }).data
      if (data?.message) return data.message
    }
    if (err instanceof Error) return err.message
    return language.t("common.requestFailed")
  }

  const abort = async () => {
    const sessionID = params.id
    const api = sdk().api.session
    const key = sessionID ? pendingKey(sessionID) : undefined
    const server = serverSync()
    computerSubmission?.abort.abort()
    if (sessionID || computerSubmission?.sessionID) await stopComputerUse(computerSubmission?.sessionID ?? sessionID)
    if (!sessionID) return Promise.resolve()

    server.session.set("todo", sessionID, [])

    input.onAbort?.()

    const queued = key ? pending.get(key) : undefined
    if (queued) {
      queued.abort.abort()
      queued.cleanup()
      if (key) pending.delete(key)
      return Promise.resolve()
    }
    return api.interrupt({ sessionID }).catch(() => {})
  }

  const restoreCommentItems = (
    target: ReturnType<ReturnType<typeof usePrompt>["capture"]>,
    items: (ContextItem & { key: string })[],
  ) => {
    for (const item of items) {
      target.context.add({
        type: "file",
        path: item.path,
        selection: item.selection,
        comment: item.comment,
        commentID: item.commentID,
        commentOrigin: item.commentOrigin,
        preview: item.preview,
      })
    }
  }

  const clearContext = (target: ReturnType<ReturnType<typeof usePrompt>["capture"]>) => {
    for (const item of target.context.items()) {
      target.context.remove(item.key)
    }
  }

  const seed = (dir: string, info: Session, server = serverSync()) => {
    server.session.remember(info)
    const [, setStore] = server.child(dir)
    setStore("session", (list: Session[]) => {
      const result = Binary.search(list, info.id, (item) => item.id)
      const next = [...list]
      if (result.found) {
        next[result.index] = info
        return next
      }
      next.splice(result.index, 0, info)
      return next
    })
  }

  const submit = async (event: Event, computer?: ComputerSubmission) => {
    event.preventDefault()

    const target = prompt.capture()
    const submission = createPromptSubmissionState({
      target,
      prompt: target.current(),
      context: target.context.items().slice(),
    })
    const currentPrompt = submission.prompt
    const context = submission.context
    const text = currentPrompt.map((part) => ("content" in part ? part.content : "")).join("")
    const images = input.imageAttachments().slice()
    const pastedTextParts = currentPrompt.filter((part): part is PastedTextPart => part.type === "pasted_text")
    const mode = input.mode()
    const origin = {
      sdk: sdk(),
      url: sdk().url,
      scope: sdk().scope,
      directory: sdk().directory,
      sync: sync(),
      server: serverSync(),
      id: params.id,
      dir: params.dir,
      draftID: search.draftId,
    }
    const unchanged = () =>
      !computer?.abort.signal.aborted &&
      sdk().scope === origin.scope &&
      sdk().url === origin.url &&
      sdk().directory === origin.directory &&
      params.id === origin.id &&
      params.dir === origin.dir &&
      search.draftId === origin.draftID &&
      submission.current(prompt.capture()) &&
      target.current() === currentPrompt

    if (text.trim().length === 0 && images.length === 0 && pastedTextParts.length === 0 && input.commentCount() === 0) {
      if (input.working()) void abort()
      return
    }

    const modelSelection = input.model ?? local.model
    const currentModel = modelSelection.current()
    const currentAgent = local.agent.current()
    const variant = modelSelection.variant.current()
    if (!currentModel || !currentAgent) {
      showToast({
        title: language.t("prompt.toast.modelAgentRequired.title"),
        description: language.t("prompt.toast.modelAgentRequired.description"),
      })
      return
    }

    input.addToHistory(currentPrompt, mode)
    input.resetHistoryNavigation()

    const projectDirectory = sdk().directory
    const permissionState = permission.currentServerState()
    const isNewSession = !params.id
    const shouldAutoAccept = isNewSession && input.autoAccept()
    const worktreeSelection = input.newSessionWorktree?.() || "main"

    let sessionDirectory = projectDirectory
    let client = sdk().client

    const handoff = (sessionID: string) =>
      startTransition(() => {
        if (shouldAutoAccept) permissionState.enableAutoAccept(sessionID, sessionDirectory)
        local.session.promote(sessionDirectory, sessionID, {
          agent: currentAgent.name,
          model: { providerID: currentModel.provider.id, modelID: currentModel.id },
          variant: variant ?? null,
        })
        layout.handoff.setTabs(base64Encode(sessionDirectory), sessionID)
        const draftID = search.draftId
        if (draftID) tabs.promoteDraft(draftID, { server: tabs.draft(draftID).server, sessionId: sessionID })
        else navigate(`/${base64Encode(sessionDirectory)}/session/${sessionID}`)
        submission.retarget(prompt.capture({ dir: base64Encode(sessionDirectory), id: sessionID }))
      })

    if (isNewSession) {
      if (worktreeSelection === "create") {
        const createdWorktree = await client.worktree
          .create({ directory: projectDirectory })
          .then((x) => x.data)
          .catch((err) => {
            showToast({
              title: language.t("prompt.toast.worktreeCreateFailed.title"),
              description: errorMessage(err),
            })
            return undefined
          })

        if (!createdWorktree?.directory) {
          showToast({
            title: language.t("prompt.toast.worktreeCreateFailed.title"),
            description: language.t("common.requestFailed"),
          })
          return
        }
        WorktreeState.pending(sdk().scope, createdWorktree.directory)
        sessionDirectory = createdWorktree.directory
      }

      if (worktreeSelection !== "main" && worktreeSelection !== "create") {
        sessionDirectory = worktreeSelection
      }

      if (sessionDirectory !== projectDirectory) {
        client = sdk().createClient({
          directory: sessionDirectory,
          throwOnError: true,
        })
        serverSync().child(sessionDirectory)
      }

      if (!computer) input.onNewSessionWorktreeReset?.()
    }

    if (computer && !unchanged()) {
      showToast({ title: language.t("computerUse.title"), description: language.t("computerUse.changed") })
      return
    }
    let session = input.info()
    if (!session && isNewSession) {
      const created = await (computer ? origin.sdk : sdk()).api.session
        .create({
          agent: currentAgent.name,
          model: { id: currentModel.id, providerID: currentModel.provider.id, variant },
          location: { directory: sessionDirectory },
        })
        .then(normalizeSessionInfo)
        .catch((err) => {
          showToast({
            title: language.t("prompt.toast.sessionCreateFailed.title"),
            description: errorMessage(err),
          })
          return undefined
        })
      if (created) {
        seed(sessionDirectory, created, computer ? origin.server : serverSync())
        session = created
        if (!computer) await handoff(session.id)
      }
    }
    if (!session) {
      showToast({
        title: language.t("prompt.toast.promptSendFailed.title"),
        description: language.t("prompt.toast.promptSendFailed.description"),
      })
      return
    }

    const model = {
      modelID: currentModel.id,
      providerID: currentModel.provider.id,
    }
    const agent = currentAgent.name
    const draft: FollowupDraft = {
      sessionID: session.id,
      sessionDirectory,
      prompt: currentPrompt,
      context,
      agent,
      model,
      variant,
    }

    const clearInput = () => {
      submission.clear()
      input.setMode("normal")
      input.setPopover(null)
    }

    const restoreInput = () => {
      const restored = submission.restore()
      if (!restored) return false
      restored.target.set(restored.prompt, input.promptLength(restored.prompt))
      if (!submission.current(prompt.capture())) return true
      input.setMode(mode)
      input.setPopover(null)
      requestAnimationFrame(() => {
        const editor = input.editor()
        if (!editor) return
        editor.focus()
        setCursorPosition(editor, input.promptLength(currentPrompt))
        input.queueScroll()
      })
      return true
    }

    if (computer) {
      computer.sessionID = session.id
      let activated = false
      let submitted = false
      try {
        if (!unchanged() || (!isNewSession && session.id !== origin.id))
          throw new Error(language.t("computerUse.changed"))
        // Consent must not outlive worktree preparation or follow a changing route.
        const worktree = WorktreeState.get(origin.scope, sessionDirectory)
        if (worktree?.status === "pending") {
          const waiting = new AbortController()
          const cancelled = () => waiting.abort()
          computer.abort.signal.addEventListener("abort", cancelled, { once: true })
          const timer = setTimeout(cancelled, 5 * 60 * 1000)
          const result = await Promise.race([
            WorktreeState.wait(origin.scope, sessionDirectory),
            new Promise<undefined>((resolve) =>
              waiting.signal.addEventListener("abort", () => resolve(undefined), { once: true }),
            ),
          ]).finally(() => {
            clearTimeout(timer)
            computer.abort.signal.removeEventListener("abort", cancelled)
          })
          if (!unchanged()) throw new Error(language.t("computerUse.changed"))
          if (result?.status !== "ready") throw new Error(language.t("workspace.error.stillPreparing"))
        }
        const access = await computer.platform.state()
        if (!unchanged()) throw new Error(language.t("computerUse.changed"))
        if (input.working()) throw new Error(language.t("computerUse.busy"))
        if (!access.available) throw new Error(language.t("computerUse.unavailable"))
        if (access.phase !== "idle" && access.phase !== "error") {
          throw new Error(
            language.t(access.phase === "stopping" ? "computerUse.settings.stoppingStatus" : "computerUse.inUse"),
          )
        }
        const state = await computer.platform.start(session.id, origin.url, sessionDirectory).catch(() => {
          throw new Error(language.t("computerUse.failed"))
        })
        activated = state.phase === "active" && state.sessionID === session.id
        const grantID = state.grantID
        if (!unchanged()) throw new Error(language.t("computerUse.changed"))
        if (!state.available || !activated || !grantID) {
          throw new Error(language.t(state.phase === "error" ? "computerUse.failed" : "computerUse.notGranted"))
        }
        const sent = await sendFollowupDraft({
          api: origin.sdk.api.session,
          sync: origin.sync,
          serverSync: origin.server,
          draft,
          instructions: COMPUTER_USE_INSTRUCTIONS(grantID),
          optimisticBusy: sessionDirectory === projectDirectory,
          loadPastedText: input.loadPastedText,
          before: async () => {
            const current = await computer.platform.state()
            // A replacement grant is not ours to use or revoke during failed admission.
            activated = current.sessionID === session.id && current.grantID === grantID
            if (!unchanged()) throw new Error(language.t("computerUse.changed"))
            if (input.working()) throw new Error(language.t("computerUse.busy"))
            return current.available && current.phase === "active" && activated
          },
        })
        if (!sent) throw new Error(language.t("computerUse.notGranted"))
        if (!unchanged()) throw new Error(language.t("computerUse.changed"))
        if (isNewSession) {
          await handoff(session.id)
          input.onNewSessionWorktreeReset?.()
        }
        clearContext(submission.target())
        clearInput()
        input.onSubmit?.()
        submitted = true
      } catch (err) {
        showToast({ title: language.t("computerUse.title"), description: errorMessage(err) })
      } finally {
        if (activated && !submitted) await stopComputerUse(session.id)
      }
      return
    }

    const goalTitle = pastedTextParts.length === 0 ? parseGoalCommand(text) : undefined
    if (goalTitle !== undefined && input.onGoal) {
      const handled = await input.onGoal(goalTitle, { id: session.id, directory: sessionDirectory })
      if (handled === false) {
        restoreInput()
        return
      }
      clearContext(submission.target())
      clearInput()
      return
    }

    if (!isNewSession && mode === "normal" && input.shouldQueue?.()) {
      const admitted = await input.onQueue?.(draft)
      if (admitted === false) {
        restoreInput()
        return
      }
      clearContext(submission.target())
      clearInput()
      return
    }

    input.onSubmit?.()

    if (mode === "shell" && pastedTextParts.length === 0) {
      clearInput()
      const eventID = Event.ID.create()
      sdk()
        .api.session.shell({
          sessionID: session.id,
          id: eventID,
          command: text,
          agent,
          model,
        })
        .catch((err) => {
          showToast({
            title: language.t("prompt.toast.shellSendFailed.title"),
            description: errorMessage(err),
          })
          restoreInput()
        })
      return
    }

    if (text.startsWith("/") && pastedTextParts.length === 0) {
      const [cmdName, ...args] = text.split(" ")
      const commandName = cmdName.slice(1)
      const customCommand = sync().data.command.find((c) => c.name === commandName)
      if (customCommand) {
        clearInput()
        const messageID = Identifier.ascending("message")
        serverSync().session.set("session_status", session.id, { type: "busy" })
        sdk()
          .api.session.command({
            sessionID: session.id,
            id: messageID,
            command: commandName,
            arguments: args.join(" "),
            agent,
            model: { id: model.modelID, providerID: model.providerID, variant },
            files: await Promise.all(
              images.map(async (attachment) => ({
                uri: await blobDataUrl(attachment.blob, attachment.mime),
                name: attachment.filename,
              })),
            ),
          })
          .catch((err) => {
            serverSync().session.set("session_status", session.id, { type: "idle" })
            showToast({
              title: language.t("prompt.toast.commandSendFailed.title"),
              description: formatServerError(err, language.t, language.t("common.requestFailed")),
            })
            restoreInput()
          })
        return
      }
    }

    const commentItems = context.filter((item) => item.type === "file" && !!item.comment?.trim())
    const messageID = Identifier.ascending("message")

    const removeOptimisticMessage = () => {
      sync().session.optimistic.remove({
        directory: sessionDirectory,
        sessionID: session.id,
        messageID,
      })
    }

    for (const item of commentItems) submission.target().context.remove(item.key)
    clearInput()

    const waitForWorktree = async () => {
      const worktree = WorktreeState.get(sdk().scope, sessionDirectory)
      if (!worktree || worktree.status !== "pending") return true

      if (sessionDirectory === projectDirectory) {
        sync().set("session_status", session.id, { type: "busy" })
      }

      const controller = new AbortController()
      const cleanup = () => {
        if (sessionDirectory === projectDirectory) {
          sync().set("session_status", session.id, { type: "idle" })
        }
        removeOptimisticMessage()
        if (restoreInput()) restoreCommentItems(submission.target(), commentItems)
      }

      pending.set(pendingKey(session.id), { abort: controller, cleanup })

      const abortWait = new Promise<Awaited<ReturnType<typeof WorktreeState.wait>>>((resolve) => {
        if (controller.signal.aborted) {
          resolve({ status: "failed", message: "aborted" })
          return
        }
        controller.signal.addEventListener(
          "abort",
          () => {
            resolve({ status: "failed", message: "aborted" })
          },
          { once: true },
        )
      })

      const timeoutMs = 5 * 60 * 1000
      const timer = { id: undefined as number | undefined }
      const timeout = new Promise<Awaited<ReturnType<typeof WorktreeState.wait>>>((resolve) => {
        timer.id = window.setTimeout(() => {
          resolve({
            status: "failed",
            message: language.t("workspace.error.stillPreparing"),
          })
        }, timeoutMs)
      })

      const result = await Promise.race([
        WorktreeState.wait(sdk().scope, sessionDirectory),
        abortWait,
        timeout,
      ]).finally(() => {
        if (timer.id === undefined) return
        clearTimeout(timer.id)
      })
      pending.delete(pendingKey(session.id))
      if (controller.signal.aborted) return false
      if (result.status === "failed") throw new Error(result.message)
      return true
    }

    await sendFollowupDraft({
      api: sdk().api.session,
      sync: sync(),
      serverSync: serverSync(),
      draft,
      messageID,
      optimisticBusy: sessionDirectory === projectDirectory,
      before: waitForWorktree,
      loadPastedText: input.loadPastedText,
    }).catch((err) => {
      pending.delete(pendingKey(session.id))
      if (sessionDirectory === projectDirectory) {
        sync().set("session_status", session.id, { type: "idle" })
      }
      showToast({
        title: language.t("prompt.toast.promptSendFailed.title"),
        description: errorMessage(err),
      })
      removeOptimisticMessage()
      if (restoreInput()) restoreCommentItems(submission.target(), commentItems)
    })
  }

  const handleSubmit = async (event: Event) => {
    event.preventDefault()
    const command = input.mode() === "normal" ? parseComputerUseCommand(draftText(prompt.current())) : undefined
    if (!command) return submit(event)
    if (command.type === "usage") {
      showToast({ title: language.t("computerUse.title"), description: language.t("computerUse.usage") })
      return
    }
    if (command.type === "off") {
      computerSubmission?.abort.abort()
      const target = prompt.capture()
      const current = target.current()
      const phase = await stopComputerUse()
      if (!phase) return
      if (target.current() === current) target.reset()
      showToast({
        title: language.t(phase === "stopping" ? "computerUse.settings.stoppingStatus" : "computerUse.stopped"),
      })
      return
    }
    if (platform.platform !== "desktop" || !platform.computerUse) {
      showToast({ title: language.t("computerUse.title"), description: language.t("computerUse.unavailable") })
      return
    }
    if (computerSubmission) {
      showToast({ title: language.t("computerUse.title"), description: language.t("computerUse.pending") })
      return
    }
    if (input.working()) {
      showToast({ title: language.t("computerUse.title"), description: language.t("computerUse.busy") })
      return
    }
    const request = { platform: platform.computerUse, abort: new AbortController() }
    computerSubmission = request
    await submit(event, request).finally(() => {
      if (computerSubmission === request) computerSubmission = undefined
    })
  }

  return {
    abort,
    handleSubmit,
  }
}
