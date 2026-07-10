"use client"

import {
  Check,
  Clipboard,
  Download,
  FileText,
  Image as ImageIcon,
  LoaderCircle,
  Pencil,
  RefreshCw,
  ThumbsDown,
  ThumbsUp,
  X,
} from "lucide-react"
import { memo, useMemo, useState } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"

import type { ChatGeneratedImage, ChatMessage as ChatMessageValue } from "@/app/chat/lib/chat-types"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"

import { ChatAttachmentPicker } from "./chat-attachment-picker"
import { ChatTooltip } from "./chat-tooltip"

export type ChatMessageAttachment = {
  id: string
  name: string
  kind: "image" | "document"
  size?: number
  previewUrl?: string
}

export type ChatMessageFeedback = "up" | "down"

export type ChatMessageEditSubmission = {
  text: string
  attachmentIds: string[]
  files: File[]
}

export type ChatMessageProps = {
  message: ChatMessageValue
  attachments?: readonly ChatMessageAttachment[]
  onCopy?: (text: string) => void | Promise<void>
  onCopyError?: (error: unknown) => void
  onEditAndResend?: (
    messageId: string,
    input: ChatMessageEditSubmission,
  ) => void | Promise<void>
  onEditError?: (error: unknown) => void
  onRetry?: (messageId: string) => void
  onFeedback?: (messageId: string, feedback: ChatMessageFeedback) => void
  onPreviewImage?: (image: ChatGeneratedImage) => void
  onDownloadImage?: (image: ChatGeneratedImage) => void
  onUseImageAsReference?: (image: ChatGeneratedImage) => void
  onRetryImage?: (messageId: string, image: ChatGeneratedImage) => void
  onResumeImage?: (messageId: string, image: ChatGeneratedImage) => void
}

type ActionButtonProps = {
  label: string
  onClick: () => void
  children: React.ReactNode
  disabled?: boolean
}

function ActionButton({ label, onClick, children, disabled = false }: ActionButtonProps) {
  return (
    <ChatTooltip label={label}>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-8 text-muted-foreground"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
      >
        {children}
      </Button>
    </ChatTooltip>
  )
}

async function copyText(text: string, onCopy?: ChatMessageProps["onCopy"]) {
  if (onCopy) {
    await onCopy(text)
    return
  }
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }
  throw new Error("当前环境不支持复制")
}

function MarkdownContent({
  text,
  onCopy,
  onCopyError,
}: {
  text: string
  onCopy?: ChatMessageProps["onCopy"]
  onCopyError?: ChatMessageProps["onCopyError"]
}) {
  const components = useMemo<Components>(
    () => ({
      h1: ({ node: _node, ...props }) => <h1 className="mt-6 mb-3 text-2xl font-semibold" {...props} />,
      h2: ({ node: _node, ...props }) => <h2 className="mt-5 mb-2 text-xl font-semibold" {...props} />,
      h3: ({ node: _node, ...props }) => <h3 className="mt-4 mb-2 text-lg font-semibold" {...props} />,
      p: ({ node: _node, ...props }) => <p className="my-3 leading-7 first:mt-0 last:mb-0" {...props} />,
      ul: ({ node: _node, ...props }) => <ul className="my-3 list-disc pl-6" {...props} />,
      ol: ({ node: _node, ...props }) => <ol className="my-3 list-decimal pl-6" {...props} />,
      li: ({ node: _node, ...props }) => <li className="my-1 pl-1 leading-7" {...props} />,
      blockquote: ({ node: _node, ...props }) => (
        <blockquote className="my-4 border-l-2 pl-4 text-muted-foreground" {...props} />
      ),
      a: ({ node: _node, ...props }) => (
        <a
          className="font-medium underline underline-offset-4"
          target="_blank"
          rel="noreferrer"
          {...props}
        />
      ),
      table: ({ node: _node, children, ...props }) => (
        <div className="my-4 max-w-full overflow-x-auto rounded-md border">
          <table className="w-full min-w-max border-collapse text-sm" {...props}>
            {children}
          </table>
        </div>
      ),
      th: ({ node: _node, ...props }) => (
        <th className="border-b bg-muted px-3 py-2 text-left font-medium" {...props} />
      ),
      td: ({ node: _node, ...props }) => <td className="border-b px-3 py-2" {...props} />,
      pre: ({ children }) => <>{children}</>,
      code: ({ node: _node, className, children, ...props }) => {
        const code = String(children).replace(/\n$/, "")
        const isBlock = Boolean(className) || String(children).includes("\n")
        if (!isBlock) {
          return (
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.92em]" {...props}>
              {children}
            </code>
          )
        }

        const language = className?.replace(/^language-/, "") || "代码"
        return (
          <div className="my-4 max-w-full overflow-hidden rounded-md border bg-muted/40">
            <div className="flex h-9 items-center justify-between border-b px-3 text-xs text-muted-foreground">
              <span>{language}</span>
              <ActionButton
                label="复制代码"
                onClick={() => {
                  void copyText(code, onCopy).catch((error: unknown) => onCopyError?.(error))
                }}
              >
                <Clipboard />
              </ActionButton>
            </div>
            <pre className="max-w-full overflow-x-auto p-4 text-sm leading-6">
              <code className={className} {...props}>
                {code}
              </code>
            </pre>
          </div>
        )
      },
    }),
    [onCopy, onCopyError],
  )

  return (
    <div className="min-w-0 max-w-full break-words">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
}

function localFileKey(file: File) {
  return `${file.name}:${file.size}:${file.type}:${file.lastModified}`
}

function EditAttachments({
  attachmentIds,
  attachments,
  files,
  onAttachmentIdsChange,
  onFilesChange,
  disabled,
}: {
  attachmentIds: readonly string[]
  attachments: readonly ChatMessageAttachment[]
  files: readonly File[]
  onAttachmentIdsChange: (ids: string[]) => void
  onFilesChange: (files: File[]) => void
  disabled: boolean
}) {
  const attachmentMap = new Map(attachments.map((attachment) => [attachment.id, attachment]))
  const selectedAttachments = attachmentIds.map(
    (id) => attachmentMap.get(id) || { id, name: "附件", kind: "document" as const },
  )
  const imageCount =
    selectedAttachments.filter((attachment) => attachment.kind === "image").length +
    files.filter((file) => file.type.startsWith("image/")).length
  const documentCount = selectedAttachments.length + files.length - imageCount

  return (
    <div className="mt-3 flex flex-col gap-2">
      {selectedAttachments.length > 0 || files.length > 0 ? (
        <div className="flex max-w-full flex-wrap gap-2">
          {selectedAttachments.map((attachment) => (
            <div
              key={attachment.id}
              className="flex h-10 min-w-0 max-w-[220px] items-center gap-2 rounded-md border bg-background px-2"
              title={attachment.name}
            >
              {attachment.kind === "image" ? <ImageIcon /> : <FileText />}
              <span className="min-w-0 flex-1 truncate text-sm">{attachment.name}</span>
              <ChatTooltip label="移除附件">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label={`移除编辑附件 ${attachment.name}`}
                  disabled={disabled}
                  onClick={() =>
                    onAttachmentIdsChange(attachmentIds.filter((id) => id !== attachment.id))
                  }
                >
                  <X />
                </Button>
              </ChatTooltip>
            </div>
          ))}
          {files.map((file) => {
            const key = localFileKey(file)
            return (
              <div
                key={key}
                className="flex h-10 min-w-0 max-w-[220px] items-center gap-2 rounded-md border bg-background px-2"
                title={file.name}
              >
                {file.type.startsWith("image/") ? <ImageIcon /> : <FileText />}
                <span className="min-w-0 flex-1 truncate text-sm">{file.name}</span>
                <ChatTooltip label="移除附件">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    aria-label={`移除新附件 ${file.name}`}
                    disabled={disabled}
                    onClick={() => onFilesChange(files.filter((item) => localFileKey(item) !== key))}
                  >
                    <X />
                  </Button>
                </ChatTooltip>
              </div>
            )
          })}
        </div>
      ) : null}

      <div>
        <ChatAttachmentPicker
          imageCount={imageCount}
          documentCount={documentCount}
          imageMode={false}
          showImageMode={false}
          disabled={disabled}
          onEnableImageMode={() => undefined}
          onFilesSelected={(selectedFiles) => {
            const next = new Map(files.map((file) => [localFileKey(file), file]))
            for (const file of selectedFiles) {
              next.set(localFileKey(file), file)
            }
            onFilesChange([...next.values()])
          }}
        />
      </div>
    </div>
  )
}

function MessageAttachments({ attachments }: { attachments: readonly ChatMessageAttachment[] }) {
  if (attachments.length === 0) {
    return null
  }

  return (
    <div className="mb-2 flex max-w-full flex-wrap gap-2">
      {attachments.map((attachment) => (
        <div
          key={attachment.id}
          className="flex min-w-0 max-w-[240px] items-center gap-2 rounded-md border bg-background p-2"
          title={attachment.name}
        >
          {attachment.kind === "image" && attachment.previewUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- Object URL previews cannot use Next image optimization.
            <img
              src={attachment.previewUrl}
              alt={attachment.name}
              className="size-10 shrink-0 rounded object-cover"
            />
          ) : (
            <div className="flex size-8 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground">
              {attachment.kind === "image" ? <ImageIcon /> : <FileText />}
            </div>
          )}
          <span className="truncate text-sm">{attachment.name}</span>
        </div>
      ))}
    </div>
  )
}

function GeneratedImages({
  images,
  messageId,
  onPreviewImage,
  onDownloadImage,
  onUseImageAsReference,
  onRetryImage,
  onResumeImage,
}: Pick<
  ChatMessageProps,
  | "onPreviewImage"
  | "onDownloadImage"
  | "onUseImageAsReference"
  | "onRetryImage"
  | "onResumeImage"
> & { images: readonly ChatGeneratedImage[]; messageId: string }) {
  if (images.length === 0) {
    return null
  }

  return (
    <div className="mt-3 grid max-w-2xl grid-cols-1 gap-2 sm:grid-cols-2">
      {images.map((image) => (
        <div key={image.id} className="min-w-0 overflow-hidden rounded-md border bg-muted/30">
          {image.url ? (
            <button
              type="button"
              className="block w-full overflow-hidden bg-muted text-left"
              style={{
                aspectRatio:
                  image.width && image.height ? `${image.width} / ${image.height}` : "1 / 1",
              }}
              aria-label="预览生成图片"
              onClick={() => onPreviewImage?.(image)}
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- Generated image hosts are dynamic and not known at build time. */}
              <img
                src={image.url}
                alt={image.revisedPrompt || "生成图片"}
                className="size-full object-contain"
              />
            </button>
          ) : (
            <div
              className="flex items-center justify-center text-sm text-muted-foreground"
              style={{
                aspectRatio:
                  image.width && image.height ? `${image.width} / ${image.height}` : "1 / 1",
              }}
            >
              {image.status === "error" ? image.error || "图片生成失败" : "图片生成中"}
            </div>
          )}
          {(image.url && (onDownloadImage || onUseImageAsReference)) ||
          (image.status === "error" && onRetryImage) ||
          (image.status === "error" &&
            image.taskId &&
            image.error?.includes("超时") &&
            onResumeImage) ? (
            <div className="flex items-center justify-end gap-1 p-1">
              {image.status === "error" && onRetryImage ? (
                <ActionButton label="重试图片" onClick={() => onRetryImage(messageId, image)}>
                  <RefreshCw />
                </ActionButton>
              ) : null}
              {image.status === "error" &&
              image.taskId &&
              image.error?.includes("超时") &&
              onResumeImage ? (
                <ActionButton
                  label="继续等待图片"
                  onClick={() => onResumeImage(messageId, image)}
                >
                  <LoaderCircle />
                </ActionButton>
              ) : null}
              {image.url && onUseImageAsReference ? (
                <ActionButton label="用作参考图" onClick={() => onUseImageAsReference(image)}>
                  <ImageIcon />
                </ActionButton>
              ) : null}
              {image.url && onDownloadImage ? (
                <ActionButton label="下载图片" onClick={() => onDownloadImage(image)}>
                  <Download />
                </ActionButton>
              ) : null}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  )
}

function ChatMessageComponent({
  message,
  attachments = [],
  onCopy,
  onCopyError,
  onEditAndResend,
  onEditError,
  onRetry,
  onFeedback,
  onPreviewImage,
  onDownloadImage,
  onUseImageAsReference,
  onRetryImage,
  onResumeImage,
}: ChatMessageProps) {
  const [editing, setEditing] = useState(false)
  const [editText, setEditText] = useState(message.text)
  const [editAttachmentIds, setEditAttachmentIds] = useState<string[]>(message.attachmentIds)
  const [editFiles, setEditFiles] = useState<File[]>([])
  const [editSaving, setEditSaving] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const attachmentIds = new Set(message.attachmentIds)
  const messageAttachments = attachments.filter((attachment) => attachmentIds.has(attachment.id))
  const isUser = message.role === "user"
  const images = message.images || []
  const isImageTurn = Boolean(message.imageSettings || images.length > 0)

  async function copyMessage() {
    try {
      await copyText(message.text, onCopy)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch (error) {
      onCopyError?.(error)
    }
  }

  if (message.role === "system") {
    return null
  }

  return (
    <article
      data-message-id={message.id}
      className={cn("flex w-full min-w-0 flex-col", isUser ? "items-end" : "items-start")}
    >
      {!editing ? <MessageAttachments attachments={messageAttachments} /> : null}

      {isUser ? (
        editing ? (
          <div className="w-full max-w-[680px] rounded-md border bg-background p-3">
            <Textarea
              autoFocus
              value={editText}
              aria-label="编辑消息内容"
              className="min-h-24 resize-y rounded-md shadow-none"
              disabled={editSaving}
              onChange={(event) => setEditText(event.target.value)}
            />
            <EditAttachments
              attachmentIds={editAttachmentIds}
              attachments={messageAttachments}
              files={editFiles}
              onAttachmentIdsChange={setEditAttachmentIds}
              onFilesChange={setEditFiles}
              disabled={editSaving}
            />
            {editError ? (
              <p role="alert" className="mt-2 text-sm text-destructive">
                {editError}
              </p>
            ) : null}
            <div className="mt-2 flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={editSaving}
                onClick={() => {
                  setEditText(message.text)
                  setEditAttachmentIds([...message.attachmentIds])
                  setEditFiles([])
                  setEditError(null)
                  setEditing(false)
                }}
              >
                取消
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={
                  editSaving ||
                  (!editText.trim() && editAttachmentIds.length === 0 && editFiles.length === 0)
                }
                onClick={() => {
                  if (!onEditAndResend) {
                    return
                  }
                  setEditSaving(true)
                  setEditError(null)
                  void (async () => {
                    try {
                      await onEditAndResend(message.id, {
                        text: editText.trim(),
                        attachmentIds: [...editAttachmentIds],
                        files: [...editFiles],
                      })
                      setEditing(false)
                      setEditFiles([])
                    } catch (error) {
                      const description =
                        error instanceof Error && error.message ? error.message : "重发失败，请重试"
                      setEditError(description)
                      onEditError?.(error)
                    } finally {
                      setEditSaving(false)
                    }
                  })()
                }}
              >
                {editSaving ? (
                  <>
                    <LoaderCircle data-icon="inline-start" className="animate-spin" />
                    正在重发
                  </>
                ) : (
                  "保存并重发"
                )}
              </Button>
            </div>
          </div>
        ) : (
          <div className="max-w-[min(85%,680px)] whitespace-pre-wrap break-words rounded-2xl bg-muted px-4 py-2.5 text-[15px] leading-6">
            {message.text}
          </div>
        )
      ) : (
        <div className="w-full min-w-0 text-[15px] leading-7">
          {message.text ? (
            <MarkdownContent text={message.text} onCopy={onCopy} onCopyError={onCopyError} />
          ) : null}
          {message.status === "streaming" ? (
            <span className="mt-2 inline-flex items-center gap-2 text-sm text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" />
              正在生成
            </span>
          ) : null}
          {message.status === "stopped" ? (
            <p className="mt-2 text-xs text-muted-foreground">已停止生成</p>
          ) : null}
          {message.status === "error" ? (
            <p role="alert" className="mt-2 text-sm text-destructive">
              {message.error || "生成失败，请重试"}
            </p>
          ) : null}
          <GeneratedImages
            images={images}
            messageId={message.id}
            onPreviewImage={onPreviewImage}
            onDownloadImage={onDownloadImage}
            onUseImageAsReference={onUseImageAsReference}
            onRetryImage={onRetryImage}
            onResumeImage={onResumeImage}
          />
        </div>
      )}

      {!editing ? (
        <div className={cn("mt-1 flex min-h-8 items-center gap-0.5", isUser && "justify-end")}>
          <ActionButton label={copied ? "已复制" : "复制消息"} onClick={() => void copyMessage()}>
            {copied ? <Check /> : <Clipboard />}
          </ActionButton>
          {isUser && onEditAndResend ? (
            <ActionButton
              label="编辑消息"
              onClick={() => {
                setEditText(message.text)
                setEditAttachmentIds([...message.attachmentIds])
                setEditFiles([])
                setEditError(null)
                setEditing(true)
              }}
            >
              <Pencil />
            </ActionButton>
          ) : null}
          {!isUser &&
          !isImageTurn &&
          onRetry &&
          (message.status === "complete" || message.status === "stopped" || message.status === "error") ? (
            <ActionButton label="重新生成" onClick={() => onRetry(message.id)}>
              <RefreshCw />
            </ActionButton>
          ) : null}
          {!isUser && onFeedback && message.status === "complete" ? (
            <>
              <ActionButton label="赞" onClick={() => onFeedback(message.id, "up")}>
                <ThumbsUp />
              </ActionButton>
              <ActionButton label="踩" onClick={() => onFeedback(message.id, "down")}>
                <ThumbsDown />
              </ActionButton>
            </>
          ) : null}
        </div>
      ) : null}
    </article>
  )
}

export const ChatMessage = memo(ChatMessageComponent)
