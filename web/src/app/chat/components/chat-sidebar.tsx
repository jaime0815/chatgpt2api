"use client"

import { differenceInCalendarDays, isValid, parseISO } from "date-fns"
import {
  Image as ImageIcon,
  LogOut,
  MessageSquare,
  Moon,
  Pencil,
  Plus,
  Sun,
  Trash2,
} from "lucide-react"
import Link from "next/link"
import { useId, useState } from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import type { AuthRole } from "@/store/auth"

import { ChatTooltip } from "./chat-tooltip"

export type ChatSidebarConversation = {
  id: string
  title: string
  updatedAt: string
}

export type ChatSidebarUser = {
  name: string
  role: AuthRole
}

export type ChatSidebarProps = {
  conversations: readonly ChatSidebarConversation[]
  activeConversationId: string | null
  user: ChatSidebarUser
  theme: "light" | "dark"
  now?: Date
  chatHref?: string
  imageHref?: string
  currentSection?: "chat" | "image"
  onNewConversation: () => void
  onSelectConversation: (conversationId: string) => void
  onRenameConversation: (conversationId: string, title: string) => void
  onDeleteConversation: (conversationId: string) => void
  onClearHistory?: () => void
  onToggleTheme: () => void
  onSignOut: () => void
  onNavigate?: () => void
}

type ConversationGroup = {
  label: "今天" | "过去 7 天" | "更早"
  conversations: ChatSidebarConversation[]
}

export function groupChatSidebarConversations(
  conversations: readonly ChatSidebarConversation[],
  now = new Date(),
): ConversationGroup[] {
  const groups: ConversationGroup[] = [
    { label: "今天", conversations: [] },
    { label: "过去 7 天", conversations: [] },
    { label: "更早", conversations: [] },
  ]

  for (const conversation of conversations) {
    const updatedAt = parseISO(conversation.updatedAt)
    const days = isValid(updatedAt) ? differenceInCalendarDays(now, updatedAt) : Number.POSITIVE_INFINITY
    const group = days <= 0 ? groups[0] : days <= 7 ? groups[1] : groups[2]
    group.conversations.push(conversation)
  }

  return groups.filter((group) => group.conversations.length > 0)
}

function roleLabel(role: AuthRole) {
  return role === "admin" ? "管理员" : "普通用户"
}

function initials(name: string) {
  const trimmed = name.trim()
  return trimmed ? Array.from(trimmed).slice(0, 2).join("").toUpperCase() : "用户"
}

export function ChatSidebar({
  conversations,
  activeConversationId,
  user,
  theme,
  now,
  chatHref = "/chat",
  imageHref = "/image",
  currentSection = "chat",
  onNewConversation,
  onSelectConversation,
  onRenameConversation,
  onDeleteConversation,
  onClearHistory,
  onToggleTheme,
  onSignOut,
  onNavigate,
}: ChatSidebarProps) {
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState("")
  const sidebarInstanceId = useId()
  const groups = groupChatSidebarConversations(conversations, now)

  function beginRename(conversation: ChatSidebarConversation) {
    setRenamingId(conversation.id)
    setRenameDraft(conversation.title)
  }

  function submitRename(conversation: ChatSidebarConversation) {
    const title = renameDraft.trim()
    setRenamingId(null)
    if (title && title !== conversation.title) {
      onRenameConversation(conversation.id, title)
    }
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex h-14 shrink-0 items-center px-3">
        <span className="truncate text-base font-semibold">ChatCanvas</span>
      </div>

      <div className="relative flex shrink-0 flex-col gap-1 px-2">
        <Button
          type="button"
          variant="outline"
          className="h-10 w-full justify-start rounded-md bg-sidebar px-3 shadow-none"
          onClick={() => {
            onNewConversation()
            onNavigate?.()
          }}
        >
          <Plus data-icon="inline-start" />
          新对话
        </Button>
        {conversations.length > 0 && onClearHistory ? (
          <ChatTooltip label="清空聊天记录">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute top-3 right-3 size-8 text-muted-foreground hover:text-destructive"
              aria-label="清空聊天记录"
              onClick={() => {
                if (window.confirm("确定清空全部本地聊天记录吗？")) {
                  onClearHistory()
                  onNavigate?.()
                }
              }}
            >
              <Trash2 />
            </Button>
          </ChatTooltip>
        ) : null}
        <Link
          href={chatHref}
          onClick={onNavigate}
          aria-current={currentSection === "chat" ? "page" : undefined}
          className={cn(
            "flex h-9 items-center gap-2 rounded-md px-3 text-sm transition hover:bg-sidebar-accent",
            currentSection === "chat" && "bg-sidebar-accent font-medium",
          )}
        >
          <MessageSquare className="size-4" />
          聊天
        </Link>
        <Link
          href={imageHref}
          onClick={onNavigate}
          aria-current={currentSection === "image" ? "page" : undefined}
          className={cn(
            "flex h-9 items-center gap-2 rounded-md px-3 text-sm transition hover:bg-sidebar-accent",
            currentSection === "image" && "bg-sidebar-accent font-medium",
          )}
        >
          <ImageIcon className="size-4" />
          高级画图
        </Link>
      </div>

      <div className="mt-3 min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {groups.map((group, groupIndex) => {
          const headingId = `${sidebarInstanceId}-history-${groupIndex}`
          return (
            <section key={group.label} aria-labelledby={headingId} className="mb-4">
              <h2 id={headingId} className="px-2 pb-1 text-xs font-medium text-muted-foreground">
                {group.label}
              </h2>
              <div className="flex flex-col gap-0.5">
              {group.conversations.map((conversation) => {
                const active = conversation.id === activeConversationId
                const isRenaming = conversation.id === renamingId

                return (
                  <div
                    key={conversation.id}
                    className={cn(
                      "group flex min-h-9 min-w-0 items-center rounded-md hover:bg-sidebar-accent",
                      active && "bg-sidebar-accent",
                    )}
                  >
                    {isRenaming ? (
                      <Input
                        autoFocus
                        value={renameDraft}
                        aria-label={`重命名 ${conversation.title}`}
                        className="mx-1 h-8 min-w-0 flex-1 rounded-md bg-background px-2 shadow-none"
                        onChange={(event) => setRenameDraft(event.target.value)}
                        onBlur={() => setRenamingId(null)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault()
                            submitRename(conversation)
                          }
                          if (event.key === "Escape") {
                            setRenamingId(null)
                          }
                        }}
                      />
                    ) : (
                      <button
                        type="button"
                        aria-label={`选择 ${conversation.title}`}
                        aria-current={active ? "true" : undefined}
                        className="min-w-0 flex-1 truncate px-2 py-2 text-left text-sm"
                        title={conversation.title}
                        onClick={() => {
                          onSelectConversation(conversation.id)
                          onNavigate?.()
                        }}
                      >
                        {conversation.title}
                      </button>
                    )}

                    {!isRenaming ? (
                      <div className="flex shrink-0 items-center pr-1 opacity-70 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100">
                        <ChatTooltip label="重命名">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-8"
                            aria-label={`重命名 ${conversation.title}`}
                            onClick={() => beginRename(conversation)}
                          >
                            <Pencil />
                          </Button>
                        </ChatTooltip>
                        <ChatTooltip label="删除">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-8 text-muted-foreground hover:text-destructive"
                            aria-label={`删除 ${conversation.title}`}
                            onClick={() => onDeleteConversation(conversation.id)}
                          >
                            <Trash2 />
                          </Button>
                        </ChatTooltip>
                      </div>
                    ) : null}
                  </div>
                )
              })}
              </div>
            </section>
          )
        })}
      </div>

      <div className="shrink-0 border-t p-2">
        <div className="flex min-w-0 items-center gap-2 rounded-md px-2 py-2">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-medium text-primary-foreground">
            {initials(user.name)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{user.name || "用户"}</div>
            <div className="text-xs text-muted-foreground">{roleLabel(user.role)}</div>
          </div>
          <ChatTooltip label="切换主题">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8"
              aria-label="切换主题"
              onClick={onToggleTheme}
            >
              {theme === "dark" ? <Sun /> : <Moon />}
            </Button>
          </ChatTooltip>
          <ChatTooltip label="退出登录">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8"
              aria-label="退出登录"
              onClick={onSignOut}
            >
              <LogOut />
            </Button>
          </ChatTooltip>
        </div>
      </div>
    </div>
  )
}
