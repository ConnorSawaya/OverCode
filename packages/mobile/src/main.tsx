import { Capacitor } from "@capacitor/core"
import {
  AppBaseProviders,
  AppInterface,
  ServerConnection,
  createBrowserDraftStore,
  normalizeLocale,
  type Platform,
  PlatformProvider,
  useServer,
  useServerSync,
} from "@opencode-ai/app"
import { isPairingCode, isRelayToken, parsePairingUri, type MobileConnection, type MobilePairing } from "@opencode-ai/mobile-relay/pairing"
import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js"
import { render } from "solid-js/web"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { useLanguage as useAppLanguage } from "@opencode-ai/app"
import pkg from "../../app/package.json"
import { MobileUpdateNotice } from "./mobile-update"
import { secureGet, secureSet } from "./secure-storage"
import "./styles.css"

const PAIRING_KEY = "overcode.mobile.pairing"
const DEFAULT_RELAY_URL = "https://overcode-relay-production.up.railway.app"
const MOBILE_DEVICE_TYPE = Capacitor.getPlatform() === "android" ? "Android phone" : "Web browser"

type SavedConnection = MobileConnection & {
  id: string
  name: string
}

if (!localStorage.getItem("opencode-color-scheme")) localStorage.setItem("opencode-color-scheme", "dark")

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

const [connections, setConnections] = createSignal<SavedConnection[]>([])
const [activeConnectionId, setActiveConnectionId] = createSignal<string>()
const [pairing, setPairing] = createSignal(false)
const [storageReady, setStorageReady] = createSignal(false)
void readConnections()
  .then((value) => {
    setConnections(value)
    setActiveConnectionId(value[0]?.id)
  })
  .finally(() => setStorageReady(true))

function MobileApp() {
  const locale = normalizeLocale(navigator.language)
  return (
    <PlatformProvider value={platform}>
      <AppBaseProviders locale={locale} defaultTheme="opencode-codex">
        <MobileUpdateNotice />
        <Show when={storageReady()}>
          <Show
            when={pairing() || !activeConnection()}
            fallback={
              <Show when={activeConnection()} keyed>
                {(value) => (
                  <MobileWorkspace
                    connection={value}
                    connections={connections()}
                    activeConnectionId={activeConnectionId()!}
                    onSelect={(id) => setActiveConnectionId(id)}
                    onAdd={() => setPairing(true)}
                    onForget={() => void forgetConnection(value.id)}
                  />
                )}
              </Show>
            }
          >
            <MobilePairingScreen
              suggestedName={`PC ${connections().length + 1}`}
              onCancel={connections().length > 0 ? () => setPairing(false) : undefined}
              onPaired={(value, name) => addConnection(value, name)}
            />
          </Show>
        </Show>
      </AppBaseProviders>
    </PlatformProvider>
  )
}

function MobilePairingScreen(props: {
  suggestedName: string
  onPaired: (value: MobileConnection, name: string) => Promise<void> | void
  onCancel?: () => void
}) {
  const language = useAppLanguage()
  const [value, setValue] = createSignal("")
  const [error, setError] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [name, setName] = createSignal(props.suggestedName)
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
      await props.onPaired(connection, name())
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

  const pairingInputIsValid = () => {
    const raw = value().trim()
    return isPairingCode(raw) || !!parsePairingUri(raw)
  }

  const normalizePairingInput = (raw: string) => {
    if (raw.trimStart().startsWith("overcode://")) return raw.trim()
    return raw.replace(/\D/g, "").slice(0, 6)
  }

  return (
    <main class="mobile-pairing">
      <section class="mobile-pairing-panel" aria-labelledby="mobile-pairing-title">
        <div class="mobile-pairing-brand">
          <div class="mobile-pairing-mark" aria-hidden="true">O</div>
          <h1 id="mobile-pairing-title" class="mobile-pairing-title">{language.t("mobile.pairing.title")}</h1>
        </div>
        <p class="mobile-pairing-copy">{language.t("mobile.pairing.description")}</p>
        <label class="mobile-pairing-name-label">
          <span>{language.t("mobile.pairing.nameLabel")}</span>
          <input
            class="mobile-pairing-input mobile-pairing-name"
            value={name()}
            onInput={(event) => setName(event.currentTarget.value.slice(0, 60))}
            placeholder={language.t("mobile.pairing.namePlaceholder")}
            autocomplete="off"
            autocapitalize="words"
            spellcheck={false}
            maxLength={60}
          />
        </label>
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
              setValue(normalizePairingInput(event.currentTarget.value))
              setError("")
            }}
            placeholder={language.t("mobile.pairing.placeholder")}
            aria-label={language.t("mobile.pairing.inputLabel")}
            autocomplete="one-time-code"
            autocapitalize="off"
            spellcheck={false}
            inputMode="numeric"
            enterkeyhint="done"
            maxLength={200}
          />
          <div class="mobile-pairing-actions">
            <ButtonV2
              type="submit"
              variant="contrast"
              size="normal"
              disabled={busy() || !pairingInputIsValid()}
            >
              {language.t("mobile.pairing.connect")}
            </ButtonV2>
            <ButtonV2 type="button" variant="neutral" size="normal" disabled={busy()} onClick={() => void scan()}>{language.t("mobile.pairing.scan")}</ButtonV2>
          </div>
        </form>
        <Show when={error()}>
          <p class="mobile-pairing-error" role="alert">{error()}</p>
        </Show>
        <Show when={props.onCancel}>
          <ButtonV2 type="button" variant="neutral" size="normal" onClick={props.onCancel}>
            {language.t("mobile.pairing.cancel")}
          </ButtonV2>
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

function activeConnection() {
  const id = activeConnectionId()
  return connections().find((value) => value.id === id) ?? connections()[0]
}

function MobileWorkspace(props: {
  connection: SavedConnection
  connections: SavedConnection[]
  activeConnectionId: string
  onSelect: (id: string) => void
  onAdd: () => void
  onForget: () => void
}) {
  const server: ServerConnection.Http = {
    type: "http",
    http: { url: props.connection.relay, token: props.connection.token },
  }
  return (
    <div class="mobile-workspace">
      <MobileConnectionSwitcher {...props} />
      <div class="mobile-workspace-app">
        <AppInterface
          defaultServer={ServerConnection.Key.make(server.http.url)}
          servers={[server]}
          serverScoped={<MobileProjectBootstrap />}
        />
      </div>
    </div>
  )
}

// The desktop sidebar remembers which projects were opened locally. A fresh
// phone has no such local history, so seed its workspace list from the remote
// project catalog once the server bootstrap has arrived.
function MobileProjectBootstrap() {
  const server = useServer()
  const sync = useServerSync()
  const [catalogError, setCatalogError] = createSignal(false)

  const openCatalogProjects = (projects: unknown) => {
    if (!Array.isArray(projects)) throw new Error("invalid_project_catalog")
    const opened = new Set(server.projects.list().map((project) => project.worktree))
    for (const item of projects) {
      if (!item || typeof item !== "object") continue
      const worktree = (item as { worktree?: unknown }).worktree
      if (typeof worktree !== "string" || !worktree || opened.has(worktree)) continue
      server.projects.open(worktree)
      opened.add(worktree)
    }
  }

  onMount(() => {
    const connection = server.current
    if (!connection || connection.type !== "http" || !connection.http.token) return
    void fetch(`${connection.http.url}/project`, {
      headers: { "x-overcode-channel-token": connection.http.token },
    })
      .then((response) => {
        if (!response.ok) throw new Error(`project_catalog_${response.status}`)
        return response.json()
      })
      .then(openCatalogProjects)
      .catch(() => setCatalogError(true))
  })

  createEffect(() => {
    openCatalogProjects(sync().data.project)
  })

  return (
    <Show when={catalogError()}>
      <div class="mobile-catalog-error" role="alert">
        Projects could not be loaded from this PC. Reconnect and try again.
      </div>
    </Show>
  )
}

function MobileConnectionSwitcher(props: {
  connection: SavedConnection
  connections: SavedConnection[]
  activeConnectionId: string
  onSelect: (id: string) => void
  onAdd: () => void
  onForget: () => void
}) {
  const language = useAppLanguage()
  return (
    <header class="mobile-connection-switcher">
      <label class="mobile-connection-select-label">
        <span>{language.t("mobile.connections.title")}</span>
        <select
          value={props.activeConnectionId}
          aria-label={language.t("mobile.connections.switch")}
          onChange={(event) => props.onSelect(event.currentTarget.value)}
        >
          {props.connections.map((connection) => <option value={connection.id}>{connection.name}</option>)}
        </select>
      </label>
      <div class="mobile-connection-actions">
        <ButtonV2 type="button" variant="neutral" size="normal" onClick={props.onAdd}>
          {language.t("mobile.connections.add")}
        </ButtonV2>
        <Show when={props.connections.length > 1}>
          <ButtonV2 type="button" variant="neutral" size="normal" onClick={props.onForget}>
            {language.t("mobile.connections.forget")}
          </ButtonV2>
        </Show>
      </div>
    </header>
  )
}

async function addConnection(value: MobileConnection, name: string) {
  const next: SavedConnection = {
    ...value,
    id: crypto.randomUUID(),
    name: name.trim() || `PC ${connections().length + 1}`,
  }
  const nextConnections = [...connections(), next]
  await saveConnections(nextConnections)
  setConnections(nextConnections)
  setActiveConnectionId(next.id)
  setPairing(false)
}

async function forgetConnection(id: string) {
  const nextConnections = connections().filter((value) => value.id !== id)
  await saveConnections(nextConnections)
  setConnections(nextConnections)
  setActiveConnectionId(nextConnections[0]?.id)
}

async function exchangePairingCode(pairing: MobilePairing): Promise<MobileConnection> {
  const response = await fetch(`${pairing.relay}/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: pairing.code, deviceName: "Overcode Mobile", deviceType: MOBILE_DEVICE_TYPE }),
  })
  if (!response.ok) throw new Error("pairing_failed")
  const result = (await response.json()) as { token?: string; deviceId?: string }
  if (!isRelayToken(result.token)) throw new Error("pairing_failed")
  return { relay: pairing.relay, token: result.token, deviceId: result.deviceId }
}

async function readConnections(): Promise<SavedConnection[]> {
  try {
    const raw = await secureGet(PAIRING_KEY)
    if (!raw) return []
    const value = JSON.parse(raw) as unknown
    const values = Array.isArray(value) ? value : [value]
    return values.map((item, index) => normalizeSavedConnection(item, index)).filter((item): item is SavedConnection => !!item)
  } catch {
    return []
  }
}

async function saveConnections(value: SavedConnection[]) {
  await secureSet(PAIRING_KEY, JSON.stringify(value))
}

function normalizeSavedConnection(value: unknown, index: number): SavedConnection | undefined {
  if (!value || typeof value !== "object") return
  const item = value as Record<string, unknown>
  if (typeof item.relay !== "string" || typeof item.token !== "string") return
  const parsed = parsePairingUri(
    `overcode://mobile?relay=${encodeURIComponent(item.relay)}&token=${encodeURIComponent(item.token)}`,
  )
  if (!parsed || !("token" in parsed)) return
  return {
    relay: parsed.relay,
    token: parsed.token,
    ...(typeof item.deviceId === "string" ? { deviceId: item.deviceId } : {}),
    id: typeof item.id === "string" && item.id ? item.id : typeof item.deviceId === "string" ? item.deviceId : `pc-${index + 1}`,
    name: typeof item.name === "string" && item.name.trim() ? item.name.trim().slice(0, 60) : `PC ${index + 1}`,
  }
}

if (!Capacitor.isNativePlatform()) console.warn("Overcode Mobile is intended to run as a native Android app")

render(() => <MobileApp />, document.getElementById("root")!)
