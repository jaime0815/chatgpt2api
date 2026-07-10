"use client";

import { usePathname } from "next/navigation";

import { TopNav } from "@/components/top-nav";
import { withBasePath } from "@/lib/paths";

function normalizePathname(pathname: string) {
  if (pathname === "/") {
    return pathname;
  }
  return pathname.replace(/\/+$/, "");
}

export function isChatPathname(pathname: string | null) {
  if (!pathname) {
    return false;
  }

  const normalizedPathname = normalizePathname(pathname);
  return (
    normalizedPathname === "/chat" ||
    normalizedPathname === normalizePathname(withBasePath("/chat"))
  );
}

export function AppShell({ children }: Readonly<{ children: React.ReactNode }>) {
  const pathname = usePathname();

  if (isChatPathname(pathname)) {
    return (
      <main className="bg-background text-foreground box-border flex h-dvh min-h-dvh w-full flex-col overflow-hidden">
        <div className="box-border flex min-h-0 flex-1 flex-col pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]">
          {children}
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen overflow-x-hidden bg-[radial-gradient(circle_at_top_left,_rgba(255,255,255,0.92),_rgba(245,239,231,0.96)_42%,_rgba(240,235,227,0.99)_100%)] px-4 pt-0 pb-2 text-stone-900 transition-colors duration-300 dark:bg-[radial-gradient(circle_at_top_left,_rgba(55,48,43,0.72),_rgba(28,25,23,0.98)_40%,_rgba(12,10,9,1)_100%)] dark:text-stone-100 sm:px-6 sm:pt-2 lg:px-8">
      <div className="mx-auto box-border flex min-h-screen max-w-[1440px] flex-col gap-2 pt-[env(safe-area-inset-top)] sm:gap-5 sm:pt-0">
        <TopNav />
        {children}
      </div>
    </main>
  );
}
