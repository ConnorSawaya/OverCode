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

export async function checkForMobileUpdate(currentVersion: string): Promise<MobileUpdateManifest | undefined> {
  const response = await fetch(UPDATE_MANIFEST_URL, { cache: "no-store" })
  if (!response.ok) throw new Error(`update_manifest_${response.status}`)

  const value = (await response.json()) as Partial<MobileUpdateManifest>
  if (typeof value.version !== "string" || typeof value.apkUrl !== "string") {
    throw new Error("update_manifest_invalid")
  }

  const apkUrl = new URL(value.apkUrl)
  if (apkUrl.protocol !== "https:") throw new Error("update_apk_url_invalid")
  if (compareMobileVersions(value.version, currentVersion) <= 0) return

  return {
    version: value.version,
    apkUrl: apkUrl.toString(),
    notes: typeof value.notes === "string" ? value.notes : undefined,
  }
}

export async function installMobileUpdate(update: MobileUpdateManifest) {
  if (!Capacitor.isNativePlatform()) {
    window.open(update.apkUrl, "_blank", "noopener,noreferrer")
    return
  }

  await OvercodeUpdater.downloadAndInstall({ url: update.apkUrl })
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
