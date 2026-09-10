export function parseComputerUseCommand(text: string) {
  const match = /^\s*\/computer-use(?:\s+([\s\S]*))?\s*$/.exec(text)
  if (!match) return
  const task = match[1]?.trim()
  if (!task) return { type: "usage" } as const
  if (task.toLowerCase() === "off") return { type: "off" } as const
  return { type: "task", task } as const
}

export const COMPUTER_USE_INSTRUCTIONS = (grantID: string) =>
  [
    "The user requested /computer-use for the task in this message. Use the computer_use tool in this ordinary session, not a subagent.",
    `Every computer_use tool call, including screenshot, every input action, and finish, must include "grantID": ${JSON.stringify(grantID)} exactly. Never omit it or use a grantID from another task.`,
    "Start with a screenshot. Request another screenshot after relevant actions when needed to verify progress; do not capture on a timer or automatically after every input.",
    "Use normalized coordinates from 0 to 1000 relative to the latest screenshot and include its frameId for physical input. Refresh stale frames before acting.",
    "Use computer_use for physical mouse and keyboard input. Do not substitute shell commands, browser automation, browsing tools, or scripts for desktop input.",
    "Desktop consent is not confirmation for sensitive or irreversible transactions. Ask the user for explicit confirmation before those actions.",
    "Call computer_use with action finish when the task is complete, blocked, or cancelled. If access is revoked, stop immediately; never try to enable it yourself.",
  ].join("\n")
