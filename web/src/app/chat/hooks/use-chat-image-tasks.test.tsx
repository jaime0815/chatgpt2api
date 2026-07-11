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
      useChatImageTasks({ onMessageChange, dependencies, pollIntervalMs: 0 }),
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
      status: "queued",
      imageSettings: { ...SETTINGS, count: 3, mode: "edit" },
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
      useChatImageTasks({ onMessageChange, dependencies, pollIntervalMs: 0 }),
    )

    await act(async () => {
      await result.current.recoverImageMessages([existing])
    })

    expect(dependencies.fetchImageTasks).toHaveBeenCalledWith(["persisted-task"])
    expect(onMessageChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: existing.id,
        status: "complete",
        images: [expect.objectContaining({ taskId: "persisted-task", url: "/images/persisted-task.png" })],
      }),
    )
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
      useChatImageTasks({ onMessageChange, dependencies, pollIntervalMs: 0 }),
    )

    await act(async () => {
      await result.current.resumeImageTask(message, "timed-out-task")
    })

    expect(dependencies.resumeImagePoll).toHaveBeenCalledWith("timed-out-task")
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
      useChatImageTasks({ onMessageChange, dependencies, pollIntervalMs: 0 }),
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
    )
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
