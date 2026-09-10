export * as ComputerUseTool from "./computer-use"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer } from "effect"
import { HttpClient } from "effect/unstable/http"
import { ComputerUse } from "../computer-use"
import { makeLocationNode } from "../effect/app-node"
import { LayerNodePlatform } from "../effect/app-node-platform"
import { PermissionV2 } from "../permission"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const http = yield* HttpClient.HttpClient
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        [ComputerUse.name]: Tool.make({
          description: ComputerUse.description,
          input: ComputerUse.Input,
          output: ComputerUse.Output,
          structured: ComputerUse.Summary,
          toStructuredOutput: ({ output }) => ComputerUse.metadata(output),
          toModelOutput: ({ output }) => [
            { type: "text", text: ComputerUse.summary(output) },
            ...(output.frame
              ? [{ type: "file" as const, data: output.frame.data, mime: output.frame.mime, name: "computer.jpg" }]
              : []),
          ],
          execute: (input, context) =>
            Effect.gen(function* () {
              const connection = yield* ComputerUse.bridge()
              ComputerUse.track(context.sessionID, input.grantID)
              return yield* Effect.gen(function* () {
                // Revocation must remain available even when normal tool permission is denied.
                if (input.action !== "finish")
                  yield* permission.assert({
                    action: ComputerUse.name,
                    resources: ["*"],
                    save: ["*"],
                    metadata: { action: input.action },
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                  })
                return yield* ComputerUse.request(http, connection, context.sessionID, input)
              }).pipe(
                Effect.onExit((exit) =>
                  ComputerUse.shouldStop(exit)
                    ? ComputerUse.stop(http, context.sessionID, input.grantID, connection)
                    : Effect.void,
                ),
              )
            }).pipe(
              Effect.mapError(
                (error) =>
                  new ToolFailure({
                    message:
                      error instanceof ComputerUse.UnavailableError ? error.message : "Computer use permission denied.",
                  }),
              ),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/computer_use",
  layer,
  deps: [ToolRegistry.node, PermissionV2.node, LayerNodePlatform.httpClient],
})
