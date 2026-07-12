"use client"

import { filterChatModels } from "@/app/chat/lib/chat-models"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { groupModelIdsByProvider } from "@/lib/model-providers"
import { cn } from "@/lib/utils"

export type ChatModelOption = string | { id?: unknown }

export type ChatModelSelectProps = {
  models: readonly ChatModelOption[]
  value: string
  onValueChange: (value: string) => void
  unavailableModel?: string | null
  disabled?: boolean
  className?: string
}

function modelLabel(model: string) {
  return model === "auto" ? "自动" : model
}

export function ChatModelSelect({
  models,
  value,
  onValueChange,
  unavailableModel,
  disabled = false,
  className,
}: ChatModelSelectProps) {
  const chatModels = filterChatModels(models)
  const hasSelectableModels = chatModels.some((model) => model !== "auto")
  const selected = hasSelectableModels && chatModels.includes(value) ? value : "auto"
  const providerGroups = groupModelIdsByProvider(chatModels)

  return (
    <div className={cn("flex min-w-0 flex-col items-center gap-0.5", className)}>
      <Select value={selected} onValueChange={onValueChange} disabled={disabled || !hasSelectableModels}>
        <SelectTrigger
          aria-label="聊天模型"
          className="h-9 w-auto min-w-[112px] max-w-[min(58vw,240px)] rounded-md border-0 bg-transparent px-2 text-sm font-medium shadow-none hover:bg-accent focus-visible:ring-2"
        >
          <SelectValue>{modelLabel(selected)}</SelectValue>
        </SelectTrigger>
        {hasSelectableModels ? (
          <SelectContent position="popper" align="center" className="min-w-[200px] rounded-md">
            {providerGroups.map((group) => (
              <SelectGroup key={group.id}>
                <SelectLabel className="px-3 py-1.5 text-[11px] text-muted-foreground">
                  {group.label}
                </SelectLabel>
                {group.modelIds.map((model) => (
                  <SelectItem key={model} value={model} className="rounded-md">
                    {modelLabel(model)}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        ) : null}
      </Select>
      {unavailableModel ? (
        <span
          role="status"
          className="max-w-[min(70vw,320px)] truncate text-[11px] leading-4 text-destructive"
          title={`${unavailableModel} 已不可用，已切换为自动`}
        >
          {unavailableModel} 已不可用，已切换为自动
        </span>
      ) : null}
    </div>
  )
}
