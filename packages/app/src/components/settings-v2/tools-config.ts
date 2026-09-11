import type { McpLocalConfig, McpRemoteConfig } from "@opencode-ai/sdk/v2/client"

export function parseMcpConnection(value: string): McpLocalConfig | McpRemoteConfig | undefined {
  const text = value.trim()
  try {
    if (text.startsWith("[")) {
      const command: unknown = JSON.parse(text)
      if (!Array.isArray(command) || command.length === 0 || !command.every((part) => typeof part === "string" && part.trim())) return
      return { type: "local", command, enabled: true }
    }
    const url = new URL(text)
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return
    return { type: "remote", url: url.href, enabled: true }
  } catch {
    return undefined
  }
}
