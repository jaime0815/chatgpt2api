import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  fetchAccounts: vi.fn(),
  fetchModels: vi.fn(),
  authGuard: {
    isCheckingAuth: false,
    session: { role: "admin" as const },
  },
}))

vi.mock("@/lib/api", () => ({
  fetchAccounts: mocks.fetchAccounts,
  fetchModels: mocks.fetchModels,
  deleteAccounts: vi.fn(),
  fetchRefreshProgress: vi.fn(),
  fetchReLoginProgress: vi.fn(),
  reLoginAccounts: vi.fn(),
  refreshAccounts: vi.fn(),
  testProxy: vi.fn(),
  updateAccount: vi.fn(),
}))

vi.mock("@/lib/use-auth-guard", () => ({
  useAuthGuard: () => mocks.authGuard,
}))

vi.mock("./components/account-import-dialog", () => ({
  AccountImportDialog: () => null,
}))

vi.mock("./components/model-catalog-card", () => ({
  ModelCatalogCard: ({ onRefresh }: { onRefresh: () => void }) => (
    <button type="button" onClick={onRefresh}>刷新系统模型</button>
  ),
}))

import AccountsPage from "./page"

describe("AccountsPage", () => {
  beforeEach(() => {
    mocks.fetchAccounts.mockReset()
    mocks.fetchModels.mockReset()
    mocks.fetchAccounts.mockResolvedValue({ items: [] })
    mocks.fetchModels.mockResolvedValue({ object: "list", data: [] })
  })

  it("uses the explicit refresh request when an administrator refreshes the model catalog", async () => {
    render(<AccountsPage />)

    await waitFor(() => expect(mocks.fetchModels).toHaveBeenCalledOnce())

    fireEvent.click(screen.getByRole("button", { name: "刷新系统模型" }))

    await waitFor(() => expect(mocks.fetchModels).toHaveBeenLastCalledWith({ refresh: true }))
  })
})
