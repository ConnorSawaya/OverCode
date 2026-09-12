import { Capacitor } from "@capacitor/core"
import { AppBaseProviders, AppInterface, ServerConnection, createBrowserDraftStore, normalizeLocale, type Platform, PlatformProvider } from "@opencode-ai/app"
import { isPairingCode, parsePairingUri, type MobileConnection, type MobilePairing } from "@opencode-ai/mobile-relay/pairing"
import { createSignal, onCleanup, Show } from "solid-js"
import { render } from "solid-js/web"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { useLanguage as useAppLanguage } from "@opencode-ai/app"
import pkg from "../../app/package.json"
import { MobileUpdateNotice } from "./mobile-update"
import { secureGet, secureSet } from "./secure-storage"
import "./styles.css"

const PAIRING_KEY = "overcode.mobile.pairing"
const DEFAULT_RELAY_URL = "https://overcode-relay-production.up.railway.app"

if (!localStorage.getItem("overcode-color-scheme")) localStorage.setItem("overcode-color-scheme", "dark")

const platform: Platform = {
  platform: "web",
  version: pkg.version,
  draftStore: createBrowserDraftStore(),
  openExternal: (url) => window.open(url, "_blank", "noopener,noreferrer"),
  restart: async () => window.location.reload(),
  notify: async (title, description) => {
    if (!("Notification" in window)) return
    const permission = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission
    if (permission === "granted") new Notification(title, { body: description ?? "" })
  },
}

const [connection, setConnection] = createSignal<MobileConnection | undefined>()
const [storageReady, setStorageReady] = createSignal(false)
void readPairing().then((value) => setConnection(value)).finally(() => setStorageReady(true))

function MobileApp() {
  const locale = normalizeLocale(navigator.language)
  return (
    <PlatformProvider value={platform}>
      <AppBaseProviders locale={locale} defaultTheme="overcode-codex">
        <MobileUpdateNotice />
        <Show when={storageReady()}>
          <Show when={connection()} keyed fallback={<MobilePairingScreen onPaired={pair} />}>
          {(value) => {
            const server: ServerConnection.Http = {
              type: "http",
              http: { url: value.relay, token: value.token },
            }
            return <AppInterface defaultServer={ServerConnection.Key.make(server.http.url)} servers={[server]} />
          }}
          </Show>
        </Show>
      </AppBaseProviders>
    </PlatformProvider>
  )
}

function MobilePairingScreen(props: { onPaired: (value: MobileConnection) => void }) {
  const language = useAppLanguage()
  const [value, setValue] = createSignal("")
  const [error, setError] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [scanning, setScanning] = createSignal(false)
  let video: HTMLVideoElement | undefined
  let stream: MediaStream | undefined
  let frame: number | undefined

  const pair = async (raw: string) => {
    const trimmed = raw.trim()
    const parsed = parsePairingUri(trimmed) ?? (isPairingCode(trimmed) ? { relay: DEFAULT_RELAY_URL, code: trimmed } : undefined)
    if (!parsed) {
      setError(language.t("mobile.pairing.invalid"))
      return
    }
    setBusy(true)
    setError("")
    try {
      const connection = "token" in parsed ? parsed : await exchangePairingCode(parsed)
      await secureSet(PAIRING_KEY, JSON.stringify(connection))
      props.onPaired(connection)
    } catch {
      setError(language.t("mobile.pairing.invalid"))
    } finally {
      setBusy(false)
    }
  }

  const scan = async () => {
    const Detector = (globalThis as unknown as {
      BarcodeDetector?: new (options?: { formats: string[] }) => { detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>> }
    }).BarcodeDetector
    if (!Detector) {
      setError(language.t("mobile.pairing.scannerUnavailable"))
      return
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false })
      setScanning(true)
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      if (!video) throw new Error("scanner_not_ready")
      video.srcObject = stream
      await video.play()
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
          <div class="mobile-pairing-mark" aria-hidden="true">O</div>
          <h1 id="mobile-pairing-title" class="mobile-pairing-title">{language.t("mobile.pairing.title")}</h1>
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
            <ButtonV2 type="submit" variant="contrast" size="normal" disabled={busy()}>{language.t("mobile.pairing.connect")}</ButtonV2>
            <ButtonV2 type="button" variant="neutral" size="normal" disabled={busy()} onClick={() => void scan()}>{language.t("mobile.pairing.scan")}</ButtonV2>
          </div>
        </form>
        <Show when={error()}>
          <p class="mobile-pairing-error" role="alert">{error()}</p>
        </Show>
      </section>
      <Show when={scanning()}>
        <div class="mobile-pairing-scanner" onClick={stopScan} role="presentation">
          <video ref={video} playsinline muted />
        </div>
      </Show>
    </main>
  )
}

function pair(value: MobileConnection) {
  setConnection(value)
}

async function exchangePairingCode(pairing: MobilePairing): Promise<MobileConnection> {
  const response = await fetch(`${pairing.relay}/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: pairing.code, deviceName: "Overcode Mobile" }),
  })
  if (!response.ok) throw new Error("pairing_failed")
  const result = (await response.json()) as { token?: string; deviceId?: string }
  if (!result.token) throw new Error("pairing_failed")
  return { relay: pairing.relay, token: result.token, deviceId: result.deviceId }
}

async function readPairing(): Promise<MobileConnection | undefined> {
  try {
    const raw = await secureGet(PAIRING_KEY)
    if (!raw) return
    const value = JSON.parse(raw) as MobileConnection
    const parsed = parsePairingUri(`overcode://mobile?relay=${encodeURIComponent(value.relay)}&token=${encodeURIComponent(value.token)}`)
    return parsed && "token" in parsed ? parsed : undefined
  } catch {
    return
  }
}

if (!Capacitor.isNativePlatform()) console.warn("Overcode Mobile is intended to run as a native Android app")

render(() => <MobileApp />, document.getElementById("root")!)
