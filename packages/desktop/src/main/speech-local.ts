import { execFile, spawn, type ChildProcess } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { createReadStream, createWriteStream } from "node:fs"
import { access, mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { availableParallelism } from "node:os"
import { createServer } from "node:net"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import { setTimeout } from "node:timers/promises"
import { promisify } from "node:util"
import type { SpeechProgress, SpeechRequest } from "@opencode-ai/app"

const execute = promisify(execFile)
const release = "b4938"
const assets = {
  cpu: { name: "whisper-bin-x64.zip", hash: "c2a4b60edb11f7e11a9191ffb50929535527d4d91c9903dbe3e554583bbbc63d" },
  cuda: {
    name: "whisper-cublas-11.8.0-bin-x64.zip",
    hash: "2510ae3fe25af5cd7fed55ff71a97a5b1bcc7ea27e88e98d1d53229761a0857d",
  },
}
const model = { name: "ggml-small-q5_1.bin", hash: "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb" }
export const isLocalSpeechAvailable = () => process.platform === "win32" && process.arch === "x64"

// A warm model shared by bounded jobs; ownership is always window + capture ID.
// WAV audio stays in memory and travels only over a private loopback route.
export function createLocalSpeech(directory: string, progress: (value: SpeechProgress) => void = () => {}) {
  let preparing: Promise<void> | undefined
  let server: ChildProcess | undefined
  let endpoint = ""
  let disposed = false
  let queue: Promise<unknown> = Promise.resolve()
  let pending = 0
  const captures = new Map<string, AbortController>()
  const setup = new AbortController()
  const prepare = () => {
    if (disposed) return Promise.reject(new Error("speech-closed"))
    if (endpoint && server?.exitCode === null) return Promise.resolve()
    if (preparing) return preparing
    preparing = (async () => {
      if (!isLocalSpeechAvailable()) throw new Error("speech-unsupported")
      await mkdir(directory, { recursive: true })
      const gpu = await execute("nvidia-smi.exe", ["--query-gpu=name", "--format=csv,noheader"], {
        windowsHide: true,
        timeout: 3000,
      }).then(
        ({ stdout }) => !!stdout.trim(),
        () => false,
      )
      const asset = gpu ? assets.cuda : assets.cpu
      const runtime = join(directory, `${release}-${gpu ? "cuda" : "cpu"}`)
      if (!(await exists(join(runtime, ".ready")))) {
        const zip = join(directory, asset.name)
        await download(
          `https://github.com/ggml-org/whisper.cpp/releases/download/${release}/${asset.name}`,
          zip,
          asset.hash,
          progress,
          setup.signal,
        )
        const staging = await mkdtemp(join(directory, "extract-"))
        try {
          await execute(
            "powershell.exe",
            [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              "Expand-Archive -LiteralPath $env:OPENCODE_SPEECH_ZIP -DestinationPath $env:OPENCODE_SPEECH_DEST -Force",
            ],
            {
              windowsHide: true,
              timeout: 180_000,
              signal: setup.signal,
              env: { ...process.env, OPENCODE_SPEECH_ZIP: zip, OPENCODE_SPEECH_DEST: staging },
            },
          )
          if (!(await findServer(staging))) throw new Error("speech-runtime-missing")
          await writeFile(join(staging, ".ready"), asset.hash)
          await rename(staging, runtime)
        } finally {
          await rm(staging, { recursive: true, force: true })
        }
      }
      const modelPath = join(directory, model.name)
      if (!(await exists(modelPath))) {
        await download(
          `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${model.name}`,
          modelPath,
          model.hash,
          progress,
          setup.signal,
        )
      }
      // The official CUDA archive omits cuBLAS. Load its pinned NVIDIA runtime
      // privately; no Python install or machine-wide CUDA changes are required.
      const cublas = join(directory, "cublas-11.11.3.6")
      if (gpu && !(await exists(join(cublas, "nvidia", "cublas", "bin", "cublas64_11.dll")))) {
        const zip = join(directory, "cublas-11.11.3.6.zip")
        await download(
          "https://files.pythonhosted.org/packages/0b/1d/7a78cd36fd5e3da4021b3ac2c2c8b2651dd72345b7c3ecc0d3e051884f50/nvidia_cublas_cu11-11.11.3.6-py3-none-win_amd64.whl",
          zip,
          "6ab12b1302bef8ac1ff4414edd1c059e57f4833abef9151683fb8f4de25900be",
          progress,
          setup.signal,
        )
        const staging = await mkdtemp(join(directory, "cublas-extract-"))
        try {
          await execute(
            "powershell.exe",
            [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              "Expand-Archive -LiteralPath $env:OPENCODE_SPEECH_ZIP -DestinationPath $env:OPENCODE_SPEECH_DEST -Force",
            ],
            {
              windowsHide: true,
              timeout: 180_000,
              signal: setup.signal,
              env: { ...process.env, OPENCODE_SPEECH_ZIP: zip, OPENCODE_SPEECH_DEST: staging },
            },
          )
          await rename(staging, cublas)
        } finally {
          await rm(staging, { recursive: true, force: true })
        }
      }
      progress({ phase: "loading" })
      const exe = await findServer(runtime)
      if (!exe || disposed) throw new Error("speech-runtime-missing")
      const port = await freePort()
      const route = `/${randomUUID()}`
      const url = `http://127.0.0.1:${port}${route}`
      const child = spawn(
        exe,
        [
          "-m",
          modelPath,
          "--host",
          "127.0.0.1",
          "--port",
          String(port),
          "--request-path",
          route,
          "--public",
          join(directory, "no-public-files"),
          "-t",
          String(Math.min(8, availableParallelism())),
          "-l",
          "auto",
          "-nt",
          "-nf",
          "-bs",
          "1",
          "-bo",
          "1",
          "-sns",
        ],
        {
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
          cwd: directory,
          env: { ...process.env, PATH: `${join(cublas, "nvidia", "cublas", "bin")};${process.env.PATH ?? ""}` },
        },
      )
      server = child
      let error: Error | undefined
      child.on("error", (value) => {
        error = value
      })
      // Drain diagnostics without saving transcripts in app logs.
      child.stdout?.resume()
      child.stderr?.resume()
      child.once("exit", () => {
        if (server === child) {
          endpoint = ""
          server = undefined
        }
      })
      try {
        const deadline = Date.now() + 60_000
        while (Date.now() < deadline) {
          if (disposed || error || child.exitCode !== null) throw error ?? new Error("speech-engine-stopped")
          const healthy = await fetch(`${url}/health`, { signal: AbortSignal.timeout(800) }).then(
            (r) => r.ok,
            () => false,
          )
          if (healthy) {
            endpoint = url
            progress({ phase: "ready" })
            return
          }
          await setTimeout(150, undefined, { signal: setup.signal })
        }
        throw new Error("speech-start-timeout")
      } catch (error) {
        child.kill()
        throw error
      }
    })().finally(() => {
      preparing = undefined
    })
    return preparing
  }
  return {
    prepare,
    transcribe(owner: number, request: SpeechRequest) {
      validateSpeechRequest(request)
      if (pending >= 16) return Promise.reject(new Error("speech-busy"))
      const key = `${owner}:${request.captureID}`
      const capture = captures.get(key) ?? new AbortController()
      captures.set(key, capture)
      pending++
      const job = queue
        .catch(() => undefined)
        .then(async () => {
          capture.signal.throwIfAborted()
          await prepare()
          capture.signal.throwIfAborted()
          const form = new FormData()
          form.set("file", new Blob([request.audio], { type: "audio/wav" }), "dictation.wav")
          form.set("response_format", "json")
          form.set("language", request.language === "auto" ? "auto" : request.language.split("-")[0]!.toLowerCase())
          form.set("temperature", "0")
          form.set("temperature_inc", "0")
          const response = await fetch(`${endpoint}/inference`, {
            method: "POST",
            body: form,
            // Let in-flight inference finish before admitting another capture.
            // Cancellation suppresses delivery but never overlaps model execution.
            signal: AbortSignal.any([setup.signal, AbortSignal.timeout(30_000)]),
          })
          if (!response.ok) throw new Error("speech-transcription-failed")
          const value = (await response.json()) as { text?: unknown }
          capture.signal.throwIfAborted()
          if (typeof value.text !== "string") throw new Error("speech-invalid-response")
          return { captureID: request.captureID, requestID: request.requestID, text: value.text.trim() }
        })
        .finally(() => {
          pending--
        })
      queue = job
      return job
    },
    cancel(owner: number, captureID?: string) {
      for (const [key, capture] of captures) {
        if (captureID ? key !== `${owner}:${captureID}` : !key.startsWith(`${owner}:`)) continue
        capture.abort()
        captures.delete(key)
      }
    },
    dispose() {
      disposed = true
      setup.abort()
      captures.forEach((capture) => capture.abort())
      captures.clear()
      server?.kill()
      server = undefined
      endpoint = ""
    },
  }
}

export function validateSpeechRequest(value: SpeechRequest) {
  if (
    !value ||
    typeof value.captureID !== "string" ||
    !/^[\w-]{1,100}$/.test(value.captureID) ||
    !Number.isSafeInteger(value.requestID) ||
    value.requestID < 0 ||
    typeof value.language !== "string" ||
    !/^(auto|[a-z]{2,3}(?:-[a-z0-9]+)*)$/i.test(value.language) ||
    !(value.audio instanceof ArrayBuffer) ||
    value.audio.byteLength < 46 ||
    value.audio.byteLength > 960_044
  )
    throw new Error("speech-invalid-audio")
  const wav = new DataView(value.audio)
  if (
    wav.getUint32(0, false) !== 0x52494646 ||
    wav.getUint32(8, false) !== 0x57415645 ||
    wav.getUint32(12, false) !== 0x666d7420 ||
    wav.getUint32(16, true) !== 16 ||
    wav.getUint16(20, true) !== 1 ||
    wav.getUint16(22, true) !== 1 ||
    wav.getUint32(24, true) !== 16000 ||
    wav.getUint16(34, true) !== 16 ||
    wav.getUint32(36, false) !== 0x64617461 ||
    wav.getUint32(40, true) !== value.audio.byteLength - 44 ||
    wav.getUint32(4, true) !== value.audio.byteLength - 8 ||
    value.audio.byteLength % 2 !== 0
  )
    throw new Error("speech-invalid-audio")
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  )
async function findServer(directory: string): Promise<string | undefined> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isFile() && entry.name === "whisper-server.exe") return join(directory, entry.name)
    if (!entry.isDirectory()) continue
    const found = await findServer(join(directory, entry.name))
    if (found) return found
  }
}
async function freePort() {
  const listener = createServer()
  return new Promise<number>((resolve, reject) => {
    listener.once("error", reject)
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address()
      if (!address || typeof address === "string") {
        listener.close()
        reject(new Error("speech-port"))
        return
      }
      listener.close((error) => (error ? reject(error) : resolve(address.port)))
    })
  })
}
async function download(
  url: string,
  destination: string,
  expected: string,
  progress: (value: SpeechProgress) => void,
  signal: AbortSignal,
) {
  if (await exists(destination)) {
    const hash = createHash("sha256")
    for await (const chunk of createReadStream(destination)) hash.update(chunk)
    if (hash.digest("hex") === expected) return
    throw new Error("speech-download-corrupt")
  }
  const partial = `${destination}.${randomUUID()}.partial`
  try {
    const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(600_000)]) })
    if (!response.ok || !response.body) throw new Error("speech-download-failed")
    const size = Number(response.headers.get("content-length"))
    let loaded = 0
    let lastPercent = -1
    const hash = createHash("sha256")
    progress({ phase: "downloading", percent: 0 })
    const reader = response.body.getReader()
    const chunks = async function* () {
      try {
        for (;;) {
          const part = await reader.read()
          if (part.done) break
          yield part.value
        }
      } finally {
        reader.releaseLock()
      }
    }
    await pipeline(
      Readable.from(chunks()),
      new Transform({
        transform(chunk, _encoding, callback) {
          hash.update(chunk)
          loaded += chunk.length
          const percent = size ? Math.min(100, Math.floor((loaded / size) * 100)) : 0
          if (lastPercent !== percent) {
            progress({ phase: "downloading", percent })
            lastPercent = percent
          }
          callback(null, chunk)
        },
      }),
      createWriteStream(partial),
      { signal },
    )
    if (hash.digest("hex") !== expected) throw new Error("speech-download-corrupt")
    await rename(partial, destination)
  } finally {
    await rm(partial, { force: true })
  }
}
