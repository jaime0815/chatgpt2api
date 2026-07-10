import { describe, expect, it } from "vitest"

import { filterChatModels, isImageModelId, resolveChatModelSelection } from "./chat-models"

describe("chat model helpers", () => {
  it("recognizes every current image model family", () => {
    expect(isImageModelId("gpt-image-2")).toBe(true)
    expect(isImageModelId("codex-gpt-image-2")).toBe(true)
    expect(isImageModelId("team-codex-gpt-image-2")).toBe(true)
    expect(isImageModelId(" GPT-IMAGE-2 ")).toBe(true)
    expect(isImageModelId("gpt-5.4")).toBe(false)
  })

  it("keeps auto and unique text models in API order", () => {
    const models = [
      { id: "gpt-5.4" },
      { id: "gpt-image-2" },
      { id: " o3 " },
      { id: "gpt-5.4" },
      { id: "team-codex-gpt-image-2" },
      { id: "" },
    ]

    expect(filterChatModels(models)).toEqual(["auto", "gpt-5.4", "o3"])
  })

  it("falls back explicitly to auto when a stored model disappeared", () => {
    const availableModels = ["auto", "gpt-5.4", "o3"]

    expect(resolveChatModelSelection("gpt-5.4", availableModels)).toBe("gpt-5.4")
    expect(resolveChatModelSelection("removed-model", availableModels)).toBe("auto")
    expect(resolveChatModelSelection("gpt-image-2", availableModels)).toBe("auto")
    expect(resolveChatModelSelection(null, availableModels)).toBe("auto")
  })
})
