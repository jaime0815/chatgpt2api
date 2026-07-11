import { act, renderHook, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import type { ImageTask } from "@/lib/api"

import type { ImageSettings } from "@/app/image/components/image-settings"
import type { ChatMessage, PreparedChatAttachment } from "@/app/chat/lib/chat-types"
import {
  useChatImageTasks,
  type ChatImageTaskDependencies,
} from "./use-chat-image-tasks"

const SETTINGS: ImageSettings = {
  model: "gpt-image-2",
  quality: "high",
  width: "1536",
  height: "1024",
  ratio: "3:2",
  tier: "1k",
  count: "3",
}

function reference(id = "reference"): PreparedChatAttachment {
  const blob = new Blob(["reference"], { type: "image/png" })
  return {
    id,
    name: `${id}.png`,
    mimeType: "image/png",
    size: blob.size,
    sha256: id.padEnd(64, "0"),
    kind: "image",
    blob,
  }
}

function documentReference(): PreparedChatAttachment {
  const blob = new Blob(["document"], { type: "application/pdf" })
  return {
    id: "document",
    name: "document.pdf",
    mimeType: "application/pdf",
    size: blob.size,
    sha256: "d".repeat(64),
    kind: "document",
    blob,
  }
}

function task(id: string, status: ImageTask["status"], overrides: Partial<ImageTask> = {}): ImageTask {
  return {
    id,
    status,
    mode: "generate",
    model: "gpt-image-2",
    size: "1536x1024",
    quality: "high",
    created_at: "2026-07-11T00:00:00.000Z",
    updated_at: "2026-07-11T00:00:01.000Z",
    ...(status === "success" ? { data: [{ url: `/images/${id}.png`, b64_json: "large" }] } : {}),
    ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function createDependencies(overrides: Partial<ChatImageTaskDependencies> = {}) {
  let id = 0
  const dependencies: ChatImageTaskDependencies = {
    createImageGenerationTask: vi.fn(async (taskId) => task(taskId, "running")),
    createImageEditTask: vi.fn(async (taskId) => task(taskId, "running", { mode: "edit" })),
    fetchImageTasks: vi.fn(async (ids: string[]) => ({
      items: ids.map((id) => task(id, "success")),
      missing_ids: [],
    })),
    resumeImagePoll: vi.fn(async (taskId) => task(taskId, "running")),
    wait: vi.fn(async () => undefined),
    createId: () => `id-${++id}`,
    now: () => new Date("2026-07-11T00:00:00.000Z"),
    ...overrides,
  }
  return dependencies
}

describe("useChatImageTasks", () => {
  it("submits one edit task per selected count and retains the full image settings snapshot", async () => {
    const dependencies = createDependencies()
    const onMessageChange = vi.fn(async (_message: ChatMessage) => undefined)
    const { result } = renderHook(() =>
      useChatImageTasks({
        onMessageChange,
        dependencies,
        pollIntervalMs: 0,
        authKey: "workspace-a-key",
      }),
    )

    let message!: ChatMessage
    await act(async () => {
      message = await result.current.submit({
        prompt: "draw a city",
        settings: SETTINGS,
        references: [reference()],
      })
    })

    expect(message).toMatchObject({
      role: "assistant",
      text: "draw a city",
      status: "queued",
      attachmentIds: ["reference"],
      imageSettings: {
        ...SETTINGS,
        count: 3,
        mode: "edit",
        referenceAttachmentIds: ["reference"],
      },
      images: [
        { status: "queued" },
        { status: "queued" },
        { status: "queued" },
      ],
    })
    await waitFor(() => expect(onMessageChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: message.id,
        status: "complete",
        images: expect.arrayContaining([
          expect.objectContaining({ url: expect.stringContaining("/images/"), status: "success" }),
        ]),
      }),
    ))
    expect(dependencies.createImageEditTask).toHaveBeenCalledTimes(3)
    expect(dependencies.createImageEditTask).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      "draw a city",
      SETTINGS.model,
      "1536x1024",
      SETTINGS.quality,
      "workspace-a-key",
    )
    expect(dependencies.createImageGenerationTask).not.toHaveBeenCalled()
    expect(JSON.stringify(onMessageChange.mock.calls)).not.toContain('"large"')
  })

  it("recovers unfinished task IDs after a refresh and continues polling them", async () => {
    const dependencies = createDependencies()
    const onMessageChange = vi.fn(async (_message: ChatMessage) => undefined)
    const existing: ChatMessage = {
      id: "assistant-1",
      role: "assistant",
      text: "",
      attachmentIds: [],
      status: "running",
      createdAt: "2026-07-11T00:00:00.000Z",
      imageSettings: { ...SETTINGS, count: 1, mode: "generate" },
      images: [{ id: "image-1", taskId: "persisted-task", status: "running" }],
    }
    const { result } = renderHook(() =>
      useChatImageTasks({
        onMessageChange,
        dependencies,
        pollIntervalMs: 0,
        authKey: "workspace-a-key",
      }),
    )

    await act(async () => {
      await result.current.recoverImageMessages([existing])
    })

    expect(dependencies.fetchImageTasks).toHaveBeenCalledWith(["persisted-task"], "workspace-a-key")
    expect(onMessageChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: existing.id,
        status: "complete",
        images: [expect.objectContaining({ taskId: "persisted-task", url: "/images/persisted-task.png" })],
      }),
    )
  })

  it("does not recover a locally queued task before its create request has finished", async () => {
    const queuedPersistence = deferred<void>()
    const createdTask = deferred<ImageTask>()
    let persistQueuedMessage = true
    const createImageGenerationTask = vi.fn<ChatImageTaskDependencies["createImageGenerationTask"]>(
      async () => createdTask.promise,
    )
    const dependencies = createDependencies({
      createImageGenerationTask,
      fetchImageTasks: vi.fn(async (ids: string[]) => ({
        items: ids.map((id) => task(id, "success")),
        missing_ids: [],
      })),
    })
    const onMessageChange = vi.fn(async (message: ChatMessage) => {
      if (persistQueuedMessage && message.status === "queued") {
        await queuedPersistence.promise
        persistQueuedMessage = false
      }
    })
    const { result } = renderHook(() =>
      useChatImageTasks({
        onMessageChange,
        dependencies,
        pollIntervalMs: 0,
        authKey: "workspace-a-key",
      }),
    )

    let submission!: Promise<ChatMessage>
    act(() => {
      submission = result.current.submit({
        prompt: "draw after recovery",
        settings: { ...SETTINGS, count: "1" },
      })
    })
    await waitFor(() => expect(onMessageChange).toHaveBeenCalledWith(
      expect.objectContaining({ status: "queued" }),
    ))
    const queued = onMessageChange.mock.calls[0]?.[0] as ChatMessage

    await act(async () => {
      await result.current.recoverImageMessages([queued])
    })

    expect(dependencies.fetchImageTasks).not.toHaveBeenCalled()

    await act(async () => {
      queuedPersistence.resolve()
      await submission
    })
    await waitFor(() => expect(createImageGenerationTask).toHaveBeenCalledOnce())
    const taskId = createImageGenerationTask.mock.calls[0]?.[0] as string
    await act(async () => {
      createdTask.resolve(task(taskId, "running"))
    })

    await waitFor(() => expect(onMessageChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: "complete",
        images: [expect.objectContaining({ status: "success" })],
      }),
    ))
  })

  it("keeps a genuinely missing hydrated task terminal", async () => {
    const dependencies = createDependencies({
      fetchImageTasks: vi.fn(async (ids: string[]) => ({ items: [], missing_ids: ids })),
    })
    const onMessageChange = vi.fn(async (_message: ChatMessage) => undefined)
    const missing: ChatMessage = {
      id: "assistant-missing",
      role: "assistant",
      text: "",
      attachmentIds: [],
      status: "running",
      createdAt: "2026-07-11T00:00:00.000Z",
      images: [{ id: "image-missing", taskId: "missing-task", status: "running" }],
    }
    const { result } = renderHook(() =>
      useChatImageTasks({
        onMessageChange,
        dependencies,
        pollIntervalMs: 0,
        authKey: "workspace-a-key",
      }),
    )

    await act(async () => {
      await result.current.recoverImageMessages([missing])
    })

    await waitFor(() => expect(onMessageChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: "error",
        images: [expect.objectContaining({ status: "error", error: "图片任务不存在或已过期" })],
      }),
    ))
  })

  it("discards deleted image messages before a pending poll can emit another update", async () => {
    const nextTasks = deferred<{ items: ImageTask[]; missing_ids: string[] }>()
    const dependencies = createDependencies({
      fetchImageTasks: vi.fn(async () => nextTasks.promise),
    })
    const onMessageChange = vi.fn(async (_message: ChatMessage) => undefined)
    const { result } = renderHook(() =>
      useChatImageTasks({ onMessageChange, dependencies, pollIntervalMs: 0 }),
    )

    let message!: ChatMessage
    await act(async () => {
      message = await result.current.submit({
        prompt: "draw city",
        settings: { ...SETTINGS, count: "1" },
      })
    })
    await waitFor(() => expect(dependencies.fetchImageTasks).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(result.current.activeTaskIds).toHaveLength(1))
    onMessageChange.mockClear()

    act(() => {
      result.current.discardImageMessages([message.id])
    })
    expect(result.current.activeTaskIds).toEqual([])

    await act(async () => {
      nextTasks.resolve({
        items: [task(message.images?.[0]?.taskId || "missing", "success")],
        missing_ids: [],
      })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(onMessageChange).not.toHaveBeenCalled()
  })

  it("resumes timed-out tasks through the existing resume API", async () => {
    const dependencies = createDependencies()
    const onMessageChange = vi.fn(async (_message: ChatMessage) => undefined)
    const message: ChatMessage = {
      id: "assistant-timeout",
      role: "assistant",
      text: "",
      attachmentIds: [],
      status: "error",
      createdAt: "2026-07-11T00:00:00.000Z",
      images: [{ id: "image-timeout", taskId: "timed-out-task", status: "error", error: "生成超时" }],
    }
    const { result } = renderHook(() =>
      useChatImageTasks({
        onMessageChange,
        dependencies,
        pollIntervalMs: 0,
        authKey: "workspace-a-key",
      }),
    )

    await act(async () => {
      await result.current.resumeImageTask(message, "timed-out-task")
    })

    expect(dependencies.resumeImagePoll).toHaveBeenCalledWith(
      "timed-out-task",
      undefined,
      "workspace-a-key",
    )
    expect(onMessageChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: message.id,
        status: "complete",
        images: [expect.objectContaining({ taskId: "timed-out-task", status: "success" })],
      }),
    )
  })

  it("retries one failed image with its saved parameter snapshot", async () => {
    const dependencies = createDependencies()
    const onMessageChange = vi.fn(async (_message: ChatMessage) => undefined)
    const message: ChatMessage = {
      id: "assistant-retry",
      role: "assistant",
      text: "",
      attachmentIds: [],
      status: "error",
      createdAt: "2026-07-11T00:00:00.000Z",
      imageSettings: { ...SETTINGS, count: 1, mode: "generate" },
      images: [{ id: "failed-image", taskId: "old-task", status: "error", error: "生成失败" }],
    }
    const { result } = renderHook(() =>
      useChatImageTasks({
        onMessageChange,
        dependencies,
        pollIntervalMs: 0,
        authKey: "workspace-a-key",
      }),
    )

    await act(async () => {
      await result.current.retryImageTask(message, "failed-image", { prompt: "retry city" })
    })

    await waitFor(() => expect(onMessageChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: "complete",
        images: [expect.objectContaining({ id: "failed-image", status: "success" })],
      }),
    ))
    expect(dependencies.createImageGenerationTask).toHaveBeenCalledWith(
      expect.any(String),
      "retry city",
      SETTINGS.model,
      "1536x1024",
      SETTINGS.quality,
      "workspace-a-key",
    )
  })

  it("restores persisted reference attachments before retrying an edit turn", async () => {
    const dependencies = createDependencies()
    const resolveAttachments = vi.fn(async () => [reference("stored-reference")])
    const onMessageChange = vi.fn(async (_message: ChatMessage) => undefined)
    const message: ChatMessage = {
      id: "assistant-edit-retry",
      role: "assistant",
      text: "",
      attachmentIds: ["stored-reference"],
      status: "error",
      createdAt: "2026-07-11T00:00:00.000Z",
      imageSettings: {
        ...SETTINGS,
        count: 1,
        mode: "edit",
        referenceAttachmentIds: ["stored-reference"],
      },
      images: [{ id: "failed-edit", taskId: "old-edit-task", status: "error", error: "生成失败" }],
    }
    const { result } = renderHook(() =>
      useChatImageTasks({
        onMessageChange,
        dependencies,
        pollIntervalMs: 0,
        resolveAttachments,
        authKey: "workspace-a-key",
      }),
    )

    await act(async () => {
      await result.current.retryImageTask(message, "failed-edit", { prompt: "retry edit" })
    })

    await waitFor(() => expect(onMessageChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "complete" }),
    ))
    expect(resolveAttachments).toHaveBeenCalledWith(["stored-reference"])
    expect(dependencies.createImageEditTask).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      "retry edit",
      SETTINGS.model,
      "1536x1024",
      SETTINGS.quality,
      "workspace-a-key",
    )
  })

  it("keeps fulfilled tasks running when another task in the same batch fails to submit", async () => {
    const dependencies = createDependencies()
    let submissions = 0
    let failedTaskId = ""
    dependencies.createImageGenerationTask = vi.fn(async (taskId) => {
      submissions += 1
      if (submissions === 2) {
        failedTaskId = taskId
        throw new Error("second submission failed")
      }
      return task(taskId, "running")
    })
    dependencies.fetchImageTasks = vi.fn(async (ids: string[]) => ({
      items: ids.filter((id) => id !== failedTaskId).map((id) => task(id, "success")),
      missing_ids: ids.filter((id) => id === failedTaskId),
    }))
    const onMessageChange = vi.fn(async (_message: ChatMessage) => undefined)
    const { result } = renderHook(() =>
      useChatImageTasks({ onMessageChange, dependencies, pollIntervalMs: 0 }),
    )

    await act(async () => {
      await result.current.submit({ prompt: "draw three", settings: SETTINGS })
    })

    await waitFor(() => expect(onMessageChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        images: expect.arrayContaining([
          expect.objectContaining({ status: "success" }),
          expect.objectContaining({ status: "error" }),
        ]),
      }),
    ))
    const finalMessage = onMessageChange.mock.calls.at(-1)?.[0] as ChatMessage
    expect(finalMessage.images?.filter((image) => image.status === "success")).toHaveLength(2)
    expect(finalMessage.images?.filter((image) => image.status === "error")).toHaveLength(1)
  })

  it("continues refresh recovery after a transient task-list failure", async () => {
    const dependencies = createDependencies()
    let calls = 0
    dependencies.fetchImageTasks = vi.fn(async (ids: string[]) => {
      calls += 1
      if (calls === 1) {
        throw new Error("temporary network failure")
      }
      return { items: ids.map((id) => task(id, "success")), missing_ids: [] }
    })
    const onMessageChange = vi.fn(async (_message: ChatMessage) => undefined)
    const existing: ChatMessage = {
      id: "assistant-transient",
      role: "assistant",
      text: "",
      attachmentIds: [],
      status: "running",
      createdAt: "2026-07-11T00:00:00.000Z",
      images: [{ id: "image-transient", taskId: "transient-task", status: "running" }],
    }
    const { result } = renderHook(() =>
      useChatImageTasks({ onMessageChange, dependencies, pollIntervalMs: 0 }),
    )

    await act(async () => {
      await result.current.recoverImageMessages([existing])
    })

    await waitFor(() => expect(onMessageChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "complete" }),
    ))
    expect(dependencies.fetchImageTasks).toHaveBeenCalledTimes(2)
  })

  it("coalesces concurrent recovery and keeps a late stale response from replacing the first result", async () => {
    const dependencies = createDependencies()
    const firstFetch = deferred<{ items: ImageTask[]; missing_ids: string[] }>()
    const lateFetch = deferred<{ items: ImageTask[]; missing_ids: string[] }>()
    dependencies.fetchImageTasks = vi
      .fn()
      .mockImplementationOnce(() => firstFetch.promise)
      .mockImplementationOnce(() => lateFetch.promise)
    const onMessageChange = vi.fn(async (_message: ChatMessage) => undefined)
    const stale: ChatMessage = {
      id: "assistant-double-recover",
      role: "assistant",
      text: "",
      attachmentIds: [],
      status: "running",
      createdAt: "2026-07-11T00:00:00.000Z",
      images: [{ id: "recover-image", taskId: "recover-task", status: "running" }],
    }
    const { result, unmount } = renderHook(() =>
      useChatImageTasks({ onMessageChange, dependencies, pollIntervalMs: 0 }),
    )

    try {
      let firstRecovery!: Promise<ChatMessage[]>
      let secondRecovery!: Promise<ChatMessage[]>
      act(() => {
        firstRecovery = result.current.recoverImageMessages([stale])
        secondRecovery = result.current.recoverImageMessages([stale])
      })

      expect(dependencies.fetchImageTasks).toHaveBeenCalledTimes(1)
      firstFetch.resolve({ items: [task("recover-task", "success")], missing_ids: [] })
      lateFetch.resolve({ items: [task("recover-task", "running")], missing_ids: [] })
      await act(async () => {
        await Promise.all([firstRecovery, secondRecovery])
      })
      await waitFor(() => expect(onMessageChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: "complete" }),
      ))

      await act(async () => {
        await result.current.recoverImageMessages([stale])
      })

      expect(onMessageChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: "complete" }),
      )
      expect(dependencies.fetchImageTasks).toHaveBeenCalledTimes(1)
    } finally {
      unmount()
    }
  })

  it("rejects documents and more than ten reference images before submitting a task", async () => {
    const dependencies = createDependencies()
    const { result } = renderHook(() =>
      useChatImageTasks({ onMessageChange: vi.fn(), dependencies, pollIntervalMs: 0 }),
    )

    await expect(
      result.current.submit({ prompt: "draw", settings: SETTINGS, references: [documentReference()] }),
    ).rejects.toThrow("文档")
    await expect(
      result.current.submit({
        prompt: "draw",
        settings: SETTINGS,
        references: Array.from({ length: 11 }, (_, index) => reference(`image-${index}`)),
      }),
    ).rejects.toThrow("10")
    expect(dependencies.createImageGenerationTask).not.toHaveBeenCalled()
  })
})
