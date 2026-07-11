"use client"

import { Menu, MoreHorizontal, Pencil, RefreshCw, SquarePen, Trash2 } from "lucide-react"
import { useState } from "react"

import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"

import { ChatModelSelect, type ChatModelOption } from "./chat-model-select"
import { ChatTooltip } from "./chat-tooltip"

export type ChatHeaderProps = {
  models: readonly ChatModelOption[]
  selectedModel: string
  unavailableModel?: string | null
  conversationTitle?: string | null
  modelDisabled?: boolean
  isRefreshingModels?: boolean
  onModelChange: (model: string) => void
  onRefreshModels?: () => void
  onOpenSidebar: () => void
  onNewConversation: () => void
  onRenameConversation?: () => void
  onDeleteConversation?: () => void
}

export function ChatHeader({
  models,
  selectedModel,
  unavailableModel,
  conversationTitle,
  modelDisabled = false,
  isRefreshingModels = false,
  onModelChange,
  onRefreshModels,
  onOpenSidebar,
  onNewConversation,
  onRenameConversation,
  onDeleteConversation,
}: ChatHeaderProps) {
  const [actionsOpen, setActionsOpen] = useState(false)
  const hasConversation = Boolean(conversationTitle)

  return (
    <header className="flex h-14 shrink-0 items-center border-b bg-background/95 px-2 backdrop-blur-sm sm:px-3">
      <div className="grid w-full min-w-0 grid-cols-[80px_minmax(0,1fr)_80px] items-center md:grid-cols-[minmax(0,1fr)_auto]">
        <ChatTooltip label="打开聊天历史">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="md:hidden"
            aria-label="打开聊天历史"
            onClick={onOpenSidebar}
          >
            <Menu />
          </Button>
        </ChatTooltip>

        <div className="flex min-w-0 items-center justify-center gap-1 md:justify-start">
          <ChatModelSelect
            models={models}
            value={selectedModel}
            unavailableModel={unavailableModel}
            disabled={modelDisabled}
            onValueChange={onModelChange}
          />
          <ChatTooltip label={isRefreshingModels ? "正在刷新模型" : "刷新模型"}>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8"
              aria-label="刷新模型"
              disabled={!onRefreshModels || isRefreshingModels}
              onClick={onRefreshModels}
            >
              <RefreshCw className={isRefreshingModels ? "animate-spin" : undefined} />
            </Button>
          </ChatTooltip>
        </div>

        <div className="flex items-center justify-end gap-1">
          <ChatTooltip label="新对话">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="md:hidden"
              aria-label="新对话"
              onClick={onNewConversation}
            >
              <SquarePen />
            </Button>
          </ChatTooltip>

          <Popover open={actionsOpen} onOpenChange={setActionsOpen}>
            <ChatTooltip label="会话操作">
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="会话操作"
                  disabled={!hasConversation}
                >
                  <MoreHorizontal />
                </Button>
              </PopoverTrigger>
            </ChatTooltip>
            <PopoverContent
              align="end"
              sideOffset={6}
              aria-label="会话操作"
              className="w-44 rounded-md p-1"
            >
              <div className="flex flex-col gap-0.5">
                <Button
                  type="button"
                  variant="ghost"
                  className="h-9 justify-start rounded-md px-2 font-normal"
                  onClick={() => {
                    setActionsOpen(false)
                    onRenameConversation?.()
                  }}
                >
                  <Pencil data-icon="inline-start" />
                  重命名对话
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className="h-9 justify-start rounded-md px-2 font-normal text-destructive hover:text-destructive"
                  onClick={() => {
                    setActionsOpen(false)
                    onDeleteConversation?.()
                  }}
                >
                  <Trash2 data-icon="inline-start" />
                  删除对话
                </Button>
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </div>
    </header>
  )
}
