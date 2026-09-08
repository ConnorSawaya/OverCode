import { describe, expect, test } from "bun:test"
import { type Message } from "@opencode-ai/sdk/v2/client"
import { buildTextPrompt, resolveFollowupIdentity } from "./side-panel-followup"

const message = (input: Partial<Message> & Pick<Message, "id">) =>
  ({
    sessionID: "ses_1",
    role: "user",
    time: { created: 0 },
    agent: "",
    model: { providerID: "", modelID: "" },
    ...input,
  }) as Message

const identified = (agent: string, providerID: string, modelID: string) =>
  message({ id: "m", agent, model: { providerID, modelID } })

describe("resolveFollowupIdentity", () => {
  test("takes the most recent complete identity", () => {
    const messages = [identified("plan", "a", "1"), identified("build", "b", "2"), message({ id: "m3" })]
    expect(resolveFollowupIdentity(messages)).toEqual({ agent: "build", model: { providerID: "b", modelID: "2" } })
  })

  test("skips messages with empty agent or model", () => {
    expect(resolveFollowupIdentity([message({ id: "m1" })])).toBeUndefined()
    expect(resolveFollowupIdentity([identified("", "b", "2")])).toBeUndefined()
    expect(resolveFollowupIdentity([identified("build", "", "2")])).toBeUndefined()
    expect(resolveFollowupIdentity(undefined)).toBeUndefined()
  })
})

describe("buildTextPrompt", () => {
  test("builds a single text part", () => {
    expect(buildTextPrompt("hello")).toEqual([{ type: "text", content: "hello", start: 0, end: 5 }])
  })
})
