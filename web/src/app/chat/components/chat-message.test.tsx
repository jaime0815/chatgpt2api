import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeAll, describe, expect, it, vi } from "vitest"

import type { ChatMessage as ChatMessageValue } from "@/app/chat/lib/chat-types"

import { ChatMessage } from "./chat-message"

beforeAll(() => {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: ResizeObserverStub,
  })
})

function message(overrides: Partial<ChatMessageValue>): ChatMessageValue {
  return {
    id: "message-1",
    role: "assistant",
    text: "",
    attachmentIds: [],
    status: "complete",
    createdAt: "2026-07-11T00:00:00.000Z",
    ...overrides,
  }
}

describe("ChatMessage", () => {
  it("renders GFM Markdown and copies fenced code without widening the page", () => {
    const onCopy = vi.fn()
    render(
      <ChatMessage
        message={message({
          text: "## 结果\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n```ts\nconst answer = 42\n```",
        })}
        onCopy={onCopy}
      />,
    )

    expect(screen.getByRole("heading", { name: "结果" })).toBeInTheDocument()
    expect(screen.getByRole("table")).toBeInTheDocument()
    const code = screen.getByText("const answer = 42")
    expect(code.closest("pre")).toHaveClass("overflow-x-auto")

    fireEvent.click(screen.getByRole("button", { name: "复制代码" }))
    expect(onCopy).toHaveBeenCalledWith("const answer = 42")
  })

  it("reports user copy and edit-and-resend actions", () => {
    const onCopy = vi.fn()
    const onEditAndResend = vi.fn()
    render(
      <ChatMessage
        message={message({ id: "user-1", role: "user", text: "原始问题" })}
        onCopy={onCopy}
        onEditAndResend={onEditAndResend}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: "复制消息" }))
    fireEvent.click(screen.getByRole("button", { name: "编辑消息" }))
    fireEvent.change(screen.getByRole("textbox", { name: "编辑消息内容" }), {
      target: { value: "修改后的问题" },
    })
    fireEvent.click(screen.getByRole("button", { name: "保存并重发" }))

    expect(onCopy).toHaveBeenCalledWith("原始问题")
    expect(onEditAndResend).toHaveBeenCalledWith("user-1", {
      text: "修改后的问题",
      attachmentIds: [],
      files: [],
    })
  })

  it("allows historical attachments to be removed and new files added before resend", () => {
    const onEditAndResend = vi.fn()
    const newImage = new File(["image"], "new-reference.png", { type: "image/png" })
    render(
      <ChatMessage
        message={message({
          id: "user-with-files",
          role: "user",
          text: "分析附件",
          attachmentIds: ["document-1", "image-1"],
        })}
        attachments={[
          { id: "document-1", name: "旧报告.pdf", kind: "document" },
          { id: "image-1", name: "旧图片.png", kind: "image" },
        ]}
        onEditAndResend={onEditAndResend}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: "编辑消息" }))
    fireEvent.click(screen.getByRole("button", { name: "移除编辑附件 旧报告.pdf" }))
    fireEvent.click(screen.getByRole("button", { name: "添加附件" }))
    expect(screen.queryByRole("button", { name: "生成图片" })).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText("选择图片"), { target: { files: [newImage] } })
    expect(screen.getByText("new-reference.png")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "保存并重发" }))
    expect(onEditAndResend).toHaveBeenCalledWith("user-with-files", {
      text: "分析附件",
      attachmentIds: ["image-1"],
      files: [newImage],
    })
  })

  it("reports copy failure without announcing success", async () => {
    const error = new Error("clipboard denied")
    const onCopyError = vi.fn()
    render(
      <ChatMessage
        message={message({ text: "无法复制的回答" })}
        onCopy={vi.fn().mockRejectedValue(error)}
        onCopyError={onCopyError}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: "复制消息" }))
    await waitFor(() => expect(onCopyError).toHaveBeenCalledWith(error))
    expect(screen.getByRole("button", { name: "复制消息" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "已复制" })).not.toBeInTheDocument()
  })

  it("keeps the edit draft and files visible when async resend fails", async () => {
    const newDocument = new File(["document"], "too-large.pdf", { type: "application/pdf" })
    let rejectResend!: (reason?: unknown) => void
    const resend = new Promise<void>((_resolve, reject) => {
      rejectResend = reject
    })
    render(
      <ChatMessage
        message={message({ id: "edit-failure", role: "user", text: "保留我的草稿" })}
        onEditAndResend={vi.fn(() => resend)}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: "编辑消息" }))
    fireEvent.click(screen.getByRole("button", { name: "添加附件" }))
    fireEvent.change(screen.getByLabelText("选择文件"), { target: { files: [newDocument] } })
    fireEvent.click(screen.getByRole("button", { name: "保存并重发" }))

    expect(screen.getByRole("button", { name: "正在重发" })).toBeDisabled()
    await act(async () => rejectResend(new Error("附件校验失败")))
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("附件校验失败"))
    expect(screen.getByRole("textbox", { name: "编辑消息内容" })).toHaveValue("保留我的草稿")
    expect(screen.getByText("too-large.pdf")).toBeInTheDocument()
  })

  it("does not expose text retry or resume-poll while an image is normally running", () => {
    const runningImage = {
      id: "image-1",
      taskId: "task-1",
      url: "/images/result.png",
      status: "running" as const,
      width: 1920,
      height: 1088,
    }
    const onRetry = vi.fn()
    render(
      <ChatMessage
        message={message({
          id: "image-message",
          status: "running",
          images: [runningImage],
          imageSettings: {
            mode: "generate",
            model: "gpt-image-2",
            quality: "high",
            width: "1920",
            height: "1088",
            ratio: "16:9",
            tier: "1k",
            count: 1,
          },
        })}
        onRetry={onRetry}
        onResumeImage={vi.fn()}
      />,
    )

    expect(screen.queryByRole("button", { name: "重新生成" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "继续等待图片" })).not.toBeInTheDocument()
    expect(screen.getByRole("img", { name: "生成图片" })).toHaveClass("object-contain")
    expect(screen.getByRole("img", { name: "生成图片" }).parentElement).toHaveStyle({
      aspectRatio: "1920 / 1088",
    })
  })

  it("offers continue waiting only for a timed-out image with a task id", () => {
    const timedOutImage = {
      id: "image-timeout",
      taskId: "task-timeout",
      status: "error" as const,
      error: "图片生成超时",
    }
    const onResumeImage = vi.fn()
    render(
      <ChatMessage
        message={message({ id: "timeout-message", status: "error", images: [timedOutImage] })}
        onResumeImage={onResumeImage}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: "继续等待图片" }))
    expect(onResumeImage).toHaveBeenCalledWith("timeout-message", timedOutImage)
  })

  it("reports a failed image through the image retry callback", () => {
    const failedImage = {
      id: "image-error",
      taskId: "task-error",
      status: "error" as const,
      error: "任务失败",
    }
    const onRetryImage = vi.fn()
    render(
      <ChatMessage
        message={message({ id: "failed-image-message", status: "error", images: [failedImage] })}
        onRetryImage={onRetryImage}
      />,
    )

    expect(screen.queryByRole("button", { name: "继续等待图片" })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "重试图片" }))
    expect(onRetryImage).toHaveBeenCalledWith("failed-image-message", failedImage)
  })

  it("reports assistant retry and feedback actions", () => {
    const onRetry = vi.fn()
    const onFeedback = vi.fn()
    render(
      <ChatMessage
        message={message({ id: "assistant-1", text: "回答" })}
        onRetry={onRetry}
        onFeedback={onFeedback}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: "重新生成" }))
    fireEvent.click(screen.getByRole("button", { name: "赞" }))
    fireEvent.click(screen.getByRole("button", { name: "踩" }))

    expect(onRetry).toHaveBeenCalledWith("assistant-1")
    expect(onFeedback).toHaveBeenNthCalledWith(1, "assistant-1", "up")
    expect(onFeedback).toHaveBeenNthCalledWith(2, "assistant-1", "down")
  })
})
