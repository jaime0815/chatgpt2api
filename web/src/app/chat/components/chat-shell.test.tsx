import { useState } from "react"
import { fireEvent, render, screen, within } from "@testing-library/react"
import { beforeAll, describe, expect, it } from "vitest"

import { ChatShell } from "./chat-shell"

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

function ShellHarness() {
  const [open, setOpen] = useState(false)
  return (
    <ChatShell
      mobileSidebarOpen={open}
      onMobileSidebarOpenChange={setOpen}
      sidebar={<nav aria-label="会话列表">历史内容</nav>}
      header={
        <button type="button" onClick={() => setOpen(true)}>
          打开聊天历史
        </button>
      }
      thread={<div>消息区域</div>}
      composer={<div>输入区域</div>}
    />
  )
}

describe("ChatShell", () => {
  it("keeps a fixed 248px desktop sidebar and prevents page overflow", () => {
    render(<ShellHarness />)

    expect(screen.getByTestId("chat-shell")).toHaveClass("overflow-hidden")
    expect(screen.getByTestId("chat-desktop-sidebar")).toHaveClass("w-[248px]")
    expect(screen.getByTestId("chat-main")).toHaveClass("min-w-0")
  })

  it("opens and closes the mobile history sheet", () => {
    render(<ShellHarness />)

    fireEvent.click(screen.getByRole("button", { name: "打开聊天历史" }))
    const drawer = screen.getByRole("dialog", { name: "聊天历史" })
    expect(within(drawer).getByRole("navigation", { name: "会话列表" })).toBeInTheDocument()

    fireEvent.click(within(drawer).getByRole("button", { name: "关闭侧栏" }))
    expect(screen.queryByRole("dialog", { name: "聊天历史" })).not.toBeInTheDocument()
  })
})
