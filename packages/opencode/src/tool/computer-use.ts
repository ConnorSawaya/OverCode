import { ComputerUse } from "@opencode-ai/core/computer-use"
import { Effect } from "effect"
import { HttpClient } from "effect/unstable/http"
import { Tool } from "./tool"

export const ComputerUseTool = Tool.define(
  ComputerUse.name,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    return {
      description: ComputerUse.description,
      parameters: ComputerUse.Input,
      execute: (input: typeof ComputerUse.Input.Type, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const connection = yield* ComputerUse.bridge()
          ComputerUse.track(ctx.sessionID, input.grantID)
          const abort = Effect.callback<never>((resume) => {
            const cancel = () =>
              resume(Effect.die(ctx.abort.reason ?? new DOMException("Computer use aborted", "AbortError")))
            if (ctx.abort.aborted) cancel()
            else ctx.abort.addEventListener("abort", cancel, { once: true })
            return Effect.sync(() => ctx.abort.removeEventListener("abort", cancel))
          })
          return yield* Effect.raceFirst(
            abort,
            Effect.gen(function* () {
              yield* ctx.metadata({
                title: `Computer: ${input.action}`,
                metadata: { computerUse: true, action: input.action },
              })
              if (input.action !== "finish")
                yield* ctx.ask({
                  permission: ComputerUse.name,
                  patterns: ["*"],
                  always: ["*"],
                  metadata: { action: input.action },
                })
              const output = yield* ComputerUse.request(http, connection, ctx.sessionID, input)
              return {
                title: `Computer: ${input.action}`,
                output: ComputerUse.summary(output),
                metadata: { computerUse: true, available: true, truncated: false, ...ComputerUse.metadata(output) },
                attachments: output.frame
                  ? [
                      {
                        type: "file" as const,
                        mime: output.frame.mime,
                        url: `data:image/jpeg;base64,${output.frame.data}`,
                        filename: "computer.jpg",
                      },
                    ]
                  : undefined,
              }
            }),
          ).pipe(
            Effect.onExit((exit) =>
              ComputerUse.shouldStop(exit) || ctx.abort.aborted
                ? ComputerUse.stop(http, ctx.sessionID, input.grantID, connection)
                : Effect.void,
            ),
          )
        }).pipe(Effect.orDie),
    }
  }),
)
