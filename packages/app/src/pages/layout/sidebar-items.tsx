import type { Session } from "@opencode-ai/sdk/v2/client"
import { Avatar } from "@opencode-ai/ui/avatar"
import { Icon } from "@opencode-ai/ui/icon"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Spinner } from "@opencode-ai/ui/spinner"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { ContextMenu } from "@opencode-ai/ui/context-menu"
import { getFilename } from "@opencode-ai/core/util/path"
import { A, useParams } from "@solidjs/router"
import { type Accessor, createMemo, createSignal, For, type JSX, Match, Show, Switch } from "solid-js"
import { useServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { getAvatarColors, type LocalProject, useLayout } from "@/context/layout"
import { useNotification } from "@/context/notification"
import { usePermission } from "@/context/permission"
import { usePins } from "@/context/pins"
import { useServer } from "@/context/server"
import { messageAgentColor } from "@/utils/agent"
import { sessionTitle } from "@/utils/session-title"
import { sessionPermissionRequest } from "../session/composer/session-request-tree"
import { childSessionOnPath, getProjectAvatarSource, hasProjectPermissions } from "./helpers"
import { useChatRowActions } from "./sidebar-chat-menu"

export const ProjectIcon = (props: {
  project: LocalProject
  class?: string
  compact?: boolean
  notify?: boolean
  working?: boolean
}): JSX.Element => {
  const serverSync = useServerSync()
  const notification = useNotification()
  const permission = usePermission()
  const dirs = createMemo(() => [props.project.worktree, ...(props.project.sandboxes ?? [])])
  const unseenCount = createMemo(() =>
    dirs().reduce((total, directory) => total + notification.project.unseenCount(directory), 0),
  )
  const hasError = createMemo(() => dirs().some((directory) => notification.project.unseenHasError(directory)))
  const hasPermissions = createMemo(() =>
    dirs().some((directory) => {
      return hasProjectPermissions(serverSync().session.data.permission, (item) => {
        if (serverSync().session.get(item.sessionID)?.directory !== directory) return false
        return !permission.autoResponds(item, directory)
      })
    }),
  )
  const notify = createMemo(() => props.notify && (hasPermissions() || unseenCount() > 0))
  const name = createMemo(() => props.project.name || getFilename(props.project.worktree))

  return (
    <div class={`relative ${props.compact ? "size-4" : "size-8"} shrink-0 rounded ${props.class ?? ""}`}>
      <div class="size-full rounded overflow-clip">
        <Avatar
          fallback={name()}
          src={getProjectAvatarSource(props.project.id, props.project.icon)}
          {...getAvatarColors(props.project.icon?.color)}
          class="size-full rounded"
          classList={{ "badge-mask": notify() }}
        />
      </div>
      <Show when={notify()}>
        <div
          classList={{
            "absolute top-px right-px size-1.5 rounded-full z-10": true,
            "bg-surface-warning-strong": hasPermissions(),
            "bg-icon-critical-base": !hasPermissions() && hasError(),
            "bg-text-interactive-base": !hasPermissions() && !hasError(),
          }}
        />
      </Show>
      <Show when={props.working}>
        <div class="absolute bottom-px right-px size-3 rounded-full bg-background-base z-10 flex items-center justify-center">
          <Spinner class="size-[9px]" />
        </div>
      </Show>
    </div>
  )
}

export type SessionItemProps = {
  session: Session
  list: Session[]
  navList?: Accessor<Session[]>
  slug: string
  mobile?: boolean
  dense?: boolean
  showTooltip?: boolean
  showChild?: boolean
  level?: number
  sidebarExpanded: Accessor<boolean>
  clearHoverProjectSoon: () => void
  prefetchSession: (session: Session, priority?: "high" | "low") => void
  openSession?: (session: Session) => void
  currentSessionID?: Accessor<string | undefined>
}

const SessionRow = (props: {
  session: Session
  slug: string
  mobile?: boolean
  dense?: boolean
  tint: Accessor<string | undefined>
  isWorking: Accessor<boolean>
  hasPermissions: Accessor<boolean>
  hasError: Accessor<boolean>
  unseenCount: Accessor<number>
  clearHoverProjectSoon: () => void
  sidebarOpened: Accessor<boolean>
  active: Accessor<boolean>
  warmPress: () => void
  warmFocus: () => void
  onRename: () => void
  openSession?: (session: Session) => void
}): JSX.Element => {
  const title = () => sessionTitle(props.session.title)

  return (
    <A
      href={`/${props.slug}/session/${props.session.id}`}
      class={`flex items-center min-w-0 w-full rounded-md px-1 text-left focus:outline-none ${props.dense ? "gap-1.5 py-0.5" : "gap-2 py-1"}`}
      classList={{
        active: props.active(),
        "bg-surface-base-active ring-1 ring-border-weak-base": props.active(),
      }}
      aria-current={props.active() ? "page" : undefined}
      onPointerDown={props.warmPress}
      onFocus={props.warmFocus}
      onClick={(event) => {
        if (props.openSession && event.button === 0) {
          event.preventDefault()
          props.openSession(props.session)
          return
        }
        if (props.sidebarOpened()) return
        props.clearHoverProjectSoon()
      }}
    >
      <Show when={props.isWorking() || props.hasPermissions() || props.hasError() || props.unseenCount() > 0}>
        <div
          classList={{
            "shrink-0 flex items-center justify-center": true,
            "size-4": props.dense,
            "size-6": !props.dense,
          }}
          style={{ color: props.tint() ?? "var(--icon-interactive-base)" }}
        >
          <Switch>
            <Match when={props.isWorking()}>
              <Spinner class={props.dense ? "size-[11px]" : "size-[15px]"} />
            </Match>
            <Match when={props.hasPermissions()}>
              <div class="size-1.5 rounded-full bg-surface-warning-strong" />
            </Match>
            <Match when={props.hasError()}>
              <div class="size-1.5 rounded-full bg-text-diff-delete-base" />
            </Match>
            <Match when={props.unseenCount() > 0}>
              <div class="size-1.5 rounded-full bg-text-interactive-base" />
            </Match>
          </Switch>
        </div>
      </Show>
      <span
        onDblClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          props.onRename()
        }}
        classList={{
          "text-text-strong min-w-0 flex-1 truncate": true,
          "text-13-medium": props.dense && props.active(),
          "text-13-regular": props.dense && !props.active(),
          "text-14-medium": !props.dense && props.active(),
          "text-14-regular": !props.dense && !props.active(),
        }}
      >
        {title()}
      </span>
    </A>
  )
}

export const SessionItem = (props: SessionItemProps): JSX.Element => {
  const params = useParams()
  const layout = useLayout()
  const language = useLanguage()
  const notification = useNotification()
  const permission = usePermission()
  const pins = usePins()
  const server = useServer()
  const serverSync = useServerSync()
  const actions = useChatRowActions()
  const [renaming, setRenaming] = createSignal(false)
  const [draftTitle, setDraftTitle] = createSignal("")
  const startRename = () => {
    setDraftTitle(sessionTitle(props.session.title) ?? "")
    setRenaming(true)
  }
  const commitRename = () => {
    if (!renaming()) return
    const next = draftTitle()
    setRenaming(false)
    void actions.renameChat(props.session, next)
  }
  const unseenCount = createMemo(() => notification.session.unseenCount(props.session.id))
  const hasError = createMemo(() => notification.session.unseenHasError(props.session.id))
  const [sessionStore] = serverSync().child(props.session.directory)
  const hasPermissions = createMemo(() => {
    return !!sessionPermissionRequest(
      sessionStore.session,
      serverSync().session.data.permission,
      props.session.id,
      (item) => {
        return !permission.autoResponds(item, props.session.directory)
      },
    )
  })
  const isWorking = createMemo(() => {
    if (hasPermissions()) return false
    return serverSync().session.data.session_working(props.session.id)
  })
  const pinned = createMemo(() => pins.isChatPinned({ server: server.key, sessionID: props.session.id }))
  const pinLabel = createMemo(() =>
    pinned() ? language.t("sidebar.unpin.chat") : language.t("sidebar.pin.chat"),
  )

  const tint = createMemo(() =>
    messageAgentColor(serverSync().session.data.message[props.session.id], sessionStore.agent),
  )
  const tooltip = createMemo(() => props.showTooltip ?? (props.mobile || !props.sidebarExpanded()))
  const active = createMemo(() =>
    props.currentSessionID ? props.currentSessionID() === props.session.id : params.id === props.session.id,
  )
  const currentChild = createMemo(() => {
    if (!props.showChild) return
    return childSessionOnPath(sessionStore.session, props.session.id, params.id)
  })

  const warm = (span: number, priority: "high" | "low") => {
    const nav = props.navList?.()
    const list = nav?.some((item) => item.id === props.session.id && item.directory === props.session.directory)
      ? nav
      : props.list

    props.prefetchSession(props.session, priority)

    const idx = list.findIndex((item) => item.id === props.session.id && item.directory === props.session.directory)
    if (idx === -1) return

    for (let step = 1; step <= span; step++) {
      const next = list[idx + step]
      if (next) props.prefetchSession(next, step === 1 ? "high" : priority)

      const prev = list[idx - step]
      if (prev) props.prefetchSession(prev, step === 1 ? "high" : priority)
    }
  }

  const item = (
    <SessionRow
      session={props.session}
      slug={props.slug}
      mobile={props.mobile}
      dense={props.dense}
      tint={tint}
      isWorking={isWorking}
      hasPermissions={hasPermissions}
      hasError={hasError}
      unseenCount={unseenCount}
      clearHoverProjectSoon={props.clearHoverProjectSoon}
      sidebarOpened={layout.sidebar.opened}
      active={active}
      warmPress={() => warm(2, "high")}
      warmFocus={() => warm(2, "high")}
      onRename={startRename}
      openSession={props.openSession}
    />
  )

  return (
    <>
      <ContextMenu>
        <ContextMenu.Trigger as="div" class="min-w-0 w-full">
          <div
            data-session-id={props.session.id}
            class="group/session relative w-full min-w-0 rounded-md cursor-default pr-3 transition-colors hover:bg-surface-raised-base-hover [&:has(:focus-visible)]:bg-surface-raised-base-hover has-[[data-expanded]]:bg-surface-raised-base-hover has-[.active]:bg-surface-base-active"
            style={{ "padding-left": `${8 + (props.level ?? 0) * 16}px` }}
          >
            <div class="flex min-w-0 items-center gap-1">
              <div class="min-w-0 flex-1">
                <Show
                  when={renaming()}
                  fallback={
                    <Show
                      when={!tooltip()}
                      fallback={
                        <Tooltip
                          placement={props.mobile ? "bottom" : "right"}
                          value={sessionTitle(props.session.title)}
                          gutter={10}
                          class="min-w-0 w-full"
                        >
                          {item}
                        </Tooltip>
                      }
                    >
                      {item}
                    </Show>
                  }
                >
                  <input
                    ref={(element) => {
                      requestAnimationFrame(() => {
                        element.focus()
                        element.select()
                      })
                    }}
                    value={draftTitle()}
                    onInput={(event) => setDraftTitle(event.currentTarget.value)}
                    onBlur={commitRename}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault()
                        commitRename()
                        return
                      }
                      if (event.key === "Escape") {
                        event.preventDefault()
                        setRenaming(false)
                      }
                    }}
                    aria-label={language.t("common.rename")}
                    class="w-full rounded bg-surface-weak px-1 py-0.5 text-14-regular text-text-strong outline-none"
                  />
                </Show>
              </div>

              <Show when={!props.level && !renaming()}>
                <div
                  class="shrink-0 overflow-hidden transition-[width,opacity]"
                  classList={{
                    "w-12 opacity-100 pointer-events-auto": !!props.mobile,
                    "w-0 opacity-0 pointer-events-none": !props.mobile,
                    "group-hover/session:w-12 group-hover/session:opacity-100 group-hover/session:pointer-events-auto": true,
                    "group-focus-within/session:w-12 group-focus-within/session:opacity-100 group-focus-within/session:pointer-events-auto": true,
                  }}
                >
                  <div class="flex items-center">
                    <Tooltip value={pinLabel()} placement="top">
                      <IconButton
                        icon="pin"
                        variant="ghost"
                        class="size-6 rounded-md"
                        aria-label={pinLabel()}
                        aria-pressed={pinned()}
                        onClick={(event) => {
                          event.preventDefault()
                          event.stopPropagation()
                          pins.toggleChat({ server: server.key, sessionID: props.session.id })
                        }}
                      />
                    </Tooltip>
                  </div>
                </div>
              </Show>
            </div>
          </div>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content>
            <ContextMenu.Item onSelect={() => setTimeout(startRename, 0)}>
              <ContextMenu.ItemLabel>{language.t("common.rename")}</ContextMenu.ItemLabel>
            </ContextMenu.Item>
            <ContextMenu.Item
              onSelect={() => pins.toggleChat({ server: server.key, sessionID: props.session.id })}
            >
              <ContextMenu.ItemLabel>{pinLabel()}</ContextMenu.ItemLabel>
            </ContextMenu.Item>
            <ContextMenu.Item onSelect={() => void actions.duplicateChat(props.session)}>
              <ContextMenu.ItemLabel>{language.t("sidebar.chat.menu.duplicate")}</ContextMenu.ItemLabel>
            </ContextMenu.Item>
            <ContextMenu.Item onSelect={() => actions.exportChat(props.session)}>
              <ContextMenu.ItemLabel>{language.t("command.session.export")}</ContextMenu.ItemLabel>
            </ContextMenu.Item>
            <ContextMenu.Separator />
            <ContextMenu.Item onSelect={() => actions.confirmDeleteChat(props.session)}>
              <ContextMenu.ItemLabel>{language.t("common.delete")}</ContextMenu.ItemLabel>
            </ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu>
      <Show when={currentChild()} keyed>
        {(child) => (
          <div class="w-full">
            <SessionItem {...props} session={child} level={(props.level ?? 0) + 1} />
          </div>
        )}
      </Show>
    </>
  )
}

export const NewSessionItem = (props: {
  slug: string
  mobile?: boolean
  dense?: boolean
  sidebarExpanded: Accessor<boolean>
  clearHoverProjectSoon: () => void
}): JSX.Element => {
  const layout = useLayout()
  const language = useLanguage()
  const label = language.t("command.session.new")
  const tooltip = () => props.mobile || !props.sidebarExpanded()
  const item = (
    <A
      href={`/${props.slug}/session`}
      end
      class={`flex items-center min-w-0 w-full text-left focus:outline-none ${props.dense ? "gap-1.5 py-0.5" : "gap-2 py-1"}`}
      onClick={() => {
        if (layout.sidebar.opened()) return
        props.clearHoverProjectSoon()
      }}
    >
      <div
        classList={{
          "shrink-0 flex items-center justify-center": true,
          "size-4": props.dense,
          "size-6": !props.dense,
        }}
      >
        <IconV2
          name="edit"
          size="small"
          class={props.dense ? "size-3.5 text-icon-weak" : "text-icon-weak"}
        />
      </div>
      <span
        classList={{
          "text-text-strong min-w-0 flex-1 truncate": true,
          "text-13-regular": props.dense,
          "text-14-regular": !props.dense,
        }}
      >
        {label}
      </span>
    </A>
  )

  return (
    <div class="group/session relative w-full min-w-0 rounded-md cursor-default transition-colors pl-2 pr-3 hover:bg-surface-raised-base-hover [&:has(:focus-visible)]:bg-surface-raised-base-hover has-[.active]:bg-surface-base-active">
      <Show
        when={!tooltip()}
        fallback={
          <Tooltip placement={props.mobile ? "bottom" : "right"} value={label} gutter={10} class="min-w-0 w-full">
            {item}
          </Tooltip>
        }
      >
        {item}
      </Show>
    </div>
  )
}

export const SessionSkeleton = (props: { count?: number }): JSX.Element => {
  const items = Array.from({ length: props.count ?? 4 }, (_, index) => index)
  return (
    <div class="flex flex-col gap-1">
      <For each={items}>
        {() => <div class="h-8 w-full rounded-md bg-surface-raised-base opacity-60 animate-pulse" />}
      </For>
    </div>
  )
}
