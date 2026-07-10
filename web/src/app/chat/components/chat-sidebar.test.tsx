import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { ChatSidebar } from "./chat-sidebar"

describe("ChatSidebar", () => {
  const conversations = [
    {
      id: "today",
      title: "今天的对话",
      updatedAt: "2026-07-11T08:00:00.000Z",
    },
    {
      id: "week",
      title: "本周的对话",
      updatedAt: "2026-07-07T08:00:00.000Z",
    },
    {
      id: "older",
      title: "更早的对话",
      updatedAt: "2026-06-01T08:00:00.000Z",
    },
  ]

  function renderSidebar() {
    const callbacks = {
      onNewConversation: vi.fn(),
      onSelectConversation: vi.fn(),
      onRenameConversation: vi.fn(),
      onDeleteConversation: vi.fn(),
      onToggleTheme: vi.fn(),
      onSignOut: vi.fn(),
      onNavigate: vi.fn(),
    }

    render(
      <ChatSidebar
        conversations={conversations}
        activeConversationId="week"
        now={new Date("2026-07-11T12:00:00.000Z")}
        user={{ name: "林舟", role: "user" }}
        theme="light"
        chatHref="/chat"
        imageHref="/image"
        {...callbacks}
      />,
    )

    return callbacks
  }

  it("groups history and reports desktop navigation actions", () => {
    const callbacks = renderSidebar()

    expect(screen.getByText("ChatGPT2API")).toBeInTheDocument()
    expect(screen.getByText("今天")).toBeInTheDocument()
    expect(screen.getByText("过去 7 天")).toBeInTheDocument()
    expect(screen.getByText("更早")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "聊天" })).toHaveAttribute("href", "/chat")
    expect(screen.getByRole("link", { name: "高级画图" })).toHaveAttribute("href", "/image")

    fireEvent.click(screen.getByRole("button", { name: "新对话" }))
    fireEvent.click(screen.getByRole("button", { name: "选择 更早的对话" }))
    fireEvent.click(screen.getByRole("button", { name: "切换主题" }))
    fireEvent.click(screen.getByRole("button", { name: "退出登录" }))

    expect(callbacks.onNewConversation).toHaveBeenCalledOnce()
    expect(callbacks.onSelectConversation).toHaveBeenCalledWith("older")
    expect(callbacks.onNavigate).toHaveBeenCalledTimes(2)
    expect(callbacks.onToggleTheme).toHaveBeenCalledOnce()
    expect(callbacks.onSignOut).toHaveBeenCalledOnce()
    expect(screen.getAllByText("林舟").length).toBeGreaterThan(0)
    expect(screen.getByText("普通用户")).toBeInTheDocument()
  })

  it("renames and deletes a conversation through controlled callbacks", () => {
    const callbacks = renderSidebar()

    fireEvent.click(screen.getByRole("button", { name: "重命名 今天的对话" }))
    const input = screen.getByRole("textbox", { name: "重命名 今天的对话" })
    fireEvent.change(input, { target: { value: "新的标题" } })
    fireEvent.keyDown(input, { key: "Enter" })

    expect(callbacks.onRenameConversation).toHaveBeenCalledWith("today", "新的标题")

    fireEvent.click(screen.getByRole("button", { name: "删除 更早的对话" }))
    expect(callbacks.onDeleteConversation).toHaveBeenCalledWith("older")
  })

  it("uses unique whitespace-free group labels across desktop and drawer instances", () => {
    const props = {
      conversations,
      activeConversationId: "today",
      now: new Date("2026-07-11T12:00:00.000Z"),
      user: { name: "林舟", role: "user" as const },
      theme: "light" as const,
      onNewConversation: vi.fn(),
      onSelectConversation: vi.fn(),
      onRenameConversation: vi.fn(),
      onDeleteConversation: vi.fn(),
      onToggleTheme: vi.fn(),
      onSignOut: vi.fn(),
    }
    render(
      <>
        <ChatSidebar {...props} />
        <ChatSidebar {...props} />
      </>,
    )

    const labelledBy = Array.from(document.querySelectorAll("section[aria-labelledby]"), (section) =>
      section.getAttribute("aria-labelledby"),
    ).filter((value): value is string => Boolean(value))
    expect(new Set(labelledBy).size).toBe(labelledBy.length)
    for (const id of labelledBy) {
      expect(id).not.toMatch(/\s/)
      expect(document.getElementById(id)).toBeInTheDocument()
    }
  })
})
