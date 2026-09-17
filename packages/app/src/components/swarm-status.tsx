import { createMemo, createSignal, For, onCleanup, Show, type Accessor } from "solid-js"
import { Button } from "@overcode-ai/ui/button"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"

export type SwarmAgentView = {
  id: string
  role: string
  status: string
  model?: { providerID: string; modelID: string }
  progress?: string
  filesTouched?: string[]
  error?: string
}

export type SwarmRecordView = {
  id: string
  status: string
  preset: string
  agents: SwarmAgentView[]
  result?: { summary: string; filesChanged?: string[]; testsPassed?: number; testsFailed?: number }
  instrumentation?: { repairRounds: number; modelCalls: number; toolCalls: number; cost: number }
  timeCreated: number
  timeUpdated: number
}

const TERMINAL = new Set(["completed", "failed", "cancelled"])

const roleLabel = (role: string) => role.charAt(0).toUpperCase() + role.slice(1)

function statusIcon(status: string) {
  if (status === "completed") return "●"
  if (status === "running") return "◉"
  if (status === "failed") return "✕"
  return "○"
}

/** Latest swarm run for a session, polled while active. timeline messages carry live progress; this is the state source. */
export function useSwarmStatus(sessionID: Accessor<string | undefined>) {
  const sdk = useSDK()
  const serverSDK = useServerSDK()
  const [record, setRecord] = createSignal<SwarmRecordView | undefined>(undefined)

  const load = async () => {
    const id = sessionID()
    if (!id) {
      setRecord(undefined)
      return
    }
    try {
      const rows = (await serverSDK().request({
        path: `/swarm?sessionID=${encodeURIComponent(id)}`,
        method: "GET",
        directory: sdk().directory,
      })) as SwarmRecordView[]
      setRecord(rows[0])
    } catch {
      setRecord(undefined)
    }
  }

  const timer = window.setInterval(() => {
    const current = record()
    if (!current || !TERMINAL.has(current.status)) void load()
  }, 3000)
  onCleanup(() => window.clearInterval(timer))

  const refresh = () => {
    void load()
  }
  void load()

  const cancel = async (swarmID: string) => {
    await serverSDK()
      .request({ path: `/swarm/${encodeURIComponent(swarmID)}/cancel`, method: "POST", directory: sdk().directory })
      .catch(() => undefined)
    await load()
  }

  return { record, refresh, cancel }
}

export function SessionSwarmDock(props: { record: SwarmRecordView; onCancel: (id: string) => void }) {
  const [expanded, setExpanded] = createSignal(false)
  const done = createMemo(() => props.record.agents.filter((a) => ["completed", "failed", "cancelled"].includes(a.status)).length)
  const active = createMemo(() => !TERMINAL.has(props.record.status))
  const elapsed = createMemo(() => {
    const ms = Math.max(0, props.record.timeUpdated - props.record.timeCreated)
    const s = Math.floor(ms / 1000)
    if (s < 60) return `${s}s`
    return `${Math.floor(s / 60)}m ${s % 60}s`
  })

  return (
    <div class="pb-2" data-component="swarm-status">
      <div class="w-full rounded-md border border-border-weak-base bg-background-base p-3">
        <div class="flex items-center gap-2">
          <span class="text-14-regular text-text-base font-[530]">Swarm · {props.record.preset}</span>
          <span class="text-12-regular text-text-muted">
            {done()}/{props.record.agents.length} · {elapsed()}
          </span>
          <span class="ml-auto flex items-center gap-2">
            <Show when={active()}>
              <Button size="normal" variant="ghost" onClick={() => props.onCancel(props.record.id)}>
                Cancel
              </Button>
            </Show>
            <Button size="normal" variant="ghost" onClick={() => setExpanded(!expanded())}>
              {expanded() ? "Hide" : "Show"}
            </Button>
          </span>
        </div>
        <div class="mt-2 flex flex-col gap-1">
          <For each={props.record.agents}>
            {(agent) => (
              <div class="flex items-center gap-2 text-13-regular">
                <span class="text-text-muted">{statusIcon(agent.status)}</span>
                <span class="text-text-base">{roleLabel(agent.role)}</span>
                <Show when={agent.model}>
                  <span class="truncate text-text-muted">
                    {agent.model!.providerID}/{agent.model!.modelID}
                  </span>
                </Show>
                <Show when={agent.progress && agent.status === "running"}>
                  <span class="truncate text-text-muted">{agent.progress}</span>
                </Show>
                <Show when={agent.error}>
                  <span class="truncate text-text-danger">{agent.error}</span>
                </Show>
              </div>
            )}
          </For>
        </div>
        <Show when={expanded()}>
          <div class="mt-2 flex flex-col gap-1 border-t border-border-weak-base pt-2 text-12-regular text-text-muted">
            <Show when={props.record.result?.filesChanged?.length}>
              <div>Changed: {props.record.result!.filesChanged!.join(", ")}</div>
            </Show>
            <Show when={props.record.instrumentation}>
              <div>
                {props.record.instrumentation!.modelCalls} model calls · {props.record.instrumentation!.toolCalls} tool
                calls · {props.record.instrumentation!.repairRounds} repairs
              </div>
            </Show>
            <Show when={props.record.result?.summary}>
              <div class="whitespace-pre-wrap text-text-base">{props.record.result!.summary}</div>
            </Show>
          </div>
        </Show>
      </div>
    </div>
  )
}
