import { EOL } from "os"
import * as Effect from "effect/Effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { disableServiceAutoStart } from "../../../services/auto-start"

export default Runtime.handler(
  Commands.commands.service.commands.disable,
  Effect.fn("cli.service.disable")(function* () {
    const removed = yield* Effect.promise(disableServiceAutoStart)
    process.stdout.write(`${removed ? "disabled" : "already disabled"}${EOL}`)
  }),
)
