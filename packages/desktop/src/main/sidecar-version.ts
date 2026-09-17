export function sidecarVersion(env: NodeJS.ProcessEnv = process.env): "v1" | "v2" {
  if (env.OVERCODE_SIDECAR_V2 === "0" || env.OVERCODE_SIDECAR_V2 === "false") return "v1"
  return "v2"
}
