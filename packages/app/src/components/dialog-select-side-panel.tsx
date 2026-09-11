import { For } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Icon, type IconProps } from "@opencode-ai/ui/icon"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"

type SidePanelChoice = "browser" | "files" | "chat"

const choices: Array<{
  value: SidePanelChoice
  icon: IconProps["name"]
  label: "side.picker.browser" | "side.picker.files" | "side.picker.chat"
  description: "side.picker.browser.description" | "side.picker.files.description" | "side.picker.chat.description"
}> = [
  {
    value: "browser",
    icon: "window-cursor",
    label: "side.picker.browser",
    description: "side.picker.browser.description",
  },
  {
    value: "files",
    icon: "file-tree",
    label: "side.picker.files",
    description: "side.picker.files.description",
  },
  {
    value: "chat",
    icon: "speech-bubble",
    label: "side.picker.chat",
    description: "side.picker.chat.description",
  },
]

export function DialogSelectSidePanel(props: { onSelect: (choice: SidePanelChoice) => void }) {
  const dialog = useDialog()
  const language = useLanguage()

  const select = (choice: SidePanelChoice) => {
    dialog.close()
    props.onSelect(choice)
  }

  return (
    <Dialog
      title={language.t("side.picker.title")}
      description={language.t("side.picker.description")}
      fit
      transition
    >
      <div class="flex flex-col gap-1 p-3">
        <For each={choices}>
          {(choice) => (
            <button
              type="button"
              class="group flex w-full items-center gap-3 rounded-lg border border-transparent px-3 py-3 text-left transition-colors hover:border-border-base hover:bg-surface-base-active focus-visible:border-border-focus focus-visible:outline-none"
              onClick={() => select(choice.value)}
            >
              <span class="flex size-9 shrink-0 items-center justify-center rounded-md bg-surface-weak text-icon-strong transition-colors group-hover:bg-surface-base-active">
                <Icon name={choice.icon} size="normal" />
              </span>
              <span class="min-w-0 flex-1">
                <span class="block text-14-medium text-text-strong">{language.t(choice.label)}</span>
                <span class="mt-0.5 block text-12-regular text-text-weak">{language.t(choice.description)}</span>
              </span>
              <Icon name="chevron-right" size="small" class="shrink-0 text-icon-weak" />
            </button>
          )}
        </For>
      </div>
    </Dialog>
  )
}
