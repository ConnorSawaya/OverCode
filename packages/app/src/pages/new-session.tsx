import { createPromptProjectController } from "@/components/prompt-project-selector"
import { useTitlebarRightMount } from "@/components/titlebar"
import { useSettings } from "@/context/settings"
import { useLayout } from "@/context/layout"
import { useLanguage } from "@/context/language"
import { useSessionKey } from "@/pages/session/session-layout"
import { SidePanel } from "@/pages/session/side-panel"
import { sidePanelWidthMax } from "@/pages/session/side-panel-width"
import FileTreeV2 from "@/components/file-tree-v2"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { createEffect, createResource, createSignal, Show } from "solid-js"
import { createNewSessionDraftController } from "./new-session/new-session-draft-controller"
import { NewSessionStatus, NewSessionView } from "./new-session/new-session-view"
import { createNewSessionWorkspaceController } from "./new-session/new-session-workspace-controller"
import { useNewSessionCommands } from "./new-session/use-new-session-commands"

type DraftSidePanel = "browser" | "files" | "chat"

function DraftFilesPanel(props: { width: number; onClose: () => void }) {
  const language = useLanguage()

  return (
    <aside
      id="file-tree-panel"
      aria-label={language.t("side.picker.files")}
      class="relative flex h-full min-w-0 shrink-0 flex-col overflow-hidden rounded-[10px] bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]"
      style={{ width: `${props.width}px` }}
    >
      <div class="flex shrink-0 items-center gap-1 px-2 py-1.5">
        <Icon name="file-tree" size="small" class="size-3.5 text-icon-weak" />
        <span class="min-w-0 flex-1 truncate text-13-medium text-text-strong">
          {language.t("side.picker.files")}
        </span>
        <IconButton
          icon="close-small"
          variant="ghost"
          class="size-6 rounded-md"
          aria-label={language.t("command.tab.close")}
          onClick={props.onClose}
        />
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
        <FileTreeV2 />
      </div>
    </aside>
  )
}

/** The draft-only V2 session page. Submitting promotes the draft into a real session. */
export default function NewSessionPage() {
  const settings = useSettings()
  const layout = useLayout()
  const { sessionKey } = useSessionKey()
  const view = layout.view(sessionKey)
  const [sidePanel, setSidePanel] = createSignal<DraftSidePanel>()
  const rightMount = useTitlebarRightMount()
  const workspace = createNewSessionWorkspaceController()
  const draft = createNewSessionDraftController({
    worktree: workspace.selection.value,
    resetWorktree: workspace.selection.reset,
  })
  const project = createPromptProjectController({
    controls: draft.project.controls,
    onDone: draft.input.restoreFocus,
  })
  useNewSessionCommands({
    restoreFocus: draft.input.restoreFocus,
    onSidePanelSelect: (choice) => {
      if (choice === "files") {
        view.sidePanel.close()
        settings.general.setShowFileTree(true)
        layout.fileTree.open()
        layout.fileTree.setTab("all")
        setSidePanel(choice)
        return
      }

      layout.fileTree.close()
      view.sidePanel.open(choice)
      setSidePanel(choice)
    },
    project: {
      empty: project.empty,
      open: () => project.setOpen(true),
    },
  })
  createEffect(() => {
    if (!draft.prompt.ready()) return
    draft.input.restoreFocus()
  })
  const ready = Promise.resolve()
  const [suspendUntilPromptReady] = createResource(
    () => draft.prompt.readyPromise() ?? ready,
    (promise) => promise.then(() => true),
  )

  return (
    <div class="relative size-full overflow-hidden flex flex-col">
      {suspendUntilPromptReady()}
      <NewSessionStatus mount={rightMount} visible={settings.visibility.status} />
      <div class="flex min-h-0 flex-1 gap-2 p-2">
        <div class="min-h-0 min-w-0 flex-1">
          <NewSessionView input={draft.input} project={project} workspace={workspace} />
        </div>
        <Show when={sidePanel() === "files"}>
          <DraftFilesPanel
            width={Math.max(240, layout.fileTree.width())}
            onClose={() => {
              setSidePanel()
              layout.fileTree.close()
            }}
          />
        </Show>
        <Show when={sidePanel() !== "files" && view.sidePanel.opened()}>
          <SidePanel
            tab={view.sidePanel.tab}
            width={view.sidePanel.width}
            maxWidth={() => sidePanelWidthMax(undefined)}
            chatSessionID={view.sidePanel.chatSession}
            draft={view.sidePanel.draft}
            onTab={(tab) => view.sidePanel.setTab(tab)}
            onChatSession={(sessionID) => view.sidePanel.setChatSession(sessionID)}
            onDraft={(sessionID, value) => view.sidePanel.setDraft(sessionID, value)}
            onClose={() => {
              setSidePanel()
              view.sidePanel.close()
            }}
            onResize={(width) => view.sidePanel.resize(Math.min(width, sidePanelWidthMax(undefined)))}
          />
        </Show>
      </div>
    </div>
  )
}
