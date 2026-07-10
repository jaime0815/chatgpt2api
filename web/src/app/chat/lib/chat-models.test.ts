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

  it("keeps an available stored chat model without an unavailable warning", () => {
    const availableModels = ["auto", "gpt-5.4", "o3"]

    expect(resolveChatModelSelection("gpt-5.4", availableModels)).toEqual({
      selected: "gpt-5.4",
      unavailable: null,
    })
  })

  it("reports a stored model that disappeared while falling back to auto", () => {
    expect(resolveChatModelSelection("removed-model", ["auto", "gpt-5.4"])).toEqual({
      selected: "auto",
      unavailable: "removed-model",
    })
  })

  it("reports a stored image model as unavailable for chat", () => {
    expect(resolveChatModelSelection("gpt-image-2", ["auto", "gpt-5.4"])).toEqual({
      selected: "auto",
      unavailable: "gpt-image-2",
    })
  })

  it("uses auto without an unavailable warning when nothing was stored", () => {
    expect(resolveChatModelSelection(null, ["auto", "gpt-5.4"])).toEqual({
      selected: "auto",
      unavailable: null,
    })
    expect(resolveChatModelSelection("   ", ["auto", "gpt-5.4"])).toEqual({
      selected: "auto",
      unavailable: null,
    })
  })
})
