import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { createInterface } from "node:readline"
import { app, globalShortcut } from "electron"
import type { ComputerAction, ComputerFrame, ComputerStatus } from "@opencode-ai/app/context/computer"

const shortcut = "CommandOrControl+Alt+Shift+F12"
type Capture = Omit<ComputerFrame, "id" | "capturedAt"> & {
  bounds: { x: number; y: number; width: number; height: number }
  foreground: string
}

// Execution ownership belongs to a session. The physical desktop is exclusive.
export class ComputerManager {
  private worker?: ChildProcessWithoutNullStreams
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private frames = new Map<string, Capture & { capturedAt: number; epoch: number }>()
  private epoch = 0
  private owner?: string
  private controller: ComputerStatus["controller"] = "off"
  private busy = false
  private actionName?: string
  private runId?: string
  private time = 0
  private executable = app.isPackaged
    ? join(process.resourcesPath, "computer", "opencode-computer.exe")
    : join(app.getAppPath(), "resources", "computer", "opencode-computer.exe")

  constructor(private changed: (status: ComputerStatus) => void, executable?: string) {
    if (executable) this.executable = executable
  }

  status(): ComputerStatus {
    return { available: process.platform === "win32" && existsSync(this.executable), ownerSessionId: this.owner,
      controller: this.controller, busy: this.busy, action: this.actionName, runId: this.runId, updatedAt: this.time }
  }

  control(sessionID: string, controller: ComputerStatus["controller"]) {
    if (!["off", "user", "agent"].includes(controller)) throw Error("Invalid computer controller")
    if (this.owner && this.owner !== sessionID) throw Error("Another chat owns computer control")
    if (controller !== "off" && !this.status().available) throw Error("Computer control is unavailable on this platform")
    if (controller !== "off" && !globalShortcut.isRegistered(shortcut)) {
      if (!globalShortcut.register(shortcut, () => { if (this.owner) this.control(this.owner, "off") }))
        throw Error("The emergency stop shortcut is unavailable")
    }
    this.epoch++
    this.stopWorker()
    this.frames.clear()
    this.owner = controller === "off" ? undefined : sessionID
    this.controller = controller
    this.busy = false
    this.actionName = undefined
    this.runId = undefined
    if (controller === "off") globalShortcut.unregister(shortcut)
    this.publish()
    return this.status()
  }

  release(sessionID?: string) {
    if (this.owner && (!sessionID || this.owner === sessionID)) this.control(this.owner, "off")
  }

  cancel(sessionID: string, runID?: string) {
    if (this.owner === sessionID && this.runId === runID) this.control(sessionID, "user")
  }

  private publish() { this.time = Math.max(Date.now(), this.time + 1); this.changed(this.status()) }
  private requireOwner(sessionID: string, epoch: number) {
    if (this.owner !== sessionID || this.controller === "off" || this.epoch !== epoch) throw Error("Computer sharing has stopped")
  }

  async frame(sessionID: string, display = 0): Promise<ComputerFrame> {
    const epoch = this.epoch
    this.requireOwner(sessionID, epoch)
    if (!Number.isInteger(display) || display < 0 || display > 15) throw Error("Invalid display")
    const capture = await this.request({ action: "screenshot", display }) as Capture
    this.requireOwner(sessionID, epoch)
    const id = randomUUID()
    const capturedAt = Date.now()
    this.frames.set(id, { ...capture, capturedAt, epoch })
    for (const [key, frame] of this.frames) if (capturedAt - frame.capturedAt > 15_000 || this.frames.size > 16) this.frames.delete(key)
    const { bounds, foreground, ...publicFrame } = capture
    return { ...publicFrame, id, capturedAt }
  }

  async action(input: ComputerAction) {
    const epoch = this.epoch
    this.requireOwner(input.sessionID, epoch)
    if (this.controller !== "agent") throw Error("The user is in control. Wait until they choose Allow AI control.")
    if (this.busy) throw Error("A computer action is already running")
    const actions = ["screenshot", "move", "click", "doubleClick", "drag", "scroll", "type", "press"]
    if (!actions.includes(input.action)) throw Error("Unknown computer action")
    this.busy = true
    this.actionName = input.action
    this.runId = input.runID
    this.publish()
    try {
      if (input.action === "screenshot") return await this.frame(input.sessionID, input.display)
      const frame = this.frames.get(input.frameId ?? "")
      if (!frame || frame.epoch !== epoch || Date.now() - frame.capturedAt > 15_000) throw Error("Take a fresh screenshot before acting")
      const point = (x?: number, y?: number) => {
        if (!Number.isFinite(x) || !Number.isFinite(y) || x! < 0 || y! < 0 || x! >= frame.width || y! >= frame.height)
          throw Error("Coordinates must be inside the screenshot")
        return { x: frame.bounds.x + Math.floor(x! * frame.bounds.width / frame.width),
          y: frame.bounds.y + Math.floor(y! * frame.bounds.height / frame.height) }
      }
      const coordinates = ["move", "click", "doubleClick", "drag", "scroll"].includes(input.action) ? point(input.x, input.y) : {}
      const end = input.action === "drag" ? point(input.endX, input.endY) : undefined
      if (input.text !== undefined && (typeof input.text !== "string" || input.text.length > 8000)) throw Error("Text is too long")
      if (input.key !== undefined && (typeof input.key !== "string" || input.key.length > 120)) throw Error("Invalid key")
      if (input.amount !== undefined && (!Number.isFinite(input.amount) || input.amount < 0 || input.amount > 2400)) throw Error("Invalid scroll amount")
      if (input.button && !["left", "right", "middle"].includes(input.button)) throw Error("Invalid mouse button")
      if (input.direction && !["up", "down", "left", "right"].includes(input.direction)) throw Error("Invalid scroll direction")
      this.requireOwner(input.sessionID, epoch)
      await this.request({ action: input.action, ...coordinates, endX: end?.x, endY: end?.y,
        button: input.button, text: input.text, key: input.key, direction: input.direction, amount: input.amount,
        display: frame.display, bounds: frame.bounds, foreground: frame.foreground })
      this.requireOwner(input.sessionID, epoch)
      // A fresh image is returned with every action, avoiding a second tool round trip.
      return await this.frame(input.sessionID, frame.display)
    } finally {
      if (epoch === this.epoch) { this.busy = false; this.actionName = undefined; this.publish() }
    }
  }

  private request(payload: Record<string, unknown>): Promise<unknown> {
    if (!this.worker) {
      const worker = spawn(this.executable, [], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] })
      this.worker = worker
      const lines = createInterface({ input: worker.stdout })
      lines.on("line", (line) => {
        try {
          const value = JSON.parse(line) as { id: string; error?: string; result?: unknown }
          const pending = this.pending.get(value.id)
          if (!pending) return
          this.pending.delete(value.id); clearTimeout(pending.timer)
          if (value.error) pending.reject(Error(value.error)); else pending.resolve(value.result)
        } catch { this.stopWorker() }
      })
      worker.stderr.resume()
      const closed = () => {
        lines.close()
        if (this.worker !== worker) return
        this.stopWorker()
        this.release()
      }
      worker.on("error", closed)
      worker.on("exit", closed)
    }
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.stopWorker(); this.release() }, 10_000)
      this.pending.set(id, { resolve, reject, timer })
      this.worker!.stdin.write(JSON.stringify({ ...payload, id }) + "\n", (error) => { if (error) { this.stopWorker(); this.release() } })
    })
  }

  private stopWorker() {
    const worker = this.worker
    this.worker = undefined
    // EOF lets the helper release held input before exiting.
    worker?.stdin.end()
    if (worker) { const timer = setTimeout(() => worker.kill(), 1000); timer.unref() }
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(Error("Computer control interrupted")) }
    this.pending.clear()
  }
}
