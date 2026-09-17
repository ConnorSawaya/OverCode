import { EOL } from "os"
import * as Effect from "effect/Effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { enableServiceAutoStart } from "../../../services/auto-start"

export default Runtime.handler(
  Commands.commands.service.commands.enable,
  Effect.fn("cli.service.enable")(function* () {
    const file = yield* Effect.promise(enableServiceAutoStart)
    process.stdout.write(`enabled ${file}${EOL}`)
  }),
)
