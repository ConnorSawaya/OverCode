/// <reference path="../markdown.d.ts" />

export * as SkillPlugin from "./skill"

import { define } from "./internal"
import { Effect } from "effect"
import { AbsolutePath } from "../schema"
import { SkillV2 } from "../skill"
import customizeOvercodeContent from "./skill/customize-overcode.md" with { type: "text" }

export const CustomizeOvercodeContent = customizeOvercodeContent

export const Plugin = define({
  id: "skill",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.skill.transform((draft) => {
      draft.source(
        SkillV2.EmbeddedSource.make({
          type: "embedded",
          skill: SkillV2.Info.make({
            name: "customize-overcode",
            description:
              "Use ONLY when the user is editing or creating overcode's own configuration: overcode.json, overcode.jsonc, files under .overcode/, or files under ~/.config/overcode/. Also use when creating or fixing overcode agents, subagents, commands, skills, plugins, MCP servers, or permission rules. Do not use for the user's own application code, or for any project that is not configuring overcode itself.",
            location: AbsolutePath.make("/builtin/customize-overcode.md"),
            content: CustomizeOvercodeContent,
          }),
        }),
      )
    })
  }),
})
