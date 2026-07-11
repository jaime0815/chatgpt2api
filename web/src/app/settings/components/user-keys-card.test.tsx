import { render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  fetchUserKeys: vi.fn(),
}))

vi.mock("@/lib/api", () => ({
  createUserKey: vi.fn(),
  deleteUserKey: vi.fn(),
  fetchUserKeys: mocks.fetchUserKeys,
  updateUserKey: vi.fn(),
}))

import { UserKeysCard } from "./user-keys-card"

describe("UserKeysCard", () => {
  beforeEach(() => {
    mocks.fetchUserKeys.mockReset()
    mocks.fetchUserKeys.mockResolvedValue({ items: [] })
  })

  it("describes chat and image access for ordinary users", async () => {
    render(<UserKeysCard />)

    expect(
      screen.getByText("为普通用户创建专用密钥；普通用户可使用聊天与画图，不能查看设置和号池。"),
    ).toBeInTheDocument()
    await waitFor(() => expect(mocks.fetchUserKeys).toHaveBeenCalledOnce())
  })
})
