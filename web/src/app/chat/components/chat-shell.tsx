"use client"

import { X } from "lucide-react"
import type { ReactNode } from "react"

import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"

import { ChatTooltip } from "./chat-tooltip"

export type ChatShellProps = {
  sidebar: ReactNode
  header: ReactNode
  thread: ReactNode
  composer: ReactNode
  mobileSidebarOpen: boolean
  onMobileSidebarOpenChange: (open: boolean) => void
}

export function ChatShell({
  sidebar,
  header,
  thread,
  composer,
  mobileSidebarOpen,
  onMobileSidebarOpenChange,
}: ChatShellProps) {
  return (
    <div
      data-testid="chat-shell"
      className="flex h-dvh w-full min-w-0 overflow-hidden bg-background text-foreground"
    >
      <aside
        data-testid="chat-desktop-sidebar"
        className="hidden h-full w-[248px] shrink-0 border-r md:flex"
      >
        {sidebar}
      </aside>

      <Sheet open={mobileSidebarOpen} onOpenChange={onMobileSidebarOpenChange}>
        <SheetContent
          side="left"
          showCloseButton={false}
          className="w-[min(88vw,320px)] gap-0 p-0 sm:max-w-[320px]"
        >
          <SheetHeader className="sr-only">
            <SheetTitle>聊天历史</SheetTitle>
            <SheetDescription>选择、重命名或删除本地聊天会话</SheetDescription>
          </SheetHeader>
          <div className="absolute right-2 top-2 z-10">
            <ChatTooltip label="关闭侧栏" side="right">
              <SheetClose asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="关闭侧栏"
                >
                  <X />
                </Button>
              </SheetClose>
            </ChatTooltip>
          </div>
          <div className="min-h-0 flex-1">{sidebar}</div>
        </SheetContent>
      </Sheet>

      <main data-testid="chat-main" className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {header}
        <div className="min-h-0 min-w-0 flex-1">{thread}</div>
        {composer}
      </main>
    </div>
  )
}
