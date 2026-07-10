import { describe, expect, it, vi } from "vitest"

const ORIGIN = "https://app.example.com"

async function loadPaths(basePath?: string) {
  vi.resetModules()
  vi.stubEnv("NODE_ENV", "test")
  vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", undefined)
  vi.stubEnv("NEXT_PUBLIC_API_URL", undefined)
  vi.stubEnv("NEXT_PUBLIC_BASE_PATH", basePath)

  return import("@/lib/paths")
}

describe("path helpers", () => {
  it("uses the default base path without duplicating it", async () => {
    const { withApiBasePath, withBasePath } = await loadPaths()

    expect(withBasePath("/settings")).toBe("/chatgpt2api/settings")
    expect(withBasePath("/chatgpt2api/settings")).toBe("/chatgpt2api/settings")
    expect(withApiBasePath("/v1/models", `${ORIGIN}/`)).toBe(`${ORIGIN}/chatgpt2api/v1/models`)
    expect(withApiBasePath("/chatgpt2api/v1/models", `${ORIGIN}/`)).toBe(
      `${ORIGIN}/chatgpt2api/v1/models`,
    )
  })

  it("uses a custom base path without duplicating it", async () => {
    const { withApiBasePath, withBasePath } = await loadPaths("/custom")

    expect(withBasePath("/settings")).toBe("/custom/settings")
    expect(withBasePath("/custom/settings")).toBe("/custom/settings")
    expect(withApiBasePath("/v1/models", ORIGIN)).toBe(`${ORIGIN}/custom/v1/models`)
    expect(withApiBasePath("/custom/v1/models", ORIGIN)).toBe(`${ORIGIN}/custom/v1/models`)
  })

  it("supports an empty normalized base path", async () => {
    const { withApiBasePath, withBasePath } = await loadPaths("/")

    expect(withBasePath("")).toBe("/")
    expect(withBasePath("/settings")).toBe("/settings")
    expect(withApiBasePath("/v1/models", `${ORIGIN}/`)).toBe(`${ORIGIN}/v1/models`)
  })

  it("preserves absolute URLs", async () => {
    const { withApiBasePath, withBasePath } = await loadPaths("/custom")
    const absoluteUrl = "https://example.com/v1/models"

    expect(withBasePath(absoluteUrl)).toBe(absoluteUrl)
    expect(withApiBasePath(absoluteUrl, ORIGIN)).toBe(absoluteUrl)
  })
})
