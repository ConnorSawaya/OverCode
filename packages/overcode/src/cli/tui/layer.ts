import { run as runTui, type TuiInput } from "@overcode-ai/tui"
import { Global } from "@overcode-ai/core/global"
import { AppNodeBuilder } from "@overcode-ai/core/effect/app-node-builder"
import { Effect } from "effect"

export function run(input: TuiInput) {
  return runTui(input).pipe(Effect.provide(AppNodeBuilder.build(Global.node)))
}
