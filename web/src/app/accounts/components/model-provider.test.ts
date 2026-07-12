import { describe, expect, it } from "vitest"

import type { Model } from "@/lib/api"

import { classifyModelProvider, groupModelsByProvider } from "./model-provider"

function model(id: string): Model {
  return {
    id,
    object: "model",
    created: 0,
    owned_by: "unknown",
    permission: [],
    root: id,
    parent: null,
  }
}

describe("model provider grouping", () => {
  it.each([
    ["gpt-5.6", "openai"],
    ["o3-pro", "openai"],
    ["anthropic/claude-sonnet-4", "anthropic"],
    ["gemini-2.5-pro", "google"],
    ["grok-4", "xai"],
    ["meta-llama/llama-4", "meta"],
    ["mistral-large", "mistral"],
    ["deepseek-v3", "deepseek"],
    ["qwen3-235b", "alibaba"],
    ["not-gpt-model", "other"],
  ])("classifies %s as %s from an anchored model family", (id, provider) => {
    expect(classifyModelProvider(id)).toBe(provider)
  })

  it("orders non-empty vendor groups while preserving upstream order within each group", () => {
    const groups = groupModelsByProvider([
      model("claude-sonnet-4"),
      model("gpt-5.6"),
      model("gpt-5.5"),
      model("gemini-2.5-pro"),
      model("custom-latest"),
    ])

    expect(groups.map((group) => group.id)).toEqual(["openai", "anthropic", "google", "other"])
    expect(groups[0]?.models.map((item) => item.id)).toEqual(["gpt-5.6", "gpt-5.5"])
  })
})
