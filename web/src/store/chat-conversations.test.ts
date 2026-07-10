import { describe, expect, it } from "vitest"

import type { ChatConversation, PreparedChatAttachment } from "@/app/chat/lib/chat-types"

import {
  ChatStorageQuotaError,
  clearChatConversations,
  createChatConversationStore,
  getChatAttachments,
  getChatConversation,
  saveChatAttachment,
  saveChatConversation,
  type ChatStorageAdapter,
} from "./chat-conversations"

class MemoryStorage implements ChatStorageAdapter {
  readonly values = new Map<string, unknown>()

  async getItem<T>(key: string): Promise<T | null> {
    return (this.values.get(key) as T | undefined) ?? null
  }

  async setItem<T>(key: string, value: T): Promise<T> {
    this.values.set(key, value)
    return value
  }

  async removeItem(key: string): Promise<void> {
    this.values.delete(key)
  }

  async keys(): Promise<string[]> {
    return [...this.values.keys()]
  }
}

class DelayedMemoryStorage extends MemoryStorage {
  activeWrites = 0
  maxActiveWrites = 0

  override async setItem<T>(key: string, value: T): Promise<T> {
    this.activeWrites += 1
    this.maxActiveWrites = Math.max(this.maxActiveWrites, this.activeWrites)
    await new Promise((resolve) => setTimeout(resolve, 5))
    try {
      return await super.setItem(key, value)
    } finally {
      this.activeWrites -= 1
    }
  }
}

class QuotaStorage extends MemoryStorage {
  override async setItem<T>(_key: string, _value: T): Promise<T> {
    throw new DOMException("Storage quota exceeded", "QuotaExceededError")
  }
}

function conversation(id: string, title: string, updatedAt = "2026-07-11T08:00:00.000Z"): ChatConversation {
  return {
    id,
    title,
    createdAt: "2026-07-11T07:00:00.000Z",
    updatedAt,
    model: "gpt-5.2",
    messages: [],
    scrollTop: 0,
  }
}

function attachment(sha256: string, name = "sample.txt", content = "same-content"): PreparedChatAttachment {
  const blob = new Blob([content], { type: "text/plain" })
  return {
    id: `temporary-${name}`,
    name,
    mimeType: "text/plain",
    size: blob.size,
    sha256,
    kind: "document",
    blob,
  }
}

function conversationWithAttachments(id: string, title: string, attachmentIds: string[]): ChatConversation {
  return {
    ...conversation(id, title),
    messages: [
      {
        id: `${id}-message`,
        role: "user",
        text: title,
        attachmentIds,
        status: "complete",
        createdAt: "2026-07-11T07:30:00.000Z",
      },
    ],
  }
}

describe("chat conversation store", () => {
  it("isolates conversations by required encoded subject id", async () => {
    const conversations = new MemoryStorage()
    const store = createChatConversationStore({
      conversations,
      attachments: new MemoryStorage(),
    })

    await store.save("alice@example.com", conversation("same-id", "Alice"))
    await store.save("bob@example.com", conversation("same-id", "Bob"))

    await expect(store.get("alice@example.com", "same-id")).resolves.toMatchObject({ title: "Alice" })
    await expect(store.get("bob@example.com", "same-id")).resolves.toMatchObject({ title: "Bob" })
    await expect(store.list("alice@example.com")).resolves.toHaveLength(1)
    await expect(store.list("")).rejects.toThrow(/subjectId/)
    expect(await conversations.keys()).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^alice%40example\.com:/),
        expect.stringMatching(/^bob%40example\.com:/),
      ]),
    )
  })

  it("uses the full sha256 as an attachment id and deduplicates only within a subject", async () => {
    const attachments = new MemoryStorage()
    const store = createChatConversationStore({
      conversations: new MemoryStorage(),
      attachments,
    })
    const sha256 = "a".repeat(64)

    const first = await store.saveAttachment("alice", attachment(sha256, "first.txt"))
    const duplicate = await store.saveAttachment("alice", attachment(sha256, "duplicate.txt"))
    const otherSubject = await store.saveAttachment("bob", attachment(sha256, "bob.txt"))

    expect(first.id).toBe(sha256)
    expect(duplicate.id).toBe(sha256)
    expect(otherSubject.id).toBe(sha256)
    expect(await attachments.keys()).toEqual([
      `alice:attachment:${sha256}`,
      `bob:attachment:${sha256}`,
    ])
    await expect(store.getAttachments("alice", [sha256])).resolves.toEqual([first])
  })

  it("keeps shared attachments until the final conversation reference is deleted", async () => {
    const store = createChatConversationStore({
      conversations: new MemoryStorage(),
      attachments: new MemoryStorage(),
    })
    const shared = "b".repeat(64)
    const firstOnly = "c".repeat(64)
    await store.saveAttachment("alice", attachment(shared, "shared.txt"))
    await store.saveAttachment("alice", attachment(firstOnly, "first.txt"))
    await store.save("alice", conversationWithAttachments("first", "First", [shared, firstOnly]))
    await store.save("alice", conversationWithAttachments("second", "Second", [shared]))

    await store.delete("alice", "first")

    await expect(store.getAttachments("alice", [shared, firstOnly])).resolves.toHaveLength(1)
    await expect(store.getAttachments("alice", [shared])).resolves.toHaveLength(1)

    await store.delete("alice", "second")

    await expect(store.getAttachments("alice", [shared])).resolves.toEqual([])
  })

  it("clears conversations and attachments for only one subject", async () => {
    const store = createChatConversationStore({
      conversations: new MemoryStorage(),
      attachments: new MemoryStorage(),
    })
    const digest = "d".repeat(64)
    for (const subjectId of ["alice", "bob"]) {
      await store.saveAttachment(subjectId, attachment(digest, `${subjectId}.txt`))
      await store.save(subjectId, conversationWithAttachments("conversation", subjectId, [digest]))
    }

    await store.clear("alice")

    await expect(store.list("alice")).resolves.toEqual([])
    await expect(store.getAttachments("alice", [digest])).resolves.toEqual([])
    await expect(store.list("bob")).resolves.toHaveLength(1)
    await expect(store.getAttachments("bob", [digest])).resolves.toHaveLength(1)
  })

  it("round-trips active conversation, selected model, and scroll preferences", async () => {
    const conversations = new MemoryStorage()
    const store = createChatConversationStore({
      conversations,
      attachments: new MemoryStorage(),
    })
    const preferences = {
      activeConversationId: "conversation/with spaces",
      selectedModel: "gpt-5.2-thinking",
      scrollPositions: {
        "conversation/with spaces": 345.5,
        other: 0,
      },
    }

    await store.savePreferences("alice@example.com", preferences)

    await expect(store.getPreferences("alice@example.com")).resolves.toEqual(preferences)
    await expect(store.getPreferences("bob@example.com")).resolves.toEqual({
      activeConversationId: null,
      selectedModel: "auto",
      scrollPositions: {},
    })
    expect(await conversations.keys()).toContain("alice%40example.com:preferences")
  })

  it("renames a conversation and counts only its unique referenced attachment bytes", async () => {
    const store = createChatConversationStore({
      conversations: new MemoryStorage(),
      attachments: new MemoryStorage(),
    })
    const first = "e".repeat(64)
    const second = "f".repeat(64)
    await store.saveAttachment("alice", attachment(first, "first.txt", "1234"))
    await store.saveAttachment("alice", attachment(second, "second.txt", "123456"))
    const item = conversationWithAttachments("one", "Before", [first, first])
    item.messages.push({
      id: "second-message",
      role: "user",
      text: "again",
      attachmentIds: [second, first],
      status: "complete",
      createdAt: "2026-07-11T07:45:00.000Z",
    })
    await store.save("alice", item)

    await store.rename("alice", "one", "After")

    await expect(store.get("alice", "one")).resolves.toMatchObject({ title: "After" })
    await expect(store.getConversationAttachmentBytes("alice", "one")).resolves.toBe(10)
    await expect(store.getConversationAttachmentBytes("alice", "missing")).resolves.toBe(0)
  })

  it("serializes writes per subject and rejects an older concurrent snapshot", async () => {
    const conversations = new DelayedMemoryStorage()
    const store = createChatConversationStore({
      conversations,
      attachments: new MemoryStorage(),
    })
    const newer = conversation("same", "Newer", "2026-07-11T10:00:00.000Z")
    const older = conversation("same", "Older", "2026-07-11T09:00:00.000Z")

    await Promise.all([
      store.save("alice", newer),
      store.save("alice", older),
    ])

    expect(conversations.maxActiveWrites).toBe(1)
    await expect(store.get("alice", "same")).resolves.toMatchObject({
      title: "Newer",
      updatedAt: newer.updatedAt,
    })
  })

  it("deeply removes base64 image payloads before persisting", async () => {
    const store = createChatConversationStore({
      conversations: new MemoryStorage(),
      attachments: new MemoryStorage(),
    })
    const item = {
      ...conversation("images", "Images"),
      messages: [
        {
          id: "assistant",
          role: "assistant",
          text: "done",
          attachmentIds: [],
          status: "complete",
          createdAt: "2026-07-11T07:30:00.000Z",
          images: [
            {
              id: "image",
              status: "success",
              url: "https://example.com/image.png",
              taskId: "task-1",
              b64_json: "large-payload",
              nested: {
                b64Json: "another-large-payload",
                width: 1024,
              },
            },
          ],
        },
      ],
    } as unknown as ChatConversation

    await store.save("alice", item)

    const stored = await store.get("alice", "images")
    expect(JSON.stringify(stored)).not.toContain("large-payload")
    expect(stored?.messages[0]?.images?.[0]).toMatchObject({
      url: "https://example.com/image.png",
      taskId: "task-1",
      nested: { width: 1024 },
    })
  })

  it("wraps quota failures without swallowing the rejected write", async () => {
    const store = createChatConversationStore({
      conversations: new QuotaStorage(),
      attachments: new MemoryStorage(),
    })

    const write = store.save("alice", conversation("quota", "Keep this in memory"))

    await expect(write).rejects.toBeInstanceOf(ChatStorageQuotaError)
    await expect(write).rejects.toMatchObject({
      name: "ChatStorageQuotaError",
      cause: expect.objectContaining({ name: "QuotaExceededError" }),
    })
  })

  it("persists through the default conversation and attachment localforage stores", async () => {
    const subjectId = "indexeddb-user@example.com"
    const digest = "1".repeat(64)

    try {
      const storedAttachment = await saveChatAttachment(
        subjectId,
        attachment(digest, "indexeddb.txt", "indexeddb"),
      )
      await saveChatConversation(
        subjectId,
        conversationWithAttachments("indexeddb-conversation", "IndexedDB", [storedAttachment.id]),
      )

      await expect(getChatConversation(subjectId, "indexeddb-conversation")).resolves.toMatchObject({
        title: "IndexedDB",
      })
      await expect(getChatAttachments(subjectId, [digest])).resolves.toHaveLength(1)
    } finally {
      await clearChatConversations(subjectId)
    }
  })
})
