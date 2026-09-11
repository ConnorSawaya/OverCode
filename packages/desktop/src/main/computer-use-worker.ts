import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"

export type ComputerUseWorker = {
  request: (command: Record<string, unknown>) => Promise<Record<string, unknown>>
  dispose: () => void
  terminated: () => Promise<void>
}

export function createComputerUseWorker(
  executable: string,
  stopped: (reason: string) => void,
): ComputerUseWorker {
  const child = spawn(executable, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
  const pending = new Map<
    string,
    { resolve: (result: Record<string, unknown>) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >()
  let buffer = ""
  let disposed = false

  const dispose = () => {
    if (disposed) return
    disposed = true
    child.stdin.end()
    for (const entry of pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(new Error("helper_closed"))
    }
    pending.clear()
    // EOF asks the independent native watchdog to release input before termination.
    const timer = setTimeout(() => child.kill(), 2000)
    timer.unref()
    child.once("exit", () => clearTimeout(timer))
  }
  const fail = () => {
    if (disposed) return
    stopped("helper_failed")
    dispose()
  }
  child.on("error", fail)
  child.on("exit", fail)
  child.stdin.on("error", fail)
  child.stderr.resume()
  child.stdout.setEncoding("utf8")
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk
    if (buffer.length > 12 * 1024 * 1024) return fail()
    let end = buffer.indexOf("\n")
    while (end !== -1) {
      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      try {
        const value = JSON.parse(line)
        if (!value || typeof value !== "object") return fail()
        if (value.event === "stopped") {
          stopped(typeof value.reason === "string" ? value.reason : "native_stop")
        } else if (value.event !== "ready") {
          const entry = pending.get(value.id)
          if (!entry) {
            if (value.id === "startup") return fail()
          } else {
            pending.delete(value.id)
            clearTimeout(entry.timer)
            if (value.ok === true && value.result && typeof value.result === "object") entry.resolve(value.result)
            else entry.reject(new Error(/^[a-z_]{1,80}$/.test(value.error) ? value.error : "helper_failed"))
          }
        }
      } catch {
        return fail()
      }
      end = buffer.indexOf("\n")
    }
  })

  return {
    dispose,
    terminated() {
      // Resolves once the helper process is gone; the kill timer in dispose
      // bounds this even if the process ignores EOF.
      return new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve()
        const done = () => {
          child.off("exit", done)
          child.off("close", done)
          resolve()
        }
        child.once("exit", done)
        child.once("close", done)
      })
    },
    request(command) {
      if (disposed) return Promise.reject(new Error("helper_closed"))
      return new Promise((resolve, reject) => {
        const id = randomUUID()
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error("helper_timeout"))
          fail()
        }, 20_000)
        pending.set(id, { resolve, reject, timer })
        child.stdin.write(JSON.stringify({ ...command, id }) + "\n", (error) => {
          if (error) fail()
        })
      })
    },
  }
}
