"use client"

import {
  ArrowUp,
  FileText,
  Image as ImageIcon,
  LoaderCircle,
  Settings2,
  Sparkles,
  Square,
  X,
} from "lucide-react"
import type {
  ClipboardEvent,
  DragEvent,
  KeyboardEvent,
} from "react"
import { useMemo, useState } from "react"

import type { PreparedChatAttachment } from "@/app/chat/lib/chat-types"
import { ImageSettingsPanel } from "@/app/image/components/image-settings-panel"
import {
  imageSettingsSummary,
  type ImageSettings,
} from "@/app/image/components/image-settings"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"

import { ChatAttachmentPicker } from "./chat-attachment-picker"
import { ChatTooltip } from "./chat-tooltip"

export type ChatComposerAttachment = PreparedChatAttachment & {
  previewUrl?: string
}

export type ChatComposerMode = "chat" | "image"

export type ChatComposerProps = {
  value: string
  attachments: readonly ChatComposerAttachment[]
  mode: ChatComposerMode
  isStreaming: boolean
  imageSettings: ImageSettings
  imageModels: string[]
  imageSettingsPresentation: "popover" | "sheet"
  onValueChange: (value: string) => void
  onSubmit: () => void | Promise<void>
  onStop: () => void
  onFilesSelected: (files: File[]) => void | Promise<void>
  onRemoveAttachment: (attachmentId: string) => void
  onModeChange: (mode: ChatComposerMode) => void
  onImageSettingsChange: (change: Partial<ImageSettings>) => void
  disabled?: boolean
  attachmentError?: string | null
  availableQuota?: number
  activeImageTaskCount?: number
}

function formatBytes(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  if (bytes < 1024 * 1024) {
    return `${Math.ceil(bytes / 1024)} KB`
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function hasFiles(dataTransfer: DataTransfer) {
  return Array.from(dataTransfer.types || []).includes("Files") || dataTransfer.files.length > 0
}

function PendingAttachments({
  attachments,
  onRemoveAttachment,
}: {
  attachments: readonly ChatComposerAttachment[]
  onRemoveAttachment: (attachmentId: string) => void
}) {
  if (attachments.length === 0) {
    return null
  }

  return (
    <div className="flex max-w-full gap-2 overflow-x-auto pb-2">
      {attachments.map((attachment) => (
        <div
          key={attachment.id}
          className="flex h-14 min-w-0 max-w-[240px] shrink-0 items-center gap-2 rounded-md border bg-background p-2"
        >
          {attachment.kind === "image" && attachment.previewUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- Object URL previews cannot use Next image optimization.
            <img
              src={attachment.previewUrl}
              alt=""
              className="size-10 shrink-0 rounded object-cover"
            />
          ) : (
            <div className="flex size-10 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground">
              {attachment.kind === "image" ? <ImageIcon /> : <FileText />}
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium" title={attachment.name}>
              {attachment.name}
            </div>
            <div className="text-xs text-muted-foreground">{formatBytes(attachment.size)}</div>
          </div>
          <ChatTooltip label="移除附件">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label={`移除附件 ${attachment.name}`}
              onClick={() => onRemoveAttachment(attachment.id)}
            >
              <X />
            </Button>
          </ChatTooltip>
        </div>
      ))}
    </div>
  )
}

export function ChatComposer({
  value,
  attachments,
  mode,
  isStreaming,
  imageSettings,
  imageModels,
  imageSettingsPresentation,
  onValueChange,
  onSubmit,
  onStop,
  onFilesSelected,
  onRemoveAttachment,
  onModeChange,
  onImageSettingsChange,
  disabled = false,
  attachmentError,
  availableQuota,
  activeImageTaskCount = 0,
}: ChatComposerProps) {
  const [imageSettingsOpen, setImageSettingsOpen] = useState(false)
  const [dragging, setDragging] = useState(false)
  const imageCount = useMemo(
    () => attachments.filter((attachment) => attachment.kind === "image").length,
    [attachments],
  )
  const documentCount = attachments.length - imageCount
  const hasDocumentConflict = mode === "image" && documentCount > 0
  const hasContent =
    mode === "image" ? Boolean(value.trim()) : Boolean(value.trim()) || attachments.length > 0
  const canSubmit = !disabled && !hasDocumentConflict && hasContent
  const settingsLabel = imageSettingsSummary(imageSettings)

  function submitFromKeyboard(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
      return
    }
    event.preventDefault()
    if (canSubmit && !isStreaming) {
      void onSubmit()
    }
  }

  function reportPastedImages(event: ClipboardEvent<HTMLTextAreaElement>) {
    const images = Array.from(event.clipboardData.files || []).filter((file) =>
      file.type.startsWith("image/"),
    )
    if (images.length === 0) {
      return
    }
    event.preventDefault()
    void onFilesSelected(images)
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    if (!hasFiles(event.dataTransfer)) {
      return
    }
    event.preventDefault()
    event.dataTransfer.dropEffect = "copy"
    setDragging(true)
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    if (!hasFiles(event.dataTransfer)) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    setDragging(false)
    const files = Array.from(event.dataTransfer.files || [])
    if (files.length > 0) {
      void onFilesSelected(files)
    }
  }

  return (
    <div className="sticky bottom-0 z-10 shrink-0 bg-background/95 px-3 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur-sm sm:px-5">
      <div data-testid="chat-composer" className="mx-auto w-full max-w-[780px] min-w-0">
        <PendingAttachments
          attachments={attachments}
          onRemoveAttachment={onRemoveAttachment}
        />

        {mode === "image" ? (
          <div
            data-testid="chat-image-status"
            className="mb-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1"
          >
            <div className="flex h-8 min-w-0 max-w-full items-center gap-1.5 rounded-md bg-muted px-2 text-sm font-medium">
              <Sparkles className="size-4 shrink-0" />
              <span className="truncate">生成图片</span>
              <ChatTooltip label="退出生成图片模式">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-6"
                  aria-label="退出生成图片模式"
                  onClick={() => onModeChange("chat")}
                >
                  <X />
                </Button>
              </ChatTooltip>
            </div>
            {typeof availableQuota === "number" ? (
              <span className="min-w-0 break-all text-xs text-muted-foreground">
                剩余额度 {availableQuota}
              </span>
            ) : null}
            {activeImageTaskCount > 0 ? (
              <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                <LoaderCircle className="size-3 shrink-0 animate-spin" />
                {activeImageTaskCount} 个任务处理中
              </span>
            ) : null}
          </div>
        ) : null}

        {hasDocumentConflict ? (
          <p role="alert" className="mb-2 text-sm text-destructive">
            生成图片模式不能添加文档附件，请先移除文档或退出生成图片模式。
          </p>
        ) : attachmentError ? (
          <p role="alert" className="mb-2 text-sm text-destructive">
            {attachmentError}
          </p>
        ) : null}

        <div
          data-testid="chat-composer-dropzone"
          className={cn(
            "relative min-w-0 overflow-hidden rounded-[24px] border bg-background shadow-sm transition",
            dragging && "border-foreground bg-muted/50",
          )}
          onDragEnter={handleDragOver}
          onDragOver={handleDragOver}
          onDragLeave={(event) => {
            const relatedTarget = event.relatedTarget
            if (!(relatedTarget instanceof Node) || !event.currentTarget.contains(relatedTarget)) {
              setDragging(false)
            }
          }}
          onDrop={handleDrop}
        >
          <Textarea
            value={value}
            aria-label="消息"
            placeholder={
              mode === "image"
                ? imageCount > 0
                  ? "描述你希望如何修改参考图"
                  : "描述你想生成的图片"
                : "输入消息"
            }
            disabled={disabled}
            className="max-h-[200px] min-h-[76px] resize-none rounded-[24px] border-0 bg-transparent px-4 pt-3 pb-11 text-[15px] leading-6 shadow-none focus-visible:ring-0"
            onChange={(event) => onValueChange(event.target.value)}
            onKeyDown={submitFromKeyboard}
            onPaste={reportPastedImages}
          />

          {dragging ? (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/90 text-sm font-medium">
              松开以添加附件
            </div>
          ) : null}

          <div className="absolute inset-x-2 bottom-2 flex min-w-0 items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1">
              <ChatAttachmentPicker
                imageCount={imageCount}
                documentCount={documentCount}
                imageMode={mode === "image"}
                disabled={disabled || isStreaming}
                onFilesSelected={onFilesSelected}
                onEnableImageMode={() => onModeChange("image")}
              />

              {mode === "image" ? (
                <ImageSettingsPanel
                  presentation={imageSettingsPresentation}
                  open={imageSettingsOpen}
                  onOpenChange={setImageSettingsOpen}
                  value={imageSettings}
                  imageModels={imageModels}
                  onChange={onImageSettingsChange}
                  trigger={
                    <Button
                      type="button"
                      variant="ghost"
                      className="h-9 min-w-0 max-w-[min(55vw,300px)] rounded-full px-3 text-xs sm:text-sm"
                      aria-label="图像设置"
                    >
                      <Settings2 data-icon="inline-start" />
                      <span className="truncate">{settingsLabel}</span>
                    </Button>
                  }
                />
              ) : null}
            </div>

            {isStreaming ? (
              <ChatTooltip label="停止生成">
                <Button
                  type="button"
                  size="icon"
                  className="size-9 rounded-full"
                  aria-label="停止生成"
                  onClick={onStop}
                >
                  <Square className="fill-current" />
                </Button>
              </ChatTooltip>
            ) : (
              <ChatTooltip label={mode === "image" ? "生成图片" : "发送消息"}>
                <Button
                  type="button"
                  size="icon"
                  className="size-9 rounded-full"
                  aria-label={mode === "image" ? "生成图片" : "发送消息"}
                  disabled={!canSubmit}
                  onClick={() => void onSubmit()}
                >
                  <ArrowUp />
                </Button>
              </ChatTooltip>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
