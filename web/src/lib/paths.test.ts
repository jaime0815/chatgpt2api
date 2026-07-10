import { describe, expect, it } from "vitest"

import { withApiBasePath, withBasePath } from "@/lib/paths"

describe("withBasePath", () => {
  it("does not duplicate an existing base path", () => {
    expect(withBasePath("/chatgpt2api/settings")).toBe("/chatgpt2api/settings")
  })
})

describe("withApiBasePath", () => {
  it("preserves absolute URLs", () => {
    expect(withApiBasePath("https://example.com/v1/models", "https://app.example.com")).toBe(
      "https://example.com/v1/models",
    )
  })

  it("uses the application base path for relative API paths", () => {
    expect(withApiBasePath("/v1/models", "https://app.example.com/")).toBe(
      "https://app.example.com/chatgpt2api/v1/models",
    )
    expect(withApiBasePath("/chatgpt2api/v1/models", "https://app.example.com/")).toBe(
      "https://app.example.com/chatgpt2api/v1/models",
    )
  })
})
