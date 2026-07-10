"use client"

import { FileText, ImagePlus, Plus, Sparkles } from "lucide-react"
import { useRef, useState } from "react"

import { MAX_CHAT_DOCUMENTS, MAX_CHAT_IMAGES } from "@/app/chat/lib/chat-attachments"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"

import { ChatTooltip } from "./chat-tooltip"

const IMAGE_ACCEPT = "image/png,image/jpeg,image/webp,image/gif"
const DOCUMENT_ACCEPT =
  ".pdf,.docx,.xlsx,.pptx,.txt,.md,.csv,application/pdf,text/plain,text/markdown,text/csv,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.presentationml.presentation"

export type ChatAttachmentPickerProps = {
  imageCount: number
  documentCount: number
  imageMode: boolean
  onFilesSelected: (files: File[]) => void | Promise<void>
  onEnableImageMode: () => void
  disabled?: boolean
  showImageMode?: boolean
}

export function ChatAttachmentPicker({
  imageCount,
  documentCount,
  imageMode,
  onFilesSelected,
  onEnableImageMode,
  disabled = false,
  showImageMode = true,
}: ChatAttachmentPickerProps) {
  const [open, setOpen] = useState(false)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const documentInputRef = useRef<HTMLInputElement>(null)
  const imageLimitReached = imageCount >= MAX_CHAT_IMAGES
  const documentLimitReached = documentCount >= MAX_CHAT_DOCUMENTS

  function reportFiles(files: FileList | null) {
    const selected = Array.from(files || [])
    if (selected.length > 0) {
      void onFilesSelected(selected)
    }
    setOpen(false)
  }

  return (
    <>
      <input
        ref={imageInputRef}
        type="file"
        accept={IMAGE_ACCEPT}
        multiple
        className="hidden"
        aria-label="选择图片"
        onChange={(event) => {
          reportFiles(event.currentTarget.files)
          event.currentTarget.value = ""
        }}
      />
      <input
        ref={documentInputRef}
        type="file"
        accept={DOCUMENT_ACCEPT}
        multiple
        className="hidden"
        aria-label="选择文件"
        onChange={(event) => {
          reportFiles(event.currentTarget.files)
          event.currentTarget.value = ""
        }}
      />

      <Popover open={open} onOpenChange={setOpen}>
        <ChatTooltip label="添加附件">
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-9 rounded-full"
              aria-label="添加附件"
              disabled={disabled}
            >
              <Plus />
            </Button>
          </PopoverTrigger>
        </ChatTooltip>
        <PopoverContent
          side="top"
          align="start"
          sideOffset={8}
          aria-label="添加附件"
          className="w-56 rounded-md p-1"
        >
          <div className="flex flex-col gap-0.5">
            <Button
              type="button"
              variant="ghost"
              aria-label="添加图片"
              className="h-10 justify-start rounded-md px-2 font-normal"
              disabled={imageLimitReached}
              title={imageLimitReached ? `单条消息最多添加 ${MAX_CHAT_IMAGES} 张图片` : undefined}
              onClick={() => imageInputRef.current?.click()}
            >
              <ImagePlus data-icon="inline-start" />
              <span className="min-w-0 flex-1 text-left">添加图片</span>
              <span className="text-xs text-muted-foreground">
                {imageCount}/{MAX_CHAT_IMAGES}
              </span>
            </Button>
            <Button
              type="button"
              variant="ghost"
              aria-label="添加文件"
              className="h-10 justify-start rounded-md px-2 font-normal"
              disabled={documentLimitReached || imageMode}
              title={
                imageMode
                  ? "生成图片模式不能添加文档附件"
                  : documentLimitReached
                    ? `单条消息最多添加 ${MAX_CHAT_DOCUMENTS} 个文档`
                    : undefined
              }
              onClick={() => documentInputRef.current?.click()}
            >
              <FileText data-icon="inline-start" />
              <span className="min-w-0 flex-1 text-left">添加文件</span>
              <span className="text-xs text-muted-foreground">
                {documentCount}/{MAX_CHAT_DOCUMENTS}
              </span>
            </Button>
            {showImageMode ? (
              <Button
                type="button"
                variant="ghost"
                className="h-10 justify-start rounded-md px-2 font-normal"
                disabled={imageMode}
                onClick={() => {
                  setOpen(false)
                  onEnableImageMode()
                }}
              >
                <Sparkles data-icon="inline-start" />
                生成图片
              </Button>
            ) : null}
          </div>
        </PopoverContent>
      </Popover>
    </>
  )
}
