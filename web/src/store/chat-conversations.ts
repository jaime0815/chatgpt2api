"use client"

import localforage from "localforage"

import type { ChatConversation, PreparedChatAttachment } from "@/app/chat/lib/chat-types"

export type ChatStorageAdapter = {
  getItem<T>(key: string): Promise<T | null>
  setItem<T>(key: string, value: T): Promise<T>
  removeItem(key: string): Promise<void>
  keys(): Promise<string[]>
}

export type ChatStorageAdapters = {
  conversations: ChatStorageAdapter
  attachments: ChatStorageAdapter
}

export type ChatPreferences = {
  activeConversationId: string | null
  selectedModel: string
  scrollPositions: Record<string, number>
}

const DEFAULT_CHAT_PREFERENCES: ChatPreferences = {
  activeConversationId: null,
  selectedModel: "auto",
  scrollPositions: {},
}

export class ChatStorageQuotaError extends Error {
  readonly cause: unknown

  constructor(cause: unknown) {
    super("聊天记录存储空间不足")
    this.name = "ChatStorageQuotaError"
    this.cause = cause
  }
}

function wrapStorageError(error: unknown) {
  if (error instanceof ChatStorageQuotaError) {
    return error
  }
  if (error && typeof error === "object") {
    const candidate = error as { name?: unknown; code?: unknown }
    if (
      candidate.name === "QuotaExceededError" ||
      candidate.code === 22 ||
      candidate.code === 1014
    ) {
      return new ChatStorageQuotaError(error)
    }
  }
  return error
}

function subjectPartition(subjectId: string) {
  if (typeof subjectId !== "string" || !subjectId.trim()) {
    throw new Error("subjectId is required")
  }
  return encodeURIComponent(subjectId)
}

function conversationPrefix(subjectId: string) {
  return `${subjectPartition(subjectId)}:conversation:`
}

function conversationKey(subjectId: string, conversationId: string) {
  return `${conversationPrefix(subjectId)}${encodeURIComponent(conversationId)}`
}

function preferencesKey(subjectId: string) {
  return `${subjectPartition(subjectId)}:preferences`
}

function normalizeSha256(sha256: string) {
  const normalized = String(sha256 || "").trim().toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error("attachment sha256 must be a full SHA-256 hex digest")
  }
  return normalized
}

function attachmentKey(subjectId: string, sha256: string) {
  return `${subjectPartition(subjectId)}:attachment:${normalizeSha256(sha256)}`
}

function attachmentPrefix(subjectId: string) {
  return `${subjectPartition(subjectId)}:attachment:`
}

function sortConversations(items: ChatConversation[]) {
  return [...items].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

function timestampOf(value: string) {
  const timestamp = new Date(value).getTime()
  return Number.isFinite(timestamp) ? timestamp : 0
}

function removeBase64Payloads<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => removeBase64Payloads(item)) as T
  }
  if (!value || typeof value !== "object") {
    return value
  }
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return value
  }

  const sanitized: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (key === "b64_json" || key === "b64Json") {
      continue
    }
    sanitized[key] = removeBase64Payloads(item)
  }
  return sanitized as T
}

function normalizePreferences(value: ChatPreferences | null): ChatPreferences {
  if (!value) {
    return { ...DEFAULT_CHAT_PREFERENCES, scrollPositions: {} }
  }
  return {
    activeConversationId:
      typeof value.activeConversationId === "string" && value.activeConversationId
        ? value.activeConversationId
        : null,
    selectedModel: typeof value.selectedModel === "string" && value.selectedModel ? value.selectedModel : "auto",
    scrollPositions: Object.fromEntries(
      Object.entries(value.scrollPositions || {}).filter((entry): entry is [string, number] =>
        Number.isFinite(entry[1]),
      ),
    ),
  }
}

export function createChatConversationStore(adapters: ChatStorageAdapters) {
  const writeQueues = new Map<string, Promise<void>>()

  function queueWrite<T>(subjectId: string, operation: () => Promise<T>) {
    const partition = subjectPartition(subjectId)
    const previous = writeQueues.get(partition) ?? Promise.resolve()
    const result = previous.then(operation).catch((error: unknown) => {
      throw wrapStorageError(error)
    })
    const settled = result.then(
      () => undefined,
      () => undefined,
    )
    writeQueues.set(partition, settled)
    void settled.finally(() => {
      if (writeQueues.get(partition) === settled) {
        writeQueues.delete(partition)
      }
    })
    return result
  }

  async function get(subjectId: string, id: string) {
    return adapters.conversations.getItem<ChatConversation>(conversationKey(subjectId, id))
  }

  async function list(subjectId: string) {
    const prefix = conversationPrefix(subjectId)
    const keys = (await adapters.conversations.keys()).filter((key) => key.startsWith(prefix))
    const items = await Promise.all(keys.map((key) => adapters.conversations.getItem<ChatConversation>(key)))
    return sortConversations(items.filter((item): item is ChatConversation => item !== null))
  }

  async function sweepUnreferencedAttachments(subjectId: string) {
    const referenced = new Set(
      (await list(subjectId)).flatMap((conversation) =>
        conversation.messages.flatMap((message) =>
          message.attachmentIds.map((attachmentId) => String(attachmentId || "").trim().toLowerCase()),
        ),
      ),
    )
    const prefix = attachmentPrefix(subjectId)
    const keys = (await adapters.attachments.keys()).filter((key) => key.startsWith(prefix))
    const unreferencedKeys = keys.filter((key) => !referenced.has(key.slice(prefix.length)))
    await Promise.all(unreferencedKeys.map((key) => adapters.attachments.removeItem(key)))
    return unreferencedKeys.length
  }

  async function save(subjectId: string, conversation: ChatConversation) {
    return queueWrite(subjectId, async () => {
      const sanitized = removeBase64Payloads(conversation)
      const key = conversationKey(subjectId, sanitized.id)
      const current = await adapters.conversations.getItem<ChatConversation>(key)
      const persisted =
        current && timestampOf(current.updatedAt) > timestampOf(sanitized.updatedAt) ? current : sanitized
      if (persisted !== current) {
        await adapters.conversations.setItem(key, persisted)
      }
      return persisted
    })
  }

  async function rename(subjectId: string, id: string, title: string) {
    return queueWrite(subjectId, async () => {
      const key = conversationKey(subjectId, id)
      const current = await adapters.conversations.getItem<ChatConversation>(key)
      if (!current) {
        return null
      }
      const currentTimestamp = new Date(current.updatedAt).getTime()
      const updatedAt = new Date(Math.max(Date.now(), Number.isFinite(currentTimestamp) ? currentTimestamp + 1 : 0)).toISOString()
      const renamed = { ...current, title, updatedAt }
      await adapters.conversations.setItem(key, renamed)
      return renamed
    })
  }

  async function saveAttachment(subjectId: string, attachment: PreparedChatAttachment) {
    return queueWrite(subjectId, async () => {
      const sha256 = normalizeSha256(attachment.sha256)
      const key = attachmentKey(subjectId, sha256)
      const current = await adapters.attachments.getItem<PreparedChatAttachment>(key)
      if (current) {
        return current
      }
      const stored = { ...attachment, id: sha256, sha256 }
      await adapters.attachments.setItem(key, stored)
      return stored
    })
  }

  async function getAttachments(subjectId: string, attachmentIds: readonly string[]) {
    subjectPartition(subjectId)
    const items = await Promise.all(
      attachmentIds.map((attachmentId) =>
        adapters.attachments.getItem<PreparedChatAttachment>(attachmentKey(subjectId, attachmentId)),
      ),
    )
    return items.filter((item): item is PreparedChatAttachment => item !== null)
  }

  async function getAttachmentBytes(subjectId: string, attachmentIds: readonly string[]) {
    const uniqueIds = [...new Set(attachmentIds.map(normalizeSha256))]
    const items = await getAttachments(subjectId, uniqueIds)
    return items.reduce((total, item) => total + item.blob.size, 0)
  }

  async function getConversationAttachmentBytes(subjectId: string, id: string) {
    const conversation = await get(subjectId, id)
    if (!conversation) {
      return 0
    }
    return getAttachmentBytes(
      subjectId,
      conversation.messages.flatMap((message) => message.attachmentIds),
    )
  }

  async function getPreferences(subjectId: string) {
    return normalizePreferences(
      await adapters.conversations.getItem<ChatPreferences>(preferencesKey(subjectId)),
    )
  }

  async function savePreferences(subjectId: string, preferences: ChatPreferences) {
    return queueWrite(subjectId, async () => {
      const normalized = normalizePreferences(preferences)
      await adapters.conversations.setItem(preferencesKey(subjectId), normalized)
      return normalized
    })
  }

  async function deleteConversation(subjectId: string, id: string) {
    return queueWrite(subjectId, async () => {
      await adapters.conversations.removeItem(conversationKey(subjectId, id))
      await sweepUnreferencedAttachments(subjectId)
    })
  }

  async function clear(subjectId: string) {
    return queueWrite(subjectId, async () => {
      const prefix = conversationPrefix(subjectId)
      const keys = (await adapters.conversations.keys()).filter((key) => key.startsWith(prefix))
      await Promise.all(keys.map((key) => adapters.conversations.removeItem(key)))
      await sweepUnreferencedAttachments(subjectId)
    })
  }

  async function releaseUnreferencedAttachments(subjectId: string) {
    return queueWrite(subjectId, () => sweepUnreferencedAttachments(subjectId))
  }

  return {
    list,
    get,
    save,
    rename,
    saveAttachment,
    getAttachments,
    getAttachmentBytes,
    getConversationAttachmentBytes,
    getPreferences,
    savePreferences,
    delete: deleteConversation,
    clear,
    releaseUnreferencedAttachments,
  }
}

const defaultStore = createChatConversationStore({
  conversations: localforage.createInstance({
    name: "chatgpt2api",
    storeName: "chat_conversations",
  }),
  attachments: localforage.createInstance({
    name: "chatgpt2api",
    storeName: "chat_attachments",
  }),
})

export const listChatConversations = defaultStore.list
export const getChatConversation = defaultStore.get
export const saveChatConversation = defaultStore.save
export const renameChatConversation = defaultStore.rename
export const saveChatAttachment = defaultStore.saveAttachment
export const getChatAttachments = defaultStore.getAttachments
export async function loadChatAttachment(subjectId: string, attachmentId: string) {
  return (await defaultStore.getAttachments(subjectId, [attachmentId]))[0] ?? null
}
export const getChatPreferences = defaultStore.getPreferences
export const saveChatPreferences = defaultStore.savePreferences
export const deleteChatConversation = defaultStore.delete
export const clearChatConversations = defaultStore.clear
export const releaseUnreferencedAttachments = defaultStore.releaseUnreferencedAttachments
export const releaseUnreferencedChatAttachments = releaseUnreferencedAttachments
export const getConversationAttachmentBytes = defaultStore.getConversationAttachmentBytes
