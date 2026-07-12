import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { ModelCatalogCard } from "./model-catalog-card"

vi.mock("@/lib/paths", () => ({
  withBasePath: (path: string) => path,
}))

const models = [
  {
    id: "gpt-latest",
    object: "model",
    created: 0,
    owned_by: "chatgpt",
    permission: [],
    root: "gpt-latest",
    parent: null,
  },
]

describe("ModelCatalogCard", () => {
  it("requests an explicit model refresh without hiding the current catalog", () => {
    const onRefresh = vi.fn()

    render(
      <ModelCatalogCard
        models={models}
        isLoading={false}
        isRefreshing={false}
        onRefresh={onRefresh}
        onCopy={vi.fn()}
      />,
    )

    expect(screen.getByText("系统可用模型")).toBeInTheDocument()
    expect(screen.getByText("(1)")).toBeInTheDocument()
    expect(screen.getByText("gpt-latest")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "刷新系统模型" }))

    expect(onRefresh).toHaveBeenCalledOnce()
  })

  it("disables the refresh action while a request is in progress", () => {
    render(
      <ModelCatalogCard
        models={models}
        isLoading={false}
        isRefreshing
        onRefresh={vi.fn()}
        onCopy={vi.fn()}
      />,
    )

    expect(screen.getByRole("button", { name: "正在刷新系统模型" })).toBeDisabled()
  })
})
