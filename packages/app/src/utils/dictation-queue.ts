import type { DictationChunk } from "./dictation-audio"

// Coalesce previews when inference is slower than capture. Finals are never
// dropped, and a cancelled capture cannot publish into a later composer.
export function createDictationQueue(input: {
  transcribe(chunk: DictationChunk): Promise<string>
  onResult(chunk: DictationChunk, text: string): void
  onError(error: unknown): void
}) {
  let pending: DictationChunk[] = []
  let running: Promise<void> | undefined
  let cancelled = false
  const pump = () => {
    if (running) return running
    running = (async () => {
      while (pending.length && !cancelled) {
        const chunk = pending.shift()!
        try {
          const text = await input.transcribe(chunk)
          if (!cancelled) input.onResult(chunk, text)
        } catch (error) {
          if (!cancelled) {
            cancelled = true
            pending = []
            input.onError(error)
          }
        }
      }
    })().finally(() => {
      running = undefined
    })
    return running
  }
  return {
    add(chunk: DictationChunk) {
      if (cancelled) return
      pending = pending.filter((item) => item.segment !== chunk.segment || item.final)
      if (pending.length >= 12) {
        cancelled = true
        pending = []
        input.onError(new Error("speech-busy"))
        return
      }
      pending.push(chunk)
      void pump()
    },
    async drain() {
      while (running || pending.length) await (running ?? pump())
    },
    cancel() {
      cancelled = true
      pending = []
    },
  }
}
