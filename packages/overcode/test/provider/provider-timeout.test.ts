import { describe, expect, test } from "bun:test"
import { OVERCODE_PROVIDER_STREAM_TIMEOUT, providerTimeouts } from "../../src/provider/provider"

describe("provider stream timeouts", () => {
  test("bounds the Overcode provider by default", () => {
    expect(providerTimeouts("overcode", {})).toEqual({
      chunk: OVERCODE_PROVIDER_STREAM_TIMEOUT,
      header: OVERCODE_PROVIDER_STREAM_TIMEOUT,
    })
    expect(OVERCODE_PROVIDER_STREAM_TIMEOUT).toBe(90_000)
    expect(providerTimeouts("opencode", {})).toEqual({
      chunk: OVERCODE_PROVIDER_STREAM_TIMEOUT,
      header: OVERCODE_PROVIDER_STREAM_TIMEOUT,
    })
  })

  test("preserves configured and non-Overcode timeout behavior", () => {
    expect(providerTimeouts("test", {})).toEqual({ chunk: 300_000, header: 300_000 })
    expect(providerTimeouts("overcode", { chunkTimeout: false, headerTimeout: 12_000 })).toEqual({
      chunk: false,
      header: 12_000,
    })
  })
})
