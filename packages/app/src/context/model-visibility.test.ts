import { describe, expect, test } from "bun:test"
import { isModelVisible } from "./model-visibility"

describe("isModelVisible", () => {
  test("hides catalog models until the user enables them", () => {
    expect(isModelVisible({ configured: false, firstParty: false })).toBe(false)
  })

  test("keeps the PC-configured model visible", () => {
    expect(isModelVisible({ configured: true, firstParty: false })).toBe(true)
  })

  test("keeps Overcode and OpenCode models available from the PC catalog", () => {
    expect(isModelVisible({ configured: false, firstParty: true })).toBe(true)
  })

  test("honors explicit user visibility over defaults", () => {
    expect(isModelVisible({ visibility: "show", configured: false, firstParty: false })).toBe(true)
    expect(isModelVisible({ visibility: "hide", configured: true, firstParty: true })).toBe(false)
  })
})
