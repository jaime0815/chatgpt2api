import { act, renderHook, waitFor } from "@testing-library/react"
import { useLayoutEffect, useRef } from "react"
import { describe, expect, it, vi } from "vitest"

import type {
  ChatConversation,
  ChatMessage,
  ChatMessageStatus,
  ChatStreamEvent,
  ChatStreamRequest,
  PreparedChatAttachment,
} from "@/app/chat/lib/chat-types"
import { ChatStorageQuotaError, type ChatPreferences } from "@/store/chat-conversations"

import {
  useChatController,
  type ChatControllerDependencies,
} from "./use-chat-controller"

const SUBJECT_ID = "alice@example.com"
const OTHER_SUBJECT_ID = "bob@example.com"
const START_TIME = Date.parse("2026-07-11T08:00:00.000Z")

function deferred<Value>() {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function attachment(
  character: string,
  name = `${character}.txt`,
  content = `content-${character}`,
): PreparedChatAttachment {
  const sha256 = character.repeat(64)
  const blob = new Blob([content], { type: "text/plain" })
  return {
    id: sha256,
    name,
    mimeType: "text/plain",
    size: blob.size,
    sha256,
    kind: "document",
    blob,
  }
}

function message(
  id: string,
  role: "user" | "assistant",
  text: string,
  status: ChatMessageStatus = "complete",
  attachmentIds: string[] = [],
) {
  return {
    id,
    role,
    text,
    attachmentIds,
    status,
    createdAt: "2026-07-11T07:30:00.000Z",
    ...(status === "error" ? { error: "failed" } : {}),
  } as const
}

function imageTurn(
  id: string,
  text: string,
  attachmentIds: string[] = [],
): ChatMessage {
  return {
    id,
    role: "assistant",
    text,
    attachmentIds,
    status: "complete",
    createdAt: "2026-07-11T07:30:00.000Z",
    imageSettings: {
      mode: attachmentIds.length > 0 ? "edit" : "generate",
      model: "gpt-image-2",
      quality: "high",
      width: "1024",
      height: "1024",
      ratio: "1:1",
      tier: "1k",
      count: 1,
      referenceAttachmentIds: attachmentIds,
    },
    images: [{ id: `${id}-image`, taskId: `${id}-task`, status: "success", url: "/images/result.png" }],
  }
}

function conversation(
  id: string,
  messages: ChatConversation["messages"] = [],
  overrides: Partial<ChatConversation> = {},
): ChatConversation {
  return {
    id,
    title: "Existing conversation",
    createdAt: "2026-07-11T07:00:00.000Z",
    updatedAt: "2026-07-11T07:45:00.000Z",
    model: "gpt-5.2",
    messages,
    scrollTop: 0,
    ...overrides,
  }
}

type QueueEntry = ChatStreamEvent | typeof STREAM_END
const STREAM_END = Symbol("stream-end")

function createEventStream() {
  const entries: QueueEntry[] = []
  const waiters: Array<{
    resolve: (entry: QueueEntry) => void
    reject: (error: unknown) => void
    signal?: AbortSignal
    onAbort?: () => void
  }> = []
  let receivedSignal: AbortSignal | undefined

  function settle(entry: QueueEntry) {
    const waiter = waiters.shift()
    if (!waiter) {
      entries.push(entry)
      return
    }
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener("abort", waiter.onAbort)
    }
    waiter.resolve(entry)
  }

  async function next(signal?: AbortSignal) {
    const queued = entries.shift()
    if (queued) {
      return queued
    }
    if (signal?.aborted) {
      throw new DOMException("The operation was aborted", "AbortError")
    }
    return new Promise<QueueEntry>((resolve, reject) => {
      const waiter = { resolve, reject, signal } as (typeof waiters)[number]
      if (signal) {
        waiter.onAbort = () => {
          const index = waiters.indexOf(waiter)
          if (index >= 0) {
            waiters.splice(index, 1)
          }
          reject(new DOMException("The operation was aborted", "AbortError"))
        }
        signal.addEventListener("abort", waiter.onAbort, { once: true })
      }
      waiters.push(waiter)
    })
  }

  const streamChatFn = vi.fn<ChatControllerDependencies["streamChatFn"]>(
    async function* (
      _request: ChatStreamRequest,
      _attachments: readonly PreparedChatAttachment[],
      signal?: AbortSignal,
    ) {
      receivedSignal = signal
      while (true) {
        const entry = await next(signal)
        if (entry === STREAM_END) {
          return
        }
        yield entry
      }
    },
  )

  return {
    streamChatFn,
    push(event: ChatStreamEvent) {
      settle(event)
    },
    end() {
      settle(STREAM_END)
    },
    get signal() {
      return receivedSignal
    },
  }
}

function createDependencies(options: {
  conversations?: ChatConversation[]
  preferences?: Partial<ChatPreferences>
  attachments?: PreparedChatAttachment[]
  streamChatFn?: ChatControllerDependencies["streamChatFn"]
  operations?: string[]
} = {}) {
  const storedConversations = new Map(
    (options.conversations || []).map((item) => [item.id, item]),
  )
  const storedAttachments = new Map(
    (options.attachments || []).map((item) => [item.id, item]),
  )
  const operations = options.operations || []
  let sequence = 0
  let clock = START_TIME
  let preferences: ChatPreferences = {
    activeConversationId: options.preferences?.activeConversationId ?? null,
    selectedModel: options.preferences?.selectedModel ?? "auto",
    scrollPositions: { ...(options.preferences?.scrollPositions || {}) },
  }

  const dependencies: ChatControllerDependencies = {
    streamChatFn:
      options.streamChatFn ||
      vi.fn<ChatControllerDependencies["streamChatFn"]>(async function* () {
        yield { type: "complete" } as const
      }),
    listConversations: vi.fn(async () => [...storedConversations.values()]),
    saveConversation: vi.fn(async (_subjectId, item) => {
      operations.push(`save-conversation:${item.messages.at(-1)?.status || "empty"}`)
      storedConversations.set(item.id, item)
      return item
    }),
    renameConversation: vi.fn(async (_subjectId, id, title) => {
      const item = storedConversations.get(id)
      if (!item) {
        return null
      }
      const renamed = { ...item, title }
      storedConversations.set(id, renamed)
      return renamed
    }),
    deleteConversation: vi.fn(async (_subjectId, id) => {
      storedConversations.delete(id)
    }),
    clearConversations: vi.fn(async () => {
      storedConversations.clear()
      storedAttachments.clear()
    }),
    releaseUnreferencedAttachments: vi.fn(async () => 0),
    saveAttachment: vi.fn(async (_subjectId, item) => {
      operations.push(`save-attachment:${item.id}`)
      storedAttachments.set(item.id, item)
      return item
    }),
    getAttachments: vi.fn(async (_subjectId, ids: readonly string[]) =>
      ids.flatMap((id) => {
        const item = storedAttachments.get(id)
        return item ? [item] : []
      }),
    ),
    getPreferences: vi.fn(async () => preferences),
    savePreferences: vi.fn(async (_subjectId, nextPreferences) => {
      preferences = nextPreferences
      return preferences
    }),
    now: () => new Date(clock++),
    createId: () => `id-${++sequence}`,
    checkpointDelayMs: 25,
  }

  return { dependencies, operations, storedConversations, storedAttachments }
}

async function renderController(dependencies: ChatControllerDependencies) {
  const hook = renderHook(() => useChatController({ subjectId: SUBJECT_ID, dependencies }))
  await waitFor(() => expect(hook.result.current.state.isLoading).toBe(false))
  return hook
}

async function renderSubjectController(dependencies: ChatControllerDependencies) {
  const hook = renderHook(
    ({ subjectId }: { subjectId: string }) => useChatController({ subjectId, dependencies }),
    { initialProps: { subjectId: SUBJECT_ID } },
  )
  await waitFor(() => expect(hook.result.current.state.isLoading).toBe(false))
  return hook
}

describe("useChatController", () => {
  it("binds stream requests to the authenticated workspace key", async () => {
    const streamChatFn = vi.fn<ChatControllerDependencies["streamChatFn"]>(async function* () {
      yield { type: "complete" } as const
    })
    const { dependencies } = createDependencies({ streamChatFn })
    const hook = renderHook(() =>
      useChatController({
        subjectId: SUBJECT_ID,
        authKey: "workspace-a-key",
        dependencies,
      }),
    )
    await waitFor(() => expect(hook.result.current.state.isLoading).toBe(false))

    await act(async () => {
      await hook.result.current.sendText({ text: "send with workspace key" })
    })

    expect(streamChatFn).toHaveBeenCalledWith(
      expect.any(Object),
      [],
      expect.any(AbortSignal),
      "workspace-a-key",
    )
  })

  it("adds optimistic messages, accumulates deltas, generates a title, and sends thinking_effort", async () => {
    const events = createEventStream()
    const { dependencies } = createDependencies({ streamChatFn: events.streamChatFn })
    const { result } = await renderController(dependencies)
    let sending!: Promise<void>

    act(() => {
      sending = result.current.sendText({ text: "  First   useful question  " })
    })

    await waitFor(() => expect(result.current.activeConversation?.messages).toHaveLength(2))
    expect(result.current.activeConversation).toMatchObject({
      title: "First useful question",
      model: "auto",
      messages: [
        { role: "user", text: "First   useful question", status: "complete" },
        { role: "assistant", text: "", status: "streaming" },
      ],
    })
    expect(result.current.isStreaming).toBe(true)

    await act(async () => {
      events.push({ type: "delta", content: "Hello" })
    })
    await waitFor(() => expect(result.current.activeConversation?.messages[1]?.text).toBe("Hello"))
    await act(async () => {
      events.push({ type: "delta", content: " world" })
      events.push({ type: "complete" })
      await sending
    })

    expect(result.current.activeConversation?.messages[1]).toMatchObject({
      text: "Hello world",
      status: "complete",
    })
    expect(result.current.isStreaming).toBe(false)
    const request = events.streamChatFn.mock.calls[0]?.[0]
    expect(request).toMatchObject({ model: "auto", thinking_effort: undefined })
    expect(request).not.toHaveProperty("reasoning_effort")
  })

  it("keeps error, DONE, and stopped assistant states terminal", async () => {
    const errorStream = vi.fn<ChatControllerDependencies["streamChatFn"]>(async function* () {
      yield { type: "delta", content: "partial" } as const
      yield { type: "error", message: "upstream failed", code: "upstream_error" } as const
      yield { type: "complete" } as const
    })
    const first = createDependencies({ streamChatFn: errorStream })
    const errorHook = await renderController(first.dependencies)

    await act(async () => {
      await errorHook.result.current.sendText({ text: "fail" })
    })
    expect(errorHook.result.current.activeConversation?.messages.at(-1)).toMatchObject({
      text: "partial",
      status: "error",
      error: "upstream failed",
    })

    const doneThenError = vi.fn<ChatControllerDependencies["streamChatFn"]>(async function* () {
      yield { type: "complete" } as const
      yield { type: "error", message: "late error" } as const
    })
    const second = createDependencies({ streamChatFn: doneThenError })
    const completeHook = await renderController(second.dependencies)
    await act(async () => {
      await completeHook.result.current.sendText({ text: "complete" })
    })
    expect(completeHook.result.current.activeConversation?.messages.at(-1)?.status).toBe("complete")

    const events = createEventStream()
    const third = createDependencies({ streamChatFn: events.streamChatFn })
    const stoppedHook = await renderController(third.dependencies)
    let sending!: Promise<void>
    act(() => {
      sending = stoppedHook.result.current.sendText({ text: "stop" })
    })
    await waitFor(() => expect(stoppedHook.result.current.isStreaming).toBe(true))
    await act(async () => {
      events.push({ type: "delta", content: "kept" })
    })
    await waitFor(() =>
      expect(stoppedHook.result.current.activeConversation?.messages.at(-1)?.text).toBe("kept"),
    )
    await act(async () => {
      stoppedHook.result.current.stop()
      await sending
    })
    expect(events.signal?.aborted).toBe(true)
    expect(stoppedHook.result.current.activeConversation?.messages.at(-1)).toMatchObject({
      text: "kept",
      status: "stopped",
    })
  })

  it("retries an assistant response without duplicating its user message", async () => {
    const existing = conversation("conversation-1", [
      message("user-1", "user", "original prompt"),
      message("assistant-1", "assistant", "failed answer", "error"),
    ])
    const streamChatFn = vi.fn<ChatControllerDependencies["streamChatFn"]>(async function* () {
      yield { type: "delta", content: "replacement" } as const
      yield { type: "complete" } as const
    })
    const { dependencies } = createDependencies({
      conversations: [existing],
      preferences: { activeConversationId: existing.id },
      streamChatFn,
    })
    const { result } = await renderController(dependencies)

    await act(async () => {
      await result.current.retryAssistant("assistant-1")
    })

    expect(result.current.activeConversation?.messages).toEqual([
      expect.objectContaining({ id: "user-1", role: "user", text: "original prompt" }),
      expect.objectContaining({ role: "assistant", text: "replacement", status: "complete" }),
    ])
    expect(streamChatFn.mock.calls[0]?.[0].messages).toEqual([
      expect.objectContaining({ id: "user-1", role: "user", text: "original prompt" }),
    ])
  })

  it("keeps a generated image in the timeline but omits it from a later text request", async () => {
    const generated = imageTurn("generated-turn", "draw a neon city")
    const existing = conversation("conversation-1", [
      message("user-1", "user", "before image"),
      generated,
    ])
    const streamChatFn = vi.fn<ChatControllerDependencies["streamChatFn"]>(async function* () {
      yield { type: "complete" } as const
    })
    const { dependencies } = createDependencies({
      conversations: [existing],
      preferences: { activeConversationId: existing.id },
      streamChatFn,
    })
    const { result } = await renderController(dependencies)

    await act(async () => {
      await result.current.sendText({ text: "now summarize the approach" })
    })

    expect(result.current.activeConversation?.messages).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: generated.id, text: generated.text })]),
    )
    expect(streamChatFn.mock.calls[0]?.[0].messages).toEqual([
      expect.objectContaining({ id: "user-1", text: "before image" }),
      expect.objectContaining({ text: "now summarize the approach" }),
    ])
  })

  it("omits referenced image edits and their files from a later text request", async () => {
    const reference = attachment("r", "reference.png", "reference")
    const editedImage = imageTurn("edited-turn", "make it brighter", [reference.id])
    const existing = conversation("conversation-1", [
      message("user-1", "user", "before edit"),
      editedImage,
    ])
    const streamChatFn = vi.fn<ChatControllerDependencies["streamChatFn"]>(async function* () {
      yield { type: "complete" } as const
    })
    const { dependencies } = createDependencies({
      conversations: [existing],
      preferences: { activeConversationId: existing.id },
      attachments: [reference],
      streamChatFn,
    })
    const { result } = await renderController(dependencies)

    await act(async () => {
      await result.current.sendText({ text: "continue as plain text" })
    })

    const [request, attachments] = streamChatFn.mock.calls[0]!
    expect(request.messages).toEqual([
      expect.objectContaining({ id: "user-1", attachment_ids: [] }),
      expect.objectContaining({ text: "continue as plain text", attachment_ids: [] }),
    ])
    expect(request.attachments).toEqual([])
    expect(attachments).toEqual([])
    expect(dependencies.getAttachments).not.toHaveBeenCalled()
  })

  it("keeps legacy text attachment ids locally but excludes them from a text follow-up request", async () => {
    const legacyDocument = attachment("l", "legacy.pdf")
    const legacyImage = {
      ...attachment("m", "legacy.png"),
      mimeType: "image/png",
      kind: "image" as const,
    }
    const existing = conversation("conversation-1", [
      message("user-1", "user", "legacy attachments", "complete", [legacyDocument.id, legacyImage.id]),
      message("assistant-1", "assistant", "stored answer"),
    ])
    const streamChatFn = vi.fn<ChatControllerDependencies["streamChatFn"]>(async function* () {
      yield { type: "complete" } as const
    })
    const { dependencies } = createDependencies({
      conversations: [existing],
      preferences: { activeConversationId: existing.id },
      attachments: [legacyDocument, legacyImage],
      streamChatFn,
    })
    const { result } = await renderController(dependencies)

    await act(async () => {
      await result.current.sendText({ text: "plain follow-up" })
    })

    expect(result.current.activeConversation?.messages[0]?.attachmentIds).toEqual([
      legacyDocument.id,
      legacyImage.id,
    ])
    const [request, streamedAttachments] = streamChatFn.mock.calls[0]!
    expect(request.messages.map((item) => item.attachment_ids)).toEqual([[], [], []])
    expect(request.attachments).toEqual([])
    expect(streamedAttachments).toEqual([])
    expect(dependencies.getAttachments).not.toHaveBeenCalled()
  })

  it("excludes legacy text attachments from a retry request", async () => {
    const legacyDocument = attachment("n", "retry.pdf")
    const existing = conversation("conversation-1", [
      message("user-1", "user", "legacy retry", "complete", [legacyDocument.id]),
      message("assistant-1", "assistant", "failed answer", "error"),
    ])
    const streamChatFn = vi.fn<ChatControllerDependencies["streamChatFn"]>(async function* () {
      yield { type: "complete" } as const
    })
    const { dependencies } = createDependencies({
      conversations: [existing],
      preferences: { activeConversationId: existing.id },
      attachments: [legacyDocument],
      streamChatFn,
    })
    const { result } = await renderController(dependencies)

    await act(async () => {
      await result.current.retryAssistant("assistant-1")
    })

    expect(result.current.activeConversation?.messages[0]?.attachmentIds).toEqual([legacyDocument.id])
    const [request, streamedAttachments] = streamChatFn.mock.calls[0]!
    expect(request.messages.map((item) => item.attachment_ids)).toEqual([[]])
    expect(request.attachments).toEqual([])
    expect(streamedAttachments).toEqual([])
    expect(dependencies.getAttachments).not.toHaveBeenCalled()
  })

  it("uses the same filtered history when retrying text after an image turn", async () => {
    const reference = attachment("s", "reference.png", "reference")
    const existing = conversation("conversation-1", [
      message("user-1", "user", "before image"),
      imageTurn("edited-turn", "edit the reference", [reference.id]),
      message("user-2", "user", "text question"),
      message("assistant-2", "assistant", "failed answer", "error"),
    ])
    const streamChatFn = vi.fn<ChatControllerDependencies["streamChatFn"]>(async function* () {
      yield { type: "complete" } as const
    })
    const { dependencies } = createDependencies({
      conversations: [existing],
      preferences: { activeConversationId: existing.id },
      attachments: [reference],
      streamChatFn,
    })
    const { result } = await renderController(dependencies)

    await act(async () => {
      await result.current.retryAssistant("assistant-2")
    })

    const [request, attachments] = streamChatFn.mock.calls[0]!
    expect(request.messages.map((item) => item.id)).toEqual(["user-1", "user-2"])
    expect(request.attachments).toEqual([])
    expect(attachments).toEqual([])
    expect(dependencies.getAttachments).not.toHaveBeenCalled()
  })

  it("upserts image-task messages into the active conversation and persists their references", async () => {
    const imageReference = {
      ...attachment("i", "reference.png", "image-content"),
      mimeType: "image/png",
      kind: "image" as const,
    }
    const { dependencies, storedAttachments } = createDependencies()
    const { result } = await renderController(dependencies)
    const pendingImage = {
      id: "image-message",
      role: "assistant" as const,
      text: "",
      attachmentIds: [imageReference.id],
      status: "queued" as const,
      createdAt: "2026-07-11T08:00:00.000Z",
      images: [{ id: "image-1", taskId: "task-1", status: "queued" as const }],
    }

    await act(async () => {
      await result.current.upsertMessage(pendingImage, [imageReference])
    })

    expect(result.current.activeConversation?.messages).toEqual([pendingImage])
    expect(storedAttachments.get(imageReference.id)).toMatchObject({
      id: imageReference.id,
      kind: "image",
    })

    const completedImage = {
      ...pendingImage,
      status: "complete" as const,
      images: [
        {
          id: "image-1",
          taskId: "task-1",
          status: "success" as const,
          url: "/images/task-1.png",
        },
      ],
    }
    await act(async () => {
      await result.current.upsertMessage(completedImage)
    })

    expect(result.current.activeConversation?.messages).toEqual([completedImage])
    expect(dependencies.saveConversation).toHaveBeenCalled()
  })

  it("does not upsert a delayed image message after the chat subject changes", async () => {
    const imageReference = {
      ...attachment("i", "reference.png", "image-content"),
      mimeType: "image/png",
      kind: "image" as const,
    }
    const saveAttachment = deferred<PreparedChatAttachment>()
    const { dependencies } = createDependencies()
    dependencies.saveAttachment = vi.fn(async () => saveAttachment.promise)
    const hook = await renderSubjectController(dependencies)
    const imageMessage: ChatMessage = {
      id: "delayed-image-message",
      role: "assistant",
      text: "city",
      attachmentIds: [imageReference.id],
      status: "queued",
      createdAt: "2026-07-11T08:00:00.000Z",
      images: [{ id: "image-1", taskId: "task-1", status: "queued" }],
    }

    let upserting!: Promise<unknown>
    act(() => {
      upserting = hook.result.current.upsertMessage(imageMessage, [imageReference])
    })
    await waitFor(() => expect(dependencies.saveAttachment).toHaveBeenCalledTimes(1))

    hook.rerender({ subjectId: OTHER_SUBJECT_ID })
    await waitFor(() => expect(hook.result.current.state.subjectId).toBe(OTHER_SUBJECT_ID))
    await waitFor(() => expect(hook.result.current.state.isLoading).toBe(false))

    await act(async () => {
      saveAttachment.resolve(imageReference)
      await upserting
    })

    expect(hook.result.current.state.conversations).toEqual([])
  })

  it("serializes concurrent image-message upserts that need attachment persistence", async () => {
    const firstReference = {
      ...attachment("a", "first.png", "first-image"),
      mimeType: "image/png",
      kind: "image" as const,
    }
    const secondReference = {
      ...attachment("b", "second.png", "second-image"),
      mimeType: "image/png",
      kind: "image" as const,
    }
    const firstSave = deferred<PreparedChatAttachment>()
    const secondSave = deferred<PreparedChatAttachment>()
    const { dependencies } = createDependencies()
    let saveCount = 0
    dependencies.saveAttachment = vi.fn(async () => {
      saveCount += 1
      return saveCount === 1 ? firstSave.promise : secondSave.promise
    })
    const { result } = await renderController(dependencies)
    const firstMessage: ChatMessage = {
      id: "first-image-message",
      role: "assistant",
      text: "first",
      attachmentIds: [firstReference.id],
      status: "queued",
      createdAt: "2026-07-11T08:00:00.000Z",
      images: [{ id: "first-image", taskId: "first-task", status: "queued" }],
    }
    const secondMessage: ChatMessage = {
      id: "second-image-message",
      role: "assistant",
      text: "second",
      attachmentIds: [secondReference.id],
      status: "queued",
      createdAt: "2026-07-11T08:00:01.000Z",
      images: [{ id: "second-image", taskId: "second-task", status: "queued" }],
    }

    let firstUpsert!: Promise<unknown>
    let secondUpsert!: Promise<unknown>
    act(() => {
      firstUpsert = result.current.upsertMessage(firstMessage, [firstReference])
      secondUpsert = result.current.upsertMessage(secondMessage, [secondReference])
    })
    await waitFor(() => expect(dependencies.saveAttachment).toHaveBeenCalledTimes(1))

    await act(async () => {
      firstSave.resolve(firstReference)
    })
    await waitFor(() => expect(dependencies.saveAttachment).toHaveBeenCalledTimes(2))
    await act(async () => {
      secondSave.resolve(secondReference)
      await Promise.all([firstUpsert, secondUpsert])
    })

    expect(result.current.state.conversations).toHaveLength(1)
    expect(result.current.activeConversation?.messages).toEqual([firstMessage, secondMessage])
  })

  it("does not recreate a deleted owner conversation for a late image update", async () => {
    const existing = conversation("deleted-conversation")
    const { dependencies } = createDependencies({ conversations: [existing] })
    const { result } = await renderController(dependencies)
    const lateImageMessage: ChatMessage = {
      id: "late-image-message",
      role: "assistant",
      text: "city",
      attachmentIds: [],
      status: "complete",
      createdAt: "2026-07-11T08:00:00.000Z",
      images: [{ id: "image-1", taskId: "task-1", status: "success", url: "/images/task-1.png" }],
    }

    await act(async () => {
      await result.current.deleteConversation(existing.id)
    })
    await act(async () => {
      await result.current.upsertMessage(lateImageMessage, [], {
        conversationId: existing.id,
      })
    })

    expect(result.current.state.conversations).toEqual([])
  })

  it("drops cached attachments when deleting or clearing their last conversation reference", async () => {
    const cachedAttachment = attachment("z", "cached.txt")
    const { dependencies } = createDependencies({ attachments: [cachedAttachment] })
    const getAttachments = vi.mocked(dependencies.getAttachments)
    const { result } = await renderController(dependencies)
    const sourceMessage: ChatMessage = {
      id: "cache-source",
      role: "assistant",
      text: "stored reference",
      attachmentIds: [cachedAttachment.id],
      status: "complete",
      createdAt: "2026-07-11T08:00:00.000Z",
    }

    await act(async () => {
      await result.current.upsertMessage(sourceMessage, [cachedAttachment])
    })
    const sourceConversationId = result.current.activeConversation?.id
    expect(sourceConversationId).toBeTruthy()

    await act(async () => {
      await result.current.deleteConversation(sourceConversationId!)
    })
    getAttachments.mockClear()

    await expect(result.current.resolveAttachments([cachedAttachment.id])).resolves.toEqual([])
    expect(getAttachments).not.toHaveBeenCalled()

    await act(async () => {
      await result.current.upsertMessage(
        { ...sourceMessage, id: "cache-source-after-delete" },
        [cachedAttachment],
      )
    })
    expect(await result.current.resolveAttachments([cachedAttachment.id])).toEqual([cachedAttachment])

    getAttachments.mockClear()
    await act(async () => {
      await result.current.clearHistory()
    })
    await expect(result.current.resolveAttachments([cachedAttachment.id])).resolves.toEqual([])
    expect(getAttachments).not.toHaveBeenCalled()
  })

  it("edits a user message, preserves omitted attachment references, and truncates its branch", async () => {
    const originalAttachment = attachment("a")
    const existing = conversation("conversation-1", [
      message("user-1", "user", "old prompt", "complete", [originalAttachment.id]),
      message("assistant-1", "assistant", "first answer"),
      message("user-2", "user", "follow-up"),
      message("assistant-2", "assistant", "second answer"),
    ])
    const streamChatFn = vi.fn<ChatControllerDependencies["streamChatFn"]>(async function* () {
      yield { type: "complete" } as const
    })
    const { dependencies } = createDependencies({
      conversations: [existing],
      preferences: { activeConversationId: existing.id },
      attachments: [originalAttachment],
      streamChatFn,
    })
    const { result } = await renderController(dependencies)

    await act(async () => {
      await result.current.editAndResend("user-1", { text: "edited prompt" })
    })

    expect(result.current.activeConversation?.messages).toEqual([
      expect.objectContaining({
        id: "user-1",
        role: "user",
        text: "edited prompt",
        attachmentIds: [originalAttachment.id],
      }),
      expect.objectContaining({ role: "assistant", status: "complete" }),
    ])
    expect(streamChatFn.mock.calls[0]?.[0].messages).toEqual([
      expect.objectContaining({
        id: "user-1",
        text: "edited prompt",
        attachment_ids: [],
      }),
    ])
    expect(streamChatFn.mock.calls[0]?.[0].attachments).toEqual([])
    expect(streamChatFn.mock.calls[0]?.[1]).toEqual([])
    expect(dependencies.getAttachments).not.toHaveBeenCalled()
    expect(dependencies.releaseUnreferencedAttachments).toHaveBeenCalledWith(SUBJECT_ID)
  })

  it("releases cached image references when an edit truncates their branch", async () => {
    const imageReference = {
      ...attachment("p", "branch-reference.png"),
      mimeType: "image/png",
      kind: "image" as const,
    }
    const existing = conversation("conversation-1", [
      message("user-1", "user", "old prompt"),
      message("assistant-1", "assistant", "first answer"),
    ])
    const streamChatFn = vi.fn<ChatControllerDependencies["streamChatFn"]>(async function* () {
      yield { type: "complete" } as const
    })
    const { dependencies } = createDependencies({
      conversations: [existing],
      preferences: { activeConversationId: existing.id },
      streamChatFn,
    })
    const { result } = await renderController(dependencies)
    const imageMessage = imageTurn("branch-image", "draw city", [imageReference.id])

    await act(async () => {
      await result.current.upsertMessage(imageMessage, [imageReference], {
        conversationId: existing.id,
      })
    })
    expect(await result.current.resolveAttachments([imageReference.id])).toEqual([imageReference])

    await act(async () => {
      await result.current.editAndResend("user-1", { text: "edited prompt" })
    })
    vi.mocked(dependencies.getAttachments).mockClear()

    await expect(result.current.resolveAttachments([imageReference.id])).resolves.toEqual([])
    expect(dependencies.getAttachments).not.toHaveBeenCalled()
  })

  it("persists new Blobs locally without forwarding text attachments to the stream", async () => {
    const oldAttachment = attachment("a", "old.txt")
    const newAttachment = attachment("b", "new.txt")
    const unusedAttachment = attachment("c", "unused.txt")
    const existing = conversation(
      "conversation-1",
      [message("user-1", "user", "with old", "complete", [oldAttachment.id, oldAttachment.id])],
      { reasoningEffort: "high" },
    )
    const operations: string[] = []
    const streamChatFn = vi.fn<ChatControllerDependencies["streamChatFn"]>(async function* () {
      yield { type: "complete" } as const
    })
    const { dependencies } = createDependencies({
      conversations: [existing],
      preferences: { activeConversationId: existing.id },
      attachments: [oldAttachment, unusedAttachment],
      streamChatFn,
      operations,
    })
    const { result } = await renderController(dependencies)
    operations.length = 0

    await act(async () => {
      await result.current.sendText({
        text: "with new",
        attachments: [newAttachment, newAttachment],
      })
    })

    expect(operations[0]).toBe(`save-attachment:${newAttachment.id}`)
    expect(operations[1]).toMatch(/^save-conversation:/)
    expect(dependencies.saveAttachment).toHaveBeenCalledTimes(1)
    const [request, streamedAttachments] = streamChatFn.mock.calls[0]!
    expect(request.thinking_effort).toBe("high")
    expect(request.messages.map((item) => item.attachment_ids)).toEqual([[], []])
    expect(request.attachments).toEqual([])
    expect(streamedAttachments).toEqual([])
    expect(result.current.activeConversation?.messages.find((item) => item.role === "user" && item.text === "with new")?.attachmentIds).toEqual([
      newAttachment.id,
    ])
  })

  it("persists debounced streaming checkpoints and the final state", async () => {
    const events = createEventStream()
    const { dependencies } = createDependencies({ streamChatFn: events.streamChatFn })
    const { result } = await renderController(dependencies)
    vi.useFakeTimers()
    try {
      let sending!: Promise<void>
      act(() => {
        sending = result.current.sendText({ text: "checkpoint" })
      })
      await act(async () => {
        await Promise.resolve()
      })
      expect(dependencies.saveConversation).toHaveBeenCalledTimes(1)

      await act(async () => {
        events.push({ type: "delta", content: "one" })
        events.push({ type: "delta", content: " two" })
      })
      expect(dependencies.saveConversation).toHaveBeenCalledTimes(1)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(25)
      })
      expect(dependencies.saveConversation).toHaveBeenCalledTimes(2)
      expect(dependencies.saveConversation).toHaveBeenLastCalledWith(
        SUBJECT_ID,
        expect.objectContaining({
          messages: expect.arrayContaining([expect.objectContaining({ text: "one two" })]),
        }),
      )

      await act(async () => {
        events.push({ type: "complete" })
        await sending
      })
      expect(dependencies.saveConversation).toHaveBeenCalledTimes(3)
      expect(dependencies.saveConversation).toHaveBeenLastCalledWith(
        SUBJECT_ID,
        expect.objectContaining({
          messages: expect.arrayContaining([expect.objectContaining({ status: "complete" })]),
        }),
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it("restores and updates active, model, and scroll preferences", async () => {
    const first = conversation("first", [], { model: "gpt-5.2", scrollTop: 10 })
    const second = conversation("second", [], { model: "gpt-5.4", scrollTop: 20 })
    const { dependencies } = createDependencies({
      conversations: [first, second],
      preferences: {
        activeConversationId: first.id,
        selectedModel: "gpt-5.2",
        scrollPositions: { first: 10, second: 20 },
      },
    })
    const { result } = await renderController(dependencies)

    await act(async () => {
      await result.current.selectConversation(second.id)
      await result.current.setSelectedModel("gpt-5.4-thinking")
      await result.current.setScrollPosition(second.id, 375.5)
    })

    expect(result.current.state).toMatchObject({
      activeConversationId: second.id,
      selectedModel: "gpt-5.4-thinking",
      scrollPositions: { first: 10, second: 375.5 },
    })
    expect(result.current.activeConversation).toMatchObject({
      id: second.id,
      model: "gpt-5.4-thinking",
      scrollTop: 375.5,
    })
    expect(dependencies.savePreferences).toHaveBeenLastCalledWith(SUBJECT_ID, {
      activeConversationId: second.id,
      selectedModel: "gpt-5.4-thinking",
      scrollPositions: { first: 10, second: 375.5 },
    })
  })

  it("restores interrupted text streams as stopped and uses the active conversation model", async () => {
    const interrupted = conversation(
      "interrupted",
      [
        message("user-1", "user", "resume context"),
        message("assistant-1", "assistant", "partial answer", "streaming"),
      ],
      { model: "gpt-5.4-thinking" },
    )
    const { dependencies } = createDependencies({
      conversations: [interrupted],
      preferences: {
        activeConversationId: interrupted.id,
        selectedModel: "auto",
      },
    })

    const { result } = await renderController(dependencies)

    expect(result.current.state.selectedModel).toBe("gpt-5.4-thinking")
    expect(result.current.activeConversation?.messages.at(-1)).toMatchObject({
      text: "partial answer",
      status: "stopped",
    })
    expect(result.current.isStreaming).toBe(false)
  })

  it("does not reorder an old conversation when only its scroll position changes", async () => {
    const older = conversation("older", [], {
      updatedAt: "2026-07-10T08:00:00.000Z",
      scrollTop: 0,
    })
    const newer = conversation("newer", [], {
      updatedAt: "2026-07-11T08:00:00.000Z",
      scrollTop: 0,
    })
    const { dependencies } = createDependencies({
      conversations: [older, newer],
      preferences: {
        activeConversationId: older.id,
        scrollPositions: { older: 0, newer: 0 },
      },
    })
    const { result } = await renderController(dependencies)

    await act(async () => {
      await result.current.setScrollPosition(older.id, 240)
    })

    expect(result.current.state.conversations.map((item) => item.id)).toEqual(["newer", "older"])
    expect(result.current.state.conversations.find((item) => item.id === older.id)).toMatchObject({
      updatedAt: older.updatedAt,
      scrollTop: 240,
    })
  })

  it("supports conversation create, rename, select, delete, and clear commands", async () => {
    const { dependencies } = createDependencies()
    const { result } = await renderController(dependencies)
    let firstId = ""
    let secondId = ""

    await act(async () => {
      firstId = await result.current.createConversation()
      await result.current.renameConversation(firstId, "Renamed")
      secondId = await result.current.createConversation()
      await result.current.selectConversation(firstId)
    })
    expect(result.current.state.conversations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: firstId, title: "Renamed" }),
        expect.objectContaining({ id: secondId }),
      ]),
    )
    expect(result.current.state.activeConversationId).toBe(firstId)

    await act(async () => {
      await result.current.deleteConversation(firstId)
    })
    expect(result.current.state.conversations.map((item) => item.id)).toEqual([secondId])
    expect(result.current.state.activeConversationId).toBe(secondId)

    await act(async () => {
      await result.current.clearHistory()
    })
    expect(result.current.state.conversations).toEqual([])
    expect(result.current.state.activeConversationId).toBeNull()
    expect(dependencies.clearConversations).toHaveBeenCalledWith(SUBJECT_ID)
  })

  it("keeps messages and streaming alive when attachment persistence hits quota", async () => {
    const newAttachment = attachment("d", "quota.txt")
    const streamChatFn = vi.fn<ChatControllerDependencies["streamChatFn"]>(async function* () {
      yield { type: "delta", content: "still answered" } as const
      yield { type: "complete" } as const
    })
    const { dependencies } = createDependencies({ streamChatFn })
    dependencies.saveAttachment = vi.fn(async () => {
      throw new ChatStorageQuotaError(
        new DOMException("Storage quota exceeded", "QuotaExceededError"),
      )
    })
    const { result } = await renderController(dependencies)

    await act(async () => {
      await result.current.sendText({ text: "keep my input", attachments: [newAttachment] })
    })

    expect(result.current.state.storageWarning).toContain("当前对话无法写入本地历史")
    expect(result.current.activeConversation?.messages).toEqual([
      expect.objectContaining({ text: "keep my input", attachmentIds: [newAttachment.id] }),
      expect.objectContaining({ text: "still answered", status: "complete" }),
    ])
    expect(streamChatFn.mock.calls[0]?.[1]).toEqual([])
  })

  it("keeps quota-failed image references available for a retry resolver", async () => {
    const imageReference = {
      ...attachment("q", "quota-reference.png"),
      mimeType: "image/png",
      kind: "image" as const,
    }
    const { dependencies } = createDependencies()
    dependencies.saveAttachment = vi.fn(async () => {
      throw new ChatStorageQuotaError(
        new DOMException("Storage quota exceeded", "QuotaExceededError"),
      )
    })
    const { result } = await renderController(dependencies)
    const pendingImage = imageTurn("quota-image", "draw city", [imageReference.id])

    await act(async () => {
      await result.current.upsertMessage(pendingImage, [imageReference])
    })

    const resolved = await result.current.resolveAttachments([imageReference.id])
    expect(resolved).toEqual([imageReference])
    expect(dependencies.getAttachments).not.toHaveBeenCalled()
  })

  it("does not expose a delayed attachment read after the chat subject changes", async () => {
    const imageReference = {
      ...attachment("r", "subject-reference.png"),
      mimeType: "image/png",
      kind: "image" as const,
    }
    const aliceRead = deferred<PreparedChatAttachment[]>()
    const existing = conversation("alice-conversation", [
      message("alice-user", "user", "attached", "complete", [imageReference.id]),
    ])
    const { dependencies } = createDependencies({
      conversations: [existing],
      preferences: { activeConversationId: existing.id },
    })
    dependencies.listConversations = vi.fn(async (subjectId) =>
      subjectId === SUBJECT_ID ? [existing] : [],
    )
    dependencies.getPreferences = vi.fn(async (subjectId) => ({
      activeConversationId: subjectId === SUBJECT_ID ? existing.id : null,
      selectedModel: "auto",
      scrollPositions: {},
    }))
    dependencies.getAttachments = vi.fn(async (subjectId) =>
      subjectId === SUBJECT_ID ? aliceRead.promise : [],
    )
    const hook = await renderSubjectController(dependencies)

    let resolving!: Promise<PreparedChatAttachment[]>
    act(() => {
      resolving = hook.result.current.resolveAttachments([imageReference.id])
    })
    await waitFor(() =>
      expect(dependencies.getAttachments).toHaveBeenCalledWith(SUBJECT_ID, [imageReference.id]),
    )

    hook.rerender({ subjectId: OTHER_SUBJECT_ID })
    await waitFor(() => expect(hook.result.current.state.isLoading).toBe(false))
    await act(async () => {
      aliceRead.resolve([imageReference])
      await expect(resolving).resolves.toEqual([])
    })
  })

  it("isolates the rendered state and blocks writes during a synchronous subject switch", async () => {
    const oldConversation = conversation("alice-conversation", [
      message("alice-user", "user", "alice-only history"),
    ])
    const otherConversations = deferred<ChatConversation[]>()
    const otherPreferences = deferred<ChatPreferences>()
    const streamChatFn = vi.fn<ChatControllerDependencies["streamChatFn"]>(async function* () {
      yield { type: "complete" } as const
    })
    const { dependencies } = createDependencies({
      conversations: [oldConversation],
      preferences: { activeConversationId: oldConversation.id },
      streamChatFn,
    })
    dependencies.listConversations = vi.fn((subjectId) =>
      subjectId === OTHER_SUBJECT_ID
        ? otherConversations.promise
        : Promise.resolve([oldConversation]),
    )
    dependencies.getPreferences = vi.fn((subjectId) =>
      subjectId === OTHER_SUBJECT_ID
        ? otherPreferences.promise
        : Promise.resolve({
            activeConversationId: oldConversation.id,
            selectedModel: "gpt-5.2",
            scrollPositions: {},
          }),
    )

    let visibleSubject = ""
    let visibleConversationCount = -1
    let visibleActiveConversationId: string | null | undefined
    let pendingSend: Promise<void> | undefined
    const hook = renderHook(
      ({ subjectId }: { subjectId: string }) => {
        const controller = useChatController({ subjectId, dependencies })
        const attemptedRef = useRef(false)
        useLayoutEffect(() => {
          if (subjectId !== OTHER_SUBJECT_ID || attemptedRef.current) {
            return
          }
          attemptedRef.current = true
          visibleSubject = controller.state.subjectId
          visibleConversationCount = controller.state.conversations.length
          visibleActiveConversationId = controller.activeConversation?.id
          pendingSend = controller.sendText({ text: "must not cross subjects" })
        }, [controller, subjectId])
        return controller
      },
      { initialProps: { subjectId: SUBJECT_ID } },
    )
    await waitFor(() => expect(hook.result.current.state.isLoading).toBe(false))

    act(() => {
      hook.rerender({ subjectId: OTHER_SUBJECT_ID })
    })

    expect(visibleSubject).toBe(OTHER_SUBJECT_ID)
    expect(visibleConversationCount).toBe(0)
    expect(visibleActiveConversationId).toBeUndefined()
    expect(pendingSend).toBeDefined()
    await expect(pendingSend).resolves.toBeUndefined()
    expect(streamChatFn).not.toHaveBeenCalled()
    expect(dependencies.saveConversation).not.toHaveBeenCalled()

    await act(async () => {
      otherConversations.resolve([])
      otherPreferences.resolve({
        activeConversationId: null,
        selectedModel: "auto",
        scrollPositions: {},
      })
    })
    await waitFor(() => expect(hook.result.current.state.isLoading).toBe(false))
  })

  it("does not resurrect a deleted conversation after slow attachment persistence", async () => {
    const pendingAttachment = deferred<PreparedChatAttachment>()
    const newAttachment = attachment("e", "slow-delete.txt")
    const streamChatFn = vi.fn<ChatControllerDependencies["streamChatFn"]>(async function* () {
      yield { type: "complete" } as const
    })
    const { dependencies, storedConversations } = createDependencies({ streamChatFn })
    dependencies.saveAttachment = vi.fn<ChatControllerDependencies["saveAttachment"]>(
      async (_subjectId, item) => {
        await pendingAttachment.promise
        return item
      },
    )
    const { result } = await renderController(dependencies)
    let sending!: Promise<void>

    act(() => {
      sending = result.current.sendText({ text: "delete while saving", attachments: [newAttachment] })
    })
    await waitFor(() => expect(dependencies.saveAttachment).toHaveBeenCalledTimes(1))
    const conversationId = result.current.state.activeConversationId
    expect(conversationId).toBeTruthy()

    await act(async () => {
      await result.current.deleteConversation(conversationId!)
      pendingAttachment.resolve(newAttachment)
      await sending
    })

    expect(storedConversations.has(conversationId!)).toBe(false)
    expect(dependencies.saveConversation).not.toHaveBeenCalled()
    expect(streamChatFn).not.toHaveBeenCalled()
  })

  it("does not resurrect a cleared conversation after slow attachment persistence", async () => {
    const pendingAttachment = deferred<PreparedChatAttachment>()
    const newAttachment = attachment("f", "slow-clear.txt")
    const streamChatFn = vi.fn<ChatControllerDependencies["streamChatFn"]>(async function* () {
      yield { type: "complete" } as const
    })
    const { dependencies, storedConversations } = createDependencies({ streamChatFn })
    dependencies.saveAttachment = vi.fn<ChatControllerDependencies["saveAttachment"]>(
      async (_subjectId, item) => {
        await pendingAttachment.promise
        return item
      },
    )
    const { result } = await renderController(dependencies)
    let sending!: Promise<void>

    act(() => {
      sending = result.current.sendText({ text: "clear while saving", attachments: [newAttachment] })
    })
    await waitFor(() => expect(dependencies.saveAttachment).toHaveBeenCalledTimes(1))
    const conversationId = result.current.state.activeConversationId
    expect(conversationId).toBeTruthy()

    await act(async () => {
      await result.current.clearHistory()
      pendingAttachment.resolve(newAttachment)
      await sending
    })

    expect(storedConversations.has(conversationId!)).toBe(false)
    expect(dependencies.saveConversation).not.toHaveBeenCalled()
    expect(streamChatFn).not.toHaveBeenCalled()
  })

  it("keeps a delayed previous-subject save from replacing the current attachment cache", async () => {
    const aliceAttachment = attachment("a", "alice.txt", "alice bytes")
    const bobAttachment = attachment("a", "bob.txt", "bob bytes")
    const aliceSave = deferred<PreparedChatAttachment>()
    const bobSave = deferred<PreparedChatAttachment>()
    const releaseBobConversationSave = deferred<void>()
    const streamChatFn = vi.fn<ChatControllerDependencies["streamChatFn"]>(async function* () {
      yield { type: "complete" } as const
    })
    const { dependencies } = createDependencies({ streamChatFn })
    dependencies.listConversations = vi.fn<ChatControllerDependencies["listConversations"]>(
      async () => [],
    )
    dependencies.getPreferences = vi.fn<ChatControllerDependencies["getPreferences"]>(async () => ({
      activeConversationId: null,
      selectedModel: "auto",
      scrollPositions: {},
    }))
    dependencies.saveAttachment = vi.fn<ChatControllerDependencies["saveAttachment"]>(
      async (subjectId) => {
        if (subjectId === SUBJECT_ID) {
          return aliceSave.promise
        }
        return bobSave.promise
      },
    )
    dependencies.saveConversation = vi.fn<ChatControllerDependencies["saveConversation"]>(
      async (subjectId, item) => {
        if (subjectId === OTHER_SUBJECT_ID && item.messages.at(-1)?.status === "streaming") {
          await releaseBobConversationSave.promise
        }
        return item
      },
    )
    const hook = await renderSubjectController(dependencies)
    let aliceSending!: Promise<void>
    let bobSending!: Promise<void>

    act(() => {
      aliceSending = hook.result.current.sendText({ text: "alice", attachments: [aliceAttachment] })
    })
    await waitFor(() => expect(dependencies.saveAttachment).toHaveBeenCalledWith(SUBJECT_ID, aliceAttachment))

    act(() => {
      hook.rerender({ subjectId: OTHER_SUBJECT_ID })
    })
    await waitFor(() => expect(hook.result.current.state.isLoading).toBe(false))

    act(() => {
      bobSending = hook.result.current.sendText({ text: "bob", attachments: [bobAttachment] })
    })
    await waitFor(() =>
      expect(dependencies.saveAttachment).toHaveBeenCalledWith(OTHER_SUBJECT_ID, bobAttachment),
    )

    act(() => {
      bobSave.resolve(bobAttachment)
    })
    await waitFor(() =>
      expect(dependencies.saveConversation).toHaveBeenCalledWith(
        OTHER_SUBJECT_ID,
        expect.objectContaining({
          messages: expect.arrayContaining([expect.objectContaining({ status: "streaming" })]),
        }),
      ),
    )

    await act(async () => {
      aliceSave.resolve(aliceAttachment)
      await aliceSending
    })
    await act(async () => {
      releaseBobConversationSave.resolve()
      await bobSending
    })

    const [request, streamedAttachments] = streamChatFn.mock.calls[0]!
    expect(request.attachments).toEqual([])
    expect(streamedAttachments).toEqual([])
  })

  it("does not resolve legacy text attachments across subject changes", async () => {
    const aliceAttachment = attachment("b", "alice-read.txt", "alice bytes")
    const bobAttachment = attachment("b", "bob-read.txt", "bob bytes")
    const streamChatFn = vi.fn<ChatControllerDependencies["streamChatFn"]>(async function* () {
      yield { type: "complete" } as const
    })
    const { dependencies } = createDependencies({ streamChatFn })
    dependencies.listConversations = vi.fn<ChatControllerDependencies["listConversations"]>(
      async () => [],
    )
    dependencies.getPreferences = vi.fn<ChatControllerDependencies["getPreferences"]>(async () => ({
      activeConversationId: null,
      selectedModel: "auto",
      scrollPositions: {},
    }))
    const hook = await renderSubjectController(dependencies)

    await act(async () => {
      await hook.result.current.sendText({
        text: "alice read",
        attachmentIds: [aliceAttachment.id],
      })
    })

    act(() => {
      hook.rerender({ subjectId: OTHER_SUBJECT_ID })
    })
    await waitFor(() => expect(hook.result.current.state.isLoading).toBe(false))

    await act(async () => {
      await hook.result.current.sendText({
        text: "bob read",
        attachmentIds: [bobAttachment.id],
      })
    })

    expect(dependencies.getAttachments).not.toHaveBeenCalled()
    expect(streamChatFn.mock.calls).toHaveLength(2)
    for (const [request, streamedAttachments] of streamChatFn.mock.calls) {
      expect(request.attachments).toEqual([])
      expect(streamedAttachments).toEqual([])
    }
  })
})
