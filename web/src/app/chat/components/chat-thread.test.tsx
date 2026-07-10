import { fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { ChatMessage } from "@/app/chat/lib/chat-types"

import { ChatThread } from "./chat-thread"

const userMessage: ChatMessage = {
  id: "user-1",
  role: "user",
  text: "你好",
  attachmentIds: [],
  status: "complete",
  createdAt: "2026-07-11T00:00:00.000Z",
}

afterEach(() => {
  vi.useRealTimers()
})

describe("ChatThread", () => {
  it("keeps the empty conversation concise", () => {
    render(<ChatThread conversationId="new" messages={[]} />)

    expect(screen.getByRole("heading", { name: "有什么可以帮你？" })).toBeInTheDocument()
    expect(screen.queryByText(/功能|快捷键|支持/)).not.toBeInTheDocument()
  })

  it("uses a stable 760px message column and reports scroll positions", () => {
    const onScrollTopChange = vi.fn()
    render(
      <ChatThread
        conversationId="chat-1"
        messages={[userMessage]}
        initialScrollTop={120}
        scrollCommitDelayMs={0}
        onScrollTopChange={onScrollTopChange}
      />,
    )

    const region = screen.getByRole("log", { name: "聊天消息" })
    expect(region.firstElementChild).toHaveClass("max-w-[760px]")
    expect(region.scrollTop).toBe(120)

    region.scrollTop = 240
    fireEvent.scroll(region)
    expect(onScrollTopChange).toHaveBeenCalledWith(240)
  })

  it("does not reset live scroll when the same conversation persists a new value", () => {
    const { rerender } = render(
      <ChatThread conversationId="chat-1" messages={[userMessage]} initialScrollTop={120} />,
    )
    const region = screen.getByRole("log", { name: "聊天消息" })
    region.scrollTop = 260

    rerender(
      <ChatThread conversationId="chat-1" messages={[userMessage]} initialScrollTop={40} />,
    )

    expect(region.scrollTop).toBe(260)
  })

  it("debounces scroll persistence and flushes the latest value when switching conversations", () => {
    vi.useFakeTimers()
    const onScrollTopChange = vi.fn()
    const { rerender } = render(
      <ChatThread
        conversationId="chat-1"
        messages={[userMessage]}
        scrollCommitDelayMs={300}
        onScrollTopChange={onScrollTopChange}
      />,
    )
    const region = screen.getByRole("log", { name: "聊天消息" })
    region.scrollTop = 120
    fireEvent.scroll(region)
    region.scrollTop = 240
    fireEvent.scroll(region)

    expect(onScrollTopChange).not.toHaveBeenCalled()
    vi.advanceTimersByTime(299)
    expect(onScrollTopChange).not.toHaveBeenCalled()

    rerender(
      <ChatThread
        conversationId="chat-2"
        messages={[]}
        scrollCommitDelayMs={300}
        onScrollTopChange={onScrollTopChange}
      />,
    )
    expect(onScrollTopChange).toHaveBeenCalledOnce()
    expect(onScrollTopChange).toHaveBeenCalledWith(240)
  })
})
