import { afterEach, describe, expect, test } from "bun:test"
import { ComputerUseController } from "./computer-use"
import type { ComputerUseWorker } from "./computer-use-worker"

type FakeWorker = {
  worker: ComputerUseWorker
  requests: Record<string, unknown>[]
  disposed: () => boolean
}

function fakeWorker(
  respond: (command: Record<string, unknown>) => Record<string, unknown> | Error = () => ({}),
): FakeWorker {
  const requests: Record<string, unknown>[] = []
  let done = false
  let release!: () => void
  const gone = new Promise<void>((resolve) => {
    release = resolve
  })
  const worker: ComputerUseWorker = {
    request: (command) => {
      requests.push(command)
      const result = respond(command)
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result)
    },
    dispose: () => {
      done = true
      release()
    },
    terminated: () => gone,
  }
  return { worker, requests, disposed: () => done }
}

type Harness = {
  controller: ComputerUseController
  interrupts: unknown[][]
  savedColors: string[]
  created: FakeWorker[]
}

function harness(respond?: (command: Record<string, unknown>) => Record<string, unknown> | Error): Harness {
  const interrupts: unknown[][] = []
  const savedColors: string[] = []
  const created: FakeWorker[] = []
  const controller = new ComputerUseController({
    available: () => true,
    color: undefined,
    saveColor: (color) => savedColors.push(color),
    labels: () => ({ active: "active", stop: "stop", escape: "esc" }),
    createWorker: () => {
      const fake = fakeWorker(respond)
      created.push(fake)
      return fake.worker
    },
    changed: () => undefined,
    interrupt: async (...args: unknown[]) => {
      interrupts.push(args)
    },
  })
  controller.setServer({ url: "http://127.0.0.1:9", username: null, password: null })
  return { controller, interrupts, savedColors, created }
}

const owner = (sessionID: string) => ({ window: 7, sessionID })

let active: ComputerUseController[] = []
afterEach(async () => {
  await Promise.all(active.map((controller) => controller.dispose()))
  active = []
})

function track(harness: Harness) {
  active.push(harness.controller)
  return harness
}

describe("computer-use grants", () => {
  test("start issues an opaque grantID and reports it in state", async () => {
    const h = track(harness())
    const state = await h.controller.start(owner("ses_alpha"), "http://127.0.0.1:9", async () => true)
    expect(state.phase).toBe("active")
    expect(state.sessionID).toBe("ses_alpha")
    expect(state.grantID).toMatch(/^[A-Za-z0-9-]{1,128}$/)
  })

  test("a second activation is rejected while a grant is active", async () => {
    const h = track(harness())
    await h.controller.start(owner("ses_alpha"), "http://127.0.0.1:9", async () => true)
    await expect(h.controller.start(owner("ses_beta"), "http://127.0.0.1:9", async () => true)).rejects.toThrow(
      "computer_already_in_use",
    )
  })

  test("declined consent ends idle with no grant", async () => {
    const h = track(harness())
    const state = await h.controller.start(owner("ses_alpha"), "http://127.0.0.1:9", async () => false)
    expect(state.phase).toBe("idle")
    expect(state.grantID).toBeUndefined()
  })

  test("stop interrupts the owning run and clears the grant", async () => {
    const h = track(harness())
    await h.controller.start(owner("ses_alpha"), "http://127.0.0.1:9", async () => true)
    const state = await h.controller.stop("ses_alpha")
    expect(state.phase).toBe("idle")
    expect(state.grantID).toBeUndefined()
    expect(h.interrupts.length).toBe(1)
  })

  test("a withheld native stop still releases the regrant barrier", async () => {
    const h = track(harness((command) =>
      command.action === "stop" ? new Promise<Record<string, unknown>>(() => {}) : {},
    ))
    await h.controller.start(owner("ses_alpha"), "http://127.0.0.1:9", async () => true)
    const stopped = await h.controller.stop("ses_alpha")
    expect(stopped.phase).toBe("idle")
    const next = await h.controller.start(owner("ses_beta"), "http://127.0.0.1:9", async () => true)
    expect(next.phase).toBe("active")
    expect(next.grantID).not.toBe(stopped.grantID)
  }, 15_000)

  test("invalid colors are rejected and valid colors persist", async () => {
    const h = track(harness())
    await expect(h.controller.setColor("transparent")).rejects.toThrow("invalid_color")
    const state = await h.controller.setColor("#38BDF8")
    expect(state.color).toBe("#38bdf8")
    expect(h.savedColors).toEqual(["#38bdf8"])
  })
})

describe("computer-use bridge fencing", () => {
  const post = (base: string, token: string, path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-overcode-computer-token": token },
      body: JSON.stringify(body),
    }).then(async (response) => ({ status: response.status, body: await response.json() }))

  test("actions require the exact grantID", async () => {
    const h = track(harness())
    const env = await h.controller.listen()
    const token = env.OVERCODE_COMPUTER_USE_TOKEN
    const active = await h.controller.start(owner("ses_alpha"), "http://127.0.0.1:9", async () => true)
    const grantID = active.grantID ?? ""
    const missing = await post(env.OVERCODE_COMPUTER_USE_URL, token, "/action", {
      sessionID: "ses_alpha",
      action: "screenshot",
    })
    expect(missing.status).toBe(400)
    const wrong = await post(env.OVERCODE_COMPUTER_USE_URL, token, "/action", {
      sessionID: "ses_alpha",
      grantID: "00000000-0000-4000-8000-000000000000",
      action: "screenshot",
    })
    expect(wrong.status).toBe(403)
    const ok = await post(env.OVERCODE_COMPUTER_USE_URL, token, "/action", {
      sessionID: "ses_alpha",
      grantID,
      action: "screenshot",
    })
    expect(ok.status).toBe(200)
  })

  test("a delayed stop for an old grant cannot disturb a regrant", async () => {
    const h = track(harness())
    const env = await h.controller.listen()
    const token = env.OVERCODE_COMPUTER_USE_TOKEN
    const first = await h.controller.start(owner("ses_alpha"), "http://127.0.0.1:9", async () => true)
    await h.controller.stop("ses_alpha", first.grantID, false)
    const second = await h.controller.start(owner("ses_alpha"), "http://127.0.0.1:9", async () => true)
    const stale = await post(env.OVERCODE_COMPUTER_USE_URL, token, "/stop", {
      sessionID: "ses_alpha",
      grantID: first.grantID,
    })
    expect(stale.status).toBe(200)
    const current = h.controller.state()
    expect(current.phase).toBe("active")
    expect(current.grantID).toBe(second.grantID)
  })
})
