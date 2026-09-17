import { EOL } from "node:os"
import { Effect } from "effect"
import { effectCmd } from "../effect-cmd"
import { disablePrimaryServiceAutoStart, enablePrimaryServiceAutoStart } from "../service-autostart"

export const ServiceCommand = effectCmd({
  command: "service <action>",
  describe: "manage primary Overcode server startup",
  instance: false,
  builder: (yargs) =>
    yargs.positional("action", {
      describe: "startup action",
      choices: ["enable", "disable"] as const,
    }),
  handler: Effect.fn("Cli.service")(function* (args) {
    if (args.action === "enable") {
      const file = yield* Effect.promise(enablePrimaryServiceAutoStart)
      process.stdout.write(`enabled ${file}${EOL}`)
      return
    }
    const removed = yield* Effect.promise(disablePrimaryServiceAutoStart)
    process.stdout.write(`${removed ? "disabled" : "already disabled"}${EOL}`)
  }),
})
