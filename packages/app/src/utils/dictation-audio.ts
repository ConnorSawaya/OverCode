export type DictationChunk = { segment: number; revision: number; final: boolean; audio: ArrayBuffer }

export function encodeDictationWav(samples: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const wav = new DataView(buffer)
  wav.setUint32(0, 0x52494646, false)
  wav.setUint32(4, buffer.byteLength - 8, true)
  wav.setUint32(8, 0x57415645, false)
  wav.setUint32(12, 0x666d7420, false)
  wav.setUint32(16, 16, true)
  wav.setUint16(20, 1, true)
  wav.setUint16(22, 1, true)
  wav.setUint32(24, 16000, true)
  wav.setUint32(28, 32000, true)
  wav.setUint16(32, 2, true)
  wav.setUint16(34, 16, true)
  wav.setUint32(36, 0x64617461, false)
  wav.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, samples[i]!))
    wav.setInt16(44 + i * 2, value * (value < 0 ? 32768 : 32767), true)
  }
  return buffer
}

// Pause-aware segments, with preview revisions of the SAME phrase. Silence
// never becomes a Whisper request (avoids hallucinated text in quiet rooms).
export function createDictationSegmenter(emit: (chunk: DictationChunk) => void) {
  let frames: Float32Array[] = []
  let preroll: Float32Array[] = []
  let count = 0
  let silence = 0
  let voiced = 0
  let previewAt = 0
  let segment = 0
  let revision = 0
  let noise = 0.001
  const publish = (final: boolean) => {
    if (voiced < 1600) return
    const samples = new Float32Array(count)
    let offset = 0
    for (const frame of frames) {
      samples.set(frame, offset)
      offset += frame.length
    }
    emit({ segment, revision: ++revision, final, audio: encodeDictationWav(samples) })
  }
  const finish = () => {
    if (count) publish(true)
    frames = []
    count = silence = voiced = previewAt = 0
    segment++
  }
  return {
    push(frame: Float32Array) {
      let sum = 0
      for (const value of frame) sum += value * value
      const rms = Math.sqrt(sum / Math.max(1, frame.length))
      const speech = rms > Math.max(0.004, noise * 3)
      if (!speech) noise = noise * 0.98 + Math.min(rms, 0.01) * 0.02
      if (!count && !speech) {
        preroll.push(frame)
        while (preroll.reduce((size, part) => size + part.length, 0) > 4000) preroll.shift()
        return rms
      }
      if (!count) {
        frames = preroll
        count = frames.reduce((size, part) => size + part.length, 0)
        preroll = []
      }
      frames.push(frame)
      count += frame.length
      silence = speech ? 0 : silence + frame.length
      if (speech) voiced += frame.length
      if (silence >= 10400 || (count > 128000 && silence >= 3200) || count >= 288000) finish()
      else if (voiced >= 6400 && count - previewAt >= 32000) {
        publish(false)
        previewAt = count
      }
      return rms
    },
    finish,
  }
}
