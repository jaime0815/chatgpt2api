"use client"

import { LoaderCircle } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { ChatComposer, type ChatComposerAttachment, type ChatComposerMode } from "./components/chat-composer"
import { ChatHeader } from "./components/chat-header"
import { ChatShell } from "./components/chat-shell"
import { ChatSidebar } from "./components/chat-sidebar"
import { ChatThread } from "./components/chat-thread"
import {
  prepareChatAttachments,
  validateChatAttachments,
} from "./lib/chat-attachments"
import { chatImageUrlToFile } from "./lib/chat-images"
import { loadChatImageSettings, saveChatImageSettings } from "./lib/chat-image-settings"
import { filterChatModels, resolveChatModelSelection } from "./lib/chat-models"
import type { ChatGeneratedImage, ChatMessage, PreparedChatAttachment } from "./lib/chat-types"
import { useChatController } from "./hooks/use-chat-controller"
import { useChatImageTasks } from "./hooks/use-chat-image-tasks"
import { ImageLightbox } from "@/components/image-lightbox"
import { normalizeImageSettings, type ImageSettings } from "@/app/image/components/image-settings"
import { fetchModels } from "@/lib/api"
import { useAuthGuard } from "@/lib/use-auth-guard"
import { clearStoredAuthSession, type StoredAuthSession } from "@/store/auth"
import { getChatAttachments } from "@/store/chat-conversations"

const TEXT_ATTACHMENT_UNAVAILABLE = "当前版本暂不支持带附件的普通聊天，请移除附件后发送。"

type PreviewAttachment = ChatComposerAttachment

type LightboxImage = {
  id: string
  src: string
  dimensions?: string
}

function mergeAttachments(
  current: readonly PreviewAttachment[],
  incoming: readonly PreparedChatAttachment[],
  mode: ChatComposerMode,
) {
  const existing = new Map(current.map((attachment) => [attachment.id, attachment]))
  const validated = validateChatAttachments([...current, ...incoming], { mode })
  return validated.map((attachment) => existing.get(attachment.id) || withPreview(attachment))
}

function withPreview(attachment: PreparedChatAttachment): PreviewAttachment {
  const previewUrl =
    attachment.kind === "image" && typeof URL.createObjectURL === "function"
      ? URL.createObjectURL(attachment.blob)
      : undefined
  return { ...attachment, previewUrl }
}

function revokePreview(attachment: PreviewAttachment) {
  if (attachment.previewUrl && typeof URL.revokeObjectURL === "function") {
    URL.revokeObjectURL(attachment.previewUrl)
  }
}

function createChatImageMessageId() {
  return (
    globalThis.crypto?.randomUUID?.() ||
    `chat-image-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  )
}

function imageSettingsPresentation() {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(min-width: 640px)").matches
      ? "popover"
      : "sheet"
    : "sheet"
}

function subscribeImageSettingsPresentation(onStoreChange: () => void) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => undefined
  }
  const mediaQuery = window.matchMedia("(min-width: 640px)")
  mediaQuery.addEventListener("change", onStoreChange)
  return () => mediaQuery.removeEventListener("change", onStoreChange)
}

function useImageSettingsPresentation() {
  return useSyncExternalStore(
    subscribeImageSettingsPresentation,
    imageSettingsPresentation,
    () => "sheet" as const,
  )
}

function documentTheme() {
  return typeof document !== "undefined" && document.documentElement.classList.contains("dark")
    ? "dark"
    : "light"
}

function subscribeTheme(onStoreChange: () => void) {
  if (typeof window === "undefined" || typeof MutationObserver === "undefined") {
    return () => undefined
  }
  const observer = new MutationObserver(onStoreChange)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
  window.addEventListener("storage", onStoreChange)
  return () => {
    observer.disconnect()
    window.removeEventListener("storage", onStoreChange)
  }
}

function useDocumentTheme() {
  return useSyncExternalStore(subscribeTheme, documentTheme, () => "light" as const)
}

function ChatWorkspace({ session }: { session: StoredAuthSession }) {
  const router = useRouter()
  const controller = useChatController({ subjectId: session.subjectId, authKey: session.key })
  const imageSettingsPresentation = useImageSettingsPresentation()
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const theme = useDocumentTheme()
  const [input, setInput] = useState("")
  const [mode, setMode] = useState<ChatComposerMode>("chat")
  const [draftAttachments, setDraftAttachments] = useState<PreviewAttachment[]>([])
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  const [savedAttachments, setSavedAttachments] = useState<PreviewAttachment[]>([])
  const [imageSettings, setImageSettings] = useState<ImageSettings>(() =>
    loadChatImageSettings(session.subjectId),
  )
  const [chatModels, setChatModels] = useState<string[]>(["auto"])
  const [imageModels, setImageModels] = useState<string[]>(["gpt-image-2"])
  const [modelsLoaded, setModelsLoaded] = useState(false)
  const [isImageSubmitPending, setIsImageSubmitPending] = useState(false)
  const [lightboxImages, setLightboxImages] = useState<LightboxImage[]>([])
  const [lightboxIndex, setLightboxIndex] = useState(0)
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const draftAttachmentsRef = useRef<PreviewAttachment[]>([])
  const imageAttachmentCacheRef = useRef(new Map<string, PreparedChatAttachment>())
  const imageMessageOwnersRef = useRef(new Map<string, string>())
  const imageMessageAttachmentIdsRef = useRef(new Map<string, readonly string[]>())
  const discardedImageMessageIdsRef = useRef(new Set<string>())
  const imageSubmitInFlightRef = useRef(false)

  const activeConversation = controller.activeConversation
  const activeAttachmentKey = useMemo(
    () =>
      [...new Set(activeConversation?.messages.flatMap((message) => message.attachmentIds) || [])].join(":"),
    [activeConversation?.messages],
  )
  const activeAttachmentIds = useMemo(
    () => (activeAttachmentKey ? activeAttachmentKey.split(":") : []),
    [activeAttachmentKey],
  )
  const recoveryMessageOwners = useMemo(
    () =>
      controller.state.conversations.flatMap((conversation) =>
        conversation.messages.map((message) => ({ conversationId: conversation.id, message })),
      ),
    [controller.state.conversations],
  )
  const recoveryMessages = useMemo(
    () => recoveryMessageOwners.map(({ message }) => message),
    [recoveryMessageOwners],
  )
  const recoveryKey = useMemo(
    () =>
      recoveryMessages
        .flatMap((message) =>
          (message.images || []).map(
            (image) => `${message.id}:${image.id}:${image.taskId || ""}:${image.status}`,
          ),
        )
        .join("|"),
    [recoveryMessages],
  )
  const modelResolution = useMemo(
    () =>
      modelsLoaded
        ? resolveChatModelSelection(controller.state.selectedModel, chatModels)
        : {
            selected: String(controller.state.selectedModel || "auto").trim() || "auto",
            unavailable: null,
          },
    [chatModels, controller.state.selectedModel, modelsLoaded],
  )
  const displayedChatModels = useMemo(
    () =>
      modelsLoaded || modelResolution.selected === "auto"
        ? chatModels
        : ["auto", modelResolution.selected],
    [chatModels, modelResolution.selected, modelsLoaded],
  )

  const persistImageMessage = useCallback(
    async (message: ChatMessage) => {
      const conversationId = imageMessageOwnersRef.current.get(message.id)
      if (discardedImageMessageIdsRef.current.has(message.id) || !conversationId) {
        return
      }
      const attachments = message.attachmentIds.flatMap((id) => {
        const attachment = imageAttachmentCacheRef.current.get(id)
        return attachment ? [attachment] : []
      })
      await controller.upsertMessage(message, attachments, { conversationId })
      if (discardedImageMessageIdsRef.current.has(message.id)) {
        return
      }
      for (const attachment of attachments) {
        imageAttachmentCacheRef.current.delete(attachment.id)
      }
      imageMessageAttachmentIdsRef.current.delete(message.id)
    },
    [controller],
  )

  const resolveImageAttachments = useCallback(
    (attachmentIds: readonly string[]) => controller.resolveAttachments(attachmentIds),
    [controller],
  )

  const {
    activeTaskIds,
    submit: submitImageTask,
    recoverImageMessages,
    discardImageMessages,
    resumeImageTask,
    retryImageTask,
  } = useChatImageTasks({
    onMessageChange: persistImageMessage,
    authKey: session.key,
    resolveAttachments: resolveImageAttachments,
  })

  const discardTrackedImageMessages = useCallback(
    (
      messages: readonly ChatMessage[],
      extraMessageIds: readonly string[] = [],
      clearAllCachedAttachments = false,
    ) => {
      const imageMessages = messages.filter((message) => (message.images || []).length > 0)
      const imageMessageIds = new Set([
        ...imageMessages.map((message) => message.id),
        ...extraMessageIds,
      ])
      if (imageMessageIds.size === 0) {
        return
      }

      const removedImageMessageIds = [...imageMessageIds]
      const removedAttachmentIds = new Set([
        ...imageMessages.flatMap((message) => message.attachmentIds),
        ...removedImageMessageIds.flatMap(
          (messageId) => imageMessageAttachmentIdsRef.current.get(messageId) || [],
        ),
      ])
      removedImageMessageIds.forEach((messageId) => discardedImageMessageIdsRef.current.add(messageId))
      discardImageMessages(removedImageMessageIds)
      removedImageMessageIds.forEach((messageId) => {
        imageMessageOwnersRef.current.delete(messageId)
        imageMessageAttachmentIdsRef.current.delete(messageId)
      })

      if (clearAllCachedAttachments) {
        imageAttachmentCacheRef.current.clear()
        imageMessageAttachmentIdsRef.current.clear()
        return
      }

      const retainedAttachmentIds = new Set([
        ...draftAttachmentsRef.current.map((attachment) => attachment.id),
        ...controller.state.conversations.flatMap((conversation) =>
          conversation.messages
            .filter((message) => !imageMessageIds.has(message.id))
            .flatMap((message) => message.attachmentIds),
        ),
      ])
      for (const attachmentId of removedAttachmentIds) {
        if (!retainedAttachmentIds.has(attachmentId)) {
          imageAttachmentCacheRef.current.delete(attachmentId)
        }
      }
    },
    [controller.state.conversations, discardImageMessages],
  )

  const ownerMessageIdsForConversation = useCallback(
    (conversationId: string, currentMessageIds: ReadonlySet<string> = new Set()) =>
      [...imageMessageOwnersRef.current.entries()].flatMap(([messageId, ownerConversationId]) =>
        ownerConversationId === conversationId && !currentMessageIds.has(messageId) ? [messageId] : [],
      ),
    [],
  )

  useEffect(() => {
    const retainedAttachmentIds = new Set([
      ...draftAttachmentsRef.current.map((attachment) => attachment.id),
      ...controller.state.conversations.flatMap((conversation) =>
        conversation.messages.flatMap((message) => message.attachmentIds),
      ),
    ])
    for (const attachmentId of imageAttachmentCacheRef.current.keys()) {
      if (!retainedAttachmentIds.has(attachmentId)) {
        imageAttachmentCacheRef.current.delete(attachmentId)
      }
    }
  }, [controller.state.conversations, draftAttachments])

  useEffect(() => {
    saveChatImageSettings(session.subjectId, imageSettings)
  }, [imageSettings, session.subjectId])

  useEffect(() => {
    let cancelled = false
    void fetchModels().then(
      (response) => {
        if (cancelled) {
          return
        }
        const models = Array.isArray(response.data) ? response.data : []
        setChatModels(filterChatModels(models))
        const imageModelIds = [
          ...new Set(
            models
              .map((model) => String(model.id || "").trim())
              .filter((model) => model.toLowerCase().includes("image")),
          ),
        ]
        setImageModels(imageModelIds.length > 0 ? imageModelIds : ["gpt-image-2"])
        setImageSettings((current) =>
          imageModelIds.includes(current.model)
            ? current
            : normalizeImageSettings({ ...current, model: imageModelIds[0] || "gpt-image-2" }),
        )
        setModelsLoaded(true)
      },
      () => {
        if (cancelled) {
          return
        }
      },
    )
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!modelsLoaded || controller.state.isLoading) {
      return
    }
    if (modelResolution.selected !== controller.state.selectedModel) {
      void controller.setSelectedModel(modelResolution.selected)
    }
  }, [controller, controller.state.isLoading, controller.state.selectedModel, modelResolution.selected, modelsLoaded])

  useEffect(() => {
    if (controller.state.isLoading) {
      return
    }
    for (const { conversationId, message } of recoveryMessageOwners) {
      if ((message.images || []).length > 0) {
        imageMessageOwnersRef.current.set(message.id, conversationId)
        imageMessageAttachmentIdsRef.current.set(message.id, message.attachmentIds)
      }
    }
    if (recoveryKey.length === 0) {
      return
    }
    void recoverImageMessages(recoveryMessages)
  }, [controller.state.isLoading, recoverImageMessages, recoveryKey, recoveryMessageOwners, recoveryMessages])

  useEffect(() => {
    let cancelled = false
    let previewAttachments: PreviewAttachment[] = []
    if (activeAttachmentIds.length === 0) {
      return undefined
    }
    void getChatAttachments(session.subjectId, activeAttachmentIds).then(
      (attachments) => {
        if (cancelled) {
          return
        }
        previewAttachments = attachments.map(withPreview)
        setSavedAttachments(previewAttachments)
      },
      () => {
        if (!cancelled) {
          setSavedAttachments([])
        }
      },
    )
    return () => {
      cancelled = true
      previewAttachments.forEach(revokePreview)
    }
  }, [activeAttachmentIds, activeAttachmentKey, session.subjectId])

  useEffect(
    () => () => {
      draftAttachmentsRef.current.forEach(revokePreview)
      draftAttachmentsRef.current = []
      imageAttachmentCacheRef.current.clear()
      imageMessageOwnersRef.current.clear()
      imageMessageAttachmentIdsRef.current.clear()
    },
    [],
  )

  const updateDraftAttachments = useCallback((next: PreviewAttachment[]) => {
    draftAttachmentsRef.current = next
    setDraftAttachments(next)
  }, [])

  const addFiles = useCallback(
    async (files: File[], targetMode: ChatComposerMode = mode) => {
      try {
        const prepared = await prepareChatAttachments(files, { mode: targetMode })
        const current = draftAttachmentsRef.current
        const next = mergeAttachments(current, prepared, targetMode)
        const keptIds = new Set(next.map((attachment) => attachment.id))
        current
          .filter((attachment) => !keptIds.has(attachment.id))
          .forEach(revokePreview)
        updateDraftAttachments(next)
        if (targetMode === "image") {
          prepared.forEach((attachment) => imageAttachmentCacheRef.current.set(attachment.id, attachment))
        }
        setAttachmentError(null)
      } catch (error) {
        const message = error instanceof Error ? error.message : "添加附件失败"
        setAttachmentError(message)
        toast.error(message)
      }
    },
    [mode, updateDraftAttachments],
  )

  const removeDraftAttachment = useCallback(
    (attachmentId: string) => {
      const removed = draftAttachmentsRef.current.find((attachment) => attachment.id === attachmentId)
      if (removed) {
        revokePreview(removed)
      }
      imageAttachmentCacheRef.current.delete(attachmentId)
      updateDraftAttachments(
        draftAttachmentsRef.current.filter((attachment) => attachment.id !== attachmentId),
      )
      setAttachmentError(null)
    },
    [updateDraftAttachments],
  )

  const handleImageSettingsChange = useCallback((change: Partial<ImageSettings>) => {
    setImageSettings((current) => normalizeImageSettings({ ...current, ...change }))
  }, [])

  const handleSubmit = useCallback(async () => {
    const submittedInput = input
    const prompt = submittedInput.trim()
    if (mode === "chat") {
      if (draftAttachmentsRef.current.length > 0) {
        setAttachmentError(TEXT_ATTACHMENT_UNAVAILABLE)
        return
      }
      try {
        const stream = controller.sendText({ text: prompt })
        setInput((current) => (current === submittedInput ? "" : current))
        await stream
      } catch (error) {
        setInput((current) => current || submittedInput)
        toast.error(error instanceof Error ? error.message : "发送消息失败")
      }
      return
    }

    const references = draftAttachmentsRef.current
    if (references.some((attachment) => attachment.kind !== "image")) {
      setAttachmentError("生成图片模式不能添加文档附件")
      return
    }
    if (imageSubmitInFlightRef.current) {
      return
    }
    imageSubmitInFlightRef.current = true
    setIsImageSubmitPending(true)
    try {
      let conversationId = activeConversation?.id || ""
      if (!conversationId) {
        conversationId = await controller.createConversation()
      }
      if (!conversationId) {
        throw new Error("无法创建图片会话")
      }
      const messageId = createChatImageMessageId()
      imageMessageOwnersRef.current.set(messageId, conversationId)
      imageMessageAttachmentIdsRef.current.set(
        messageId,
        references.map((attachment) => attachment.id),
      )
      references.forEach((attachment) => imageAttachmentCacheRef.current.set(attachment.id, attachment))
      await submitImageTask({
        prompt,
        settings: imageSettings,
        references,
        messageId,
      })
      draftAttachmentsRef.current.forEach(revokePreview)
      updateDraftAttachments([])
      setInput((current) => (current === submittedInput ? "" : current))
      setAttachmentError(null)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "图片生成失败")
    } finally {
      imageSubmitInFlightRef.current = false
      setIsImageSubmitPending(false)
    }
  }, [
    activeConversation?.id,
    controller,
    imageSettings,
    input,
    mode,
    submitImageTask,
    updateDraftAttachments,
  ])

  const handleEditAndResend = useCallback(
    async (
      messageId: string,
      inputValue: { text: string; attachmentIds: string[]; files: File[] },
    ) => {
      if (inputValue.attachmentIds.length > 0 || inputValue.files.length > 0) {
        throw new Error(TEXT_ATTACHMENT_UNAVAILABLE)
      }
      if (controller.isStreaming) {
        throw new Error("当前已有回复正在生成")
      }
      const conversation = activeConversation
      const message = conversation?.messages.find((item) => item.id === messageId)
      if (!conversation || !message || message.role !== "user") {
        throw new Error("没有找到要编辑的用户消息")
      }
      const messageIndex = conversation.messages.findIndex((item) => item.id === messageId)
      const firstRemovedIndex = messageIndex + 1
      discardTrackedImageMessages(
        conversation.messages.slice(firstRemovedIndex),
        ownerMessageIdsForConversation(
          conversation.id,
          new Set(conversation.messages.map((item) => item.id)),
        ),
      )
      await controller.editAndResend(messageId, { text: inputValue.text, attachmentIds: [] })
    },
    [activeConversation?.messages, controller, discardTrackedImageMessages, ownerMessageIdsForConversation],
  )

  const handleRetryAssistant = useCallback(
    async (messageId: string) => {
      if (controller.isStreaming) {
        toast.error("当前已有回复正在生成")
        return
      }
      const conversation = activeConversation
      const message = conversation?.messages.find((item) => item.id === messageId)
      if (!conversation || !message || message.role !== "assistant") {
        toast.error("没有找到要重新生成的助手消息")
        return
      }
      const messageIndex = conversation.messages.findIndex((item) => item.id === messageId)
      discardTrackedImageMessages(
        conversation.messages.slice(messageIndex),
        ownerMessageIdsForConversation(
          conversation.id,
          new Set(conversation.messages.map((item) => item.id)),
        ),
      )
      try {
        await controller.retryAssistant(messageId)
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "重新生成失败")
      }
    },
    [activeConversation?.messages, controller, discardTrackedImageMessages, ownerMessageIdsForConversation],
  )

  const handleUseImageAsReference = useCallback(
    async (image: ChatGeneratedImage) => {
      if (!image.url) {
        return
      }
      try {
        const file = await chatImageUrlToFile(image.url, `reference-${image.id}.png`)
        await addFiles([file], "image")
        setMode("image")
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "读取参考图失败")
      }
    },
    [addFiles],
  )

  const handleRetryImage = useCallback(
    async (messageId: string, image: ChatGeneratedImage) => {
      const message = controller.state.conversations
        .flatMap((conversation) => conversation.messages)
        .find((item) => item.id === messageId)
      if (!message) {
        return
      }
      try {
        await retryImageTask(message, image.id, { prompt: message.text })
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "重试图片失败")
      }
    },
    [controller.state.conversations, retryImageTask],
  )

  const handleResumeImage = useCallback(
    async (messageId: string, image: ChatGeneratedImage) => {
      if (!image.taskId) {
        return
      }
      const message = controller.state.conversations
        .flatMap((conversation) => conversation.messages)
        .find((item) => item.id === messageId)
      if (!message) {
        return
      }
      try {
        await resumeImageTask(message, image.taskId)
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "恢复图片任务失败")
      }
    },
    [controller.state.conversations, resumeImageTask],
  )

  const openImagePreview = useCallback(
    (image: ChatGeneratedImage) => {
      const images = (activeConversation?.messages || [])
        .flatMap((message) => message.images || [])
        .flatMap((item) =>
          item.url
            ? [
                {
                  id: item.id,
                  src: item.url,
                  dimensions: item.width && item.height ? `${item.width} x ${item.height}` : undefined,
                },
              ]
            : [],
        )
      const index = images.findIndex((item) => item.id === image.id)
      if (index < 0) {
        return
      }
      setLightboxImages(images)
      setLightboxIndex(index)
      setLightboxOpen(true)
    },
    [activeConversation?.messages],
  )

  const downloadImage = useCallback((image: ChatGeneratedImage) => {
    if (!image.url) {
      return
    }
    const link = document.createElement("a")
    link.href = image.url
    link.download = `image-${image.id}.png`
    link.click()
  }, [])

  const handleThemeToggle = useCallback(() => {
    const nextTheme = theme === "dark" ? "light" : "dark"
    document.documentElement.classList.toggle("dark", nextTheme === "dark")
    document.documentElement.style.colorScheme = nextTheme
    window.localStorage.setItem("chatgpt2api-theme", nextTheme)
  }, [theme])

  const handleSignOut = useCallback(async () => {
    await clearStoredAuthSession()
    router.replace("/login")
  }, [router])

  const handleDeleteConversation = useCallback(
    (conversationId: string) => {
      const conversation = controller.state.conversations.find((item) => item.id === conversationId)
      discardTrackedImageMessages(
        conversation?.messages || [],
        ownerMessageIdsForConversation(conversationId),
      )
      void controller.deleteConversation(conversationId)
    },
    [controller, discardTrackedImageMessages, ownerMessageIdsForConversation],
  )

  const handleClearHistory = useCallback(async () => {
    discardTrackedImageMessages(
      controller.state.conversations.flatMap((conversation) => conversation.messages),
      [...imageMessageOwnersRef.current.keys()],
      true,
    )
    imageMessageOwnersRef.current.clear()
    imageMessageAttachmentIdsRef.current.clear()
    await controller.clearHistory()
  }, [controller, discardTrackedImageMessages])

  const attachmentWarning =
    attachmentError || (mode === "chat" && draftAttachments.length > 0 ? TEXT_ATTACHMENT_UNAVAILABLE : null)
  const threadAttachments = activeAttachmentIds.length > 0 ? savedAttachments : []

  if (controller.state.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <>
      <ChatShell
        mobileSidebarOpen={mobileSidebarOpen}
        onMobileSidebarOpenChange={setMobileSidebarOpen}
        sidebar={
          <ChatSidebar
            conversations={controller.state.conversations}
            activeConversationId={controller.state.activeConversationId}
            user={{ name: session.name, role: session.role }}
            theme={theme}
            chatHref="/chat"
            imageHref="/image"
            currentSection="chat"
            onNewConversation={() => {
              void controller.createConversation()
              setMobileSidebarOpen(false)
            }}
            onSelectConversation={(conversationId) => {
              void controller.selectConversation(conversationId)
              setMobileSidebarOpen(false)
            }}
            onRenameConversation={(conversationId, title) => {
              void controller.renameConversation(conversationId, title)
            }}
            onDeleteConversation={(conversationId) => {
              handleDeleteConversation(conversationId)
            }}
            onClearHistory={() => void handleClearHistory()}
            onToggleTheme={handleThemeToggle}
            onSignOut={() => void handleSignOut()}
            onNavigate={() => setMobileSidebarOpen(false)}
          />
        }
        header={
          <ChatHeader
            models={displayedChatModels}
            selectedModel={modelsLoaded ? controller.state.selectedModel : modelResolution.selected}
            unavailableModel={modelsLoaded ? modelResolution.unavailable : null}
            conversationTitle={activeConversation?.title}
            modelDisabled={controller.state.isLoading || !modelsLoaded}
            onModelChange={(model) => {
              void controller.setSelectedModel(model)
            }}
            onOpenSidebar={() => setMobileSidebarOpen(true)}
            onNewConversation={() => void controller.createConversation()}
            onRenameConversation={() => {
              if (!activeConversation) {
                return
              }
              const title = window.prompt("重命名对话", activeConversation.title)
              if (title) {
                void controller.renameConversation(activeConversation.id, title)
              }
            }}
            onDeleteConversation={() => {
              if (activeConversation) {
                handleDeleteConversation(activeConversation.id)
              }
            }}
          />
        }
        thread={
          <ChatThread
            conversationId={activeConversation?.id || null}
            messages={activeConversation?.messages || []}
            attachments={threadAttachments}
            allowAttachmentEdits={false}
            initialScrollTop={activeConversation?.scrollTop || 0}
            onScrollTopChange={(scrollTop) => {
              if (activeConversation) {
                void controller.setScrollPosition(activeConversation.id, scrollTop)
              }
            }}
            onCopyError={(error) => toast.error(error instanceof Error ? error.message : "复制失败")}
            onEditAndResend={handleEditAndResend}
            onEditError={(error) => toast.error(error instanceof Error ? error.message : "重发失败")}
            onRetry={(messageId) => void handleRetryAssistant(messageId)}
            onPreviewImage={openImagePreview}
            onDownloadImage={downloadImage}
            onUseImageAsReference={(image) => void handleUseImageAsReference(image)}
            onRetryImage={(messageId, image) => void handleRetryImage(messageId, image)}
            onResumeImage={(messageId, image) => void handleResumeImage(messageId, image)}
          />
        }
        composer={
          <>
            {controller.state.storageWarning ? (
              <div className="mx-auto w-full max-w-[780px] px-3 sm:px-5">
                <p role="alert" className="mb-1 text-sm text-destructive">
                  {controller.state.storageWarning}
                </p>
              </div>
            ) : null}
            <ChatComposer
              value={input}
              attachments={draftAttachments}
              mode={mode}
              isStreaming={controller.isStreaming}
              imageSettings={imageSettings}
              imageModels={imageModels}
              imageSettingsPresentation={imageSettingsPresentation}
              onValueChange={setInput}
              onSubmit={() => handleSubmit()}
              onStop={controller.stop}
              onFilesSelected={addFiles}
              onRemoveAttachment={removeDraftAttachment}
              onModeChange={setMode}
              onImageSettingsChange={handleImageSettingsChange}
              disabled={controller.state.isLoading || isImageSubmitPending}
              attachmentError={attachmentWarning}
              activeImageTaskCount={activeTaskIds.length}
            />
          </>
        }
      />

      <ImageLightbox
        images={lightboxImages}
        currentIndex={lightboxIndex}
        open={lightboxOpen}
        onOpenChange={setLightboxOpen}
        onIndexChange={setLightboxIndex}
      />
    </>
  )
}

export default function ChatPage() {
  const { isCheckingAuth, session } = useAuthGuard()

  if (isCheckingAuth || !session) {
    return (
      <div className="flex h-full items-center justify-center">
        <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return <ChatWorkspace key={session.subjectId} session={session} />
}
