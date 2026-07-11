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
  const messageEpochsRef = useRef(new Map<string, number>())
  const retryLocksRef = useRef(new Map<string, Map<string, number>>())
  const disposedRef = useRef(false)
  const [activeTaskIds, setActiveTaskIds] = useState<string[]>([])

  useEffect(() => {
    disposedRef.current = false
    return () => {
      disposedRef.current = true
    }
  }, [])

  const registerMessage = useCallback((message: ChatMessage, replace = false) => {
    const existing = messagesRef.current.get(message.id)
    const existingEpoch = messageEpochsRef.current.get(message.id)
    if (existing && existingEpoch !== undefined && !replace) {
      return { message: existing, epoch: existingEpoch }
    }
    const epoch = (existingEpoch || 0) + 1
    messagesRef.current.set(message.id, message)
    messageEpochsRef.current.set(message.id, epoch)
    pollersRef.current.delete(message.id)
    return { message, epoch }
  }, [])

  const isMessageActive = useCallback(
    (messageId: string, epoch: number) =>
      !disposedRef.current &&
      messageEpochsRef.current.get(messageId) === epoch &&
      messagesRef.current.has(messageId),
    [],
  )

  const emit = useCallback(async (message: ChatMessage, epoch: number) => {
    if (!isMessageActive(message.id, epoch)) {
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
  }, [isMessageActive])

  const pollMessage = useCallback(
    async (messageId: string, epoch: number, immediate = false) => {
      let consecutiveErrors = 0
      let firstRequest = true
      while (isMessageActive(messageId, epoch)) {
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
        if (!isMessageActive(messageId, epoch)) {
          return
        }
        try {
          const workspaceAuthKey = String(authKeyRef.current || "").trim()
          const taskList = workspaceAuthKey
            ? await dependenciesRef.current.fetchImageTasks(ids, workspaceAuthKey)
            : await dependenciesRef.current.fetchImageTasks(ids)
          if (!isMessageActive(messageId, epoch)) {
            return
          }
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
          await emit(next, epoch)
          if (!isMessageActive(messageId, epoch)) {
            return
          }
        } catch (error) {
          if (!isMessageActive(messageId, epoch)) {
            return
          }
          firstRequest = false
          consecutiveErrors += 1
          if (consecutiveErrors >= MAX_CONSECUTIVE_POLL_ERRORS) {
            const latest = messagesRef.current.get(messageId)
            if (latest) {
              await emit(setPendingImagesError(latest, errorMessage(error)), epoch)
            }
            return
          }
        }
      }
    },
    [emit, isMessageActive, pollIntervalMs],
  )

  const ensurePolling = useCallback(
    (messageId: string, epoch: number, immediate = false) => {
      if (!isMessageActive(messageId, epoch)) {
        return Promise.resolve()
      }
      const existing = pollersRef.current.get(messageId)
      if (existing) {
        return existing
      }
      const poller = pollMessage(messageId, epoch, immediate).finally(() => {
        if (pollersRef.current.get(messageId) === poller) {
          pollersRef.current.delete(messageId)
        }
      })
      pollersRef.current.set(messageId, poller)
      return poller
    },
    [isMessageActive, pollMessage],
  )

  const runPendingTasks = useCallback(
    async (
      messageId: string,
      prompt: string,
      settings: ChatImageSettingsSnapshot,
      references: readonly PreparedChatAttachment[],
      placeholderIds: readonly string[],
      epoch: number,
    ) => {
      if (!isMessageActive(messageId, epoch)) {
        return
      }
      try {
        const referenceFiles = settings.mode === "edit" ? taskFiles(references) : []
        const workspaceAuthKey = String(authKeyRef.current || "").trim()
        if (settings.mode === "edit" && referenceFiles.length === 0) {
          throw new Error("未找到可用于编辑的参考图")
        }
        const submitted = await Promise.allSettled(
          placeholderIds.map(async (placeholderId) => {
            if (!isMessageActive(messageId, epoch)) {
              return null
            }
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
            if (!isMessageActive(messageId, epoch)) {
              return null
            }
            return { placeholderId, task }
          }),
        )
        if (!isMessageActive(messageId, epoch)) {
          return
        }
        let next = messagesRef.current.get(messageId)
        if (!next) {
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
        await emit(next, epoch)
        if (!isMessageActive(messageId, epoch)) {
          return
        }
        await ensurePolling(messageId, epoch)
      } catch (error) {
        if (!isMessageActive(messageId, epoch)) {
          return
        }
        const current = messagesRef.current.get(messageId)
        if (current) {
          await emit(setPendingImagesError(current, errorMessage(error)), epoch)
        }
      }
    },
    [emit, ensurePolling, isMessageActive],
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
      const { epoch } = registerMessage(message, true)
      await emit(message, epoch)
      if (isMessageActive(messageId, epoch)) {
        void runPendingTasks(messageId, prompt, settings, references, taskIds, epoch)
      }
      return message
    },
    [emit, isMessageActive, registerMessage, runPendingTasks],
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
        const { message: registered, epoch } = registerMessage(current)
        pending.push(registered)
        void ensurePolling(registered.id, epoch, true)
      }
      return pending
    },
    [ensurePolling, registerMessage],
  )

  const discardImageMessages = useCallback((messageIds: readonly string[]) => {
    const taskIds = new Set<string>()
    for (const messageId of messageIds) {
      messageEpochsRef.current.set(messageId, (messageEpochsRef.current.get(messageId) || 0) + 1)
      retryLocksRef.current.delete(messageId)
      pollersRef.current.delete(messageId)
      const message = messagesRef.current.get(messageId)
      if (message) {
        for (const taskId of pendingTaskIds(message)) {
          taskIds.add(taskId)
        }
      }
      messagesRef.current.delete(messageId)
    }
    if (taskIds.size > 0) {
      setActiveTaskIds((previous) => previous.filter((taskId) => !taskIds.has(taskId)))
    }
  }, [])

  const resumeImageTask = useCallback(
    async (message: ChatMessage, taskId: string) => {
      const { message: registered, epoch } = registerMessage(message)
      const workspaceAuthKey = String(authKeyRef.current || "").trim()
      const task = workspaceAuthKey
        ? await dependenciesRef.current.resumeImagePoll(taskId, undefined, workspaceAuthKey)
        : await dependenciesRef.current.resumeImagePoll(taskId)
      if (!isMessageActive(registered.id, epoch)) {
        return messagesRef.current.get(registered.id) || registered
      }
      const current = messagesRef.current.get(registered.id)
      if (!current) {
        return registered
      }
      const resumed: ChatMessage = {
        ...current,
        images: (current.images || []).map((image) =>
          image.taskId === taskId ? { ...image, status: "running" as const, error: undefined } : image,
        ),
      }
      const next = await emit(applyImageTaskToChatMessage(resumed, task), epoch)
      if (!isMessageActive(next.id, epoch)) {
        return messagesRef.current.get(next.id) || next
      }
      if (pendingTaskIds(next).length > 0) {
        await ensurePolling(next.id, epoch)
      }
      return messagesRef.current.get(next.id) || next
    },
    [emit, ensurePolling, isMessageActive, registerMessage],
  )

  const retryImageTask = useCallback(
    async (message: ChatMessage, imageId: string, input: ChatImageRetryInput) => {
      const current = messagesRef.current.get(message.id) || message
      const image = current.images?.find((item) => item.id === imageId)
      if (!image) {
        throw new Error("未找到要重试的图片")
      }
      if (image.status === "queued" || image.status === "running") {
        return current
      }
      const prompt = input.prompt.trim()
      if (!prompt) {
        throw new Error("图片提示词不能为空")
      }
      const snapshot = current.imageSettings
      if (!snapshot) {
        throw new Error("缺少图片生成参数，无法重试")
      }
      const { message: registered, epoch } = registerMessage(current)
      const registeredImage = registered.images?.find((item) => item.id === imageId)
      if (registeredImage?.status === "queued" || registeredImage?.status === "running") {
        return registered
      }
      let locks = retryLocksRef.current.get(registered.id)
      if (locks?.get(imageId) === epoch) {
        return registered
      }
      if (!locks) {
        locks = new Map<string, number>()
        retryLocksRef.current.set(registered.id, locks)
      }
      locks.set(imageId, epoch)

      try {
        const savedReferenceIds = snapshot.referenceAttachmentIds || registered.attachmentIds
        const references = input.references?.length
          ? [...input.references]
          : savedReferenceIds.length > 0 && resolveAttachments
            ? [...(await resolveAttachments(savedReferenceIds))]
            : []
        if (!isMessageActive(registered.id, epoch)) {
          return messagesRef.current.get(registered.id) || registered
        }
        const live = messagesRef.current.get(registered.id)
        if (!live) {
          return registered
        }
        const liveImage = live.images?.find((item) => item.id === imageId)
        if (liveImage?.status === "queued" || liveImage?.status === "running") {
          return live
        }
        const liveSnapshot = live.imageSettings
        if (!liveSnapshot) {
          throw new Error("缺少图片生成参数，无法重试")
        }
        validateReferences(references)
        const mode: ChatImageSettingsSnapshot["mode"] = references.length > 0 ? "edit" : liveSnapshot.mode
        const settings = chatImageSettingsSnapshot(
          snapshotToSettings(liveSnapshot),
          mode,
          uniqueAttachmentIds(references),
        )
        const taskId = dependenciesRef.current.createId()
        const next: ChatMessage = {
          ...live,
          attachmentIds: uniqueAttachmentIds(references),
          imageSettings: settings,
          status: "queued",
          error: undefined,
          images: (live.images || []).map((item) =>
            item.id === imageId ? { ...pendingImage(taskId), id: item.id } : item,
          ),
        }
        await emit(next, epoch)
        if (!isMessageActive(next.id, epoch)) {
          return messagesRef.current.get(next.id) || next
        }
        void runPendingTasks(next.id, prompt, settings, references, [imageId], epoch)
        return next
      } finally {
        const currentLocks = retryLocksRef.current.get(registered.id)
        if (currentLocks?.get(imageId) === epoch) {
          currentLocks.delete(imageId)
          if (currentLocks.size === 0) {
            retryLocksRef.current.delete(registered.id)
          }
        }
      }
    },
    [emit, isMessageActive, registerMessage, resolveAttachments, runPendingTasks],
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
