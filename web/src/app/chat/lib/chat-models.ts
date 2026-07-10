export const AUTO_CHAT_MODEL_ID = "auto"

type ChatModelLike = string | { id?: unknown }

function modelId(item: ChatModelLike) {
  return String(typeof item === "string" ? item : item.id || "").trim()
}

export function isImageModelId(id: string) {
  return String(id || "").trim().toLowerCase().includes("image")
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
) {
  const selected = String(storedModel || "").trim()
  if (!selected || isImageModelId(selected)) {
    return AUTO_CHAT_MODEL_ID
  }

  const availableIds = new Set(availableModels.map(modelId).filter(Boolean))
  return availableIds.has(selected) ? selected : AUTO_CHAT_MODEL_ID
}
