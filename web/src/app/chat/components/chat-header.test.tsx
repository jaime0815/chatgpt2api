import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeAll, describe, expect, it, vi } from "vitest"

import { ChatHeader } from "./chat-header"
import { ChatModelSelect } from "./chat-model-select"

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", {
    configurable: true,
    value: () => false,
  })
  Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
    configurable: true,
    value: () => undefined,
  })
  Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", {
    configurable: true,
    value: () => undefined,
  })
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: () => undefined,
  })
})

describe("ChatModelSelect", () => {
  it("groups selectable text models by provider and reports a normal-user selection", async () => {
    const onValueChange = vi.fn()
    const user = userEvent.setup()
    render(
      <ChatModelSelect
        models={["gpt-5.4", "claude-sonnet-4", "gpt-image-2", "codex-mini-latest"]}
        value="auto"
        onValueChange={onValueChange}
      />,
    )

    const trigger = screen.getByRole("combobox", { name: "聊天模型" })
    await user.click(trigger)

    expect(screen.queryByRole("option", { name: "gpt-image-2" })).not.toBeInTheDocument()
    expect(screen.getByText("OpenAI")).toBeInTheDocument()
    expect(screen.getByText("Anthropic")).toBeInTheDocument()
    await user.click(screen.getByRole("option", { name: "claude-sonnet-4" }))
    expect(onValueChange).toHaveBeenCalledWith("claude-sonnet-4")
  })

  it("does not expose a selectable list when no text model is available", () => {
    render(
      <ChatModelSelect
        models={["gpt-image-2"]}
        value="auto"
        onValueChange={vi.fn()}
      />,
    )

    expect(screen.getByRole("combobox", { name: "聊天模型" })).toBeDisabled()
  })

  it("shows an unavailable model warning without selecting another concrete model", () => {
    render(
      <ChatModelSelect
        models={["gpt-5.4"]}
        value="auto"
        unavailableModel="retired-model"
        onValueChange={vi.fn()}
      />,
    )

    expect(screen.getByRole("status")).toHaveTextContent("retired-model 已不可用，已切换为自动")
  })
})

describe("ChatHeader", () => {
  it("exposes mobile and conversation commands", () => {
    const onOpenSidebar = vi.fn()
    const onNewConversation = vi.fn()
    const onRenameConversation = vi.fn()
    const onDeleteConversation = vi.fn()
    const onRefreshModels = vi.fn()

    render(
      <ChatHeader
        models={["gpt-5.4"]}
        selectedModel="gpt-5.4"
        conversationTitle="测试会话"
        onModelChange={vi.fn()}
        onOpenSidebar={onOpenSidebar}
        onNewConversation={onNewConversation}
        onRefreshModels={onRefreshModels}
        onRenameConversation={onRenameConversation}
        onDeleteConversation={onDeleteConversation}
      />,
    )

    expect(screen.getByRole("banner").firstElementChild).toHaveClass(
      "grid-cols-[80px_minmax(0,1fr)_80px]",
    )

    fireEvent.click(screen.getByRole("button", { name: "打开聊天历史" }))
    fireEvent.click(screen.getByRole("button", { name: "新对话" }))
    fireEvent.click(screen.getByRole("button", { name: "刷新模型" }))
    fireEvent.click(screen.getByRole("button", { name: "会话操作" }))
    fireEvent.click(screen.getByRole("button", { name: "重命名对话" }))

    expect(onOpenSidebar).toHaveBeenCalledOnce()
    expect(onNewConversation).toHaveBeenCalledOnce()
    expect(onRefreshModels).toHaveBeenCalledOnce()
    expect(onRenameConversation).toHaveBeenCalledOnce()

    fireEvent.click(screen.getByRole("button", { name: "会话操作" }))
    fireEvent.click(screen.getByRole("button", { name: "删除对话" }))
    expect(onDeleteConversation).toHaveBeenCalledOnce()
  })
})
