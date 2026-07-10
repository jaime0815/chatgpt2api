import { createElement } from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { ImageSettingsPanel } from "./image-settings-panel"
import {
  aspectOptions,
  countOptions,
  imageSettingsSummary,
  isImagePresetDisabled,
  normalizeImageSettings,
  qualityOptions,
} from "./image-settings"

describe("shared image settings", () => {
  it("keeps the current quality values and Chinese labels", () => {
    expect(qualityOptions).toEqual([
      { value: "auto", label: "自动" },
      { value: "low", label: "低" },
      { value: "medium", label: "中" },
      { value: "high", label: "高" },
    ])
  })

  it("keeps every current aspect preset and dimension", () => {
    expect(
      aspectOptions.map(({ ratio, tier, width, height, label }) => ({
        ratio,
        tier,
        width,
        height,
        label,
      })),
    ).toEqual([
      { ratio: "1:1", tier: "1k", width: "1024", height: "1024", label: "1:1" },
      { ratio: "2:3", tier: "1k", width: "1024", height: "1536", label: "2:3" },
      { ratio: "3:2", tier: "1k", width: "1536", height: "1024", label: "3:2" },
      { ratio: "3:4", tier: "1k", width: "1024", height: "1365", label: "3:4" },
      { ratio: "4:3", tier: "1k", width: "1365", height: "1024", label: "4:3" },
      { ratio: "9:16", tier: "1k", width: "1088", height: "1920", label: "9:16" },
      { ratio: "16:9", tier: "1k", width: "1920", height: "1088", label: "16:9" },
      { ratio: "1:1", tier: "2k", width: "2048", height: "2048", label: "1:1(2k)" },
      { ratio: "16:9", tier: "2k", width: "2560", height: "1440", label: "16:9(2k)" },
      { ratio: "9:16", tier: "2k", width: "1440", height: "2560", label: "9:16(2k)" },
      { ratio: "16:9", tier: "4k", width: "3840", height: "2160", label: "16:9(4k)" },
      { ratio: "9:16", tier: "4k", width: "2160", height: "3840", label: "9:16(4k)" },
      { ratio: "auto", tier: "auto", width: "1024", height: "1024", label: "auto" },
    ])
  })

  it("keeps the existing quick counts while normalising every custom count from 1 to 100", () => {
    expect(countOptions).toEqual(Array.from({ length: 10 }, (_, index) => String(index + 1)))

    for (let count = 1; count <= 100; count += 1) {
      expect(normalizeImageSettings({ count }).count).toBe(String(count))
    }

    expect(normalizeImageSettings({ count: 0 }).count).toBe("1")
    expect(normalizeImageSettings({ count: 101 }).count).toBe("100")
    expect(normalizeImageSettings({ count: 3.9 }).count).toBe("3")
  })

  it("preserves valid custom dimensions and trims stored strings", () => {
    expect(
      normalizeImageSettings({
        model: "  gpt-image-custom  ",
        quality: "high",
        width: " 1234 ",
        height: "2345",
        ratio: "16:9",
        tier: "2k",
        count: "7",
      }),
    ).toEqual({
      model: "gpt-image-custom",
      quality: "high",
      width: "1234",
      height: "2345",
      ratio: "16:9",
      tier: "2k",
      count: "7",
    })
  })

  it("normalises invalid stored values to the existing safe defaults", () => {
    expect(
      normalizeImageSettings({
        model: " ",
        quality: "ultra",
        width: "0",
        height: "not-a-size",
        ratio: "cinema",
        tier: "8k",
        count: "not-a-count",
      }),
    ).toEqual({
      model: "gpt-image-2",
      quality: "auto",
      width: "1024",
      height: "1024",
      ratio: "1:1",
      tier: "1k",
      count: "1",
    })
  })

  it("builds the same compact summary labels", () => {
    expect(
      imageSettingsSummary({ quality: "high", ratio: "16:9", tier: "2k", count: "3" }),
    ).toBe("高 · 16:9(2k) · 3 张")
    expect(
      imageSettingsSummary({ quality: "unexpected", ratio: "auto", tier: "1k", count: "" }),
    ).toBe("自动 · auto · 1 张")
  })

  it("disables 2k and 4k presets unless the selected model is Codex", () => {
    expect(isImagePresetDisabled("gpt-image-2", "1k")).toBe(false)
    expect(isImagePresetDisabled("gpt-image-2", "2k")).toBe(true)
    expect(isImagePresetDisabled("gpt-image-2", "4k")).toBe(true)
    expect(isImagePresetDisabled("codex-mini-latest", "2k")).toBe(false)
    expect(isImagePresetDisabled("GPT-IMAGE-CODEX", "4k")).toBe(false)
  })
})

describe("ImageSettingsPanel", () => {
  const value = {
    model: "gpt-image-2",
    quality: "auto",
    width: "1024",
    height: "1024",
    ratio: "1:1",
    tier: "1k",
    count: "3",
  }

  it("reports popover field changes without owning image settings state", async () => {
    const onChange = vi.fn()
    const onOpenChange = vi.fn()

    render(
      createElement(ImageSettingsPanel, {
        presentation: "popover",
        open: true,
        onOpenChange,
        trigger: createElement("button", { type: "button" }, "打开图像设置"),
        value,
        imageModels: ["gpt-image-2", "codex-mini-latest"],
        onChange,
      }),
    )

    expect(screen.getByRole("heading", { name: "图像设置" })).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "图像设置" }).closest('[data-slot="popover-content"]')).toHaveAttribute(
      "data-side",
      "top",
    )
    expect(screen.getByRole("button", { name: "16:9(2k)" })).toBeDisabled()

    fireEvent.click(screen.getByRole("button", { name: "高" }))
    fireEvent.change(screen.getByLabelText("自定义宽度"), { target: { value: "1234" } })

    expect(onChange).toHaveBeenNthCalledWith(1, { quality: "high" })
    expect(onChange).toHaveBeenNthCalledWith(2, { width: "1234" })

    await new Promise((resolve) => window.setTimeout(resolve, 0))
    fireEvent.pointerDown(document.body)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("renders the same controlled settings in a bottom sheet", () => {
    render(
      createElement(ImageSettingsPanel, {
        presentation: "sheet",
        open: true,
        onOpenChange: vi.fn(),
        trigger: createElement("button", { type: "button" }, "打开移动图像设置"),
        value,
        imageModels: ["gpt-image-2"],
        onChange: vi.fn(),
      }),
    )

    expect(screen.getByRole("dialog")).toHaveAttribute("data-slot", "sheet-content")
    expect(screen.getByRole("heading", { name: "图像设置" })).toBeInTheDocument()
    expect(screen.getByLabelText("自定义生成数量")).toHaveAttribute("max", "100")
  })
})
