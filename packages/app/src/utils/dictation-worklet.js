class DictationCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.samples = new Float32Array(512)
    this.offset = 0
    this.port.onmessage = (event) => {
      if (event.data !== "flush") return
      if (this.offset) this.port.postMessage(this.samples.slice(0, this.offset))
      this.offset = 0
      this.port.postMessage("flushed")
    }
  }
  process(inputs) {
    const samples = inputs[0]?.[0]
    if (!samples) return true
    for (const value of samples) {
      this.samples[this.offset++] = value
      if (this.offset !== this.samples.length) continue
      this.port.postMessage(this.samples, [this.samples.buffer])
      this.samples = new Float32Array(512)
      this.offset = 0
    }
    return true
  }
}
registerProcessor("opencode-dictation", DictationCapture)
