import { Effect, Schema } from "effect"
import { Session } from "../session/session"
import { Tool } from "./tool"

export const Parameters = Schema.Struct({
  title: Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(100)).annotate({
    description: "A concise, descriptive conversation title (at most 100 characters).",
  }),
})

export const SessionRenameTool = Tool.define<typeof Parameters, { title: string; changed: boolean }, Session.Service>(
  "session_rename",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    return {
      description:
        "Rename the current chat only when the user explicitly asks to change its chat, conversation, session, thread, title, or name. Never rename automatically because the topic changed. Use a concise, meaningful title based on the user's request. This changes only the current chat's display name; the user can also rename it manually.",
      parameters: Parameters,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          const title = params.title.trim().replace(/\s+/g, " ")
          if (!Session.userRequestedTitleChange(ctx.messages)) {
            const current = yield* sessions.get(ctx.sessionID).pipe(Effect.orDie)
            return {
              title: "Title unchanged",
              output: JSON.stringify({ title: current.title, changed: false, reason: "explicit_request_required" }),
              metadata: { title: current.title, changed: false },
            }
          }
          yield* ctx.ask({
            permission: "session_rename",
            patterns: ["*"],
            always: ["*"],
            metadata: { title },
          })
          yield* sessions.setTitle({ sessionID: ctx.sessionID, title })
          return { title, output: JSON.stringify({ title, changed: true }), metadata: { title, changed: true } }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, { title: string; changed: boolean }>
  }),
)
