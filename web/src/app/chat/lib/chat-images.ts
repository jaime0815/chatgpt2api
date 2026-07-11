import type { ImageSettings } from "@/app/image/components/image-settings"
import type { ImageTask } from "@/lib/api"

import type {
  ChatGeneratedImage,
  ChatImageSettingsSnapshot,
  ChatMessage,
  ChatMessageStatus,
} from "./chat-types"

function imageDimensions(size: string | undefined) {
  const match = String(size || "").match(/^(\d+)x(\d+)$/)
  if (!match) {
    return {}
  }
  return { width: Number(match[1]), height: Number(match[2]) }
}

function asImageTaskStatus(status: ImageTask["status"]): ChatGeneratedImage["status"] {
  return status
}

export function chatImageSettingsSnapshot(
  settings: ImageSettings,
  mode: ChatImageSettingsSnapshot["mode"] = "generate",
): ChatImageSettingsSnapshot {
  return {
    mode,
    model: settings.model,
    quality: settings.quality,
    width: settings.width,
    height: settings.height,
    ratio: settings.ratio,
    tier: settings.tier,
    count: Math.min(100, Math.max(1, Math.floor(Number(settings.count) || 1))),
  }
}

export function taskImageToChatImage(task: ImageTask): ChatGeneratedImage[] {
  if (task.status !== "success") {
    return []
  }
  const dimensions = imageDimensions(task.size)
  return (task.data || []).flatMap((item, index) =>
    item.url
      ? [
          {
            id: `${task.id}:${index}`,
            taskId: task.id,
            status: "success" as const,
            url: item.url,
            ...dimensions,
            ...(item.revised_prompt ? { revisedPrompt: item.revised_prompt } : {}),
          },
        ]
      : [],
  )
}

export function chatImageMessageStatus(images: readonly ChatGeneratedImage[]): ChatMessageStatus {
  if (images.some((image) => image.status === "queued")) {
    return "queued"
  }
  if (images.some((image) => image.status === "running")) {
    return "running"
  }
  if (images.some((image) => image.status === "error")) {
    return "error"
  }
  return "complete"
}

export function applyImageTaskToChatMessage(message: ChatMessage, task: ImageTask): ChatMessage {
  const images = message.images || []
  const matchingIndexes = images.flatMap((image, index) => (image.taskId === task.id ? [index] : []))
  if (matchingIndexes.length === 0) {
    return message
  }

  const successfulImages = taskImageToChatImage(task)
  const dimensions = imageDimensions(task.size)
  let successfulIndex = 0
  const nextImages = images.map((image) => {
    if (image.taskId !== task.id) {
      return image
    }
    if (task.status === "success") {
      const result = successfulImages[successfulIndex]
      successfulIndex += 1
      if (!result) {
        return {
          ...image,
          status: "error" as const,
          error: "图像任务未返回可持久化的图片 URL",
          ...dimensions,
        }
      }
      return {
        ...image,
        ...result,
        id: image.id,
        taskId: task.id,
        status: "success" as const,
        error: undefined,
      }
    }
    if (task.status === "error") {
      return {
        ...image,
        status: "error" as const,
        error: task.error || "图片生成失败",
        ...dimensions,
      }
    }
    return {
      ...image,
      status: asImageTaskStatus(task.status),
      error: undefined,
      ...dimensions,
    }
  })
  const status = chatImageMessageStatus(nextImages)
  return {
    ...message,
    images: nextImages,
    status,
    ...(status === "error" ? { error: nextImages.find((image) => image.error)?.error } : { error: undefined }),
  }
}

export async function chatImageUrlToFile(
  url: string,
  name: string,
  fetchImpl: typeof fetch = fetch,
): Promise<File> {
  const response = await fetchImpl(url)
  if (!response.ok) {
    throw new Error(`无法读取参考图（HTTP ${response.status}）`)
  }
  const blob = await response.blob()
  return new File([blob], name, { type: blob.type || "image/png" })
}
