import { describe, expect, it, vi } from "vitest"

import type { ImageTask } from "@/lib/api"

import type { ChatMessage } from "./chat-types"
import {
  applyImageTaskToChatMessage,
  chatImageMessageStatus,
  chatImageSettingsSnapshot,
  chatImageUrlToFile,
  taskImageToChatImage,
} from "./chat-images"

function imageTask(overrides: Partial<ImageTask> = {}): ImageTask {
  return {
    id: "task-1",
    status: "success",
    mode: "generate",
    model: "gpt-image-2",
    size: "1536x1024",
    quality: "high",
    created_at: "2026-07-11T00:00:00.000Z",
    updated_at: "2026-07-11T00:00:01.000Z",
    data: [
      {
        url: "/images/task-1.png",
        b64_json: "large-base64-payload",
        revised_prompt: "revised prompt",
      },
    ],
    ...overrides,
  }
}

describe("chat image helpers", () => {
  it("captures every shared image setting, including custom counts through 100", () => {
    expect(
      chatImageSettingsSnapshot({
        model: "codex-image",
        quality: "high",
        width: "3840",
        height: "2160",
        ratio: "16:9",
        tier: "4k",
        count: "100",
      }),
    ).toEqual({
      model: "codex-image",
      quality: "high",
      width: "3840",
      height: "2160",
      ratio: "16:9",
      tier: "4k",
      count: 100,
      mode: "generate",
    })
  })

  it("keeps only server URLs when converting completed task data", () => {
    expect(taskImageToChatImage(imageTask())).toEqual([
      {
        id: "task-1:0",
        taskId: "task-1",
        status: "success",
        url: "/images/task-1.png",
        width: 1536,
        height: 1024,
        revisedPrompt: "revised prompt",
      },
    ])
    expect(taskImageToChatImage(imageTask({ data: [{ b64_json: "only-base64" }] }))).toEqual([])
  })

  it("updates a pending image slot without retaining b64_json", () => {
    const message: ChatMessage = {
      id: "assistant-1",
      role: "assistant",
      text: "",
      attachmentIds: [],
      status: "running",
      createdAt: "2026-07-11T00:00:00.000Z",
      images: [{ id: "slot-1", taskId: "task-1", status: "running" }],
    }

    expect(applyImageTaskToChatMessage(message, imageTask())).toMatchObject({
      status: "complete",
      images: [
        {
          id: "slot-1",
          taskId: "task-1",
          status: "success",
          url: "/images/task-1.png",
          width: 1536,
          height: 1024,
          revisedPrompt: "revised prompt",
        },
      ],
    })
    expect(JSON.stringify(applyImageTaskToChatMessage(message, imageTask()))).not.toContain(
      "large-base64-payload",
    )
  })

  it("keeps a mixed image turn active while another image is still pending", () => {
    expect(
      chatImageMessageStatus([
        { id: "missing", taskId: "missing", status: "error", error: "任务不存在" },
        { id: "running", taskId: "running", status: "running" },
      ]),
    ).toBe("running")
  })

  it("fetches a persisted image URL as a File for a later edit", async () => {
    const fetchImpl = vi.fn(async () =>
      ({
        ok: true,
        status: 200,
        blob: async () => new Blob(["image"], { type: "image/png" }),
      }) as Response,
    )

    const file = await chatImageUrlToFile("/images/task-1.png", "reference.png", fetchImpl)

    expect(fetchImpl).toHaveBeenCalledWith("/images/task-1.png")
    expect(file).toMatchObject({ name: "reference.png", type: "image/png", size: 5 })
  })
})
