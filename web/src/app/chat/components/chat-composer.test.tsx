import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import type { PreparedChatAttachment } from "@/app/chat/lib/chat-types"
import type { ImageSettings } from "@/app/image/components/image-settings"

import { ChatAttachmentPicker } from "./chat-attachment-picker"
import { ChatComposer } from "./chat-composer"

const imageSettings: ImageSettings = {
  model: "gpt-image-2",
  quality: "high",
  width: "1920",
  height: "1088",
  ratio: "16:9",
  tier: "1k",
  count: "3",
}

function attachment(
  id: string,
  kind: PreparedChatAttachment["kind"],
  name: string,
): PreparedChatAttachment {
  return {
    id,
    name,
    mimeType: kind === "image" ? "image/png" : "application/pdf",
    size: 1024,
    sha256: id.padEnd(64, "0").slice(0, 64),
    kind,
    blob: new Blob(["x"]),
  }
}

function composerProps() {
  return {
    value: "请总结",
    onValueChange: vi.fn(),
    onSubmit: vi.fn(),
    onStop: vi.fn(),
    onFilesSelected: vi.fn(),
    onRemoveAttachment: vi.fn(),
    onModeChange: vi.fn(),
    onImageSettingsChange: vi.fn(),
    attachments: [] as PreparedChatAttachment[],
    mode: "chat" as const,
    isStreaming: false,
    imageSettings,
    imageModels: ["gpt-image-2", "codex-mini-latest"],
    imageSettingsPresentation: "popover" as const,
  }
}

describe("ChatAttachmentPicker", () => {
  it("enforces the visible 10 image and 5 document picker limits", () => {
    render(
      <ChatAttachmentPicker
        imageCount={10}
        documentCount={5}
        imageMode={false}
        onFilesSelected={vi.fn()}
        onEnableImageMode={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: "添加附件" }))
    expect(screen.getByRole("button", { name: "添加图片" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "添加文件" })).toBeDisabled()
  })
})

describe("ChatComposer", () => {
  it("removes pending attachments and blocks a document/image-mode conflict", () => {
    const props = composerProps()
    const document = attachment("document", "document", "季度报告.pdf")
    render(<ChatComposer {...props} attachments={[document]} mode="image" />)

    expect(screen.getByRole("alert")).toHaveTextContent("生成图片模式不能添加文档附件")
    expect(screen.getByRole("button", { name: "生成图片" })).toBeDisabled()
    fireEvent.click(screen.getByRole("button", { name: "移除附件 季度报告.pdf" }))
    expect(props.onRemoveAttachment).toHaveBeenCalledWith("document")
  })

  it("uses Enter to send, Shift+Enter for a newline, and exposes stop while streaming", () => {
    const props = composerProps()
    const { rerender } = render(<ChatComposer {...props} />)
    const textbox = screen.getByRole("textbox", { name: "消息" })
    expect(screen.getByTestId("chat-composer")).toHaveClass("max-w-[780px]")

    fireEvent.keyDown(textbox, { key: "Enter", shiftKey: true })
    expect(props.onSubmit).not.toHaveBeenCalled()
    fireEvent.keyDown(textbox, { key: "Enter", shiftKey: false })
    expect(props.onSubmit).toHaveBeenCalledOnce()

    rerender(<ChatComposer {...props} isStreaming />)
    fireEvent.click(screen.getByRole("button", { name: "停止生成" }))
    expect(props.onStop).toHaveBeenCalledOnce()
  })

  it("requires a prompt in image mode even when a reference image is attached", () => {
    const props = composerProps()
    render(
      <ChatComposer
        {...props}
        value=""
        mode="image"
        attachments={[attachment("reference", "image", "reference.png")]}
      />,
    )

    expect(screen.getByRole("button", { name: "生成图片" })).toBeDisabled()
  })

  it("wraps image quota and task status instead of overflowing narrow screens", () => {
    const props = composerProps()
    render(
      <ChatComposer
        {...props}
        mode="image"
        availableQuota={123456789}
        activeImageTaskCount={999}
      />,
    )

    expect(screen.getByTestId("chat-image-status")).toHaveClass("flex-wrap")
    expect(screen.getByText("剩余额度 123456789")).toBeInTheDocument()
    expect(screen.getByText("999 个任务处理中")).toBeInTheDocument()
  })

  it("reports pasted and dropped images without preparing or storing them", () => {
    const props = composerProps()
    render(<ChatComposer {...props} />)
    const textbox = screen.getByRole("textbox", { name: "消息" })
    const image = new File(["image"], "reference.png", { type: "image/png" })

    fireEvent.paste(textbox, { clipboardData: { files: [image] } })
    expect(props.onFilesSelected).toHaveBeenCalledWith([image])

    const dropzone = screen.getByTestId("chat-composer-dropzone")
    fireEvent.drop(dropzone, { dataTransfer: { files: [image], types: ["Files"] } })
    expect(props.onFilesSelected).toHaveBeenLastCalledWith([image])
  })

  it.each([
    ["popover", "popover-content"],
    ["sheet", "sheet-content"],
  ] as const)("opens image settings in the %s presentation", (presentation, slot) => {
    const props = composerProps()
    render(
      <ChatComposer
        {...props}
        mode="image"
        imageSettingsPresentation={presentation}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: "图像设置" }))
    expect(screen.getByRole("heading", { name: "图像设置" })).toBeInTheDocument()
    expect(document.querySelector(`[data-slot="${slot}"]`)).toBeInTheDocument()
  })

  it("enables explicit image mode from the attachment menu", () => {
    const props = composerProps()
    render(<ChatComposer {...props} />)

    fireEvent.click(screen.getByRole("button", { name: "添加附件" }))
    fireEvent.click(screen.getByRole("button", { name: "生成图片" }))
    expect(props.onModeChange).toHaveBeenCalledWith("image")
  })
})
