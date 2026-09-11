const actions = ["screenshot", "move", "click", "doubleClick", "drag", "scroll", "type", "press", "finish"] as const

export function computerUseAudit(input: Record<string, unknown>, metadata: Record<string, unknown>) {
  const action = actions.find((action) => action === input.action) ?? "unknown"
  // Never render arbitrary input/output: it may contain text, keys, secrets or image data.
  const coordinates = Object.fromEntries(
    ["x", "y", "endX", "endY", "amount"].flatMap((key) => {
      const value = input[key]
      return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1000 ? [[key, value]] : []
    }),
  )
  return {
    action,
    coordinates,
    frameId:
      typeof metadata.frameId === "string"
        ? metadata.frameId
        : typeof input.frameId === "string"
          ? input.frameId
          : undefined,
    characters: typeof input.text === "string" ? input.text.length : undefined,
    stopped: metadata.stopped === true,
  }
}
