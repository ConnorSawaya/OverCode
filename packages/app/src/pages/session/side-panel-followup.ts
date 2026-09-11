import type { Message } from "@opencode-ai/sdk/v2/client"
import type { Prompt } from "@/context/prompt-state"

export type FollowupIdentity = {
  agent: string
  model: { providerID: string; modelID: string }
  variant?: string
}

// Resolves which agent/model a side-chat follow-up must use: the most recent
// message carrying a complete identity. Returns undefined when the session
// has no usable identity, in which case sending stays disabled rather than
// risking a prompt with the wrong agent or model.
export const resolveFollowupIdentity = (messages: Message[] | undefined): FollowupIdentity | undefined => {
  const list = messages ?? []
  for (let index = list.length - 1; index >= 0; index--) {
    const message = list[index]
    if (!message || message.role !== "user" || !message.agent) continue
    const model = message.model
    if (!model?.providerID || !model?.modelID) continue
    return {
      agent: message.agent,
      model: { providerID: model.providerID, modelID: model.modelID },
      variant: model.variant,
    }
  }
  return undefined
}

export const buildTextPrompt = (text: string): Prompt => [{ type: "text", content: text, start: 0, end: text.length }]
