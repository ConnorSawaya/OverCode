import { Effect, Schema } from "effect"
import * as Tool from "./tool"

const Parameters = Schema.Struct({
  action: Schema.String,
  url: Schema.optional(Schema.String),
  tabId: Schema.optional(Schema.String),
  target: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  key: Schema.optional(Schema.String),
  x: Schema.optional(Schema.Number),
  y: Schema.optional(Schema.Number),
  direction: Schema.optional(Schema.String),
  amount: Schema.optional(Schema.Number),
  option: Schema.optional(Schema.String),
  timeoutMs: Schema.optional(Schema.Number),
})

type Input = Schema.Schema.Type<typeof Parameters>

const label = (input: Input) => {
  const target = input.target ? ` “${input.target}”` : ""
  switch (input.action) {
    case "open":
    case "navigate":
      return `Open ${input.url ?? "page"}`
    case "click":
      return `Click${target}`
    case "move":
      return `Move cursor to (${input.x ?? "?"}, ${input.y ?? "?"})`
    case "type":
    case "fill":
      return input.target?.toLowerCase().includes("password") ? "Enter password" : `Type${target}`
    case "read":
    case "getText":
      return "Read page"
    default:
      return input.action
  }
}

export const BrowserTool = Tool.define(
  "browser",
  Effect.succeed({
    description: `Control the real session-owned Chromium browser in the OpenCode desktop app. Use this for testing local web apps, inspecting pages, and interacting with forms. Browser actions are observable in the user's browser panel and use semantic targets where possible.

Actions: open, navigate, newTab, closeTab, switchTab, back, forward, reload, click, type, fill, press, scroll, scrollTo, hover, move, select, check, uncheck, waitFor, waitForNavigation, read, getText, screenshot, getTabs, currentUrl. Use move with x and y when a page requires the cursor to be positioned at an exact viewport coordinate; use hover for a semantic target.

Targets may be role=button name="Continue", label=Email, placeholder=Search, text=Settings, css=#submit, or a concise visible name. Browser screenshot returns an image attachment; coordinates for browser move use the reported viewport size.`,
    parameters: Parameters,
    execute: (input: Input, ctx: Tool.Context) =>
      Effect.gen(function* () {
        const bridge = process.env.OPENCODE_BROWSER_BRIDGE_URL
        const token = process.env.OPENCODE_BROWSER_BRIDGE_TOKEN
        if (!bridge || !token) {
          return {
            title: "Browser unavailable",
            output: "The session-owned browser is available in the OpenCode desktop build, but this server is not connected to the desktop browser bridge.",
            metadata: { browser: false, action: input.action, target: input.target, available: false, snapshot: undefined },
          }
        }

        const actionLabel = label(input)
        yield* ctx.metadata({
          title: actionLabel,
          metadata: {
            browser: true,
            action: input.action,
            target: input.target,
          },
        })

        const response = yield* Effect.tryPromise({
          try: async () => {
            const result = await fetch(`${bridge}/action`, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-opencode-browser-token": token,
              },
              body: JSON.stringify({
                ...input,
                sessionID: ctx.sessionID,
                runID: ctx.messageID,
              }),
              signal: AbortSignal.any([ctx.abort, AbortSignal.timeout(Math.min(Math.max(input.timeoutMs ?? 30_000, 5_000), 60_000))]),
            })
            const value = (await result.json()) as { result?: unknown; error?: string; snapshot?: unknown }
            if (!result.ok) throw new Error(value.error ?? `Browser bridge request failed (${result.status})`)
            return value
          },
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
        }).pipe(Effect.orDie)

        const frame = response.result as { data?: unknown; mime?: unknown; [key: string]: unknown } | undefined
        const hasImage = frame && typeof frame.data === "string" && frame.mime === "image/jpeg"
        const result = hasImage ? Object.fromEntries(Object.entries(frame).filter(([key]) => key !== "data")) : response.result
        const output = typeof result === "string" ? result : JSON.stringify(result ?? response.snapshot, null, 2)
        return {
          title: actionLabel,
          output: output.slice(0, 30_000),
          attachments: hasImage ? [{ type: "file" as const, mime: "image/jpeg", url: `data:image/jpeg;base64,${frame.data}`,
            filename: "browser.jpg" }] : undefined,
          metadata: {
            browser: true,
            action: input.action,
            target: input.target,
            available: true,
            snapshot: response.snapshot,
          },
        }
      }),
  }),
)
