import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppShell } from "@/components/app-shell";

const mocks = vi.hoisted(() => ({
  pathname: "/chat",
  replace: vi.fn(),
  getValidatedAuthSession: vi.fn(),
  fetchThirdPartyApps: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
  useRouter: () => ({ replace: mocks.replace }),
}));

vi.mock("@/components/header-actions", () => ({
  HeaderActions: () => <div data-testid="header-actions" />,
}));

vi.mock("@/lib/auth-session", () => ({
  getValidatedAuthSession: mocks.getValidatedAuthSession,
}));

vi.mock("@/lib/api", () => ({
  fetchThirdPartyApps: mocks.fetchThirdPartyApps,
}));

const userSession = {
  key: "user-key",
  role: "user" as const,
  subjectId: "user:1",
  name: "Alice",
};

const adminSession = {
  key: "admin-key",
  role: "admin" as const,
  subjectId: "admin:1",
  name: "Admin",
};

function renderShell(pathname: string) {
  mocks.pathname = pathname;
  return render(
    <AppShell>
      <section>页面内容</section>
    </AppShell>,
  );
}

describe("AppShell", () => {
  beforeEach(() => {
    mocks.pathname = "/chat";
    mocks.replace.mockReset();
    mocks.getValidatedAuthSession.mockReset();
    mocks.getValidatedAuthSession.mockResolvedValue(userSession);
    mocks.fetchThirdPartyApps.mockReset();
    mocks.fetchThirdPartyApps.mockResolvedValue({
      third_party_apps: {
        infinite_canvas: { enabled: false, url: "" },
      },
    });
  });

  it("为 /chat 提供无 TopNav 的全高中性工作表面", () => {
    const { container } = renderShell("/chat");

    const main = container.querySelector("main");
    expect(main).toHaveClass("h-dvh", "min-h-dvh", "overflow-hidden", "bg-background");
    expect(main).not.toHaveClass("px-4", "max-w-[1440px]");
    expect(main?.firstElementChild).toHaveClass(
      "min-h-0",
      "flex-1",
      "pt-[env(safe-area-inset-top)]",
      "pr-[env(safe-area-inset-right)]",
      "pb-[env(safe-area-inset-bottom)]",
      "pl-[env(safe-area-inset-left)]",
    );
    expect(container.querySelector("header")).not.toBeInTheDocument();
    expect(screen.getByText("页面内容")).toBeVisible();
  });

  it("识别带 basePath 和尾斜杠的聊天路径", () => {
    const { container } = renderShell("/chatgpt2api/chat/");

    expect(container.querySelector("main")).toHaveClass("min-h-dvh", "bg-background");
    expect(container.querySelector("header")).not.toBeInTheDocument();
  });

  it("保留 /image 的现有 TopNav、渐变、间距和最大宽度", async () => {
    const { container } = renderShell("/image");

    await waitFor(() => expect(container.querySelector("header")).toBeInTheDocument());
    const main = container.querySelector("main");
    expect(main).toHaveClass("min-h-screen", "px-4", "sm:px-6", "lg:px-8");
    expect(main?.className).toContain("bg-[radial-gradient");
    expect(main?.firstElementChild).toHaveClass("max-w-[1440px]");
  });

  it("保留 login 的现有非聊天壳层并隐藏 TopNav", () => {
    const { container } = renderShell("/login");

    expect(container.querySelector("main")).toHaveClass("min-h-screen", "px-4");
    expect(container.querySelector("header")).not.toBeInTheDocument();
  });

  it("保留 admin 导航和现有壳层", async () => {
    mocks.getValidatedAuthSession.mockResolvedValue(adminSession);
    const { container } = renderShell("/accounts");

    await waitFor(() => expect(container.querySelector("header")).toBeInTheDocument());
    expect(container.querySelector("main")).toHaveClass("min-h-screen", "px-4");
    expect(screen.getAllByRole("link", { name: "号池管理" }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("link", { name: "聊天" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "画图" })).not.toBeInTheDocument();
  });

  it("普通用户导航同时提供聊天和画图入口", async () => {
    renderShell("/image");

    const chatLinks = await screen.findAllByRole("link", { name: "聊天" });
    const imageLinks = screen.getAllByRole("link", { name: "画图" });
    expect(screen.getAllByText("ChatCanvas").length).toBeGreaterThan(0);
    expect(chatLinks.some((link) => link.getAttribute("href") === "/chat")).toBe(true);
    expect(imageLinks.some((link) => link.getAttribute("href") === "/image")).toBe(true);
  });
});
