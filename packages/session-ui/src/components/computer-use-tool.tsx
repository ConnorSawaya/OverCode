import { For, Show } from "solid-js"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { BasicTool } from "./basic-tool"
import type { ToolProps } from "./message-part"
import { computerUseAudit } from "./computer-use-audit"

export function ComputerUseTool(props: ToolProps) {
  const i18n = useI18n()
  const audit = () => computerUseAudit(props.input, props.metadata)
  const status = () => (props.status === "completed" ? "completed" : props.status === "running" ? "running" : "pending")
  return (
    <BasicTool
      icon="window-cursor"
      status={props.status}
      defaultOpen={false}
      open={props.open}
      onOpenChange={props.onOpenChange}
      allowOpenWhilePending
      trigger={{
        title: i18n.t("ui.computerUse.action", { action: i18n.t(`ui.computerUse.action.${audit().action}`) }),
        subtitle: i18n.t(`ui.computerUse.status.${status()}`),
      }}
    >
      <div data-component="tool-output" class="text-12-regular text-text-weak">
        <p>{i18n.t("ui.computerUse.audit")}</p>
        <Show when={audit().frameId}>
          {(frameId) => <p>{i18n.t("ui.computerUse.frame", { frameId: frameId() })}</p>}
        </Show>
        <For each={Object.entries(audit().coordinates)}>
          {([name, value]) => <p>{i18n.t("ui.computerUse.detail", { name, value })}</p>}
        </For>
        <Show when={audit().characters !== undefined}>
          <p>{i18n.t("ui.computerUse.characters", { count: audit().characters ?? 0 })}</p>
        </Show>
        <Show when={audit().stopped}>
          <p>{i18n.t("ui.computerUse.stopped")}</p>
        </Show>
      </div>
    </BasicTool>
  )
}
