"use client"

import { useCallback, useEffect, useRef, useState } from "react"

import {
  normalizeImageSettings,
  type ImageSettings,
} from "@/app/image/components/image-settings"
import {
  createImageEditTask,
  createImageGenerationTask,
  fetchImageTasks,
  resumeImagePoll,
  type ImageTask,
} from "@/lib/api"

import {
  applyImageTaskToChatMessage,
  chatImageMessageStatus,
  chatImageSettingsSnapshot,
} from "@/app/chat/lib/chat-images"
import type {
  ChatGeneratedImage,
  ChatImageSettingsSnapshot,
  ChatMessage,
  PreparedChatAttachment,
} from "@/app/chat/lib/chat-types"

const DEFAULT_POLL_INTERVAL_MS = 2_000
const MAX_REFERENCE_IMAGES = 10
const MAX_CONSECUTIVE_POLL_ERRORS = 5

export type ChatImageTaskDependencies = {
  createImageGenerationTask: typeof createImageGenerationTask
  createImageEditTask: typeof createImageEditTask
  fetchImageTasks: typeof fetchImageTasks
  resumeImagePoll: typeof resumeImagePoll
  wait: (milliseconds: number) => Promise<void>
  createId: () => string
  now: () => Date
}

const DEFAULT_DEPENDENCIES: ChatImageTaskDependencies = {
  createImageGenerationTask,
  createImageEditTask,
  fetchImageTasks,
  resumeImagePoll,
  wait: (milliseconds) =>
    new Promise((resolve) => {
      globalThis.setTimeout(resolve, milliseconds)
    }),
  createId: () =>
    globalThis.crypto?.randomUUID?.() ||
    `image-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
  now: () => new Date(),
}

export type ChatImageTaskInput = {
  prompt: string
  settings: ImageSettings
  references?: readonly PreparedChatAttachment[]
  messageId?: string
}

export type ChatImageRetryInput = Pick<ChatImageTaskInput, "prompt" | "references">

export type UseChatImageTasksOptions = {
  onMessageChange: (message: ChatMessage) => void | Promise<void>
  authKey?: string
  dependencies?: Partial<ChatImageTaskDependencies>
  pollIntervalMs?: number
  resolveAttachments?: (
    attachmentIds: readonly string[],
  ) => Promise<readonly PreparedChatAttachment[]>
}

function imageSize(snapshot: ChatImageSettingsSnapshot) {
  return `${snapshot.width}x${snapshot.height}`
}

function taskFiles(references: readonly PreparedChatAttachment[]) {
  return references.map(
    (reference) =>
      new File([reference.blob], reference.name, {
        type: reference.mimeType || reference.blob.type || "image/png",
      }),
  )
}

function errorMessage(error: unknown) {
  return error instanceof Error && error.message.trim() ? error.message : "图片生成失败"
}

function validateReferences(references: readonly PreparedChatAttachment[]) {
  if (references.some((reference) => reference.kind !== "image")) {
    throw new Error("生成图片时不能使用文档附件")
  }
  if (references.length > MAX_REFERENCE_IMAGES) {
    throw new Error(`一次最多使用 ${MAX_REFERENCE_IMAGES} 张参考图`)
  }
}

function uniqueAttachmentIds(references: readonly PreparedChatAttachment[]) {
  return [...new Set(references.map((reference) => reference.id).filter(Boolean))]
}

function pendingImage(taskId: string): ChatGeneratedImage {
  return { id: taskId, taskId, status: "queued" }
}

function pendingTaskIds(message: ChatMessage) {
  return (message.images || []).flatMap((image) =>
    (image.status === "queued" || image.status === "running") && image.taskId
      ? [image.taskId]
      : [],
  )
}

function replaceMessageImageTaskId(message: ChatMessage, placeholderId: string, task: ImageTask) {
  return {
    ...message,
    images: (message.images || []).map((image) =>
      image.id === placeholderId ? { ...image, taskId: task.id } : image,
    ),
  }
}

function setPendingImagesError(message: ChatMessage, error: string): ChatMessage {
  const images = (message.images || []).map((image) =>
    image.status === "queued" || image.status === "running"
      ? { ...image, status: "error" as const, error }
      : image,
  )
  return {
    ...message,
    images,
    status: "error",
    error,
  }
}

function setMissingTaskErrors(message: ChatMessage, missingIds: readonly string[]): ChatMessage {
  const missing = new Set(missingIds)
  const images = (message.images || []).map((image) =>
    image.taskId && missing.has(image.taskId)
      ? { ...image, status: "error" as const, error: "图片任务不存在或已过期" }
      : image,
  )
  const status = chatImageMessageStatus(images)
  return {
    ...message,
    images,
    status,
    ...(status === "error" ? { error: "图片任务不存在或已过期" } : { error: undefined }),
  }
}

function snapshotToSettings(snapshot: ChatImageSettingsSnapshot): ImageSettings {
  return {
    model: snapshot.model,
    quality: snapshot.quality,
    width: snapshot.width,
    height: snapshot.height,
    ratio: snapshot.ratio,
    tier: snapshot.tier,
    count: String(snapshot.count),
  }
}

export function useChatImageTasks({
  onMessageChange,
  authKey,
  dependencies,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  resolveAttachments,
}: UseChatImageTasksOptions) {
  const dependenciesRef = useRef<ChatImageTaskDependencies>({
    ...DEFAULT_DEPENDENCIES,
    ...dependencies,
  })
  dependenciesRef.current = { ...DEFAULT_DEPENDENCIES, ...dependencies }
  const onMessageChangeRef = useRef(onMessageChange)
  onMessageChangeRef.current = onMessageChange
  const authKeyRef = useRef(authKey)
  authKeyRef.current = authKey
  const messagesRef = useRef(new Map<string, ChatMessage>())
  const pollersRef = useRef(new Map<string, Promise<void>>())
  const disposedRef = useRef(false)
  const [activeTaskIds, setActiveTaskIds] = useState<string[]>([])

  useEffect(() => {
    disposedRef.current = false
    return () => {
      disposedRef.current = true
    }
  }, [])

  const emit = useCallback(async (message: ChatMessage) => {
    if (disposedRef.current) {
      return message
    }
    messagesRef.current.set(message.id, message)
    const currentTaskIds = new Set(pendingTaskIds(message))
    setActiveTaskIds((previous) => {
      const next = new Set(previous)
      for (const image of message.images || []) {
        if (image.taskId) {
          next.delete(image.taskId)
        }
      }
      for (const taskId of currentTaskIds) {
        next.add(taskId)
      }
      return [...next]
    })
    await onMessageChangeRef.current(message)
    return message
  }, [])

  const pollMessage = useCallback(
    async (messageId: string, immediate = false) => {
      let consecutiveErrors = 0
      let firstRequest = true
      while (!disposedRef.current) {
        const current = messagesRef.current.get(messageId)
        if (!current) {
          return
        }
        const ids = [...new Set(pendingTaskIds(current))]
        if (ids.length === 0) {
          return
        }
        if (pollIntervalMs > 0 && (!immediate || !firstRequest)) {
          await dependenciesRef.current.wait(pollIntervalMs)
        }
        if (disposedRef.current || !messagesRef.current.has(messageId)) {
          return
        }
        try {
          const workspaceAuthKey = String(authKeyRef.current || "").trim()
          const taskList = workspaceAuthKey
            ? await dependenciesRef.current.fetchImageTasks(ids, workspaceAuthKey)
            : await dependenciesRef.current.fetchImageTasks(ids)
          firstRequest = false
          consecutiveErrors = 0
          const latest = messagesRef.current.get(messageId)
          if (!latest) {
            return
          }
          let next = latest
          for (const task of taskList.items) {
            next = applyImageTaskToChatMessage(next, task)
          }
          if (taskList.missing_ids.length > 0) {
            next = setMissingTaskErrors(next, taskList.missing_ids)
          }
          await emit(next)
        } catch (error) {
          firstRequest = false
          consecutiveErrors += 1
          if (consecutiveErrors >= MAX_CONSECUTIVE_POLL_ERRORS) {
            const latest = messagesRef.current.get(messageId)
            if (latest) {
              await emit(setPendingImagesError(latest, errorMessage(error)))
            }
            return
          }
        }
      }
    },
    [emit, pollIntervalMs],
  )

  const ensurePolling = useCallback(
    (messageId: string, immediate = false) => {
      const existing = pollersRef.current.get(messageId)
      if (existing) {
        return existing
      }
      const poller = pollMessage(messageId, immediate).finally(() => {
        if (pollersRef.current.get(messageId) === poller) {
          pollersRef.current.delete(messageId)
        }
      })
      pollersRef.current.set(messageId, poller)
      return poller
    },
    [pollMessage],
  )

  const runPendingTasks = useCallback(
    async (
      messageId: string,
      prompt: string,
      settings: ChatImageSettingsSnapshot,
      references: readonly PreparedChatAttachment[],
      placeholderIds: readonly string[],
    ) => {
      try {
        const referenceFiles = settings.mode === "edit" ? taskFiles(references) : []
        const workspaceAuthKey = String(authKeyRef.current || "").trim()
        if (settings.mode === "edit" && referenceFiles.length === 0) {
          throw new Error("未找到可用于编辑的参考图")
        }
        const submitted = await Promise.allSettled(
          placeholderIds.map(async (placeholderId) => {
            const taskId = messagesRef.current
              .get(messageId)
              ?.images?.find((image) => image.id === placeholderId)?.taskId
            if (!taskId) {
              return null
            }
            const task =
              settings.mode === "edit"
                ? workspaceAuthKey
                  ? await dependenciesRef.current.createImageEditTask(
                      taskId,
                      referenceFiles,
                      prompt,
                      settings.model,
                      imageSize(settings),
                      settings.quality,
                      workspaceAuthKey,
                    )
                  : await dependenciesRef.current.createImageEditTask(
                      taskId,
                      referenceFiles,
                      prompt,
                      settings.model,
                      imageSize(settings),
                      settings.quality,
                    )
                : workspaceAuthKey
                  ? await dependenciesRef.current.createImageGenerationTask(
                      taskId,
                      prompt,
                      settings.model,
                      imageSize(settings),
                      settings.quality,
                      workspaceAuthKey,
                    )
                  : await dependenciesRef.current.createImageGenerationTask(
                      taskId,
                      prompt,
                      settings.model,
                      imageSize(settings),
                      settings.quality,
                    )
            return { placeholderId, task }
          }),
        )
        let next = messagesRef.current.get(messageId)
        if (!next || disposedRef.current) {
          return
        }
        for (let index = 0; index < submitted.length; index += 1) {
          const result = submitted[index]
          const placeholderId = placeholderIds[index]
          if (!placeholderId || !result) {
            continue
          }
          if (result.status === "rejected" || !result.value) {
            // Leave the client task ID pending so polling can discover a request that reached the server.
            continue
          }
          const linked = replaceMessageImageTaskId(next, result.value.placeholderId, result.value.task)
          next = applyImageTaskToChatMessage(linked, result.value.task)
        }
        await emit(next)
        await ensurePolling(messageId)
      } catch (error) {
        const current = messagesRef.current.get(messageId)
        if (current && !disposedRef.current) {
          await emit(setPendingImagesError(current, errorMessage(error)))
        }
      }
    },
    [emit, ensurePolling],
  )

  const submit = useCallback(
    async (input: ChatImageTaskInput) => {
      const prompt = input.prompt.trim()
      if (!prompt) {
        throw new Error("图片提示词不能为空")
      }
      const references = [...(input.references || [])]
      validateReferences(references)
      const mode: ChatImageSettingsSnapshot["mode"] = references.length > 0 ? "edit" : "generate"
      const referenceAttachmentIds = uniqueAttachmentIds(references)
      const settings = chatImageSettingsSnapshot(
        normalizeImageSettings(input.settings),
        mode,
        referenceAttachmentIds,
      )
      const messageId = input.messageId || dependenciesRef.current.createId()
      const taskIds = Array.from({ length: settings.count }, () => dependenciesRef.current.createId())
      const message: ChatMessage = {
        id: messageId,
        role: "assistant",
        text: prompt,
        attachmentIds: referenceAttachmentIds,
        status: "queued",
        createdAt: dependenciesRef.current.now().toISOString(),
        imageSettings: settings,
        images: taskIds.map(pendingImage),
      }
      await emit(message)
      void runPendingTasks(messageId, prompt, settings, references, taskIds)
      return message
    },
    [emit, runPendingTasks],
  )

  const recoverImageMessages = useCallback(
    async (messages: readonly ChatMessage[]) => {
      const pending: ChatMessage[] = []
      for (const storedMessage of messages) {
        // A live message may be persisted before its task creation request finishes.
        // Its submit path owns polling, so a recovery snapshot must not race it.
        if (messagesRef.current.has(storedMessage.id)) {
          continue
        }
        const current = storedMessage
        if (pendingTaskIds(current).length === 0) {
          continue
        }
        messagesRef.current.set(current.id, current)
        pending.push(current)
        void ensurePolling(current.id, true)
      }
      return pending
    },
    [ensurePolling],
  )

  const discardImageMessages = useCallback((messageIds: readonly string[]) => {
    const taskIds = new Set<string>()
    for (const messageId of messageIds) {
      const message = messagesRef.current.get(messageId)
      if (!message) {
        continue
      }
      for (const taskId of pendingTaskIds(message)) {
        taskIds.add(taskId)
      }
      messagesRef.current.delete(messageId)
    }
    if (taskIds.size > 0) {
      setActiveTaskIds((previous) => previous.filter((taskId) => !taskIds.has(taskId)))
    }
  }, [])

  const resumeImageTask = useCallback(
    async (message: ChatMessage, taskId: string) => {
      messagesRef.current.set(message.id, message)
      const workspaceAuthKey = String(authKeyRef.current || "").trim()
      const task = workspaceAuthKey
        ? await dependenciesRef.current.resumeImagePoll(taskId, undefined, workspaceAuthKey)
        : await dependenciesRef.current.resumeImagePoll(taskId)
      const resumed: ChatMessage = {
        ...message,
        images: (message.images || []).map((image) =>
          image.taskId === taskId ? { ...image, status: "running" as const, error: undefined } : image,
        ),
      }
      const next = await emit(applyImageTaskToChatMessage(resumed, task))
      if (pendingTaskIds(next).length > 0) {
        await ensurePolling(next.id)
      }
      return messagesRef.current.get(next.id) || next
    },
    [emit, ensurePolling],
  )

  const retryImageTask = useCallback(
    async (message: ChatMessage, imageId: string, input: ChatImageRetryInput) => {
      const image = message.images?.find((item) => item.id === imageId)
      if (!image) {
        throw new Error("未找到要重试的图片")
      }
      const prompt = input.prompt.trim()
      if (!prompt) {
        throw new Error("图片提示词不能为空")
      }
      const snapshot = message.imageSettings
      if (!snapshot) {
        throw new Error("缺少图片生成参数，无法重试")
      }
      const savedReferenceIds = snapshot.referenceAttachmentIds || message.attachmentIds
      const references = input.references?.length
        ? [...input.references]
        : savedReferenceIds.length > 0 && resolveAttachments
          ? [...(await resolveAttachments(savedReferenceIds))]
          : []
      validateReferences(references)
      const mode: ChatImageSettingsSnapshot["mode"] = references.length > 0 ? "edit" : snapshot.mode
      const settings = chatImageSettingsSnapshot(
        snapshotToSettings(snapshot),
        mode,
        uniqueAttachmentIds(references),
      )
      const taskId = dependenciesRef.current.createId()
      const next: ChatMessage = {
        ...message,
        attachmentIds: uniqueAttachmentIds(references),
        imageSettings: settings,
        status: "queued",
        error: undefined,
        images: (message.images || []).map((item) =>
          item.id === imageId ? { ...pendingImage(taskId), id: item.id } : item,
        ),
      }
      await emit(next)
      void runPendingTasks(next.id, prompt, settings, references, [imageId])
      return next
    },
    [emit, resolveAttachments, runPendingTasks],
  )

  return {
    activeTaskIds,
    isGenerating: activeTaskIds.length > 0,
    submit,
    recoverImageMessages,
    discardImageMessages,
    resumeImageTask,
    retryImageTask,
  }
}
