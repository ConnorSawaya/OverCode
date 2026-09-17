import { createMemo } from "solid-js"
import { executionModeLabel, useLocal } from "../context/local"
import type { ExecutionMode } from "../context/local"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"

const descriptions: Record<ExecutionMode, string> = {
  normal: "Single agent, current behavior",
  deep: "Planner, solver, critic and judge before answering",
  swarm: "Parallel solvers with verification and repair",
}

export function DialogExecutionMode() {
  const local = useLocal()
  const dialog = useDialog()

  const options = createMemo(() => {
    return local.model.mode.list.map((mode) => ({
      value: mode,
      title: executionModeLabel(mode),
      description: descriptions[mode],
      onSelect: () => {
        dialog.clear()
        local.model.mode.set(mode)
      },
    }))
  })

  return (
    <DialogSelect<string>
      options={options()}
      title={"Select execution mode"}
      current={local.model.mode.current()}
      flat={true}
    />
  )
}
