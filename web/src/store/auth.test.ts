import { describe, expect, it } from "vitest";

import { getDefaultRouteForRole } from "@/store/auth";

describe("getDefaultRouteForRole", () => {
  it("将普通用户送到聊天页", () => {
    expect(getDefaultRouteForRole("user")).toBe("/chat");
  });

  it("保留管理员的号池管理入口", () => {
    expect(getDefaultRouteForRole("admin")).toBe("/accounts");
  });
});
