import { $ } from "bun"
import { existsSync } from "node:fs"
import { chmod, copyFile, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import cliPackage from "../../cli/package.json"

// Keep the desktop downloader on the same version as the CLI package in this
// workspace. A stale preview version can install an incompatible binary (or
// fail because that preview was never published).
const CLI_VERSION = cliPackage.version

export type Channel = "dev" | "beta" | "prod"

export function resolveChannel(): Channel {
  const raw = Bun.env.OVERCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
}

export const CLI_BINARIES: Array<{ rustTarget: string; package: string; os: string; cpu: string }> = [
  {
    rustTarget: "aarch64-apple-darwin",
    package: "@overcode-ai/cli-darwin-arm64",
    os: "darwin",
    cpu: "arm64",
  },
  {
    rustTarget: "x86_64-apple-darwin",
    package: "@overcode-ai/cli-darwin-x64-baseline",
    os: "darwin",
    cpu: "x64",
  },
  {
    rustTarget: "aarch64-pc-windows-msvc",
    package: "@overcode-ai/cli-windows-arm64",
    os: "win32",
    cpu: "arm64",
  },
  {
    rustTarget: "x86_64-pc-windows-msvc",
    package: "@overcode-ai/cli-windows-x64-baseline",
    os: "win32",
    cpu: "x64",
  },
  {
    rustTarget: "x86_64-unknown-linux-gnu",
    package: "@overcode-ai/cli-linux-x64-baseline",
    os: "linux",
    cpu: "x64",
  },
  {
    rustTarget: "aarch64-unknown-linux-gnu",
    package: "@overcode-ai/cli-linux-arm64",
    os: "linux",
    cpu: "arm64",
  },
]

export const RUST_TARGET = Bun.env.RUST_TARGET

function nativeTarget() {
  const { platform, arch } = process
  if (platform === "darwin") return arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin"
  if (platform === "win32") return arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc"
  if (platform === "linux") return arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu"
  throw new Error(`Unsupported platform: ${platform}/${arch}`)
}

export function getCurrentCli(target = RUST_TARGET ?? nativeTarget()) {
  const binaryConfig = CLI_BINARIES.find((item) => item.rustTarget === target)
  if (!binaryConfig) throw new Error(`CLI configuration not available for target '${target}'`)

  return binaryConfig
}

export async function downloadCliToResources(dest = windowsify("resources/opencode-cli")) {
  const cli = getCurrentCli()
  // CI stages the freshly built CLI binary into resources/ before prebuild
  // runs (see the "Stage CLI binary for desktop" step). Never overwrite it
  // with whatever version happens to be on npm — it may be older, or the new
  // version may not be published yet and the install would fail the release.
  if (existsSync(dest)) {
    console.log(`CLI binary already exists at ${dest}, skipping download`)
    return
  }
  const directory = await mkdtemp(join(tmpdir(), "overcode-cli-"))
  try {
    // Bun does not materialize dependencies when installing into an empty
    // temporary directory. Create a minimal package manifest first so the
    // dev/packaging CLI binary is actually extracted before we copy it.
    await Bun.write(join(directory, "package.json"), '{"private":true}\n')
    await $`bun install --no-save --cwd ${directory} ${`${cli.package}@${CLI_VERSION}`} ${`--os=${cli.os}`} ${`--cpu=${cli.cpu}`}`
    await copyFile(
      join(directory, "node_modules", cli.package, "bin", cli.os === "win32" ? "lildax.exe" : "lildax"),
      dest,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
  if (process.platform !== "win32") await chmod(dest, 0o755)
  if (process.platform === "win32" && process.env.GITHUB_ACTIONS === "true") {
    await $`pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -File ../../script/sign-windows.ps1 ${dest}`
  }
  if (process.platform === "darwin") await $`codesign --force --sign - ${dest}`

  console.log(`Copied ${cli.package} to ${dest}`)
}

export function windowsify(path: string) {
  if (path.endsWith(".exe")) return path
  return `${path}${process.platform === "win32" ? ".exe" : ""}`
}
