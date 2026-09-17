import { expect, test } from "@playwright/test"
import { base64Encode } from "@overcode-ai/core/util/encode"
import { mockOvercodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

test.use({ viewport: { width: 390, height: 844 } })

const directory = "C:/Overcode/PromptInputV2MobileLayout"
const projectID = "proj_prompt_input_v2_mobile_layout"
const sessionID = "ses_prompt_input_v2_mobile_layout"

test("keeps narrow composer controls separate and reachable", async ({ page }) => {
  await mockOvercodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "prompt-input-v2-mobile-layout",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "mock-provider",
          name: "Mock Provider",
          models: {
            "mobile-model": {
              id: "mobile-model",
              name: "Mobile Model",
              limit: { context: 200_000 },
              variants: { high: {} },
            },
          },
        },
      ],
      connected: ["mock-provider"],
      default: { providerID: "mock-provider", modelID: "mobile-model" },
    },
    sessions: [
      {
        id: sessionID,
        slug: "prompt-input-v2-mobile-layout",
        projectID,
        directory,
        title: "Prompt input V2 mobile layout",
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    pageMessages: () => ({ items: [] }),
  })
  await page.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
  })

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  const composer = page.locator('[data-component="prompt-input-v2"]')
  await expectAppVisible(composer)

  const controls = [
    composer.locator('[data-action="prompt-permission"]'),
    composer.getByRole("button", { name: "Choose agent" }),
    composer.locator('[data-action="prompt-model"]'),
    composer.getByRole("button", { name: "Choose model variant" }),
    composer.getByRole("button", { name: /dictation|voice/i }),
    composer.getByRole("button", { name: "Send" }),
  ]

  for (const control of controls) await expect(control).toBeVisible()

  const bounds = await Promise.all(controls.map((control) => control.boundingBox()))
  expect(bounds.every((box): box is NonNullable<typeof box> => box !== null)).toBe(true)
  const visibleBounds = bounds.filter((box): box is NonNullable<typeof box> => box !== null)

  for (let index = 0; index < visibleBounds.length; index++) {
    const first = visibleBounds[index]!
    expect(first.x).toBeGreaterThanOrEqual(0)
    expect(first.x + first.width).toBeLessThanOrEqual(390)
    for (const second of visibleBounds.slice(index + 1)) {
      const overlapWidth = Math.min(first.x + first.width, second.x + second.width) - Math.max(first.x, second.x)
      const overlapHeight = Math.min(first.y + first.height, second.y + second.height) - Math.max(first.y, second.y)
      expect(overlapWidth > 0 && overlapHeight > 0).toBe(false)
    }
  }
})
