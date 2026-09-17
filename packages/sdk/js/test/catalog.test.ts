import { describe, expect, test } from "bun:test"
import { normalizeProviderCatalog } from "../src/v2/data"

describe("normalizeProviderCatalog", () => {
  test("tolerates flat daemon shapes without api/request/time objects", () => {
    const result = normalizeProviderCatalog(
      [{ id: "flat", name: "Flat", settings: { mode: "flat" } }] as never,
      [
        {
          id: "model",
          providerID: "flat",
          name: "Flat Model",
          package: "flat-package",
          settings: { modelOption: true },
        },
      ] as never,
    )

    const provider = result.all.get("flat")
    expect(provider?.options).toMatchObject({ mode: "flat" })
    expect(provider?.models.model).toMatchObject({
      id: "model",
      providerID: "flat",
      api: { id: "model" },
      options: { modelOption: true },
      release_date: "",
    })
    expect(result.connected).toEqual(["flat"])
  })
})
