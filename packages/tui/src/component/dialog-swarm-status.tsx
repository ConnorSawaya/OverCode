import { createMemo, createResource, For, onCleanup, Show } from "solid-js"
import type { OpencodeClient } from "@overcode-ai/sdk/v2/client"
import { useRoute } from "../context/route"
import { useSDK } from "../context/sdk"
import { useDialog } from "../ui/dialog"

const TERMINAL = new Set(["completed", "failed", "cancelled"])

function icon(status: string) {
  if (status === "completed") return "✓"
  if (status === "running") return "◉"
  if (status === "failed") return "✕"
  return "○"
}

function roleLabel(role: string) {
  return role.charAt(0).toUpperCase() + role.slice(1)
}

export function DialogSwarmStatus() {
  const route = useRoute()
  const sdk = useSDK()
  const dialog = useDialog()

  const sessionID = createMemo(() => (route.data.type === "session" ? route.data.sessionID : undefined))

  const [record, { refetch }] = createResource(sessionID, async (id) => {
    if (!id) return undefined
    const res = await sdk.client.swarm.list({ sessionID: id })
    if (res.error) return undefined
    return res.data[0]
  })

  // Poll unconditionally so a new run started after a finished one appears
  // without reopening the dialog.
  const timer = setInterval(() => {
    refetch()
  }, 3000)
  onCleanup(() => clearInterval(timer))

  const cancel = async () => {
    const current = record()
    const id = sessionID()
    if (!current || !id || TERMINAL.has(current.status)) return
    await sdk.client.swarm.cancel({ swarmID: current.id, sessionID: id }).catch(() => undefined)
    dialog.clear()
  }

  return (
    <box flexDirection="column" gap={1} padding={1}>
      <Show
        when={record()}
        fallback={
          <text>No swarm runs on this session yet. Switch execution mode to Swarm and submit a task.</text>
        }
      >
        {(swarm) => (
          <>
            <text>
              Swarm · {swarm().preset} · {swarm().status}
            </text>
            <For each={swarm().agents}>
              {(agent) => (
                <text>
                  {icon(agent.status)} {roleLabel(agent.role)}
                  {agent.model ? ` · ${agent.model.providerID}/${agent.model.modelID}` : ""}
                  {agent.status === "running" && agent.progress ? ` · ${agent.progress}` : ""}
                  {agent.error ? ` · ${agent.error}` : ""}
                </text>
              )}
            </For>
            <Show when={!TERMINAL.has(swarm().status)}>
              <text>Press enter to cancel the swarm, escape to close.</text>
            </Show>
          </>
        )}
      </Show>
    </box>
  )
}

export async function cancelActiveSwarm(
  sdk: { client: Pick<OpencodeClient, "swarm"> },
  sessionID: string | undefined,
): Promise<boolean> {
  if (!sessionID) return false
  const res = await sdk.client.swarm.list({ sessionID }).catch(() => undefined)
  const active = (res?.data ?? []).find((item) => !TERMINAL.has(item.status))
  if (!active) return false
  await sdk.client.swarm.cancel({ swarmID: active.id, sessionID }).catch(() => undefined)
  return true
}
