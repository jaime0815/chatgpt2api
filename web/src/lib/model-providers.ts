import type { Model } from "@/lib/api"

const providerDefinitions = [
  { id: "openai", label: "OpenAI" },
  { id: "anthropic", label: "Anthropic" },
  { id: "google", label: "Google" },
  { id: "xai", label: "xAI" },
  { id: "meta", label: "Meta" },
  { id: "mistral", label: "Mistral" },
  { id: "deepseek", label: "DeepSeek" },
  { id: "alibaba", label: "Alibaba" },
  { id: "moonshot", label: "Moonshot" },
  { id: "zhipu", label: "Zhipu" },
  { id: "baidu", label: "Baidu" },
  { id: "bytedance", label: "ByteDance" },
  { id: "other", label: "其他" },
] as const

export type ModelProviderId = (typeof providerDefinitions)[number]["id"]

export type ModelProviderGroup = {
  id: ModelProviderId
  label: string
  models: Model[]
}

export type ModelIdProviderGroup = {
  id: ModelProviderId
  label: string
  modelIds: string[]
}

const namespaceProviders: Record<string, ModelProviderId> = {
  openai: "openai",
  anthropic: "anthropic",
  google: "google",
  xai: "xai",
  meta: "meta",
  "meta-llama": "meta",
  mistral: "mistral",
  deepseek: "deepseek",
  alibaba: "alibaba",
  qwen: "alibaba",
  moonshot: "moonshot",
  zhipu: "zhipu",
  baidu: "baidu",
  bytedance: "bytedance",
}

const familyPatterns: readonly [Exclude<ModelProviderId, "other">, RegExp][] = [
  ["openai", /^(?:auto|research|gpt(?:[-_.\d]|$)|chatgpt(?:[-_.\d]|$)|o(?:1|3|4)(?:[-_.]|$)|codex(?:[-_.]|$)|dall-e(?:[-_.]|$)|sora(?:[-_.]|$)|whisper(?:[-_.]|$)|tts(?:[-_.]|$))/],
  ["anthropic", /^claude(?:[-_.\d]|$)/],
  ["google", /^(?:gemini|gemma|imagen|veo)(?:[-_.\d]|$)/],
  ["xai", /^grok(?:[-_.\d]|$)/],
  ["meta", /^(?:llama|meta-llama)(?:[-_./\d]|$)/],
  ["mistral", /^(?:mistral|mixtral|codestral|ministral|pixtral)(?:[-_.\d]|$)/],
  ["deepseek", /^deepseek(?:[-_.\d]|$)/],
  ["alibaba", /^(?:qwen|qwq|wan|tongyi)(?:[-_.\d]|$)/],
  ["moonshot", /^(?:kimi|moonshot)(?:[-_.\d]|$)/],
  ["zhipu", /^(?:glm|chatglm|cogview)(?:[-_.\d]|$)/],
  ["baidu", /^ernie(?:[-_.\d]|$)/],
  ["bytedance", /^(?:doubao|seed)(?:[-_.\d]|$)/],
]

function normalizeModelId(modelId: string) {
  return String(modelId || "")
    .trim()
    .toLowerCase()
    .replace(/^models\//, "")
    .replace(/^(?:plus|team|pro)-(?=codex-gpt-image)/, "")
}

function newProviderBuckets<T>() {
  const buckets = new Map<ModelProviderId, T[]>()
  for (const provider of providerDefinitions) {
    buckets.set(provider.id, [])
  }
  return buckets
}

export function classifyModelProvider(modelId: string): ModelProviderId {
  const normalized = normalizeModelId(modelId)
  const namespace = normalized.match(/^([a-z0-9-]+)[/:]/)?.[1]
  if (namespace && namespace in namespaceProviders) {
    return namespaceProviders[namespace]!
  }

  for (const [provider, pattern] of familyPatterns) {
    if (pattern.test(normalized)) {
      return provider
    }
  }
  return "other"
}

export function groupModelsByProvider(models: readonly Model[]): ModelProviderGroup[] {
  const modelsByProvider = newProviderBuckets<Model>()
  for (const model of models) {
    modelsByProvider.get(classifyModelProvider(model.id))?.push(model)
  }

  return providerDefinitions.flatMap((provider) => {
    const providerModels = modelsByProvider.get(provider.id) || []
    return providerModels.length > 0
      ? [{ id: provider.id, label: provider.label, models: providerModels }]
      : []
  })
}

export function groupModelIdsByProvider(modelIds: readonly string[]): ModelIdProviderGroup[] {
  const idsByProvider = newProviderBuckets<string>()
  for (const modelId of modelIds) {
    idsByProvider.get(classifyModelProvider(modelId))?.push(modelId)
  }

  return providerDefinitions.flatMap((provider) => {
    const providerModelIds = idsByProvider.get(provider.id) || []
    return providerModelIds.length > 0
      ? [{ id: provider.id, label: provider.label, modelIds: providerModelIds }]
      : []
  })
}
