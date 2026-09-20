import { describe, expect, test } from "bun:test"
import { compareMobileVersions } from "./update"

describe("compareMobileVersions", () => {
  test("detects minor and patch updates", () => {
    expect(compareMobileVersions("1.19.0", "1.18.27")).toBeGreaterThan(0)
    expect(compareMobileVersions("1.18.28", "1.18.27")).toBeGreaterThan(0)
    expect(compareMobileVersions("1.18.27", "1.18.28")).toBeLessThan(0)
  })

  test("ignores release prefixes and metadata", () => {
    expect(compareMobileVersions("v1.18.27+build.1", "1.18.27")).toBe(0)
    expect(compareMobileVersions("1.18.27-beta.1", "1.18.26")).toBeGreaterThan(0)
  })
})
