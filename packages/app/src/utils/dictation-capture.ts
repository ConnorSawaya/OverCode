import { createDictationSegmenter, type DictationChunk } from "./dictation-audio"

export async function startDictationCapture(input: {
  deviceID: string
  signal: AbortSignal
  onChunk(chunk: DictationChunk): void
  onLevel(level: number): void
  onDeviceLost(): void
}) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: input.deviceID ? { exact: input.deviceID } : undefined,
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  })
  let context: AudioContext | undefined
  let node: AudioWorkletNode | undefined
  let stopping = false
  let flush: (() => void) | undefined
  const segmenter = createDictationSegmenter(input.onChunk)
  const close = () => {
    stream.getTracks().forEach((track) => {
      track.onended = null
      track.stop()
    })
    node?.disconnect()
    if (node) {
      node.port.onmessage = null
      node.port.close()
    }
    if (context && context.state !== "closed") void context.close().catch(() => undefined)
    input.onLevel(0)
  }
  const abort = () => {
    stopping = true
    flush?.()
    close()
  }
  input.signal.addEventListener("abort", abort, { once: true })
  try {
    input.signal.throwIfAborted()
    context = new AudioContext({ sampleRate: 16000 })
    if (context.sampleRate !== 16000) throw new Error("speech-sample-rate")
    await context.audioWorklet.addModule(new URL("./dictation-worklet.js", import.meta.url).href)
    input.signal.throwIfAborted()
    node = new AudioWorkletNode(context, "overcode-dictation")
    node.port.onmessage = (event: MessageEvent<Float32Array | string>) => {
      if (event.data === "flushed") {
        flush?.()
        return
      }
      if (typeof event.data === "string" || input.signal.aborted) return
      const rms = segmenter.push(event.data)
      input.onLevel(Math.min(1, Math.sqrt(rms) * 2.5))
    }
    context.createMediaStreamSource(stream).connect(node)
    // Keep processing while the tab is hidden without playing microphone audio.
    const mute = context.createGain()
    mute.gain.value = 0
    node.connect(mute).connect(context.destination)
    await context.resume()
    input.signal.throwIfAborted()
    stream.getAudioTracks().forEach((track) => {
      track.onended = () => {
        if (!stopping) input.onDeviceLost()
      }
    })
    return {
      async stop() {
        if (stopping) return
        stopping = true
        await new Promise<void>((resolve) => {
          const timeout = window.setTimeout(resolve, 250)
          flush = () => {
            window.clearTimeout(timeout)
            resolve()
          }
          node?.port.postMessage("flush")
        })
        close()
        if (!input.signal.aborted) segmenter.finish()
        input.signal.removeEventListener("abort", abort)
      },
    }
  } catch (error) {
    close()
    input.signal.removeEventListener("abort", abort)
    throw error
  }
}
