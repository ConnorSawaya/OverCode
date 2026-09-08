import { expect, test } from "bun:test"
import { parseMcpConnection } from "./tools-config"

test("accepts MCP URLs and preserves command argument boundaries", () => {
  expect(parseMcpConnection("https://example.com/mcp")).toEqual({ type: "remote", url: "https://example.com/mcp", enabled: true })
  expect(parseMcpConnection('["node", "C:/My Tools/server.js"]')).toEqual({ type: "local", command: ["node", "C:/My Tools/server.js"], enabled: true })
})

test("rejects malformed commands and credentials in URLs", () => {
  for (const input of ["[]", "[1]", "[\"\"]", "npx foo", "file:///etc/passwd", "https://user:secret@example.com"]) expect(parseMcpConnection(input)).toBeUndefined()
})
