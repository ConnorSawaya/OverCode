import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { useNavigate } from "@solidjs/router"
import { LocalProvider, useLocal } from "@/context/local"
import { DirectoryDataProvider } from "@/pages/directory-layout"
import { normalizeSessionInfo } from "@/utils/session"
import { sessionHref } from "@/utils/session-route"
import { ModelSelectorPopoverV2 } from "@/components/dialog-select-model"
import { PromptInputV2PermissionControl } from "@/components/prompt-input-v2"
import { SessionPermissionDock } from "./composer/session-permission-dock"
import { SessionQuestionDock } from "./composer/session-question-dock"
import { LOCAL_FILE_REFERENCE_MIME } from "@opencode-ai/core/file"
import type { FileAttachmentPart, Prompt } from "@/context/prompt"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useSync } from "@/context/sync"
import { SDKProvider, useSDK } from "@/context/sdk"
import { useServerSync } from "@/context/server-sync"
import { ServerConnection } from "@/context/server"
import { tabKey, useTabs, type SessionTab } from "@/context/tabs"
import { showToast } from "@/utils/toast"
import { type SidePanelDraft, type SidePanelTab } from "@/context/layout"
import { sendFollowupDraft } from "@/components/prompt-input/submit"
import { DictationControl } from "@/components/prompt-input/dictation-control"
import {
  PromptInputV2Select,
  PromptInputV2SubmitButton,
  type PromptInputV2Option,
} from "@opencode-ai/session-ui/v2/prompt-input"
import { Icon as V2Icon } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { SessionTurn } from "@opencode-ai/session-ui/session-turn"
import { errorMessage } from "../layout/helpers"
import { BrowserPanel } from "./side-browser"
import { chatTabTitle } from "./side-panel-transcript"
import { buildTextPrompt, resolveFollowupIdentity } from "./side-panel-followup"

const tabButtonClass = (active: boolean) =>
  `shrink-0 rounded-md px-2 py-1 text-13-medium [font-weight:530] ${
    active ? "bg-surface-base-active text-text-strong" : "text-text-weak hover:text-text-strong"
  }`

type SessionChoice = {
  sessionID: string
  server: ServerConnection.Key
  title: string
  updated: number
  current: boolean
}

const directoryLabel = (directory?: string) => {
  if (!directory) return ""
  const parts = directory.split(/[\\/]/).filter(Boolean)
  return parts.at(-1) || directory
}

function ChatSessionPicker(props: {
  selected: Accessor<string | undefined>
  onSelect: (sessionID: string | undefined) => void
  sourceSessionID?: string
  sourceDirectory?: string
  sourceServer?: ServerConnection.Key
}) {
  const global = useGlobal()
  const language = useLanguage()
  const tabs = useTabs()
  const currentSync = useSync()
  const sdk = useSDK()
  const serverSync = useServerSync()
  const local = useLocal()
  const [picker, setPicker] = createStore({ search: "", creating: false, limit: 18 })
  const create = async (fork: boolean) => {
    if (picker.creating) return
    setPicker("creating", true)
    try {
      const model = local.model.current()
      const agent = local.agent.current()
      const session = normalizeSessionInfo(
        fork && props.sourceSessionID
          ? await sdk().api.session.fork({ sessionID: props.sourceSessionID })
          : await sdk().api.session.create({
              location: { directory: props.sourceDirectory ?? sdk().directory },
              agent: agent?.name,
              model: model ? { id: model.id, providerID: model.provider.id, variant: local.model.variant.current() } : undefined,
            }),
      )
      serverSync().session.remember(session)
      currentSync().session.remember(session)
      props.onSelect(session.id)
    } catch (error) {
      showToast({ title: language.t("common.requestFailed"), description: errorMessage(error, language.t("common.requestFailed")) })
    } finally {
      setPicker("creating", false)
    }
  }
  const sessionTabs = createMemo(() => tabs.store.filter((tab): tab is SessionTab => tab.type === "session"))
  const sourceTab = createMemo(() => {
    if (!props.sourceSessionID) return undefined
    return sessionTabs().find((tab) => tab.sessionId === props.sourceSessionID)
  })
  const sourceServer = createMemo(() => props.sourceServer ?? sourceTab()?.server)
  const resolvedSourceServer = createMemo(
    () => sourceServer() ?? global.servers.list().map(ServerConnection.key).at(0),
  )
  const sourceSync = createMemo(() => currentSync())

  createEffect(() => {
    const sync = sourceSync()
    if (sync) void sync.session.fetch(picker.limit).catch(() => {})
  })

  const titleFor = (tab: SessionTab) => {
    const conn = global.servers.list().find((item) => ServerConnection.key(item) === tab.server)
    const live = conn ? global.ensureServerCtx(conn).sync.session.peek(tab.sessionId) : undefined
    return chatTabTitle(tab.sessionId, tabs.info[tabKey(tab)]?.title, live)
  }

  const choices = createMemo<SessionChoice[]>(() => {
    const result = new Map<string, SessionChoice>()
    const server = resolvedSourceServer()
    const directory = props.sourceDirectory
    for (const session of sourceSync()?.data.session ?? []) {
      if (session.parentID || session.time.archived || !server) continue
      result.set(session.id, {
        sessionID: session.id,
        server,
        title: chatTabTitle(session.id, undefined, session),
        updated: session.time.updated ?? session.time.created,
        current: session.id === props.sourceSessionID,
      })
    }
    for (const tab of sessionTabs()) {
      if (server && tab.server !== server) continue
      const conn = global.servers.list().find((item) => ServerConnection.key(item) === tab.server)
      const live = conn ? global.ensureServerCtx(conn).sync.session.peek(tab.sessionId) : undefined
      if (directory && live?.directory && live.directory !== directory) continue
      result.set(tab.sessionId, {
        sessionID: tab.sessionId,
        server: tab.server,
        title: titleFor(tab),
        updated: live?.time.updated ?? live?.time.created ?? 0,
        current: tab.sessionId === props.sourceSessionID,
      })
    }
    return [...result.values()].filter((choice) => choice.title.toLowerCase().includes(picker.search.toLowerCase())).sort((a, b) => b.updated - a.updated)
  })

  return (
    <div class="flex min-h-0 flex-1 flex-col">
      <div class="shrink-0 border-b border-border-weak-base px-3 py-3">
        <div class="flex items-center gap-2">
          <Icon name="prompt" size="small" class="text-text-weak" />
          <span class="text-14-medium text-text-strong">{language.t("side.picker.title")}</span>
        </div>
        <Show when={props.sourceDirectory}>
          <div class="mt-1 truncate pl-5 text-12-regular text-text-weak">
            {directoryLabel(props.sourceDirectory)} · {language.t("side.chat.historyDescription")}
          </div>
        </Show>
      </div>
      <div class="flex shrink-0 flex-col gap-2 border-b border-border-weak-base px-3 py-3">
        <div class="flex gap-2">
          <button type="button" disabled={picker.creating} onClick={() => void create(false)}
            class="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-border-weak-base px-2 py-2 text-12-medium text-text-strong hover:bg-surface-weak">
            <Icon name="plus-small" size="small" />{language.t("side.chat.new")}
          </button>
          <Show when={props.sourceSessionID}>
            <button type="button" disabled={picker.creating} onClick={() => void create(true)}
              class="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-border-weak-base px-2 py-2 text-12-medium text-text-strong hover:bg-surface-weak">
              <Icon name="branch" size="small" />{language.t("side.chat.branch")}
            </button>
          </Show>
        </div>
        <input value={picker.search} onInput={(event) => setPicker("search", event.currentTarget.value)}
          aria-label={language.t("side.chat.search")} placeholder={language.t("side.chat.search")}
          class="h-8 rounded-md border border-transparent bg-surface-weak px-2.5 text-13-regular text-text-strong outline-none focus:border-border-focus" />
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto px-2 pb-2 pt-2">
        <Show
          when={choices().length > 0}
          fallback={<div class="px-2 py-8 text-center text-13-regular text-text-weak">{language.t("side.chat.noSessions")}</div>}
        >
          <div class="flex flex-col gap-0.5">
            <For each={choices()}>
              {(choice) => {
                const selected = () => props.selected() === choice.sessionID
                return (
                  <button
                    type="button"
                    class="group min-w-0 flex items-center gap-2 rounded-md px-2.5 py-2 text-left hover:bg-surface-raised-base-hover"
                    classList={{ "bg-surface-base-active": selected() }}
                    aria-pressed={selected()}
                    onClick={() => props.onSelect(choice.sessionID)}
                  >
                    <Icon name="prompt" size="small" class="shrink-0 text-text-weak" />
                    <span class="min-w-0 flex-1 truncate text-13-regular text-text-strong">{choice.title}</span>
                    <Show when={choice.current}>
                      <span class="shrink-0 text-11-medium text-text-weak">{language.t("side.chat.current")}</span>
                    </Show>
                    <Show when={selected()}>
                      <Icon name="check-small" size="small" class="shrink-0 text-icon-success-base" />
                    </Show>
                  </button>
                )
              }}
            </For>
          </div>
        </Show>
        <Show when={(sourceSync().data.session.length ?? 0) >= picker.limit}>
          <button type="button" class="w-full rounded px-2 py-2 text-12-medium text-text-weak hover:bg-surface-weak"
            onClick={() => setPicker("limit", picker.limit + 18)}>{language.t("common.loadMore")}</button>
        </Show>
      </div>
    </div>
  )
}

type SideAttachment = SidePanelDraft["attachments"][number]
type SideQueuedDraft = SidePanelDraft

const sidePrompt = (text: string, attachments: SideAttachment[]): Prompt => {
  const content = text
  const prompt: Prompt = content ? [...buildTextPrompt(content)] : []
  let start = content.length
  for (const attachment of attachments) {
    const mention = `@${attachment.name}`
    prompt.push({
      type: "file",
      path: attachment.path,
      filename: attachment.name,
      mime: LOCAL_FILE_REFERENCE_MIME,
      content: (start > 0 ? " " : "") + mention,
      start,
      end: start + mention.length + (start > 0 ? 1 : 0),
    } satisfies FileAttachmentPart)
    start += mention.length + (start > 0 ? 1 : 0)
  }
  return prompt
}

function ChatTranscript(props: {
  tab: SessionTab
  onDeselect: () => void
  sourceDirectory?: string
  draft: (sessionID: string) => SidePanelDraft
  onDraft: (sessionID: string, draft: SidePanelDraft) => void
}) {
  const language = useLanguage()
  const platform = usePlatform()
  const tabs = useTabs()
  const sync = useSync()
  const sdk = useSDK()
  const serverSync = useServerSync()
  const local = useLocal()
  const navigate = useNavigate()
  const [view, setView] = createStore({ responding: "", error: "", atBottom: true })
  let scroller: HTMLDivElement | undefined
  let fileInput: HTMLInputElement | undefined

  const title = createMemo(() => {
    const session = serverSync().session.peek(props.tab.sessionId)
    if (!session) return view.error ? language.t("side.chat.unavailable") : language.t("side.chat.loading")
    return chatTabTitle(props.tab.sessionId, tabs.info[tabKey(props.tab)]?.title, session)
  })
  const messages = createMemo(() => sync().data.message[props.tab.sessionId])
  const userMessages = createMemo(() => (messages() ?? []).filter((message) => message.role === "user"))
  const identity = createMemo(() => {
    const model = local.model.current()
    const agent = local.agent.current()
    if (!model || !agent) return
    return {
      agent: agent.name,
      model: { providerID: model.provider.id, modelID: model.id },
      variant: local.model.variant.current(),
    }
  })
  createEffect(() => {
    const resolved = resolveFollowupIdentity(messages())
    const session = serverSync().session.peek(props.tab.sessionId)
    const saved = resolved ?? (session?.agent && session.model ? {
      agent: session.agent,
      model: { providerID: session.model.providerID, modelID: session.model.id, variant: session.model.variant },
    } : undefined)
    if (saved) local.session.restore({ sessionID: props.tab.sessionId, agent: saved.agent, model: { ...saved.model, variant: resolved?.variant ?? session?.model?.variant } })
  })
  const directory = createMemo(() => serverSync().session.peek(props.tab.sessionId)?.directory ?? props.sourceDirectory)
  const directorySync = createMemo(() => sync())
  const chatDraft = createMemo(() => props.draft(props.tab.sessionId))
  const reply = () => chatDraft().text
  const attachments = () => chatDraft().attachments
  const updateDraft = (next: Partial<SidePanelDraft>) =>
    props.onDraft(props.tab.sessionId, { ...chatDraft(), ...next })
  const [inflight, setInflight] = createSignal(0)
  const sending = () => inflight() > 0
  const [loading, setLoading] = createSignal(true)
  const queued = createMemo(() => serverSync().session.pending.list(props.tab.sessionId) ?? [])
  const working = createMemo(() => directorySync()?.data.session_working(props.tab.sessionId) ?? false)
  const status = createMemo(() => directorySync()?.data.session_status[props.tab.sessionId] ?? { type: "idle" as const })
  const activeMessageID = createMemo(() => {
    if (!working()) return
    const unfinished = (messages() ?? []).findLast(
      (message) => message.role === "assistant" && typeof message.time.completed !== "number",
    )
    if (unfinished?.role === "assistant") return unfinished.parentID
    return userMessages().at(-1)?.id
  })
  const permissionCount = createMemo(
    () => directorySync()?.data.permission[props.tab.sessionId]?.length ?? 0,
  )
  const permission = () => directorySync().data.permission[props.tab.sessionId]?.[0]
  const question = () => directorySync().data.question[props.tab.sessionId]?.[0]
  const agentOptions = createMemo<PromptInputV2Option[]>(() =>
    local.agent.list().map((agent) => ({ id: agent.name, label: agent.name })),
  )
  const variantOptions = createMemo<PromptInputV2Option[]>(() =>
    local.model.variant.list().map((variant) => ({ id: variant, label: variant })),
  )
  const decide = async (reply: "once" | "always" | "reject") => {
    const request = permission()
    if (!request || view.responding) return
    setView("responding", request.id)
    try { await sdk().api.permission.reply({ sessionID: request.sessionID, requestID: request.id, reply }) }
    catch (error) { showToast({ title: language.t("common.requestFailed"), description: errorMessage(error, language.t("common.requestFailed")) }) }
    finally { setView("responding", "") }
  }

  const draftFor = (entry: SideQueuedDraft) => ({
    sessionID: props.tab.sessionId,
    sessionDirectory: directory()!,
    prompt: sidePrompt(entry.text, entry.attachments),
    context: [],
    agent: identity()!.agent,
    model: identity()!.model,
    variant: identity()!.variant,
  })

  const dispatch = async (entry: SideQueuedDraft, delivery: "steer" | "queue") => {
    const resolved = identity()
    const targetDirectory = directory()
    if (!resolved || !targetDirectory) return false
    setInflight((value) => value + 1)
    try {
      const sync = directorySync()
      if (!sync) return false
      await sendFollowupDraft({
        api: sdk().api.session,
        serverSync: serverSync(),
        sync,
        draft: draftFor(entry),
        optimisticBusy: delivery === "steer",
        delivery,
      })
      return true
    } catch (err) {
      showToast({ title: language.t("common.requestFailed"), description: errorMessage(err, language.t("common.requestFailed")) })
      return false
    } finally {
      setInflight((value) => Math.max(0, value - 1))
    }
  }

  const send = () => {
    const sessionID = props.tab.sessionId
    const saved = { text: reply(), attachments: [...attachments()] }
    const text = saved.text.trim()
    const files = saved.attachments
    if ((!text && files.length === 0) || !identity() || loading()) return
    const entry: SideQueuedDraft = { text, attachments: files }
    props.onDraft(sessionID, { text: "", attachments: [] })
    const delivery =
      sending() || queued().length > 0 || working()
        ? "queue"
        : "steer"
    void dispatch(entry, delivery).then((sent) => {
      if (sent) return
      const current = props.draft(sessionID)
      if (current.text || current.attachments.length > 0) return
      props.onDraft(sessionID, saved)
    })
  }

  const addFile = async (file: File) => {
    const path = platform.getPathForFile?.(file)
    if (!path) {
      showToast({ title: language.t("side.chat.filePathUnavailable"), description: file.name })
      return
    }
    const items = attachments()
    if (items.some((item) => item.path === path)) return
    updateDraft({ attachments: [...items, { path, name: file.name }] })
  }

  const chooseFiles = () => {
    if (platform.openAttachmentPickerDialog) {
      void platform
        .openAttachmentPickerDialog(
          { title: language.t("side.chat.attach"), multiple: true, allowAll: true, defaultPath: directory() },
          addFile,
        )
        .catch((err) => showToast({ title: language.t("common.requestFailed"), description: errorMessage(err, language.t("common.requestFailed")) }))
      return
    }
    fileInput?.click()
  }

  createEffect(() => {
    const sessionID = props.tab.sessionId
    let active = true
    setLoading(true)
    setView("error", "")
    void serverSync().session
      .sync(sessionID)
      .then(() => serverSync().session.pending.sync(sessionID, { force: true }))
      .catch((error) => { if (active) setView("error", errorMessage(error, language.t("common.requestFailed"))) })
      .finally(() => {
        if (active) setLoading(false)
      })
    onCleanup(() => {
      active = false
    })
  })
  createEffect(() => {
    for (const message of messages() ?? []) {
      const parts = sync().data.part[message.id] ?? []
      const tail = parts.at(-1)
      if (tail?.type === "text" || tail?.type === "reasoning") tail.text
      if (tail?.type === "tool") tail.state
      if (message.role === "assistant") message.time.completed
    }
    const el = scroller
    if (!el) return
    if (view.atBottom) requestAnimationFrame(() => { if (scroller) scroller.scrollTop = scroller.scrollHeight })
  })

  const loadEarlier = async () => {
    const el = scroller
    const height = el?.scrollHeight ?? 0
    const top = el?.scrollTop ?? 0
    setView("atBottom", false)
    try {
      await serverSync().session.history.loadMore(props.tab.sessionId)
      requestAnimationFrame(() => { if (el) el.scrollTop = top + el.scrollHeight - height })
    } catch (error) { setView("error", errorMessage(error, language.t("common.requestFailed"))) }
  }

  const stop = async () => {
    const targetDirectory = directory()
    if (!targetDirectory) return
    const sessionID = props.tab.sessionId
    const session = sdk().api.session
    try {
      await platform.computerUse?.stop(sessionID).catch(() => {
        showToast({ title: language.t("computerUse.title"), description: language.t("computerUse.stopFailed") })
      })
      await session.interrupt({ sessionID })
    } catch (err) {
      showToast({
        title: language.t("common.requestFailed"),
        description: errorMessage(err, language.t("common.requestFailed")),
      })
    }
  }

  return (
    <div class="flex min-h-0 flex-1 flex-col">
      <div class="flex shrink-0 items-center gap-2 border-b border-border-weak-base px-3 py-2">
        <Tooltip value={language.t("side.chat.switch")} placement="bottom">
          <IconButton
            icon="menu"
            variant="ghost"
            class="size-7 rounded-md"
            aria-label={language.t("side.chat.switch")}
            onClick={props.onDeselect}
          />
        </Tooltip>
        <div class="min-w-0 flex-1">
          <div class="truncate text-14-medium text-text-strong">{title()}</div>
          <Show when={!view.error && serverSync().session.peek(props.tab.sessionId) && directory()}>
            <div class="truncate text-12-regular text-text-weak">
              {directoryLabel(directory())} · {language.t("side.chat.projectContext")}
            </div>
          </Show>
        </div>
        <Show when={!view.error}>
          <Show when={working()}>
            <span class="flex shrink-0 items-center gap-1.5 text-11-medium text-text-weak" role="status">
              <span class="size-1.5 rounded-full bg-icon-warning-base animate-pulse" />
              {language.t("side.chat.working")}
            </span>
          </Show>
          <Show when={permissionCount() > 0}>
            <span class="size-1.5 shrink-0 rounded-full bg-icon-warning-base" />
          </Show>
          <Tooltip value={language.t("side.chat.openMain")} placement="bottom">
            <IconButton icon="square-arrow-top-right" variant="ghost" class="size-7 rounded-md"
              aria-label={language.t("side.chat.openMain")}
              onClick={() => navigate(sessionHref(props.tab.server, props.tab.sessionId))} />
          </Tooltip>
        </Show>
      </div>
      <div ref={(el) => (scroller = el)} class="min-h-0 flex-1 overflow-y-auto px-3 pb-5 pt-1"
        onScroll={(event) => { const el = event.currentTarget; setView("atBottom", el.scrollHeight - el.scrollTop - el.clientHeight < 80) }}>
        <Show
          when={view.error}
          fallback={
            <>
              <Show when={serverSync().session.history.more(props.tab.sessionId)}>
                <button type="button" class="w-full rounded-md px-2 py-2 text-12-medium text-text-weak hover:bg-surface-weak"
                  disabled={serverSync().session.history.loading(props.tab.sessionId)}
                  onClick={() => void loadEarlier()}>
                  {language.t("side.chat.older")}
                </button>
              </Show>
              <Show
                when={!loading()}
                fallback={<div class="px-2 py-8 text-center text-13-regular text-text-weak">{language.t("side.chat.loading")}</div>}
              >
                <Show
                  when={userMessages().length > 0}
                  fallback={
                    <div class="px-2 py-8 text-center">
                      <Icon name="prompt" size="normal" class="mx-auto mb-2 text-text-weak" />
                      <div class="text-14-medium text-text-strong">{language.t("side.chat.empty")}</div>
                    </div>
                  }
                >
                  <div data-component="side-chat-timeline" class="flex min-w-0 flex-col gap-6 py-4">
                    <For each={userMessages()}>
                      {(message) => (
                        <SessionTurn
                          sessionID={props.tab.sessionId}
                          messageID={message.id}
                          messages={messages()}
                          status={status()}
                          active={activeMessageID() === message.id}
                          showReasoningSummaries
                          classes={{
                            root: "!h-auto !block",
                            content: "!h-auto !overflow-visible",
                            container: "min-w-0",
                          }}
                        />
                      )}
                    </For>
                  </div>
                </Show>
              </Show>
            </>
          }
        >
          <div class="mx-1 mt-10 rounded-xl border border-border-weak-base bg-surface-weak px-4 py-5 text-center" role="alert">
            <Icon name="warning" size="normal" class="mx-auto mb-3 text-icon-warning-base" />
            <div class="text-14-medium text-text-strong">{language.t("side.chat.unavailable")}</div>
            <div class="mx-auto mt-1 max-w-56 text-12-regular leading-5 text-text-weak">
              {language.t("side.chat.unavailableDescription")}
            </div>
            <button type="button" class="mt-4 rounded-md border border-border-weak-base bg-surface-base px-3 py-1.5 text-12-medium text-text-strong hover:bg-surface-base-active"
              onClick={props.onDeselect}>
              {language.t("side.chat.chooseAnother")}
            </button>
          </div>
        </Show>
      </div>
      <Show when={!view.atBottom}>
        <button type="button" class="mx-auto mb-2 flex shrink-0 items-center gap-1 rounded-full border border-border-weak-base px-3 py-1 text-12-regular text-text-strong"
          onClick={() => { setView("atBottom", true); if (scroller) scroller.scrollTop = scroller.scrollHeight }}>
          <Icon name="chevron-down" size="small" />{language.t("side.chat.latest")}
        </button>
      </Show>
      <div class="max-h-[45%] shrink-0 overflow-y-auto px-3" data-component="side-chat-requests">
        <Show when={permission()} keyed>{(request) => <SessionPermissionDock request={request} responding={view.responding === request.id} onDecide={(reply) => void decide(reply)} />}</Show>
        <Show when={question()} keyed>{(request) => <SessionQuestionDock request={request} onSubmit={() => {}} />}</Show>
      </div>
      <Show when={queued().length > 0}>
        <div class="shrink-0 border-t border-border-weak-base px-3 py-2">
          <div class="mb-1 text-12-medium text-text-weak">{language.t("side.chat.queued", { count: queued().length })}</div>
          <div class="flex max-h-20 flex-col gap-1 overflow-y-auto">
            <For each={queued()}>
              {(entry) => (
                <div class="flex items-center gap-1.5 rounded-md bg-surface-weak px-2 py-1">
                  <span class="min-w-0 flex-1 truncate text-12-regular text-text-strong">
                    {entry.text || entry.files.map((file) => file.name).filter(Boolean).join(", ")}
                  </span>
                  <IconButton
                    icon="close-small"
                    variant="ghost"
                    class="size-5 shrink-0 rounded"
                    aria-label={language.t("side.chat.removeQueued")}
                    onClick={() => {
                      void serverSync().session.pending
                        .cancel({
                          sessionID: props.tab.sessionId,
                          messageID: entry.id,
                          directory: directory(),
                        })
                        .catch((err) =>
                          showToast({
                            title: language.t("common.requestFailed"),
                            description: errorMessage(err, language.t("common.requestFailed")),
                          }),
                        )
                    }}
                  />
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>
      <Show
        when={!loading() && identity()}
        fallback={<div class="shrink-0 border-t border-border-weak-base px-3 py-3 text-12-regular text-text-weak">{language.t("side.chat.identityMissing")}</div>}
      >
        <form
          class="shrink-0 px-3 pb-3 pt-1"
          onSubmit={(event) => {
            event.preventDefault()
            send()
          }}
        >
          <Show when={attachments().length > 0}>
            <div class="mb-2 flex flex-wrap gap-1.5">
              <For each={attachments()}>
                {(file) => (
                  <div class="flex max-w-full items-center gap-1 rounded-md bg-surface-weak px-1.5 py-1">
                    <Icon name="open-file" size="small" class="shrink-0 text-text-weak" />
                    <span class="max-w-40 truncate text-12-regular text-text-strong">{file.name}</span>
                    <IconButton
                      icon="close-small"
                      variant="ghost"
                      class="size-5 shrink-0 rounded"
                      aria-label={language.t("side.chat.removeAttachment")}
                      onClick={() =>
                        updateDraft({ attachments: attachments().filter((item) => item.path !== file.path) })
                      }
                    />
                  </div>
                )}
              </For>
            </div>
          </Show>
          <div class="group/side-composer relative min-h-[98px] w-full overflow-clip rounded-[18px] border border-v2-border-border-base bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)] transition-colors focus-within:border-v2-border-border-strong">
            <textarea
              value={reply()}
              onInput={(event) => updateDraft({ text: event.currentTarget.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
                  event.preventDefault()
                  send()
                }
              }}
              placeholder={language.t("side.chat.placeholder")}
              aria-label={language.t("side.chat.placeholder")}
              rows={1}
              class="block min-h-[57px] max-h-[57px] w-full resize-none overflow-y-auto bg-transparent px-3 pt-3 pb-1 text-[13px] font-[440] leading-5 text-v2-text-text-base outline-none placeholder:text-v2-text-text-faint"
            />
            <input
              ref={(el) => (fileInput = el)}
              type="file"
              multiple
              class="hidden"
              onChange={(event) => {
                const files = Array.from(event.currentTarget.files ?? [])
                event.currentTarget.value = ""
                for (const file of files) void addFile(file)
              }}
            />
            <div class="flex h-10 items-center gap-2 px-2 pb-1">
              <div class="flex min-w-0 items-center gap-0.5">
                <TooltipV2 placement="top" gutter={4} value={language.t("side.chat.attach")}>
                  <IconButtonV2
                    type="button"
                    icon={<V2Icon name="plus" />}
                    variant="ghost-muted"
                    size="large"
                    class="size-7 shrink-0 rounded-md"
                    aria-label={language.t("side.chat.attach")}
                    onClick={chooseFiles}
                  />
                </TooltipV2>
                <PromptInputV2PermissionControl sessionID={props.tab.sessionId} />
                <Show when={agentOptions().length > 0}>
                  <PromptInputV2Select
                    title={language.t("side.chat.agent")}
                    options={agentOptions()}
                    current={local.agent.current()?.name ?? agentOptions()[0]?.id ?? ""}
                    onSelect={(value) => local.agent.set(value)}
                  />
                </Show>
              </div>
              <div class="ml-auto flex min-w-0 items-center justify-end gap-0.5">
                <ModelSelectorPopoverV2 model={local.model}
                  trigger={(trigger) => <button {...trigger} type="button" aria-label={language.t("dialog.model.select.title")}
                    class="flex min-w-0 max-w-64 items-center justify-start gap-1 rounded-md px-1 py-1 text-12-regular text-v2-text-text-muted hover:bg-v2-overlay-simple-overlay-hover">
                    <span class="truncate">{local.model.current()?.name ?? identity()?.model.modelID}</span><Icon name="chevron-down" size="small" />
                  </button>} />
                <Show when={variantOptions().length > 0}>
                  <PromptInputV2Select
                    title={language.t("side.chat.effort")}
                    options={[{ id: "", label: language.t("common.default") }, ...variantOptions()]}
                    current={local.model.variant.current() ?? ""}
                    onSelect={(value) => local.model.variant.set(value || undefined)}
                    class="max-w-28"
                  />
                </Show>
                <DictationControl
                  getText={reply}
                  onText={(text) => updateDraft({ text })}
                />
              </div>
              <PromptInputV2SubmitButton
                mode="normal"
                stopping={working() && !reply().trim() && attachments().length === 0}
                disabled={loading() || (!reply().trim() && attachments().length === 0)}
                sendLabel={language.t("side.chat.send")}
                stopLabel={language.t("prompt.action.stop")}
                onSubmit={send}
                onStop={() => void stop()}
              />
            </div>
          </div>
        </form>
      </Show>
    </div>
  )
}

function SideChatSession(props: Parameters<typeof ChatTranscript>[0]) {
  const sync = useServerSync()
  const directory = () => sync().session.peek(props.tab.sessionId)?.directory ?? props.sourceDirectory
  createEffect(() => { void sync().session.resolve(props.tab.sessionId).catch(() => {}) })
  return (
    <Show when={directory()} keyed>
      {(directory) => (
        <SDKProvider directory={directory}>
          <DirectoryDataProvider directory={directory} server={() => props.tab.server} sessionID={props.tab.sessionId}>
            <LocalProvider sessionID={props.tab.sessionId}>
              <ChatTranscript {...props} />
            </LocalProvider>
          </DirectoryDataProvider>
        </SDKProvider>
      )}
    </Show>
  )
}


export function SidePanel(props: {
  tab: Accessor<SidePanelTab>
  width: Accessor<number>
  maxWidth: Accessor<number>
  chatSessionID: Accessor<string | undefined>
  sourceSessionID?: string
  sourceDirectory?: string
  sourceServer?: ServerConnection.Key
  draft: (sessionID: string) => SidePanelDraft
  onTab: (tab: SidePanelTab) => void
  onChatSession: (sessionID: string | undefined) => void
  onDraft: (sessionID: string, draft: SidePanelDraft) => void
  onClose: () => void
  onResize: (width: number) => void
}) {
  const language = useLanguage()
  const tabs = useTabs()
  const browser = () => props.tab() === "browser"
  const [chooseChat, setChooseChat] = createSignal(
    !props.chatSessionID() || props.chatSessionID() === props.sourceSessionID,
  )
  const sourceServer = createMemo(() => {
    if (props.sourceServer) return props.sourceServer
    const sourceID = props.sourceSessionID
    if (!sourceID) return undefined
    return tabs.store.find((item): item is SessionTab => item.type === "session" && item.sessionId === sourceID)?.server
  })
  const selectedChatID = createMemo(() => props.chatSessionID())
  const selectedTab = createMemo(() => {
    const id = selectedChatID()
    if (!id) return undefined
    const open = tabs.store.find((item): item is SessionTab => item.type === "session" && item.sessionId === id)
    if (open) return open
    const server = sourceServer()
    if (!server) return undefined
    return { type: "session", server, sessionId: id } satisfies SessionTab
  })
  const activeChatTab = createMemo(() => (!chooseChat() ? selectedTab() : undefined))

  return (
    <div class="relative h-full min-w-0 shrink-0" style={{ width: `${props.width()}px` }}>
      <div
        class="group absolute inset-y-0 -start-2 z-30 w-4 cursor-col-resize"
        data-component="side-panel-resizer"
        aria-label={language.t("side.panel.resize")}
        title={language.t("side.panel.resize")}
      >
        <div class="pointer-events-none absolute inset-y-2 start-1/2 w-px -translate-x-1/2 rounded-full bg-transparent transition-colors group-hover:bg-border-interactive-base group-active:bg-border-interactive-base" />
        <ResizeHandle
          class="absolute inset-0 h-full w-full cursor-col-resize bg-transparent"
          direction="horizontal"
          edge="start"
          size={props.width()}
          min={320}
          max={props.maxWidth()}
          onResize={props.onResize}
        />
      </div>
      <aside
        id="side-panel"
        aria-label={browser() ? language.t("side.tabs.browser") : language.t("side.tabs.chat")}
        class="h-full w-full min-w-0 overflow-hidden rounded-[10px] bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]"
      >
        <div class="flex h-full min-w-0 flex-col">
        <div class="flex shrink-0 items-center gap-1 px-2 py-1.5">
          <button
            type="button"
            class={tabButtonClass(!browser())}
            onClick={() => {
              props.onTab("chat")
              if (!selectedChatID()) setChooseChat(true)
            }}
          >
            {language.t("side.tabs.chat")}
          </button>
          <button type="button" class={tabButtonClass(browser())} onClick={() => props.onTab("browser")}>
            {language.t("side.tabs.browser")}
          </button>
          <div class="flex-1" />
          <Tooltip value={language.t("command.tab.close")} placement="bottom">
            <IconButton
              icon="close-small"
              variant="ghost"
              class="size-6 rounded-md"
              aria-label={language.t("command.tab.close")}
              onClick={props.onClose}
            />
          </Tooltip>
        </div>
        <Show
          when={browser()}
          fallback={
            <Show
              when={activeChatTab()}
              keyed
              fallback={
                <ChatSessionPicker
                  selected={selectedChatID}
                  sourceSessionID={props.sourceSessionID}
                  sourceDirectory={props.sourceDirectory}
                  sourceServer={sourceServer()}
                  onSelect={(sessionID) => {
                    props.onChatSession(sessionID)
                    setChooseChat(false)
                  }}
                />
              }
            >
              {(tab) => (
                <SideChatSession
                  tab={tab}
                  sourceDirectory={props.sourceDirectory}
                  draft={props.draft}
                  onDraft={props.onDraft}
                  onDeselect={() => setChooseChat(true)}
                />
              )}
            </Show>
          }
        >
          <BrowserPanel sessionID={props.sourceSessionID} />
        </Show>
        </div>
      </aside>
    </div>
  )
}
