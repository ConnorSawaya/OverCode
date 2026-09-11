import { Effect, Schema } from "effect"
import { Session } from "../session/session"
import { Tool } from "./tool"

export const Parameters = Schema.Struct({
  title: Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(100)).annotate({
    description: "A concise, descriptive conversation title (at most 100 characters).",
  }),
})

export const SessionRenameTool = Tool.define<typeof Parameters, { title: string }, Session.Service>(
  "session_rename",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    return {
      description:
        "Rename the current chat. Give an unnamed conversation a concise title based on the user's request. You may update the title later when the topic or objective changes, or whenever the user asks. Use a meaningful title rather than progress/status text, and avoid needless renaming. This changes only the current chat's display name; the user can also rename it manually.",
      parameters: Parameters,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          const title = params.title.trim().replace(/\s+/g, " ")
          yield* ctx.ask({
            permission: "session_rename",
            patterns: ["*"],
            always: ["*"],
            metadata: { title },
          })
          yield* sessions.setTitle({ sessionID: ctx.sessionID, title })
          return { title, output: JSON.stringify({ title }), metadata: { title } }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, { title: string }>
  }),
)
