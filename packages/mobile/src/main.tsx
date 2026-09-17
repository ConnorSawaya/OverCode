import { Capacitor } from "@capacitor/core"
import {
  AppBaseProviders,
  AppInterface,
  ServerConnection,
  createBrowserDraftStore,
  normalizeLocale,
  type Platform,
  PlatformProvider,
} from "@overcode-ai/app"
import {
  isPairingCode,
  parsePairingUri,
  type MobileConnection,
  type MobilePairing,
} from "@overcode-ai/mobile-relay/pairing"
import { RELAY_STALE_DEVICE_HEADER } from "@overcode-ai/mobile-relay/protocol"
import { createEffect, createSignal, onCleanup, Show } from "solid-js"
import { render } from "solid-js/web"
import { ButtonV2 } from "@overcode-ai/ui/v2/button-v2"
import { useLanguage as useAppLanguage } from "@overcode-ai/app"
import pkg from "../../app/package.json"
import { MobileUpdateNotice } from "./mobile-update"
import { createPairingRecoveryFetch, type MobilePairingConnection } from "./pairing-recovery"
import { secureGet, secureRemove, secureSet } from "./secure-storage"
import {
  activeMobileDevice,
  mobileDeviceId,
  removeMobileDevice,
  selectMobileDevice,
  upsertMobileDevice,
  type MobileDeviceRecord,
  type MobileDeviceStore,
} from "./device-store"
import "./styles.css"

const PAIRING_KEY = "overcode.mobile.pairing"
const DEVICES_KEY = "overcode.mobile.devices"
const DEFAULT_RELAY_URL = "https://overcode-relay-production.up.railway.app"

if (!localStorage.getItem("overcode-color-scheme")) localStorage.setItem("overcode-color-scheme", "dark")

const [connection, setConnection] = createSignal<MobileDeviceRecord | undefined>()
const [deviceState, setDeviceState] = createSignal<MobileDeviceStore>({ devices: [] })
const [pairingOpen, setPairingOpen] = createSignal(false)
const [storageReady, setStorageReady] = createSignal(false)
let pairingVersion = 0
let clearingPairing: MobileConnection | undefined
let persistQueue = Promise.resolve()

const platform: Platform = {
  platform: "web",
  version: pkg.version,
  draftStore: createBrowserDraftStore(),
  openExternal: (url) => window.open(url, "_blank", "noopener,noreferrer"),
  restart: async () => window.location.reload(),
  notify: async (title, description) => {
    if (!("Notification" in window)) return
    const permission =
      Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission
    if (permission === "granted") new Notification(title, { body: description ?? "" })
  },
  fetch: createPairingRecoveryFetch({
    fetch: (request, init) => globalThis.fetch(request, init),
    getConnection: () => connection(),
    onStalePairing: (value) => clearStalePairing(value),
  }),
  mobileRemoteDevices: {
    devices: () => deviceState().devices.map(({ id, name, lastUsedAt }) => ({ id, name, lastUsedAt })),
    active: () => deviceState().activeId,
    select: selectDevice,
    add: () => setPairingOpen(true),
    remove: removeDevice,
  },
}

void readDeviceState()
  .then((value) => {
    applyDeviceState(value)
  })
  .finally(() => setStorageReady(true))

function MobileApp() {
  const locale = normalizeLocale(navigator.language)
  createEffect(() => {
    const value = connection()
    if (!value) return

    const heartbeat = () => {
      void fetch(new URL("/presence", value.relay), {
        method: "POST",
        headers: { "x-overcode-channel-token": value.token },
      })
        .then((response) => {
          if (response.headers.get(RELAY_STALE_DEVICE_HEADER) === "1") void clearStalePairing(value)
        })
        .catch(() => undefined)
    }

    heartbeat()
    const timer = window.setInterval(heartbeat, 15_000)
    onCleanup(() => window.clearInterval(timer))
  })
  return (
    <PlatformProvider value={platform}>
      <AppBaseProviders locale={locale} defaultTheme="overcode-codex">
        <MobileUpdateNotice />
        <Show when={storageReady()}>
          <Show
            when={!pairingOpen() && connection()}
            keyed
            fallback={
              <MobilePairingScreen
                canCancel={deviceState().devices.length > 0}
                suggestedName={nextDeviceName()}
                onCancel={() => setPairingOpen(false)}
                onPaired={pair}
              />
            }
          >
            {(value) => {
              const server = mobileServer(value)
              return <AppInterface defaultServer={ServerConnection.key(server)} servers={mobileServers()} />
            }}
          </Show>
        </Show>
      </AppBaseProviders>
    </PlatformProvider>
  )
}

function MobilePairingScreen(props: {
  suggestedName: string
  canCancel: boolean
  onCancel: () => void
  onPaired: (value: MobileConnection, name: string) => void
}) {
  const language = useAppLanguage()
  const [value, setValue] = createSignal("")
  const [name, setName] = createSignal(props.suggestedName)
  const [error, setError] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [scanning, setScanning] = createSignal(false)
  let video: HTMLVideoElement | undefined
  let stream: MediaStream | undefined
  let frame: number | undefined

  const pair = async (raw: string) => {
    const trimmed = raw.trim()
    const parsed =
      parsePairingUri(trimmed) ?? (isPairingCode(trimmed) ? { relay: DEFAULT_RELAY_URL, code: trimmed } : undefined)
    if (!parsed) {
      setError(language.t("mobile.pairing.invalid"))
      return
    }
    setBusy(true)
    setError("")
    try {
      const connection = "token" in parsed ? parsed : await exchangePairingCode(parsed)
      props.onPaired(connection, name())
    } catch {
      setError(language.t("mobile.pairing.invalid"))
    } finally {
      setBusy(false)
    }
  }

  const scan = async () => {
    const Detector = (
      globalThis as unknown as {
        BarcodeDetector?: new (options?: { formats: string[] }) => {
          detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>>
        }
      }
    ).BarcodeDetector
    if (!Detector) {
      setError(language.t("mobile.pairing.scannerUnavailable"))
      return
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      })
      setScanning(true)
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      if (!video) throw new Error("scanner_not_ready")
      const currentVideo = video
      currentVideo.srcObject = stream
      currentVideo.muted = true
      currentVideo.playsInline = true
      await new Promise<void>((resolve, reject) => {
        if (currentVideo.readyState >= HTMLMediaElement.HAVE_METADATA) {
          resolve()
          return
        }
        const cleanup = () => {
          currentVideo.removeEventListener("loadedmetadata", onLoadedMetadata)
          currentVideo.removeEventListener("error", onError)
        }
        const onLoadedMetadata = () => {
          cleanup()
          resolve()
        }
        const onError = () => {
          cleanup()
          reject(new Error("scanner_media_failed"))
        }
        currentVideo.addEventListener("loadedmetadata", onLoadedMetadata)
        currentVideo.addEventListener("error", onError)
      })
      await currentVideo.play()
      const detector = new Detector({ formats: ["qr_code"] })
      const read = async () => {
        if (!video || !scanning()) return
        const result = await detector.detect(video).catch(() => [])
        const raw = result[0]?.rawValue
        if (raw) {
          stopScan()
          void pair(raw)
          return
        }
        frame = requestAnimationFrame(() => void read())
      }
      void read()
    } catch {
      setError(language.t("mobile.pairing.cameraDenied"))
      stopScan()
    }
  }

  const stopScan = () => {
    if (frame !== undefined) cancelAnimationFrame(frame)
    frame = undefined
    stream?.getTracks().forEach((track) => track.stop())
    stream = undefined
    setScanning(false)
  }

  onCleanup(stopScan)

  return (
    <main class="mobile-pairing">
      <section class="mobile-pairing-panel" aria-labelledby="mobile-pairing-title">
        <div class="mobile-pairing-brand">
          <div class="mobile-pairing-mark" aria-hidden="true">
            O
          </div>
          <h1 id="mobile-pairing-title" class="mobile-pairing-title">
            {language.t("mobile.pairing.title")}
          </h1>
        </div>
        <p class="mobile-pairing-copy">{language.t("mobile.pairing.description")}</p>
        <form
          class="mobile-pairing-form"
          onSubmit={(event) => {
            event.preventDefault()
            void pair(value())
          }}
        >
          <input
            class="mobile-pairing-input"
            value={name()}
            onInput={(event) => setName(event.currentTarget.value)}
            placeholder={language.t("dialog.server.add.namePlaceholder")}
            aria-label={language.t("dialog.server.add.name")}
            autocomplete="off"
            autocapitalize="words"
            spellcheck={false}
          />
          <input
            class="mobile-pairing-input"
            value={value()}
            onInput={(event) => {
              setValue(event.currentTarget.value)
              setError("")
            }}
            placeholder={language.t("mobile.pairing.placeholder")}
            aria-label={language.t("mobile.pairing.inputLabel")}
            autocomplete="off"
            autocapitalize="off"
            spellcheck={false}
          />
          <div class="mobile-pairing-actions">
            <Show when={props.canCancel}>
              <ButtonV2 type="button" variant="neutral" size="normal" disabled={busy()} onClick={props.onCancel}>
                {language.t("common.cancel")}
              </ButtonV2>
            </Show>
            <ButtonV2 type="submit" variant="contrast" size="normal" disabled={busy()}>
              {language.t("mobile.pairing.connect")}
            </ButtonV2>
            <ButtonV2 type="button" variant="neutral" size="normal" disabled={busy()} onClick={() => void scan()}>
              {language.t("mobile.pairing.scan")}
            </ButtonV2>
          </div>
        </form>
        <Show when={error()}>
          <p class="mobile-pairing-error" role="alert">
            {error()}
          </p>
        </Show>
      </section>
      <Show when={scanning()}>
        <div class="mobile-pairing-scanner" onClick={stopScan} role="presentation">
          <video ref={video} autoplay playsinline muted />
        </div>
      </Show>
    </main>
  )
}

function pair(value: MobileConnection, name: string) {
  const next = upsertMobileDevice(deviceState(), value, {
    name: name.trim() || nextDeviceName(),
  })
  pairingVersion += 1
  applyDeviceState(next)
  setPairingOpen(false)
}

function clearStalePairing(value: MobilePairingConnection) {
  const current = connection()
  if (current && !samePairing(current, value)) return
  if (clearingPairing && samePairing(clearingPairing, value)) return
  clearingPairing = value
  const version = pairingVersion
  try {
    if (pairingVersion !== version) return
    const active = connection()
    if (!active || !samePairing(active, value)) return
    const next = removeMobileDevice(deviceState(), active.id)
    applyDeviceState(next)
    setPairingOpen(next.devices.length === 0)
  } finally {
    clearingPairing = undefined
  }
}

async function exchangePairingCode(pairing: MobilePairing): Promise<MobileConnection> {
  const response = await fetch(`${pairing.relay}/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: pairing.code, deviceName: mobileDeviceName() }),
  })
  if (!response.ok) throw new Error("pairing_failed")
  const result = (await response.json()) as { token?: string; deviceId?: string }
  if (!result.token) throw new Error("pairing_failed")
  return { relay: pairing.relay, token: result.token, deviceId: result.deviceId }
}

async function readDeviceState(): Promise<MobileDeviceStore> {
  try {
    const stored = readStoredDeviceState(await secureGet(DEVICES_KEY))
    if (stored) return stored
    const legacy = readStoredPairing(await secureGet(PAIRING_KEY))
    if (!legacy) return { devices: [] }
    return upsertMobileDevice({ devices: [] }, legacy, { name: "Overcode PC 1" })
  } catch {
    return { devices: [] }
  }
}

function readStoredPairing(raw: string | undefined): MobileConnection | undefined {
  if (!raw) return
  return readStoredConnection(JSON.parse(raw))
}

function readStoredDeviceState(raw: string | undefined): MobileDeviceStore | undefined {
  if (!raw) return
  const value = JSON.parse(raw) as { devices?: unknown; activeId?: unknown }
  if (!Array.isArray(value.devices)) return
  const devices = value.devices.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return []
    const record = item as Record<string, unknown>
    const connection = readStoredConnection(record)
    if (!connection) return []
    const now = Date.now()
    const id = typeof record.id === "string" && record.id ? record.id : mobileDeviceId(connection)
    return [
      {
        ...connection,
        id,
        name: typeof record.name === "string" && record.name.trim() ? record.name.trim() : "Overcode PC",
        pairedAt: typeof record.pairedAt === "string" ? record.pairedAt : new Date(now).toISOString(),
        lastUsedAt: typeof record.lastUsedAt === "number" ? record.lastUsedAt : now,
      } satisfies MobileDeviceRecord,
    ]
  })
  const deduped = [...new Map(devices.map((device) => [device.id, device])).values()]
  const requested = typeof value.activeId === "string" ? value.activeId : undefined
  return { devices: deduped, activeId: deduped.some((device) => device.id === requested) ? requested : deduped[0]?.id }
}

function readStoredConnection(value: unknown): MobileConnection | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const input = value as Record<string, unknown>
  if (typeof input.relay !== "string" || typeof input.token !== "string") return
  const parsed = parsePairingUri(
    `overcode://mobile?relay=${encodeURIComponent(input.relay)}&token=${encodeURIComponent(input.token)}`,
  )
  if (!parsed || !("token" in parsed)) return
  return {
    ...parsed,
    deviceId: typeof input.deviceId === "string" && input.deviceId ? input.deviceId : undefined,
  }
}

function applyDeviceState(next: MobileDeviceStore, persist = true) {
  const active = activeMobileDevice(next)
  const normalized = { devices: next.devices, activeId: active?.id }
  setDeviceState(normalized)
  setConnection(active)
  if (persist) persistDeviceState(normalized)
}

function persistDeviceState(state: MobileDeviceStore) {
  const snapshot = JSON.stringify(state)
  persistQueue = persistQueue
    .then(async () => {
      await secureSet(DEVICES_KEY, snapshot)
      await secureRemove(PAIRING_KEY)
    })
    .catch(() => undefined)
}

function selectDevice(id: string) {
  const next = selectMobileDevice(deviceState(), id)
  if (next === deviceState()) return
  pairingVersion += 1
  applyDeviceState(next)
  setPairingOpen(false)
}

function removeDevice(id: string) {
  const state = deviceState()
  if (!state.devices.some((device) => device.id === id)) return
  pairingVersion += 1
  const next = removeMobileDevice(state, id)
  applyDeviceState(next)
  setPairingOpen(next.devices.length === 0)
}

function nextDeviceName() {
  const used = new Set(deviceState().devices.map((device) => device.name))
  let index = 1
  while (used.has(`Overcode PC ${index}`)) index += 1
  return `Overcode PC ${index}`
}

function mobileServer(device: MobileDeviceRecord): ServerConnection.Http {
  return {
    type: "http",
    http: { url: device.relay, token: device.token, deviceId: device.id },
    displayName: device.name,
  }
}

function mobileServers() {
  return deviceState().devices.map(mobileServer)
}

function samePairing(left: MobileConnection | undefined, right: MobilePairingConnection) {
  return left?.relay === right.relay && left.token === right.token
}

function mobileDeviceName() {
  const fallback = "Overcode Mobile"
  const match = navigator.userAgent.match(/Android\s+[^;]+;\s*([^;)]+?)(?:\s+Build\/[^;)]+)?[;)]/i)
  const model = match?.[1]?.trim()
  return model ? fallback + " · " + model : fallback
}

if (!Capacitor.isNativePlatform()) console.warn("Overcode Mobile is intended to run as a native Android app")

render(() => <MobileApp />, document.getElementById("root")!)
