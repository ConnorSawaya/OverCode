export type SpeechProgress = { phase: "downloading" | "loading" | "ready"; percent?: number }
export type SpeechRequest = { captureID: string; requestID: number; audio: ArrayBuffer; language: string }
export type SpeechPlatform = {
  isAvailable(): Promise<boolean>
  prepare(): Promise<void>
  transcribe(request: SpeechRequest): Promise<{ captureID: string; requestID: number; text: string }>
  cancel(captureID: string): Promise<void>
  onProgress(callback: (progress: SpeechProgress) => void): () => void
}
