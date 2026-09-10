import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { ComputerUseState } from "@opencode-ai/app/computer-use"
import type { ComputerUseWorker } from "./computer-use-worker"

type Owner = { window: number; sessionID: string; directory?: string }
type Grant = Owner & { grantID: string; worker?: ComputerUseWorker; timer?: NodeJS.Timeout; busy: boolean }
type Server = { url: string; username: string | null; password: string | null }

type Options = {
  available: () => boolean
  color: unknown
  saveColor: (color: string) => void
  labels: () => { active: string; stop: string; escape: string }
  createWorker: (stopped: (reason: string) => void) => ComputerUseWorker
  changed: (state: ComputerUseState) => void
  interrupt?: (owner: Owner, server: Server) => Promise<void>
}

const GRANT_PATTERN = /^[A-Za-z0-9-]{1,128}$/
const STOP_RACE_MS = 750
const INTERRUPT_RACE_MS = 3000
const LEASE_MS = 10 * 60_000

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export class ComputerUseController {
  private grant?: Grant
  private stopping?: { sessionID: string; grantID: string }
  private local?: Server
  private phase: ComputerUseState["phase"] = "idle"
  private reason?: string
  private color: string
  private closing = false
  private draining?: Promise<void>
  private readonly token = randomBytes(32).toString("hex")
  private readonly bridge = createServer((request, response) => void this.handle(request, response))
  private url?: string

  constructor(private readonly options: Options) {
    this.color = typeof options.color === "string" && /^#[0-9a-f]{6}$/i.test(options.color)
      ? options.color.toLowerCase()
      : "#23b7a5"
    this.bridge.requestTimeout = 30_000
    this.bridge.headersTimeout = 10_000
  }

  async listen() {
    await new Promise<void>((resolve, reject) => {
      this.bridge.once("error", reject)
      this.bridge.listen(0, "127.0.0.1", () => {
        this.bridge.off("error", reject)
        resolve()
      })
    })
    const address = this.bridge.address()
    if (!address || typeof address === "string") throw new Error("bridge_unavailable")
    this.url = `http://127.0.0.1:${address.port}`
    return { OVERCODE_COMPUTER_USE_URL: this.url, OVERCODE_COMPUTER_USE_TOKEN: this.token }
  }

  setServer(server?: Server) {
    if (this.grant) void this.revoke("server_changed", true)
    this.local = server
    this.emit()
  }

  state(): ComputerUseState {
    const identity = this.grant
      ? { sessionID: this.grant.sessionID, grantID: this.grant.grantID }
      : this.stopping
        ? { sessionID: this.stopping.sessionID, grantID: this.stopping.grantID }
        : {}
    return {
      available: !this.closing && this.options.available() && !!this.local,
      phase: this.phase,
      color: this.color,
      ...identity,
      ...(this.reason ? { reason: this.reason } : {}),
    }
  }

  async start(owner: Owner, serverUrl: string, consent: () => Promise<boolean>) {
    if (!/^ses_[\w-]{1,124}$/.test(owner.sessionID)) throw new Error("invalid_session")
    if (owner.directory !== undefined && (typeof owner.directory !== "string" || owner.directory.length > 32768))
      throw new Error("invalid_directory")
    if (!this.state().available || serverUrl !== this.local?.url) throw new Error("local_desktop_required")
    if (this.grant || this.draining || this.phase === "stopping") throw new Error("computer_already_in_use")
    const grant: Grant = { ...owner, grantID: randomUUID(), busy: false }
    this.grant = grant
    this.phase = "starting"
    this.reason = undefined
    this.emit()
    // A replacement grant must never observe or disturb this attempt: report a
    // dedicated idle snapshot tied to the original request instead.
    const snapshot = (): ComputerUseState => ({
      available: !this.closing && this.options.available() && !!this.local,
      phase: "idle",
      color: this.color,
      reason: "superseded",
    })
    try {
      const allowed = await consent()
      if (this.grant !== grant) return snapshot()
      if (!allowed) {
        await this.revoke("consent_declined", false)
        return this.state()
      }
      const worker = this.options.createWorker((reason) => {
        if (this.grant === grant) void this.revoke(reason, true)
      })
      grant.worker = worker
      await worker.request({ action: "start", color: this.color, labels: this.options.labels() })
      if (this.grant !== grant) {
        worker.dispose()
        return snapshot()
      }
      grant.timer = setTimeout(() => void this.revoke("lease_expired", true), LEASE_MS)
      grant.timer.unref()
      this.phase = "active"
      this.emit()
      return this.state()
    } catch {
      if (this.grant !== grant) return snapshot()
      await this.revoke("activation_failed", false)
      this.phase = "error"
      this.reason = "activation_failed"
      this.emit()
      return this.state()
    }
  }

  async setColor(color: unknown) {
    if (typeof color !== "string" || !/^#[0-9a-f]{6}$/i.test(color)) throw new Error("invalid_color")
    const next = color.toLowerCase()
    const worker = this.grant?.worker
    if (worker) {
      try {
        await worker.request({ action: "color", color: next })
      } catch {
        await this.revoke("helper_failed", true)
        throw new Error("overlay_color_failed")
      }
    }
    this.options.saveColor(next)
    this.color = next
    this.emit()
    return this.state()
  }

  async stop(sessionID?: string, grantID?: string, interrupt = true) {
    const grant = this.grant
    if (
      grant &&
      (sessionID === undefined || sessionID === grant.sessionID) &&
      (grantID === undefined || grantID === grant.grantID)
    )
      return this.revoke("stopped", interrupt)
    return this.state()
  }

  async releaseOwner(window: number) {
    if (this.grant?.window !== window) return
    await this.revoke("owner_closed", true)
  }

  async dispose() {
    this.closing = true
    await this.revoke("shutdown", true)
    if (this.bridge.listening) {
      this.bridge.closeAllConnections()
      await new Promise<void>((resolve) => this.bridge.close(() => resolve()))
    }
    if (process.env.OVERCODE_COMPUTER_USE_TOKEN === this.token) {
      delete process.env.OVERCODE_COMPUTER_USE_URL
      delete process.env.OVERCODE_COMPUTER_USE_TOKEN
    }
  }

  private emit() {
    this.options.changed(this.state())
  }

  private async revoke(reason: string, interrupt: boolean) {
    const grant = this.grant
    if (!grant) return this.state()
    this.grant = undefined
    this.phase = "stopping"
    this.stopping = { sessionID: grant.sessionID, grantID: grant.grantID }
    this.emit()
    if (grant.timer) clearTimeout(grant.timer)
    // The activation barrier stays up until native shutdown AND the backend
    // interrupt settle; start() rejects while draining is set.
    this.draining = (async () => {
      try {
        const stopping = grant.worker?.request({ action: "stop" }).catch(() => undefined)
        if (grant.worker) {
          await Promise.race([stopping, delay(STOP_RACE_MS)])
          grant.worker.dispose()
          await grant.worker.terminated()
        }
      } finally {
        if (interrupt && this.local) {
          try {
            await Promise.race([this.options.interrupt?.(grant, this.local), delay(INTERRUPT_RACE_MS)])
          } catch {}
        }
      }
    })().finally(() => {
      this.draining = undefined
    })
    await this.draining
    if (!this.grant && this.phase === "stopping") {
      this.phase = "idle"
      this.stopping = undefined
      this.emit()
    }
    return this.state()
  }

  private async handle(request: IncomingMessage, response: ServerResponse) {
    const reply = (code: number, body: unknown) => {
      if (response.destroyed || response.writableEnded) return
      response.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" })
      response.end(JSON.stringify(body))
    }
    const supplied = request.headers["x-overcode-computer-token"]
    if (
      request.headers.origin !== undefined ||
      request.headers.host !== this.url?.slice("http://".length) ||
      typeof supplied !== "string" ||
      Buffer.byteLength(supplied) !== Buffer.byteLength(this.token) ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(this.token))
    )
      return reply(401, { error: "unauthorized" })
    if (request.method !== "POST" || !["/action", "/stop"].includes(request.url ?? ""))
      return reply(404, { error: "not_found" })
    try {
      let length = 0
      const chunks: Buffer[] = []
      for await (const chunk of request) {
        length += chunk.length
        if (length > 32_768) return reply(413, { error: "request_too_large" })
        chunks.push(chunk)
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
      if (!body || typeof body !== "object" || typeof body.sessionID !== "string")
        return reply(400, { error: "invalid_session" })
      if (typeof body.grantID !== "string" || !GRANT_PATTERN.test(body.grantID))
        return reply(400, { error: "invalid_grant" })
      const grant = this.grant
      if (request.url === "/stop") {
        // Unknown or already-torn-down grants are idempotent no-ops: they must
        // never disturb the current grant.
        if (grant && grant.sessionID === body.sessionID && grant.grantID === body.grantID)
          await this.stop(body.sessionID, body.grantID, false)
        return reply(200, { result: { ok: true, stopped: true } })
      }
      if (!grant || grant.sessionID !== body.sessionID || grant.grantID !== body.grantID)
        return reply(403, { error: "native_consent_required" })
      if (this.phase !== "active" || !grant.worker) return reply(403, { error: "native_consent_required" })
      if (body.action === "finish") {
        await this.revoke("finished", false)
        return reply(200, { result: { ok: true, stopped: true } })
      }
      if (!["screenshot", "move", "click", "doubleClick", "drag", "scroll", "type", "press"].includes(body.action))
        return reply(400, { error: "invalid_action" })
      if (grant.busy) return reply(409, { error: "action_in_progress" })
      // The model-facing bridge has no activation operation and cannot supply native labels or colors.
      const command = Object.fromEntries(
        ["action", "frameId", "x", "y", "endX", "endY", "button", "text", "key", "direction", "amount"]
          .filter((key) => body[key] !== undefined)
          .map((key) => [key, body[key]]),
      )
      grant.busy = true
      const disconnected = () => {
        if (!response.writableEnded && this.grant === grant) void this.revoke("disconnected", true)
      }
      response.once("close", disconnected)
      try {
        const result = await grant.worker.request(command)
        if (this.grant !== grant) return reply(403, { error: "consent_revoked" })
        if (body.action !== "screenshot") delete result.frame
        reply(200, { result })
      } catch (error) {
        const code = error instanceof Error && /^[a-z_]{1,80}$/.test(error.message) ? error.message : "action_failed"
        reply(409, { error: code })
      } finally {
        grant.busy = false
        response.off("close", disconnected)
      }
    } catch {
      reply(400, { error: "invalid_request" })
    }
  }
}
