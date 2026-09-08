export const BACKGROUND_PRESETS = {
  none: "none",
  aurora:
    "radial-gradient(circle at 18% 12%, rgba(99, 102, 241, 0.32), transparent 38%), radial-gradient(circle at 82% 18%, rgba(45, 212, 191, 0.22), transparent 34%), linear-gradient(135deg, #111827 0%, #1e1b4b 52%, #0f172a 100%)",
  ember:
    "radial-gradient(circle at 80% 12%, rgba(251, 146, 60, 0.30), transparent 36%), radial-gradient(circle at 12% 82%, rgba(244, 63, 94, 0.18), transparent 40%), linear-gradient(135deg, #171313 0%, #2b1818 50%, #160f16 100%)",
  ocean:
    "radial-gradient(circle at 14% 18%, rgba(56, 189, 248, 0.24), transparent 38%), radial-gradient(circle at 86% 76%, rgba(14, 116, 144, 0.30), transparent 42%), linear-gradient(135deg, #071923 0%, #0c3040 54%, #07131f 100%)",
  forest:
    "radial-gradient(circle at 78% 16%, rgba(74, 222, 128, 0.20), transparent 36%), radial-gradient(circle at 20% 84%, rgba(163, 230, 53, 0.16), transparent 42%), linear-gradient(135deg, #0b1713 0%, #15352a 54%, #0b1210 100%)",
} as const

export type BackgroundPreset = keyof typeof BACKGROUND_PRESETS | "custom"

export function backgroundImageFor(preset: BackgroundPreset, customImage: string) {
  if (preset === "custom" && customImage) return `url("${customImage}")`
  return BACKGROUND_PRESETS[preset as keyof typeof BACKGROUND_PRESETS] ?? BACKGROUND_PRESETS.none
}
