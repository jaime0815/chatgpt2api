"use client"

import { useCallback, useEffect, useMemo, useReducer, useRef } from "react"

import { streamChat } from "@/app/chat/lib/chat-stream"
import type {
  ChatAttachmentManifest,
  ChatConversation,
  ChatMessage,
  ChatMessageStatus,
  ChatRequestMessage,
  ChatStreamEvent,
  ChatStreamRequest,
  PreparedChatAttachment,
} from "@/app/chat/lib/chat-types"
import {
  ChatStorageQuotaError,
  clearChatConversations,
  deleteChatConversation,
  getChatAttachments,
  getChatPreferences,
  listChatConversations,
  releaseUnreferencedAttachments,
  renameChatConversation,
  saveChatAttachment,
  saveChatConversation,
  saveChatPreferences,
  type ChatPreferences,
} from "@/store/chat-conversations"

const DEFAULT_CONVERSATION_TITLE = "新对话"
const STORAGE_WARNING = "当前对话无法写入本地历史"
const DEFAULT_CHECKPOINT_DELAY_MS = 300
const TITLE_MAX_CHARACTERS = 32

export type ChatMessageInput = {
  text: string
  attachments?: readonly PreparedChatAttachment[]
  attachmentIds?: readonly string[]
}

export type ChatControllerDependencies = {
  streamChatFn: typeof streamChat
  listConversations: typeof listChatConversations
  saveConversation: typeof saveChatConversation
  renameConversation: typeof renameChatConversation
  deleteConversation: typeof deleteChatConversation
  clearConversations: typeof clearChatConversations
  releaseUnreferencedAttachments: typeof releaseUnreferencedAttachments
  saveAttachment: typeof saveChatAttachment
  getAttachments: typeof getChatAttachments
  getPreferences: typeof getChatPreferences
  savePreferences: typeof saveChatPreferences
  now: () => Date
  createId: () => string
  checkpointDelayMs: number
}

export type ChatActiveStream = {
  conversationId: string
  assistantMessageId: string
}

export type ChatControllerState = {
  subjectId: string
  conversations: ChatConversation[]
  activeConversationId: string | null
  selectedModel: string
  scrollPositions: Record<string, number>
  activeStream: ChatActiveStream | null
  isLoading: boolean
  storageWarning: string | null
}

type ChatControllerAction =
  | { type: "reset"; subjectId: string }
  | {
      type: "hydrate"
      conversations: ChatConversation[]
      preferences: ChatPreferences
    }
  | { type: "finish-loading" }
  | {
      type: "upsert-conversation"
      conversation: ChatConversation
      activate?: boolean
    }
  | {
      type: "start-stream"
      conversation: ChatConversation
      stream: ChatActiveStream
    }
  | {
      type: "append-delta"
      stream: ChatActiveStream
      content: string
      updatedAt: string
    }
  | {
      type: "finish-stream"
      stream: ChatActiveStream
      status: Extract<ChatMessageStatus, "complete" | "stopped" | "error">
      updatedAt: string
      error?: string
    }
  | { type: "select-conversation"; id: string }
  | { type: "rename-conversation"; id: string; title: string; updatedAt: string }
  | { type: "delete-conversation"; id: string }
  | { type: "clear-conversations" }
  | { type: "set-model"; model: string; updatedAt: string }
  | { type: "set-scroll"; id: string; scrollTop: number }
  | { type: "set-warning"; warning: string | null }

type ActiveRun = ChatActiveStream & {
  token: symbol
  abortController: AbortController
  terminal: Extract<ChatMessageStatus, "complete" | "stopped" | "error"> | null
}

const DEFAULT_DEPENDENCIES: ChatControllerDependencies = {
  streamChatFn: streamChat,
  listConversations: listChatConversations,
  saveConversation: saveChatConversation,
  renameConversation: renameChatConversation,
  deleteConversation: deleteChatConversation,
  clearConversations: clearChatConversations,
  releaseUnreferencedAttachments,
  saveAttachment: saveChatAttachment,
  getAttachments: getChatAttachments,
  getPreferences: getChatPreferences,
  savePreferences: saveChatPreferences,
  now: () => new Date(),
  createId: () =>
    globalThis.crypto?.randomUUID?.() ||
    `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
  checkpointDelayMs: DEFAULT_CHECKPOINT_DELAY_MS,
}

function emptyState(subjectId: string): ChatControllerState {
  return {
    subjectId,
    conversations: [],
    activeConversationId: null,
    selectedModel: "auto",
    scrollPositions: {},
    activeStream: null,
    isLoading: true,
    storageWarning: null,
  }
}

function timestamp(value: string) {
  const parsed = new Date(value).getTime()
  return Number.isFinite(parsed) ? parsed : 0
}

function sortConversations(conversations: readonly ChatConversation[]) {
  return [...conversations].sort(
    (left, right) => timestamp(right.updatedAt) - timestamp(left.updatedAt),
  )
}

function normalizeHydratedConversation(conversation: ChatConversation) {
  let changed = false
  const messages = conversation.messages.map((message) => {
    if (message.status !== "sending" && message.status !== "streaming") {
      return message
    }
    changed = true
    return { ...message, status: "stopped" as const }
  })
  return changed ? { ...conversation, messages } : conversation
}

function replaceConversation(
  conversations: readonly ChatConversation[],
  conversation: ChatConversation,
) {
  const index = conversations.findIndex((item) => item.id === conversation.id)
  if (index < 0) {
    return sortConversations([conversation, ...conversations])
  }
  const next = [...conversations]
  next[index] = conversation
  return sortConversations(next)
}

function mapConversation(
  state: ChatControllerState,
  id: string,
  update: (conversation: ChatConversation) => ChatConversation,
) {
  const current = state.conversations.find((conversation) => conversation.id === id)
  if (!current) {
    return state
  }
  return {
    ...state,
    conversations: replaceConversation(state.conversations, update(current)),
  }
}

function updateStreamMessage(
  state: ChatControllerState,
  stream: ChatActiveStream,
  update: (message: ChatMessage) => ChatMessage,
  updatedAt: string,
) {
  if (
    state.activeStream?.conversationId !== stream.conversationId ||
    state.activeStream.assistantMessageId !== stream.assistantMessageId
  ) {
    return state
  }
  return mapConversation(state, stream.conversationId, (conversation) => {
    const messageIndex = conversation.messages.findIndex(
      (message) => message.id === stream.assistantMessageId,
    )
    if (messageIndex < 0) {
      return conversation
    }
    const current = conversation.messages[messageIndex]
    if (current.status !== "streaming" && current.status !== "sending") {
      return conversation
    }
    const messages = [...conversation.messages]
    messages[messageIndex] = update(current)
    return { ...conversation, messages, updatedAt }
  })
}

export function chatControllerReducer(
  state: ChatControllerState,
  action: ChatControllerAction,
): ChatControllerState {
  switch (action.type) {
    case "reset":
      return emptyState(action.subjectId)
    case "hydrate": {
      const conversations = sortConversations(
        action.conversations.map((storedConversation) => {
          const conversation = normalizeHydratedConversation(storedConversation)
          return {
            ...conversation,
            scrollTop:
              action.preferences.scrollPositions[conversation.id] ?? conversation.scrollTop ?? 0,
          }
        }),
      )
      const preferredId = action.preferences.activeConversationId
      const activeConversationId = conversations.some((item) => item.id === preferredId)
        ? preferredId
        : conversations[0]?.id || null
      const activeConversation = conversations.find(
        (conversation) => conversation.id === activeConversationId,
      )
      return {
        ...state,
        conversations,
        activeConversationId,
        selectedModel:
          activeConversation?.model || action.preferences.selectedModel || "auto",
        scrollPositions: { ...action.preferences.scrollPositions },
        activeStream: null,
        isLoading: false,
      }
    }
    case "finish-loading":
      return { ...state, isLoading: false }
    case "upsert-conversation":
      return {
        ...state,
        conversations: replaceConversation(state.conversations, action.conversation),
        activeConversationId: action.activate
          ? action.conversation.id
          : state.activeConversationId,
      }
    case "start-stream":
      return {
        ...state,
        conversations: replaceConversation(state.conversations, action.conversation),
        activeConversationId: action.conversation.id,
        activeStream: action.stream,
      }
    case "append-delta":
      return updateStreamMessage(
        state,
        action.stream,
        (message) => ({
          ...message,
          text: `${message.text}${action.content}`,
          status: "streaming",
          updatedAt: action.updatedAt,
        }),
        action.updatedAt,
      )
    case "finish-stream": {
      const next = updateStreamMessage(
        state,
        action.stream,
        (message) => ({
          ...message,
          status: action.status,
          updatedAt: action.updatedAt,
          ...(action.error ? { error: action.error } : { error: undefined }),
        }),
        action.updatedAt,
      )
      if (next === state) {
        return state
      }
      return { ...next, activeStream: null }
    }
    case "select-conversation": {
      const conversation = state.conversations.find((item) => item.id === action.id)
      if (!conversation) {
        return state
      }
      return {
        ...state,
        activeConversationId: conversation.id,
        selectedModel: conversation.model || state.selectedModel,
      }
    }
    case "rename-conversation":
      return mapConversation(state, action.id, (conversation) => ({
        ...conversation,
        title: action.title,
        updatedAt: action.updatedAt,
      }))
    case "delete-conversation": {
      const conversations = state.conversations.filter((item) => item.id !== action.id)
      const deletedActive = state.activeConversationId === action.id
      const activeConversationId = deletedActive
        ? conversations[0]?.id || null
        : state.activeConversationId
      const activeConversation = conversations.find((item) => item.id === activeConversationId)
      return {
        ...state,
        conversations,
        activeConversationId,
        selectedModel: deletedActive
          ? activeConversation?.model || state.selectedModel
          : state.selectedModel,
        scrollPositions: Object.fromEntries(
          Object.entries(state.scrollPositions).filter(([id]) => id !== action.id),
        ),
        activeStream:
          state.activeStream?.conversationId === action.id ? null : state.activeStream,
      }
    }
    case "clear-conversations":
      return {
        ...state,
        conversations: [],
        activeConversationId: null,
        scrollPositions: {},
        activeStream: null,
      }
    case "set-model": {
      const next = {
        ...state,
        selectedModel: action.model,
      }
      if (!state.activeConversationId) {
        return next
      }
      return mapConversation(next, state.activeConversationId, (conversation) => ({
        ...conversation,
        model: action.model,
        updatedAt: action.updatedAt,
      }))
    }
    case "set-scroll": {
      if (!Number.isFinite(action.scrollTop)) {
        return state
      }
      const scrollTop = Math.max(0, action.scrollTop)
      const next = {
        ...state,
        scrollPositions: { ...state.scrollPositions, [action.id]: scrollTop },
      }
      return mapConversation(next, action.id, (conversation) => ({
        ...conversation,
        scrollTop,
      }))
    }
    case "set-warning":
      return { ...state, storageWarning: action.warning }
  }
}

function uniqueStrings(values: readonly string[]) {
  const seen = new Set<string>()
  const unique: string[] = []
  for (const value of values) {
    const normalized = String(value || "").trim()
    if (!normalized || seen.has(normalized)) {
      continue
    }
    seen.add(normalized)
    unique.push(normalized)
  }
  return unique
}

function uniqueAttachments(attachments: readonly PreparedChatAttachment[]) {
  const byId = new Map<string, PreparedChatAttachment>()
  for (const attachment of attachments) {
    if (!byId.has(attachment.id)) {
      byId.set(attachment.id, attachment)
    }
  }
  return [...byId.values()]
}

function nextUpdatedAt(conversation: ChatConversation, now: Date) {
  const nextTimestamp = Math.max(now.getTime(), timestamp(conversation.updatedAt) + 1)
  return new Date(nextTimestamp).toISOString()
}

function messageTimestamp(now: Date) {
  return now.toISOString()
}

export function createConversationTitle(text: string) {
  const normalized = text.trim().replace(/\s+/g, " ")
  if (!normalized) {
    return DEFAULT_CONVERSATION_TITLE
  }
  const characters = Array.from(normalized)
  if (characters.length <= TITLE_MAX_CHARACTERS) {
    return normalized
  }
  return `${characters.slice(0, TITLE_MAX_CHARACTERS - 1).join("")}…`
}

function requestMessage(message: ChatMessage): ChatRequestMessage {
  return {
    id: message.id,
    role: message.role,
    text: message.text,
    attachment_ids: uniqueStrings(message.attachmentIds),
  }
}

function attachmentManifest(attachment: PreparedChatAttachment): ChatAttachmentManifest {
  return {
    id: attachment.id,
    file_name: attachment.name,
    mime_type: attachment.mimeType,
    size: attachment.size,
    sha256: attachment.sha256,
  }
}

function isAbortError(error: unknown) {
  return Boolean(
    error &&
      typeof error === "object" &&
      "name" in error &&
      (error as { name?: unknown }).name === "AbortError",
  )
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message.trim()) {
    return error.message
  }
  return "聊天请求失败"
}

function storageWarning(error: unknown) {
  if (
    error instanceof ChatStorageQuotaError ||
    (error &&
      typeof error === "object" &&
      "name" in error &&
      (error as { name?: unknown }).name === "QuotaExceededError")
  ) {
    return STORAGE_WARNING
  }
  const details = error instanceof Error && error.message.trim() ? `：${error.message}` : ""
  return `${STORAGE_WARNING}${details}`
}

function preferencesFromState(state: ChatControllerState): ChatPreferences {
  return {
    activeConversationId: state.activeConversationId,
    selectedModel: state.selectedModel,
    scrollPositions: { ...state.scrollPositions },
  }
}

export type UseChatControllerOptions = {
  subjectId: string
  dependencies?: Partial<ChatControllerDependencies>
}

export function useChatController({ subjectId, dependencies }: UseChatControllerOptions) {
  const dependenciesRef = useRef<ChatControllerDependencies>({
    ...DEFAULT_DEPENDENCIES,
    ...dependencies,
  })
  dependenciesRef.current = { ...DEFAULT_DEPENDENCIES, ...dependencies }

  const [state, reactDispatch] = useReducer(chatControllerReducer, subjectId, emptyState)
  const stateRef = useRef(state)
  const activeRunRef = useRef<ActiveRun | null>(null)
  const attachmentCacheRef = useRef(new Map<string, PreparedChatAttachment>())
  const checkpointTimersRef = useRef(
    new Map<string, ReturnType<typeof globalThis.setTimeout>>(),
  )

  const transition = useCallback((action: ChatControllerAction) => {
    const next = chatControllerReducer(stateRef.current, action)
    stateRef.current = next
    reactDispatch(action)
    return next
  }, [])

  useEffect(() => {
    stateRef.current = state
  }, [state])

  const clearCheckpoint = useCallback((conversationId: string) => {
    const timer = checkpointTimersRef.current.get(conversationId)
    if (timer !== undefined) {
      globalThis.clearTimeout(timer)
      checkpointTimersRef.current.delete(conversationId)
    }
  }, [])

  const attemptStorageWrite = useCallback(
    async <T,>(operation: () => Promise<T>) => {
      try {
        return { ok: true as const, value: await operation() }
      } catch (error) {
        transition({ type: "set-warning", warning: storageWarning(error) })
        return { ok: false as const, value: undefined }
      }
    },
    [transition],
  )

  const persistConversation = useCallback(
    (conversation: ChatConversation) =>
      attemptStorageWrite(() =>
        dependenciesRef.current.saveConversation(subjectId, conversation),
      ),
    [attemptStorageWrite, subjectId],
  )

  const persistPreferences = useCallback(
    (snapshot: ChatControllerState) =>
      attemptStorageWrite(() =>
        dependenciesRef.current.savePreferences(subjectId, preferencesFromState(snapshot)),
      ),
    [attemptStorageWrite, subjectId],
  )

  const scheduleCheckpoint = useCallback(
    (conversation: ChatConversation) => {
      clearCheckpoint(conversation.id)
      const timer = globalThis.setTimeout(() => {
        checkpointTimersRef.current.delete(conversation.id)
        void persistConversation(conversation)
      }, dependenciesRef.current.checkpointDelayMs)
      checkpointTimersRef.current.set(conversation.id, timer)
    },
    [clearCheckpoint, persistConversation],
  )

  const conversationFromState = useCallback((id: string) => {
    return stateRef.current.conversations.find((conversation) => conversation.id === id) || null
  }, [])

  const saveNewAttachments = useCallback(
    async (attachments: readonly PreparedChatAttachment[]) => {
      const unique = uniqueAttachments(attachments)
      for (const attachment of unique) {
        attachmentCacheRef.current.set(attachment.id, attachment)
        const stored = await attemptStorageWrite(() =>
          dependenciesRef.current.saveAttachment(subjectId, attachment),
        )
        if (stored.ok) {
          attachmentCacheRef.current.set(stored.value.id, stored.value)
        }
      }
      return unique
    },
    [attemptStorageWrite, subjectId],
  )

  const resolveReferencedAttachments = useCallback(
    async (messages: readonly ChatMessage[]) => {
      const ids = uniqueStrings(messages.flatMap((message) => message.attachmentIds))
      const missingIds = ids.filter((id) => !attachmentCacheRef.current.has(id))
      if (missingIds.length > 0) {
        const stored = await dependenciesRef.current.getAttachments(subjectId, missingIds)
        for (const attachment of stored) {
          attachmentCacheRef.current.set(attachment.id, attachment)
        }
      }
      const resolved = ids.flatMap((id) => {
        const attachment = attachmentCacheRef.current.get(id)
        return attachment ? [attachment] : []
      })
      if (resolved.length !== ids.length) {
        throw new Error("无法读取当前对话引用的附件，请重新添加后再试")
      }
      return resolved
    },
    [subjectId],
  )

  const terminalTransition = useCallback(
    (
      run: ActiveRun,
      status: Extract<ChatMessageStatus, "complete" | "stopped" | "error">,
      error?: string,
    ) => {
      if (run.terminal) {
        return null
      }
      run.terminal = status
      const conversation = conversationFromState(run.conversationId)
      if (!conversation) {
        return null
      }
      const updatedAt = nextUpdatedAt(conversation, dependenciesRef.current.now())
      const next = transition({
        type: "finish-stream",
        stream: run,
        status,
        updatedAt,
        error,
      })
      clearCheckpoint(run.conversationId)
      return next.conversations.find((item) => item.id === run.conversationId) || null
    },
    [clearCheckpoint, conversationFromState, transition],
  )

  const executeRun = useCallback(
    async (run: ActiveRun, history: readonly ChatMessage[]) => {
      try {
        const conversation = conversationFromState(run.conversationId)
        if (!conversation || run.terminal) {
          return
        }
        const attachments = await resolveReferencedAttachments(history)
        if (run.terminal) {
          return
        }
        const request: ChatStreamRequest = {
          model: conversation.model || stateRef.current.selectedModel,
          messages: history.map(requestMessage),
          attachments: attachments.map(attachmentManifest),
          thinking_effort: conversation.reasoningEffort,
        }

        let receivedTerminal = false
        for await (const event of dependenciesRef.current.streamChatFn(
          request,
          attachments,
          run.abortController.signal,
        )) {
          if (run.terminal) {
            break
          }
          if (event.type === "delta") {
            const current = conversationFromState(run.conversationId)
            if (!current) {
              break
            }
            const updatedAt = nextUpdatedAt(current, dependenciesRef.current.now())
            const next = transition({
              type: "append-delta",
              stream: run,
              content: event.content,
              updatedAt,
            })
            const checkpoint = next.conversations.find(
              (item) => item.id === run.conversationId,
            )
            if (checkpoint) {
              scheduleCheckpoint(checkpoint)
            }
            continue
          }

          receivedTerminal = true
          const terminal = terminalTransition(
            run,
            event.type === "error" ? "error" : "complete",
            event.type === "error" ? event.message : undefined,
          )
          if (terminal) {
            await persistConversation(terminal)
          }
          break
        }

        if (!receivedTerminal && !run.terminal) {
          const terminal = terminalTransition(run, "error", "聊天流意外中断")
          if (terminal) {
            await persistConversation(terminal)
          }
        }
      } catch (error) {
        if (run.terminal === "stopped" || (run.abortController.signal.aborted && isAbortError(error))) {
          return
        }
        const terminal = terminalTransition(run, "error", errorMessage(error))
        if (terminal) {
          await persistConversation(terminal)
        }
      } finally {
        if (activeRunRef.current?.token === run.token) {
          activeRunRef.current = null
        }
      }
    },
    [
      conversationFromState,
      persistConversation,
      resolveReferencedAttachments,
      scheduleCheckpoint,
      terminalTransition,
      transition,
    ],
  )

  const startRun = useCallback(
    async (
      conversation: ChatConversation,
      history: readonly ChatMessage[],
      newAttachments: readonly PreparedChatAttachment[],
      releaseAfterPersist = false,
    ) => {
      if (activeRunRef.current && !activeRunRef.current.terminal) {
        throw new Error("当前已有回复正在生成")
      }
      const assistantMessage: ChatMessage = {
        id: dependenciesRef.current.createId(),
        role: "assistant",
        text: "",
        attachmentIds: [],
        status: "streaming",
        createdAt: messageTimestamp(dependenciesRef.current.now()),
      }
      const updatedAt = nextUpdatedAt(conversation, dependenciesRef.current.now())
      const streamingConversation = {
        ...conversation,
        messages: [...history, assistantMessage],
        updatedAt,
      }
      const run: ActiveRun = {
        conversationId: conversation.id,
        assistantMessageId: assistantMessage.id,
        token: Symbol(assistantMessage.id),
        abortController: new AbortController(),
        terminal: null,
      }
      activeRunRef.current = run
      transition({
        type: "start-stream",
        conversation: streamingConversation,
        stream: run,
      })

      await saveNewAttachments(newAttachments)
      const persisted = await persistConversation(streamingConversation)
      if (releaseAfterPersist && persisted.ok) {
        await attemptStorageWrite(() =>
          dependenciesRef.current.releaseUnreferencedAttachments(subjectId),
        )
      }
      await executeRun(run, history)
    },
    [
      attemptStorageWrite,
      executeRun,
      persistConversation,
      saveNewAttachments,
      subjectId,
      transition,
    ],
  )

  useEffect(() => {
    const currentRun = activeRunRef.current
    if (currentRun && !currentRun.terminal) {
      currentRun.terminal = "stopped"
      currentRun.abortController.abort()
    }
    for (const timer of checkpointTimersRef.current.values()) {
      globalThis.clearTimeout(timer)
    }
    checkpointTimersRef.current.clear()
    attachmentCacheRef.current.clear()
    transition({ type: "reset", subjectId })

    let cancelled = false
    void Promise.all([
      dependenciesRef.current.listConversations(subjectId),
      dependenciesRef.current.getPreferences(subjectId),
    ]).then(
      ([conversations, preferences]) => {
        if (!cancelled) {
          transition({ type: "hydrate", conversations, preferences })
        }
      },
      (error) => {
        if (!cancelled) {
          transition({ type: "finish-loading" })
          transition({ type: "set-warning", warning: storageWarning(error) })
        }
      },
    )

    return () => {
      cancelled = true
      const activeRun = activeRunRef.current
      if (activeRun && !activeRun.terminal) {
        activeRun.terminal = "stopped"
        activeRun.abortController.abort()
      }
      for (const timer of checkpointTimersRef.current.values()) {
        globalThis.clearTimeout(timer)
      }
      checkpointTimersRef.current.clear()
    }
  }, [subjectId, transition])

  const createConversation = useCallback(async () => {
    const now = dependenciesRef.current.now()
    const id = dependenciesRef.current.createId()
    const conversation: ChatConversation = {
      id,
      title: DEFAULT_CONVERSATION_TITLE,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      model: stateRef.current.selectedModel,
      messages: [],
      scrollTop: 0,
    }
    const next = transition({ type: "upsert-conversation", conversation, activate: true })
    await persistConversation(conversation)
    await persistPreferences(next)
    return id
  }, [persistConversation, persistPreferences, transition])

  const selectConversation = useCallback(
    async (id: string) => {
      const next = transition({ type: "select-conversation", id })
      await persistPreferences(next)
    },
    [persistPreferences, transition],
  )

  const renameConversation = useCallback(
    async (id: string, title: string) => {
      const normalized = title.trim() || DEFAULT_CONVERSATION_TITLE
      const conversation = conversationFromState(id)
      if (!conversation) {
        return
      }
      const updatedAt = nextUpdatedAt(conversation, dependenciesRef.current.now())
      transition({ type: "rename-conversation", id, title: normalized, updatedAt })
      await attemptStorageWrite(() =>
        dependenciesRef.current.renameConversation(subjectId, id, normalized),
      )
    },
    [attemptStorageWrite, conversationFromState, subjectId, transition],
  )

  const deleteConversation = useCallback(
    async (id: string) => {
      const run = activeRunRef.current
      if (run?.conversationId === id && !run.terminal) {
        run.terminal = "stopped"
        run.abortController.abort()
        clearCheckpoint(id)
      }
      const next = transition({ type: "delete-conversation", id })
      await attemptStorageWrite(() =>
        dependenciesRef.current.deleteConversation(subjectId, id),
      )
      await persistPreferences(next)
    },
    [attemptStorageWrite, clearCheckpoint, persistPreferences, subjectId, transition],
  )

  const sendText = useCallback(
    async (input: ChatMessageInput) => {
      const text = input.text.trim()
      const attachments = uniqueAttachments(input.attachments || [])
      const attachmentIds = uniqueStrings([
        ...(input.attachmentIds || []),
        ...attachments.map((attachment) => attachment.id),
      ])
      if (!text && attachmentIds.length === 0) {
        throw new Error("消息内容不能为空")
      }

      let conversation = stateRef.current.conversations.find(
        (item) => item.id === stateRef.current.activeConversationId,
      )
      if (!conversation) {
        const now = dependenciesRef.current.now()
        conversation = {
          id: dependenciesRef.current.createId(),
          title: DEFAULT_CONVERSATION_TITLE,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          model: stateRef.current.selectedModel,
          messages: [],
          scrollTop: 0,
        }
      }

      const createdAt = messageTimestamp(dependenciesRef.current.now())
      const userMessage: ChatMessage = {
        id: dependenciesRef.current.createId(),
        role: "user",
        text,
        attachmentIds,
        status: "complete",
        createdAt,
      }
      const existingUserMessages = conversation.messages.some((message) => message.role === "user")
      const prepared = {
        ...conversation,
        title: existingUserMessages ? conversation.title : createConversationTitle(text),
        model: stateRef.current.selectedModel,
        messages: [...conversation.messages, userMessage],
      }
      await startRun(prepared, prepared.messages, attachments)
    },
    [startRun],
  )

  const stop = useCallback(() => {
    const run = activeRunRef.current
    if (!run || run.terminal) {
      return
    }
    const terminal = terminalTransition(run, "stopped")
    run.abortController.abort()
    if (terminal) {
      void persistConversation(terminal)
    }
  }, [persistConversation, terminalTransition])

  const retryAssistant = useCallback(
    async (assistantMessageId: string) => {
      const conversation = stateRef.current.conversations.find(
        (item) => item.id === stateRef.current.activeConversationId,
      )
      if (!conversation) {
        throw new Error("没有可重试的对话")
      }
      const assistantIndex = conversation.messages.findIndex(
        (message) => message.id === assistantMessageId && message.role === "assistant",
      )
      if (assistantIndex < 0) {
        throw new Error("没有找到要重新生成的助手消息")
      }
      const history = conversation.messages.slice(0, assistantIndex)
      if (!history.some((message) => message.role === "user")) {
        throw new Error("助手消息前没有可重试的用户消息")
      }
      await startRun({ ...conversation, messages: history }, history, [], true)
    },
    [startRun],
  )

  const editAndResend = useCallback(
    async (userMessageId: string, input: ChatMessageInput) => {
      const conversation = stateRef.current.conversations.find(
        (item) => item.id === stateRef.current.activeConversationId,
      )
      if (!conversation) {
        throw new Error("没有可编辑的对话")
      }
      const userIndex = conversation.messages.findIndex(
        (message) => message.id === userMessageId && message.role === "user",
      )
      if (userIndex < 0) {
        throw new Error("没有找到要编辑的用户消息")
      }

      const original = conversation.messages[userIndex]
      const attachments = uniqueAttachments(input.attachments || [])
      const attachmentIds = uniqueStrings([
        ...(input.attachmentIds === undefined ? original.attachmentIds : input.attachmentIds),
        ...attachments.map((attachment) => attachment.id),
      ])
      const text = input.text.trim()
      if (!text && attachmentIds.length === 0) {
        throw new Error("消息内容不能为空")
      }
      const edited: ChatMessage = {
        ...original,
        text,
        attachmentIds,
        status: "complete",
        updatedAt: messageTimestamp(dependenciesRef.current.now()),
        error: undefined,
      }
      const history = [...conversation.messages.slice(0, userIndex), edited]
      const firstUserIndex = history.findIndex((message) => message.role === "user")
      const prepared = {
        ...conversation,
        title: firstUserIndex === userIndex ? createConversationTitle(text) : conversation.title,
        messages: history,
      }
      await startRun(prepared, history, attachments, true)
    },
    [startRun],
  )

  const clearHistory = useCallback(async () => {
    const run = activeRunRef.current
    if (run && !run.terminal) {
      run.terminal = "stopped"
      run.abortController.abort()
    }
    for (const conversation of stateRef.current.conversations) {
      clearCheckpoint(conversation.id)
    }
    attachmentCacheRef.current.clear()
    const next = transition({ type: "clear-conversations" })
    await attemptStorageWrite(() => dependenciesRef.current.clearConversations(subjectId))
    await persistPreferences(next)
  }, [attemptStorageWrite, clearCheckpoint, persistPreferences, subjectId, transition])

  const setSelectedModel = useCallback(
    async (model: string) => {
      const normalized = model.trim() || "auto"
      const activeConversation = stateRef.current.conversations.find(
        (item) => item.id === stateRef.current.activeConversationId,
      )
      const updatedAt = activeConversation
        ? nextUpdatedAt(activeConversation, dependenciesRef.current.now())
        : dependenciesRef.current.now().toISOString()
      const next = transition({ type: "set-model", model: normalized, updatedAt })
      const updatedConversation = next.conversations.find(
        (item) => item.id === next.activeConversationId,
      )
      if (updatedConversation) {
        await persistConversation(updatedConversation)
      }
      await persistPreferences(next)
    },
    [persistConversation, persistPreferences, transition],
  )

  const setScrollPosition = useCallback(
    async (id: string, scrollTop: number) => {
      const conversation = conversationFromState(id)
      if (!conversation || !Number.isFinite(scrollTop)) {
        return
      }
      const next = transition({ type: "set-scroll", id, scrollTop })
      const updatedConversation = next.conversations.find((item) => item.id === id)
      if (updatedConversation) {
        await persistConversation(updatedConversation)
      }
      await persistPreferences(next)
    },
    [conversationFromState, persistConversation, persistPreferences, transition],
  )

  const clearStorageWarning = useCallback(() => {
    transition({ type: "set-warning", warning: null })
  }, [transition])

  const activeConversation = useMemo(
    () =>
      state.conversations.find((conversation) => conversation.id === state.activeConversationId) ||
      null,
    [state.activeConversationId, state.conversations],
  )

  return {
    state,
    activeConversation,
    isStreaming: state.activeStream !== null,
    createConversation,
    selectConversation,
    renameConversation,
    deleteConversation,
    sendText,
    stop,
    retryAssistant,
    editAndResend,
    clearHistory,
    setSelectedModel,
    setScrollPosition,
    clearStorageWarning,
  }
}
