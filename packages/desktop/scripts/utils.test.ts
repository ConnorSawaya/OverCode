import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { downloadCliToResources } from "./utils"

describe("downloadCliToResources", () => {
  test("reuses a staged CLI binary instead of downloading", async () => {
    const directory = await mkdtemp(join(tmpdir(), "overcode-cli-test-"))
    try {
      const dest = join(directory, "opencode-cli")
      await Bun.write(dest, "staged-binary")
      await downloadCliToResources(dest)
      expect(await Bun.file(dest).text()).toBe("staged-binary")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
