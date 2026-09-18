import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { chmod, copyFile, mkdir, rename, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { app } from "electron"

const execFileAsync = promisify(execFile)
const root = dirname(fileURLToPath(import.meta.url))
const currentStateHome = () => process.env.XDG_STATE_HOME
const desktopStateNames = [
  "ai.overcode.desktop.dev",
  "ai.overcode.desktop.beta",
  "ai.overcode.desktop",
  // Legacy OpenCode state dirs — still probed so a service started by either
  // app is reused instead of duplicated.
  "ai.opencode.desktop.dev",
  "ai.opencode.desktop.beta",
  "ai.opencode.desktop",
]

type Logger = {
  log(message: string, meta?: Record<string, unknown>): void
  error(message: string, meta?: Record<string, unknown>): void
}

export function bundledCliPath() {
  return app.isPackaged ? join(process.resourcesPath, executableName()) : join(root, "../../resources", executableName())
}

/**
 * Install the bundled CLI as a user-facing command (the "Install CLI" menu
 * action). Mirrors the standalone installer: `~/.overcode/bin` on Windows and
 * `XDG_BIN_DIR` or `~/.local/bin` elsewhere. The Windows user PATH is updated
 * best-effort so a new terminal picks the command up.
 */
export async function installUserCli(): Promise<string> {
  const source = bundledCliPath()
  if (!existsSync(source)) throw new Error(`Bundled CLI not found at ${source}`)
  const directory =
    process.platform === "win32"
      ? join(homedir(), ".overcode", "bin")
      : (process.env.XDG_BIN_DIR ?? join(homedir(), ".local", "bin"))
  const destination = join(directory, process.platform === "win32" ? "overcode.exe" : "overcode")
  await mkdir(directory, { recursive: true })
  await copyFile(source, destination)
  if (process.platform !== "win32") await chmod(destination, 0o755)
  if (process.platform === "win32") await ensureWindowsPath(directory).catch(() => undefined)
  return destination
}

async function ensureWindowsPath(directory: string) {
  const quoted = directory.replace(/'/g, "''")
  const script = [
    "$path=[Environment]::GetEnvironmentVariable('Path','User')",
    "if (-not $path) { $path='' }",
    `if (($path -split ';') -notcontains '${quoted}') { [Environment]::SetEnvironmentVariable('Path', ($path.TrimEnd(';') + ';${quoted}'), 'User') }`,
  ].join("; ")
  await execFileAsync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true })
}

export async function startBackgroundCli(logger: Logger, shellStateHome?: string) {
  // Resolve this after the main process applies the app environment. Reading
  // XDG_STATE_HOME at module load can capture the shell value before
  // preferAppEnv() has selected the desktop state directory.
  const stateHome = currentStateHome()
  const bundled = bundledCliPath()
  logger.log("v2 CLI executable resolved", { bundled, packaged: app.isPackaged })
  const version = await run(bundled, ["--version"], logger)
  const binary = app.isPackaged ? await installCli(bundled, version, logger) : bundled

  const candidates = [
    ...new Set([stateHome, shellStateHome, ...desktopStateNames.map((name) => join(app.getPath("appData"), name))]),
  ].filter((candidate) => candidate === undefined || existsSync(candidate))
  const discovered = await Promise.all(
    candidates.map(async (candidate) => ({
      stateHome: candidate,
      url: serviceUrl(await run(binary, ["service", "status"], logger, { stateHome: candidate })),
    })),
  )
  const found = discovered.find((candidate) => candidate.url !== undefined)
  logger.log("v2 CLI background instance checked", {
    detected: Boolean(found),
    ...endpoint(found?.url),
  })

  // Reuse the discovered daemon's state directory exactly, including the
  // default CLI location (stateHome === undefined). Falling back to the
  // desktop's XDG_STATE_HOME here would start a second daemon with a separate
  // registration instead of sharing sessions/models/auth with the CLI.
  if (found?.url) {
    const password = await getPassword(binary, logger, found.stateHome)
    const username = await detectUsername(found.url, password)
    logger.log("v2 CLI background service reused", {
      username,
      ...endpoint(found.url),
    })
    return {
      url: found.url,
      username,
      password,
    }
  }

  const daemonStateHome = stateHome
  const url = await run(binary, ["service", "start"], logger, { stateHome: daemonStateHome })
  const password = await getPassword(binary, logger, daemonStateHome)
  const username = await detectUsername(url, password)
  logger.log("v2 CLI background service ready", {
    existing: Boolean(found),
    username,
    ...endpoint(url),
  })
  return {
    url,
    username,
    password,
  }
}

async function installCli(source: string, version: string, logger: Logger) {
  const directory = join(app.getPath("userData"), "cli", version.replace(/[^a-zA-Z0-9._-]/g, "-"))
  const destination = join(directory, executableName())
  if (existsSync(destination)) {
    logger.log("v2 CLI staged executable reused", { path: destination, version })
    return destination
  }

  const temp = destination + `.${process.pid}.tmp`
  await mkdir(directory, { recursive: true })
  await copyFile(source, temp)
  if (process.platform !== "win32") await chmod(temp, 0o755)
  await rename(temp, destination).catch(async (error) => {
    await rm(temp, { force: true })
    throw error
  })
  logger.log("v2 CLI executable staged", { source, path: destination, version })
  return destination
}

async function run(
  binary: string,
  args: string[],
  logger: Logger,
  options: { redact?: boolean; stateHome?: string } = {},
) {
  logger.log("v2 CLI command started", { binary, args })
  const env = { ...process.env }
  if (options.stateHome === undefined) delete env.XDG_STATE_HOME
  else env.XDG_STATE_HOME = options.stateHome
  return execFileAsync(binary, args, { env, windowsHide: true }).then(
    (result) => {
      const stdout = result.stdout.trim()
      const stderr = result.stderr.trim()
      logger.log("v2 CLI command completed", { args, stdout: options.redact ? "[redacted]" : stdout, stderr })
      return stdout
    },
    (error: unknown) => {
      const output = error as { stdout?: string; stderr?: string }
      logger.error("v2 CLI command failed", {
        args,
        error: error instanceof Error ? error.message : String(error),
        stdout: options.redact && output.stdout ? "[redacted]" : (output.stdout?.trim() ?? ""),
        stderr: output.stderr?.trim() ?? "",
      })
      throw error
    },
  )
}

async function getPassword(binary: string, logger: Logger, stateHome: string | undefined) {
  // The bundled Rust daemon exposes `service get password`. Newer CLI
  // surfaces may expose `service password`; try it first, then fall back so
  // desktop startup works against either binary.
  try {
    return await run(binary, ["service", "password"], logger, { redact: true, stateHome })
  } catch {
    return await run(binary, ["service", "get", "password"], logger, { redact: true, stateHome })
  }
}

const DAEMON_USERNAMES = ["opencode", "overcode"] as const

async function detectUsername(url: string, password: string): Promise<string> {
  for (const username of DAEMON_USERNAMES) {
    try {
      const auth = Buffer.from(`${username}:${password}`).toString("base64")
      const response = await fetch(new URL("/api/health", url), {
        headers: { authorization: `Basic ${auth}` },
        signal: AbortSignal.timeout(3000),
      })
      if (response.ok) return username
    } catch {}
  }
  // Default to the bundled daemon's username; the app's protocol probing and
  // request paths work once authenticated, and a wrong default surfaces as a
  // normal 401 rather than a startup crash.
  return "opencode"
}

function serviceUrl(status: string) {
  if (URL.canParse(status)) return status
  if (!status.startsWith("running ")) return
  const url = status.slice("running ".length).trim()
  return URL.canParse(url) ? url : undefined
}

function endpoint(url: string | undefined) {
  if (!url || !URL.canParse(url)) return {}
  const parsed = new URL(url)
  return { url, hostname: parsed.hostname, port: parsed.port }
}

function executableName() {
  return process.platform === "win32" ? "opencode-cli.exe" : "opencode-cli"
}
