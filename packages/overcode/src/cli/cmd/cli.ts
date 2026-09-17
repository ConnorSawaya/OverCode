// Plain-terminal CLI for overcode.
//
// `overcode cli` is the dumb-terminal-friendly counterpart to the fullscreen
// TUI (`overcode`) and the split-footer mini mode (`overcode --mini`):
//   - one-shot: `overcode cli "explain this repo"` runs a single prompt,
//     streams plain text to stdout, and exits on session idle.
//   - REPL: `overcode cli` with no message and a TTY stdin starts a
//     readline loop (`overcode> `) until /exit, Ctrl-C, or Ctrl-D.
//   - piped: `echo "hi" | overcode cli` uses piped stdin as the prompt.
//
// No raw mode, no fullscreen, no ANSI-required rendering. Output is plain
// `process.stdout.write` (+ `UI` helpers on stderr) so it works in CMD,
// PowerShell, CI logs, and dumb terminals.
import type { Argv } from "yargs"
import path from "path"
import { EOL } from "os"
import { Effect } from "effect"
import { UI } from "../ui"
import { effectCmd } from "../effect-cmd"
import { Filesystem } from "@/util/filesystem"
import { createOpencodeClient, type OpencodeClient } from "@overcode-ai/sdk/v2"
import { FormatError, FormatUnknownError } from "../error"

export function resolveCliInput(value?: string, piped?: string): string | undefined {
  if (!value) return piped
  if (!piped) return value
  return value + "\n" + piped
}

export function isCliExitCommand(text: string): boolean {
  const normalized = text.trim().toLowerCase()
  return (
    normalized === "/exit" ||
    normalized === "/quit" ||
    normalized === "/q" ||
    normalized === "exit" ||
    normalized === "quit"
  )
}

export function isCliNewSessionCommand(text: string): boolean {
  return text.trim().toLowerCase() === "/new"
}

export function parseCliModel(value: string | undefined): { providerID: string; modelID: string } | undefined {
  if (!value) return undefined
  const [providerID, ...rest] = value.split("/")
  if (!providerID || rest.length === 0) return undefined
  return { providerID, modelID: rest.join("/") }
}

export function normalizeCliAttachUrl(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined
    return url.toString().replace(/\/$/, "")
  } catch {
    return undefined
  }
}

export function cliAttachHeaders(input: {
  password?: string
  username?: string
  token?: string
  environment?: Record<string, string | undefined>
}) {
  const headers = new Headers(
    ServerAuthHeaders({ password: input.password, username: input.username }, input.environment ?? process.env),
  )
  const token = input.token ?? input.environment?.OVERCODE_CHANNEL_TOKEN
  if (token) headers.set("x-overcode-channel-token", token)
  return headers
}

function ServerAuthHeaders(
  input: { password?: string; username?: string },
  environment: Record<string, string | undefined>,
): Record<string, string> {
  // Importing auth at module load makes the standalone input helpers harder
  // to test and needlessly initializes server configuration for --help.
  const username = input.username ?? environment.OVERCODE_SERVER_USERNAME ?? "overcode"
  const password = input.password ?? environment.OVERCODE_SERVER_PASSWORD
  if (!password) return {}
  return { authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` }
}

function formatCliError(error: unknown) {
  return FormatError(error) ?? FormatUnknownError(error)
}

export const CliCommand = effectCmd({
  command: "cli [message..]",
  describe: "plain-terminal CLI (no fullscreen TUI)",
  instance: (args) => !args.attach,
  directory: (args) => (args.dir && !args.attach ? path.resolve(process.cwd(), args.dir) : process.cwd()),
  builder: (yargs: Argv) =>
    yargs
      .positional("message", {
        describe: "message to send",
        type: "string",
        array: true,
        default: [],
      })
      .option("session", {
        alias: ["s"],
        describe: "session id to continue",
        type: "string",
      })
      .option("continue", {
        alias: ["c"],
        describe: "continue the last session",
        type: "boolean",
      })
      .option("model", {
        alias: ["m"],
        describe: "model to use in the format of provider/model",
        type: "string",
      })
      .option("agent", {
        describe: "agent to use",
        type: "string",
      })
      .option("format", {
        describe: "output format",
        type: "string",
        choices: ["text", "json"],
        default: "text",
      })
      .option("dir", {
        describe: "directory to run in, path on remote server if attaching",
        type: "string",
      })
      .option("attach", {
        describe: "attach to a running overcode server (e.g., http://localhost:4096)",
        type: "string",
      })
      .option("token", {
        alias: ["channel-token"],
        describe: "relay channel token (defaults to OVERCODE_CHANNEL_TOKEN)",
        type: "string",
      })
      .option("password", {
        alias: ["p"],
        describe: "basic auth password (defaults to OVERCODE_SERVER_PASSWORD)",
        type: "string",
      })
      .option("username", {
        alias: ["u"],
        describe: "basic auth username (defaults to OVERCODE_SERVER_USERNAME or 'overcode')",
        type: "string",
      })
      .option("auto", {
        describe: "auto-approve permissions that are not explicitly denied (dangerous!)",
        type: "boolean",
        default: false,
      }),
  handler: Effect.fn("Cli.cli")(function* (args) {
    const { ServerAuth } = yield* Effect.promise(() => import("@/server/auth"))
    yield* Effect.promise(async () => {
      const die = (message: string): never => {
        UI.error(message)
        process.exit(1)
      }

      const root = Filesystem.resolve(process.env.PWD ?? process.cwd())
      const directory = (() => {
        if (!args.dir) return args.attach ? undefined : root
        if (args.attach) return args.dir
        try {
          process.chdir(path.isAbsolute(args.dir) ? args.dir : path.join(root, args.dir))
          return process.cwd()
        } catch {
          die("Failed to change directory to " + args.dir)
        }
      })() as string | undefined

      const rawMessage = [...args.message, ...(args["--"] || [])].join(" ")
      const piped = process.stdin.isTTY ? undefined : await Bun.stdin.text()
      const message = resolveCliInput(rawMessage || undefined, piped)
      const repl = !message?.trim()

      if (repl && !process.stdin.isTTY) {
        die("You must provide a message when stdin is not a TTY (or pipe one in)")
      }

      const parsedModel = parseCliModel(args.model)
      if (args.model && !parsedModel) {
        die(`Invalid --model "${args.model}", expected provider/model`)
      }

      const attach = normalizeCliAttachUrl(args.attach)
      if (args.attach && !attach) die(`Invalid --attach URL "${args.attach}"`)

      const attachHeaders = attach
        ? cliAttachHeaders({
            password: args.password,
            username: args.username,
            token: args.token,
            environment: process.env,
          })
        : undefined

      const sdk: OpencodeClient = attach
        ? createOpencodeClient({
            baseUrl: attach,
            directory,
            headers: attachHeaders,
          })
        : createOpencodeClient({
            baseUrl: "http://overcode.internal",
            directory,
            fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
              const { Server } = await import("@/server/server")
              const request = new Request(input, init)
              const headers = new Headers(request.headers)
              const auth = ServerAuth.header()
              if (auth) headers.set("Authorization", auth)
              return Server.Default().app.fetch(new Request(request, { headers }))
            }) as typeof globalThis.fetch,
          })

      const resolveSessionID = async (): Promise<string> => {
        if (args.session) {
          const current = await sdk.session.get({ sessionID: args.session }).catch(() => undefined)
          if (!current?.data) die(`Session not found: ${args.session}`)
          return args.session
        }
        if (args.continue) {
          const listed = await sdk.session.list().catch(() => undefined)
          const baseID = listed?.data?.find((item) => !item.parentID)?.id
          return baseID ?? die("No previous session to continue")
        }
        const created = await sdk.session.create({
          permission: [
            { permission: "question", action: "deny", pattern: "*" },
            { permission: "plan_enter", action: "deny", pattern: "*" },
            { permission: "plan_exit", action: "deny", pattern: "*" },
          ],
        })
        const createdID = created.data?.id
        return createdID ?? die("Failed to create session")
      }

      const promptOnce = async (sessionID: string, text: string): Promise<number> => {
        const emit = (type: string, data: Record<string, unknown>) => {
          if (args.format !== "json") return false
          process.stdout.write(JSON.stringify({ type, timestamp: Date.now(), sessionID, ...data }) + EOL)
          return true
        }
        const controller = new AbortController()
        const events = await sdk.event.subscribe(undefined, { signal: controller.signal })
        const consumed = (async (): Promise<string | undefined> => {
          let error: string | undefined
          for await (const event of events.stream) {
            if (event.type === "message.part.updated") {
              const part = event.properties.part
              if (part.sessionID !== sessionID) continue
              if (part.type === "text" && part.time?.end) {
                if (emit("text", { part })) continue
                const out = part.text.trim()
                if (!out) continue
                process.stdout.write(out + EOL)
                continue
              }
              if (part.type === "tool" && (part.state.status === "completed" || part.state.status === "error")) {
                if (emit("tool_use", { part })) continue
                const label = part.state.status === "completed" ? "ok" : "failed"
                process.stdout.write(`[${label}] ${part.tool}` + EOL)
                if (part.state.status === "error") UI.error(part.state.error)
                continue
              }
            }
            if (event.type === "session.error") {
              const props = event.properties
              if (props.sessionID !== sessionID || !props.error) continue
              const data = props.error.data as { message?: unknown } | undefined
              const err = data?.message !== undefined ? String(data.message) : String(props.error.name)
              error = error ? error + EOL + err : err
              if (emit("error", { error: props.error })) continue
              UI.error(err)
            }
            if (
              event.type === "session.status" &&
              event.properties.sessionID === sessionID &&
              event.properties.status.type === "idle"
            ) {
              break
            }
            if (event.type === "permission.asked") {
              const permission = event.properties
              if (permission.sessionID !== sessionID) continue
              if (args.auto) {
                await sdk.permission.reply({ requestID: permission.id, reply: "once" })
                continue
              }
              UI.println(
                UI.Style.TEXT_WARNING_BOLD +
                  "! " +
                  UI.Style.TEXT_NORMAL +
                  `permission requested: ${permission.permission} (${permission.patterns.join(", ")}); auto-rejecting (pass --auto to approve)`,
              )
              await sdk.permission.reply({ requestID: permission.id, reply: "reject" })
            }
          }
          return error
        })().catch((e) => {
          UI.error(formatCliError(e) ?? "Event stream failed")
          return "event stream failed" as string | undefined
        })

        try {
          const result = await sdk.session.prompt({
            sessionID,
            agent: args.agent,
            model: parsedModel ? { providerID: parsedModel.providerID, modelID: parsedModel.modelID } : undefined,
            parts: [{ type: "text", text }],
          })
          if (result.error) {
            if (!emit("error", { error: result.error })) UI.error(formatCliError(result.error))
            return 1
          }
          const failed = await consumed
          if (failed) return 1
          return 0
        } finally {
          // Stop the SSE request on prompt errors and after the idle event. This
          // keeps one-shot and REPL invocations from leaving a live fetch open.
          controller.abort()
        }
      }

      let sessionID = await resolveSessionID()

      if (!repl) {
        process.exitCode = await promptOnce(sessionID, message!.trim())
        return
      }

      const readline = await import("node:readline")
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: "overcode> ",
      })
      UI.println(
        UI.Style.TEXT_DIM + "Plain CLI mode. Type /new for a fresh session, /exit to quit." + UI.Style.TEXT_NORMAL,
      )
      UI.println(UI.Style.TEXT_DIM + `Session: ${sessionID}` + UI.Style.TEXT_NORMAL)
      rl.prompt()

      const onLine = async (line: string) => {
        const text = line.trim()
        if (!text) {
          rl.prompt()
          return
        }
        if (isCliExitCommand(text)) {
          rl.close()
          return
        }
        if (isCliNewSessionCommand(text)) {
          const created = await sdk.session
            .create({
              permission: [
                { permission: "question", action: "deny", pattern: "*" },
                { permission: "plan_enter", action: "deny", pattern: "*" },
                { permission: "plan_exit", action: "deny", pattern: "*" },
              ],
            })
            .catch(() => undefined)
          if (!created?.data?.id) {
            UI.error("Failed to create session")
            rl.prompt()
            return
          }
          sessionID = created.data.id
          UI.println(UI.Style.TEXT_DIM + `New session: ${sessionID}` + UI.Style.TEXT_NORMAL)
          rl.prompt()
          return
        }
        rl.pause()
        const code = await promptOnce(sessionID, text)
        if (code !== 0) process.exitCode = code
        rl.resume()
        rl.prompt()
      }

      await new Promise<void>((resolve) => {
        rl.on("line", (line) => {
          void onLine(line)
        })
        rl.on("close", () => resolve())
        rl.on("SIGINT", () => rl.close())
      })
    })
  }),
})
