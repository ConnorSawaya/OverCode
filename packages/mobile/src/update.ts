import { Capacitor, registerPlugin } from "@capacitor/core"

export type MobileUpdateManifest = {
  version: string
  apkUrl: string
  notes?: string
}

type OvercodeUpdaterPlugin = {
  downloadAndInstall(options: { url: string }): Promise<{ downloadId: number }>
}

const OvercodeUpdater = registerPlugin<OvercodeUpdaterPlugin>("OvercodeUpdater")

const UPDATE_MANIFEST_URL =
  import.meta.env.VITE_OVERCODE_MOBILE_UPDATE_URL ??
  "https://raw.githubusercontent.com/ConnorSawaya/overcode/overcode-rebrand/packages/mobile/update.json"
const UPDATE_REQUEST_TIMEOUT_MS = 15_000
const MAX_MANIFEST_BYTES = 64 * 1024
const ALLOW_CUSTOM_UPDATES = import.meta.env.VITE_OVERCODE_ALLOW_CUSTOM_UPDATES === "true"
const TRUSTED_MANIFEST_URL =
  "https://raw.githubusercontent.com/ConnorSawaya/overcode/overcode-rebrand/packages/mobile/update.json"
const TRUSTED_APK_HOST = "github.com"
const TRUSTED_APK_PATH_PREFIX = "/ConnorSawaya/overcode/releases/download/"

export async function checkForMobileUpdate(currentVersion: string): Promise<MobileUpdateManifest | undefined> {
  if (!isTrustedMobileManifestUrl(UPDATE_MANIFEST_URL)) throw new Error("update_manifest_url_invalid")
  const response = await fetch(UPDATE_MANIFEST_URL, {
    cache: "no-store",
    signal: AbortSignal.timeout(UPDATE_REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`update_manifest_${response.status}`)
  if (!isTrustedMobileManifestUrl(response.url)) throw new Error("update_manifest_redirect_invalid")

  const value = JSON.parse(await readResponseText(response, MAX_MANIFEST_BYTES)) as Partial<MobileUpdateManifest>
  if (
    typeof value.version !== "string" ||
    !/^\d+(?:\.\d+){2}(?:[-+][0-9A-Za-z.-]+)?$/.test(value.version) ||
    typeof value.apkUrl !== "string"
  ) {
    throw new Error("update_manifest_invalid")
  }

  const apkUrl = new URL(value.apkUrl)
  if (!isTrustedMobileUpdateUrl(apkUrl)) throw new Error("update_apk_url_invalid")
  if (compareMobileVersions(value.version, currentVersion) <= 0) return

  return {
    version: value.version,
    apkUrl: apkUrl.toString(),
    notes: typeof value.notes === "string" ? value.notes.slice(0, 4_000) : undefined,
  }
}

export async function installMobileUpdate(update: MobileUpdateManifest) {
  if (!isTrustedMobileUpdateUrl(update.apkUrl)) throw new Error("update_apk_url_invalid")
  if (!Capacitor.isNativePlatform()) {
    window.open(update.apkUrl, "_blank", "noopener,noreferrer")
    return
  }

  await OvercodeUpdater.downloadAndInstall({ url: update.apkUrl })
}

export function isTrustedMobileUpdateUrl(value: string | URL) {
  const url = typeof value === "string" ? safeUrl(value) : value
  return (
    !!url &&
    url.protocol === "https:" &&
    url.hostname === TRUSTED_APK_HOST &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    url.pathname.startsWith(TRUSTED_APK_PATH_PREFIX) &&
    url.pathname.endsWith("/Overcode-Mobile.apk")
  )
}

export function isTrustedMobileManifestUrl(value: string | URL) {
  const url = typeof value === "string" ? safeUrl(value) : value
  if (!url || url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return false
  if (ALLOW_CUSTOM_UPDATES) return true
  return url.hostname === "raw.githubusercontent.com" && url.pathname === new URL(TRUSTED_MANIFEST_URL).pathname
}

export function compareMobileVersions(left: string, right: string) {
  const a = parseMobileVersion(left)
  const b = parseMobileVersion(right)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

function parseMobileVersion(value: string) {
  return value
    .replace(/^v/i, "")
    .split(/[.+-]/, 1)[0]
    .split(".")
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0))
}

function safeUrl(value: string) {
  try {
    return new URL(value)
  } catch {
    return undefined
  }
}

async function readResponseText(response: Response, maxBytes: number) {
  const declared = Number(response.headers.get("content-length") ?? 0)
  if (!Number.isFinite(declared) || declared < 0 || declared > maxBytes) throw new Error("update_manifest_too_large")
  if (!response.body) throw new Error("update_manifest_empty")

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const next = await reader.read()
    if (next.done) return new TextDecoder().decode(joinBytes(chunks, total))
    total += next.value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw new Error("update_manifest_too_large")
    }
    chunks.push(next.value)
  }
}

function joinBytes(chunks: Uint8Array[], total: number) {
  const value = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    value.set(chunk, offset)
    offset += chunk.byteLength
  }
  return value
}
