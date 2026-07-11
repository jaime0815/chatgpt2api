import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  httpRequest: vi.fn(),
}))

vi.mock("@/lib/request", () => ({
  httpRequest: mocks.httpRequest,
  request: {},
}))

import {
  createImageEditTask,
  createImageGenerationTask,
  fetchImageTasks,
  resumeImagePoll,
} from "./api"

describe("image task API authentication", () => {
  beforeEach(() => {
    mocks.httpRequest.mockReset()
    mocks.httpRequest.mockResolvedValue({})
  })

  it("keeps all image task requests bound to the supplied workspace key", async () => {
    const reference = new File(["image"], "reference.png", { type: "image/png" })

    await createImageGenerationTask("generation-client", "generate", "gpt-image-2", "1024x1024", "high", "workspace-a-key")
    await createImageEditTask("edit-client", reference, "edit", "gpt-image-2", "1024x1024", "high", "workspace-a-key")
    await fetchImageTasks(["generation-client", "edit-client"], "workspace-a-key")
    await resumeImagePoll("edit-client", 45, "workspace-a-key")

    expect(mocks.httpRequest).toHaveBeenNthCalledWith(1, "/api/image-tasks/generations", {
      method: "POST",
      body: {
        client_task_id: "generation-client",
        prompt: "generate",
        model: "gpt-image-2",
        size: "1024x1024",
        quality: "high",
      },
      headers: { Authorization: "Bearer workspace-a-key" },
    })
    expect(mocks.httpRequest.mock.calls[1]?.[0]).toBe("/api/image-tasks/edits")
    expect(mocks.httpRequest.mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
      headers: { Authorization: "Bearer workspace-a-key" },
    })
    expect(mocks.httpRequest.mock.calls[2]?.[0]).toMatch(/^\/api\/image-tasks\?ids=generation-client%2Cedit-client&_t=/)
    expect(mocks.httpRequest.mock.calls[2]?.[1]).toEqual({
      headers: { Authorization: "Bearer workspace-a-key" },
    })
    expect(mocks.httpRequest).toHaveBeenNthCalledWith(4, "/api/image-tasks/edit-client/resume-poll", {
      method: "POST",
      body: { extra_timeout_secs: 45 },
      headers: { Authorization: "Bearer workspace-a-key" },
    })
  })
})
