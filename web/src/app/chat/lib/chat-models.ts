export const AUTO_CHAT_MODEL_ID = "auto"

const imageModelPatterns = [
  /image/i,
  /^(?:dall-e|dalle|imagen|cogview|flux|stable-diffusion|sdxl|recraft|midjourney|ideogram|seedream)(?:[-_.:/]|$)/i,
]

type ChatModelLike = string | { id?: unknown }

export type ChatModelSelectionResolution = {
  selected: string
  unavailable: string | null
}

function modelId(item: ChatModelLike) {
  return String(typeof item === "string" ? item : item.id || "").trim()
}

export function isImageModelId(id: string) {
  const normalized = String(id || "").trim()
  return imageModelPatterns.some((pattern) => pattern.test(normalized))
}

export function filterChatModels(models: readonly ChatModelLike[]) {
  const result = [AUTO_CHAT_MODEL_ID]
  const seen = new Set(result)

  for (const item of models) {
    const id = modelId(item)
    if (!id || isImageModelId(id) || seen.has(id)) {
      continue
    }
    seen.add(id)
    result.push(id)
  }

  return result
}

export function resolveChatModelSelection(
  storedModel: string | null | undefined,
  availableModels: readonly ChatModelLike[],
): ChatModelSelectionResolution {
  const selected = String(storedModel || "").trim()
  if (!selected) {
    return { selected: AUTO_CHAT_MODEL_ID, unavailable: null }
  }
  if (selected === AUTO_CHAT_MODEL_ID) {
    return { selected: AUTO_CHAT_MODEL_ID, unavailable: null }
  }
  if (isImageModelId(selected)) {
    return { selected: AUTO_CHAT_MODEL_ID, unavailable: selected }
  }

  const availableIds = new Set(availableModels.map(modelId).filter(Boolean))
  return availableIds.has(selected)
    ? { selected, unavailable: null }
    : { selected: AUTO_CHAT_MODEL_ID, unavailable: selected }
}
