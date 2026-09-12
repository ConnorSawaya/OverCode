// @ts-nocheck

import { Overcode } from "@opencode-ai/core"
import { ReadTool } from "@opencode-ai/core/tools"

const overcode = Overcode.make({})

overcode.tool.add(ReadTool)

overcode.tool.add({
  name: "bash",
  schema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The command to run.",
      },
    },
    required: ["command"],
  },
  execute(input, ctx) {},
})

overcode.auth.add({
  provider: "openai",
  type: "api",
  value: process.env.OPENAI_API_KEY,
})

overcode.agent.add({
  name: "build",
  permissions: [],
  model: {
    id: "gpt-5-5",
    provider: "openai",
    variant: "xhigh",
  },
})

const sessionID = await overcode.session.create({
  agent: "build",
})

overcode.subscribe((event) => {
  console.log(event)
})

await overcode.session.prompt({
  sessionID,
  text: "hey what is up",
})

await overcode.session.prompt({
  sessionID,
  text: "what is up with this",
  files: [
    {
      mime: "image/png",
      uri: "data:image/png;base64,xxxx",
    },
  ],
})

await overcode.session.wait()

console.log(await overcode.session.messages(sessionID))
