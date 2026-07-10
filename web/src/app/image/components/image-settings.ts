import {
  RectangleHorizontal,
  RectangleVertical,
  Square,
  type LucideIcon,
} from "lucide-react"

export type ImageSettings = {
  model: string
  quality: string
  width: string
  height: string
  ratio: string
  tier: string
  count: string
}

export type StoredImageSettings = Partial<{
  [Key in keyof ImageSettings]: unknown
}>

export type ImageAspectOption = {
  ratio: string
  tier: string
  width: string
  height: string
  label: string
  icon: LucideIcon | null
}

export const qualityOptions = [
  { value: "auto", label: "自动" },
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
]

export const aspectOptions: ImageAspectOption[] = [
  { ratio: "1:1", tier: "1k", width: "1024", height: "1024", label: "1:1", icon: Square },
  { ratio: "2:3", tier: "1k", width: "1024", height: "1536", label: "2:3", icon: RectangleVertical },
  { ratio: "3:2", tier: "1k", width: "1536", height: "1024", label: "3:2", icon: RectangleHorizontal },
  { ratio: "3:4", tier: "1k", width: "1024", height: "1365", label: "3:4", icon: RectangleVertical },
  { ratio: "4:3", tier: "1k", width: "1365", height: "1024", label: "4:3", icon: RectangleHorizontal },
  { ratio: "9:16", tier: "1k", width: "1088", height: "1920", label: "9:16", icon: RectangleVertical },
  { ratio: "16:9", tier: "1k", width: "1920", height: "1088", label: "16:9", icon: RectangleHorizontal },
  { ratio: "1:1", tier: "2k", width: "2048", height: "2048", label: "1:1(2k)", icon: Square },
  { ratio: "16:9", tier: "2k", width: "2560", height: "1440", label: "16:9(2k)", icon: RectangleHorizontal },
  { ratio: "9:16", tier: "2k", width: "1440", height: "2560", label: "9:16(2k)", icon: RectangleVertical },
  { ratio: "16:9", tier: "4k", width: "3840", height: "2160", label: "16:9(4k)", icon: RectangleHorizontal },
  { ratio: "9:16", tier: "4k", width: "2160", height: "3840", label: "9:16(4k)", icon: RectangleVertical },
  { ratio: "auto", tier: "auto", width: "1024", height: "1024", label: "auto", icon: null },
]

export const countOptions = Array.from({ length: 10 }, (_, index) => String(index + 1))

const qualityValues = new Set(qualityOptions.map((option) => option.value))
const ratioValues = new Set(aspectOptions.map((option) => option.ratio))
const tierValues = new Set(aspectOptions.map((option) => option.tier))

function normalizeOption(value: unknown, values: Set<string>, fallback: string) {
  const normalized = String(value ?? "").trim()
  return values.has(normalized) ? normalized : fallback
}

function normalizeDimension(value: unknown) {
  const normalized = String(value ?? "").trim()
  if (!/^\d+$/.test(normalized)) {
    return "1024"
  }

  const dimension = Number(normalized)
  return Number.isSafeInteger(dimension) && dimension > 0 ? String(dimension) : "1024"
}

function normalizeCount(value: unknown) {
  const count = Math.floor(Number(value) || 1)
  return String(Math.min(100, Math.max(1, count)))
}

export function normalizeImageSettings(value: StoredImageSettings | null | undefined): ImageSettings {
  const model = String(value?.model ?? "").trim()

  return {
    model: model || "gpt-image-2",
    quality: normalizeOption(value?.quality, qualityValues, "auto"),
    width: normalizeDimension(value?.width),
    height: normalizeDimension(value?.height),
    ratio: normalizeOption(value?.ratio, ratioValues, "1:1"),
    tier: normalizeOption(value?.tier, tierValues, "1k"),
    count: normalizeCount(value?.count),
  }
}

export function imageSettingsSummary(
  settings: Pick<ImageSettings, "quality" | "ratio" | "tier" | "count">,
) {
  const qualityLabel =
    qualityOptions.find((option) => option.value === settings.quality)?.label || "自动"
  const ratioLabel = settings.ratio === "auto" ? "auto" : `${settings.ratio}(${settings.tier})`

  return `${qualityLabel} · ${ratioLabel} · ${settings.count || 1} 张`
}

export function isImagePresetDisabled(model: string, tier: string) {
  return !model.toLowerCase().includes("codex") && (tier === "2k" || tier === "4k")
}
