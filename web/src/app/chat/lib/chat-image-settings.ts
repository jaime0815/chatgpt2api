import {
  aspectOptions,
  normalizeImageSettings,
  type ImageSettings,
} from "@/app/image/components/image-settings"

const CHAT_IMAGE_SETTINGS_STORAGE_PREFIX = "chatgpt2api:chat_image_settings"

type StoredImageSettings = {
  model: string | null
  quality: string | null
  ratio: string | null
  tier: string | null
  count: string | null
  width: string | null
  height: string | null
}

function initialImageSettings(): ImageSettings {
  return normalizeImageSettings({ count: "1" })
}

function normalizeStoredImageSettings(stored: StoredImageSettings): ImageSettings {
  const normalized = normalizeImageSettings(stored)
  const preset = aspectOptions.find(
    (option) => option.ratio === normalized.ratio && option.tier === normalized.tier,
  )
  return normalizeImageSettings({
    ...normalized,
    width: stored.width || preset?.width || normalized.width,
    height: stored.height || preset?.height || normalized.height,
  })
}

function chatImageSettingsKey(subjectId: string, field: keyof StoredImageSettings) {
  return `${CHAT_IMAGE_SETTINGS_STORAGE_PREFIX}:${encodeURIComponent(subjectId)}:${field}`
}

function subjectImageSettings(subjectId: string): StoredImageSettings {
  return {
    model: window.localStorage.getItem(chatImageSettingsKey(subjectId, "model")),
    quality: window.localStorage.getItem(chatImageSettingsKey(subjectId, "quality")),
    ratio: window.localStorage.getItem(chatImageSettingsKey(subjectId, "ratio")),
    tier: window.localStorage.getItem(chatImageSettingsKey(subjectId, "tier")),
    count: window.localStorage.getItem(chatImageSettingsKey(subjectId, "count")),
    width: window.localStorage.getItem(chatImageSettingsKey(subjectId, "width")),
    height: window.localStorage.getItem(chatImageSettingsKey(subjectId, "height")),
  }
}

export function loadChatImageSettings(subjectId: string): ImageSettings {
  if (typeof window === "undefined") {
    return initialImageSettings()
  }
  const normalizedSubjectId = subjectId.trim()
  if (!normalizedSubjectId) {
    return initialImageSettings()
  }
  return normalizeStoredImageSettings(subjectImageSettings(normalizedSubjectId))
}

export function saveChatImageSettings(subjectId: string, settings: ImageSettings) {
  const normalizedSubjectId = subjectId.trim()
  if (typeof window === "undefined" || !normalizedSubjectId) {
    return
  }
  window.localStorage.setItem(chatImageSettingsKey(normalizedSubjectId, "model"), settings.model)
  window.localStorage.setItem(chatImageSettingsKey(normalizedSubjectId, "quality"), settings.quality)
  window.localStorage.setItem(chatImageSettingsKey(normalizedSubjectId, "ratio"), settings.ratio)
  window.localStorage.setItem(chatImageSettingsKey(normalizedSubjectId, "tier"), settings.tier)
  window.localStorage.setItem(chatImageSettingsKey(normalizedSubjectId, "count"), settings.count)
  window.localStorage.setItem(chatImageSettingsKey(normalizedSubjectId, "width"), settings.width)
  window.localStorage.setItem(chatImageSettingsKey(normalizedSubjectId, "height"), settings.height)
}
