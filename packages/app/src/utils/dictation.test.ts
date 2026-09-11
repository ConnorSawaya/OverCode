import { describe, expect, test } from "bun:test"
import { createDictationSegmenter, encodeDictationWav, type DictationChunk } from "./dictation-audio"
import { createDictationQueue } from "./dictation-queue"

const silence = () => new Float32Array(512)
const voice = () => Float32Array.from({ length: 512 }, (_, i) => Math.sin(i * 0.1) * 0.15)
describe("dictation audio", () => {
  test("does not transcribe silence or keyboard-like short impulses", () => {
    const chunks: DictationChunk[] = []
    const segmenter = createDictationSegmenter((chunk) => chunks.push(chunk))
    for (let i = 0; i < 80; i++) segmenter.push(silence())
    segmenter.push(voice())
    for (let i = 0; i < 30; i++) segmenter.push(silence())
    segmenter.finish()
    expect(chunks).toHaveLength(0)
  })
  test("previews replace a phrase and Stop flushes its last words once", () => {
    const chunks: DictationChunk[] = []
    const segmenter = createDictationSegmenter((chunk) => chunks.push(chunk))
    for (let i = 0; i < 100; i++) segmenter.push(voice())
    segmenter.finish()
    segmenter.finish()
    expect(chunks.map((chunk) => chunk.final)).toEqual([false, true])
    expect(chunks.map((chunk) => chunk.segment)).toEqual([0, 0])
    expect(chunks[1]!.audio.byteLength).toBe(44 + 100 * 512 * 2)
  })
  test("pauses finalize distinct phrases and long dictation stays bounded", () => {
    const chunks: DictationChunk[] = []
    const segmenter = createDictationSegmenter((chunk) => chunks.push(chunk))
    for (let i = 0; i < 25; i++) segmenter.push(voice())
    for (let i = 0; i < 30; i++) segmenter.push(silence())
    for (let i = 0; i < 1200; i++) segmenter.push(voice())
    segmenter.finish()
    expect(chunks.filter((chunk) => chunk.final).length).toBeGreaterThanOrEqual(3)
    expect(chunks.every((chunk) => chunk.audio.byteLength < 600_000)).toBe(true)
    expect(new Set(chunks.filter((chunk) => chunk.final).map((chunk) => chunk.segment)).size).toBe(
      chunks.filter((chunk) => chunk.final).length,
    )
  })
  test("encodes canonical 16 kHz mono PCM without clipping overflow", () => {
    const audio = encodeDictationWav(new Float32Array([-2, 0, 2]))
    const view = new DataView(audio)
    expect(view.getUint32(24, true)).toBe(16000)
    expect(view.getUint32(40, true)).toBe(6)
    expect(view.getInt16(44, true)).toBe(-32768)
    expect(view.getInt16(48, true)).toBe(32767)
  })
})
describe("dictation inference queue", () => {
  const chunk = (revision: number, final = false): DictationChunk => ({
    segment: 0,
    revision,
    final,
    audio: encodeDictationWav(voice()),
  })
  test("coalesces obsolete previews while preserving the final phrase", async () => {
    const first = Promise.withResolvers<string>()
    const requested: number[] = []
    const delivered: string[] = []
    const queue = createDictationQueue({
      transcribe: async (item) => {
        requested.push(item.revision)
        return item.revision === 1 ? first.promise : "complete phrase"
      },
      onResult: (_item, text) => delivered.push(text),
      onError: (error) => {
        throw error
      },
    })
    queue.add(chunk(1))
    queue.add(chunk(2))
    queue.add(chunk(3))
    queue.add(chunk(4, true))
    first.resolve("partial")
    await queue.drain()
    expect(requested).toEqual([1, 4])
    expect(delivered).toEqual(["partial", "complete phrase"])
  })
  test("a late result cannot write after switching chats", async () => {
    const response = Promise.withResolvers<string>()
    const delivered: string[] = []
    const queue = createDictationQueue({
      transcribe: () => response.promise,
      onResult: (_item, text) => delivered.push(text),
      onError: (error) => {
        throw error
      },
    })
    queue.add(chunk(1))
    queue.add(chunk(2, true))
    queue.cancel()
    response.resolve("old chat")
    await queue.drain()
    expect(delivered).toEqual([])
  })
})
