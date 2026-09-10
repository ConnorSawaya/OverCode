import { expect, test } from "bun:test"
import { rm } from "node:fs/promises"
import { resolve } from "node:path"

const executable = resolve(import.meta.dir, "../resources/computer-use/overcode-computer-use.exe")

async function run(args: string[], input = "") {
  const child = Bun.spawn([executable, ...args], {
    cwd: resolve(import.meta.dir, ".."),
    stdin: new TextEncoder().encode(input),
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  const timeout = setTimeout(() => child.kill(), 10_000)
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(stderr).toBe("")
    const lines = stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line))
    for (const line of lines) {
      if ("event" in line) {
        expect(["ready", "stopped"]).toContain(line.event)
        continue
      }
      expect(typeof line.id).toBe("string")
      expect(Object.keys(line).sort()).toEqual(line.ok ? ["id", "ok", "result"] : ["error", "id", "ok"])
    }
    return { code, lines }
  } finally {
    clearTimeout(timeout)
  }
}

// Never activates: every action probe must fail before capture or input injection.
test.skipIf(process.platform !== "win32")("native --check has no control or capture side effects", async () => {
  const result = await run(["--check"])
  expect(result.code).toBe(0)
  expect(result.lines).toHaveLength(1)
  expect(result.lines[0]).toMatchObject({
    id: "check",
    ok: true,
    result: {
      hookInstalled: false,
      overlayShown: false,
      inputInjected: false,
      screenshotTaken: false,
      requiresActivationProbe: true,
      leaseMs: 600_000,
      frameMaxAgeMs: 120_000,
      maxScreenshot: { width: 1280, height: 720 },
      maxTextLength: 2000,
      maxScrollAmount: 10,
    },
  })
})

test.skipIf(process.platform !== "win32")("inactive protocol fails closed and EOF terminates the helper", async () => {
  const actions = ["screenshot", "move", "click", "doubleClick", "drag", "scroll", "type", "press"]
  const requests = [
    ...actions.map((action) => ({ id: action, action })),
    { id: "bad-color", action: "color", color: "#00000000" },
    { id: "idle-color", action: "color", color: "#23b7a5" },
    { id: "unknown", action: "rawSendInput" },
    { id: "stop", action: "stop" },
    { id: "stop-again", action: "stop" },
  ]
  const result = await run([], `${requests.map((request) => JSON.stringify(request)).join("\n")}\n`)
  expect(result.code).toBe(0)
  for (const action of actions) {
    expect(result.lines).toContainEqual({ id: action, ok: false, error: "inactive" })
  }
  expect(result.lines).toContainEqual({ id: "bad-color", ok: false, error: "invalid_color" })
  expect(result.lines).toContainEqual({ id: "idle-color", ok: false, error: "inactive" })
  expect(result.lines).toContainEqual({ id: "unknown", ok: false, error: "unknown_action" })
  expect(result.lines).toContainEqual({ id: "stop", ok: true, result: { stopped: true } })
  expect(result.lines).toContainEqual({ id: "stop-again", ok: true, result: { stopped: true } })
  expect(result.lines.filter((line) => "result" in line).every((line) => !("frame" in line.result))).toBe(true)
})

test.skipIf(process.platform !== "win32")("invalid JSON and oversized lines cannot activate or hang the helper", async () => {
  const result = await run([], `{broken}\n${"x".repeat(65_537)}\n`)
  expect(result.code).toBe(0)
  expect(result.lines).toContainEqual({ id: "", ok: false, error: "invalid_json" })
  expect(result.lines).toContainEqual({ id: "", ok: false, error: "request_too_large" })
})

test.skipIf(process.platform !== "win32")("unknown command-line switches do not enter interactive mode", async () => {
  const result = await run(["--not-a-mode"])
  expect(result.code).toBe(1)
  expect(result.lines).toEqual([{ id: "startup", ok: false, error: "invalid_arguments" }])
})

test.skipIf(process.platform !== "win32")("preview shares the overlay renderer without windows, capture, or input", async () => {
  const output = resolve(import.meta.dir, `../resources/computer-use/preview-smoke-${process.pid}.png`)
  try {
    const result = await run(["--preview-image", output, "#23b7a5"])
    expect(result.code).toBe(0)
    expect(result.lines).toEqual([
      {
        id: "preview-image",
        ok: true,
        result: {
          path: output,
          width: 1280,
          height: 720,
          generatedFixture: true,
          sharedOverlayRenderer: true,
          borderCenterAlpha: 0,
          windowCreated: false,
          overlayShown: false,
          hookInstalled: false,
          inputInjected: false,
          screenshotTaken: false,
        },
      },
    ])
    expect(Array.from(new Uint8Array(await Bun.file(output).slice(0, 8).arrayBuffer()))).toEqual([
      137, 80, 78, 71, 13, 10, 26, 10,
    ])
  } finally {
    await rm(output, { force: true })
  }
})
