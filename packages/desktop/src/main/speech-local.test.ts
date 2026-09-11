import { expect, test } from "bun:test"
import { validateSpeechRequest } from "./speech-local"
import { encodeDictationWav } from "../../../app/src/utils/dictation-audio"

test("speech IPC accepts bounded PCM and rejects malformed payloads before inference", () => {
  const request = {
    captureID: "capture-a",
    requestID: 1,
    language: "en-US",
    audio: encodeDictationWav(new Float32Array(16000)),
  }
  expect(() => validateSpeechRequest(request)).not.toThrow()
  expect(() => validateSpeechRequest({ ...request, audio: new ArrayBuffer(960_046) })).toThrow()
  expect(() => validateSpeechRequest({ ...request, captureID: "../other-session" })).toThrow()
  expect(() => validateSpeechRequest({ ...request, language: "en;bad" })).toThrow()
  expect(() => validateSpeechRequest({ ...request, requestID: NaN })).toThrow()
  new DataView(request.audio).setUint32(40, 99999999, true)
  expect(() => validateSpeechRequest(request)).toThrow()
})
