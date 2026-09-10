import { describe, expect, test } from "bun:test"
import { COMPUTER_USE_INSTRUCTIONS, parseComputerUseCommand } from "./computer-use"

describe("computer-use command", () => {
  test.each(["/computer-use", " /computer-use  ", "/computer-use\n"])("requires a task: %s", (text) => {
    expect(parseComputerUseCommand(text)).toEqual({ type: "usage" })
  })
  test.each(["/computer-use off", " /computer-use\tOFF \n"])("recognizes immediate revocation: %s", (text) => {
    expect(parseComputerUseCommand(text)).toEqual({ type: "off" })
  })
  test("preserves multiline tasks without treating a task beginning with off as revocation", () => {
    expect(parseComputerUseCommand("/computer-use  off the main window,\nopen Settings ")).toEqual({
      type: "task",
      task: "off the main window,\nopen Settings",
    })
  })
  test.each(["hello /computer-use click", "/computer-useful click", "/computer_use click", "/Computer-use click"])(
    "does not intercept ordinary text: %s",
    (text) => {
      expect(parseComputerUseCommand(text)).toBeUndefined()
    },
  )
  test("instructions specify tool safety and ordinary-session execution", () => {
    const grantID = "4b642151-b115-4c31-99f4-f0632eb44d4a"
    const instructions = COMPUTER_USE_INSTRUCTIONS(grantID)
    for (const phrase of [
      "computer_use",
      "not a subagent",
      "Start with a screenshot",
      "frameId",
      "0 to 1000",
      "Do not substitute shell",
      "explicit confirmation",
      "action finish",
    ]) {
      expect(instructions).toContain(phrase)
    }
    expect(instructions).toContain(`"grantID": "${grantID}" exactly`)
    expect(instructions).toContain("Every computer_use tool call, including screenshot, every input action, and finish")
    expect(COMPUTER_USE_INSTRUCTIONS("c542fbfa-95d8-4e36-8d7f-0e9d6338d4a4")).not.toContain(grantID)
  })
})
