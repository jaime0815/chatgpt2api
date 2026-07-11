"use client"

import { useCallback, useEffect, useLayoutEffect, useRef } from "react"

import type { ChatGeneratedImage, ChatMessage as ChatMessageValue } from "@/app/chat/lib/chat-types"

import {
  ChatMessage,
  type ChatMessageAttachment,
  type ChatMessageEditSubmission,
  type ChatMessageFeedback,
} from "./chat-message"

export type ChatThreadProps = {
  conversationId: string | null
  messages: readonly ChatMessageValue[]
  attachments?: readonly ChatMessageAttachment[]
  allowAttachmentEdits?: boolean
  initialScrollTop?: number
  scrollCommitDelayMs?: number
  onScrollTopChange?: (scrollTop: number) => void
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
  emptyHeading?: string
}

export function ChatThread({
  conversationId,
  messages,
  attachments = [],
  allowAttachmentEdits = true,
  initialScrollTop = 0,
  scrollCommitDelayMs = 300,
  onScrollTopChange,
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
  emptyHeading = "有什么可以帮你？",
}: ChatThreadProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const pinnedToBottomRef = useRef(true)
  const restoredConversationRef = useRef(false)
  const restoredConversationIdRef = useRef<string | null | undefined>(undefined)
  const scrollTimerRef = useRef<ReturnType<typeof globalThis.setTimeout> | null>(null)
  const pendingScrollRef = useRef<{
    value: number
    callback: (scrollTop: number) => void
  } | null>(null)
  const lastMessage = messages.at(-1)
  const lastMessageKey = lastMessage
    ? `${lastMessage.id}:${lastMessage.text.length}:${lastMessage.status}:${lastMessage.images?.length || 0}`
    : "empty"

  const flushScrollPosition = useCallback(() => {
    if (scrollTimerRef.current !== null) {
      globalThis.clearTimeout(scrollTimerRef.current)
      scrollTimerRef.current = null
    }
    const pending = pendingScrollRef.current
    pendingScrollRef.current = null
    pending?.callback(pending.value)
  }, [])

  useEffect(
    () => () => {
      flushScrollPosition()
    },
    [conversationId, flushScrollPosition],
  )

  useLayoutEffect(() => {
    const container = scrollRef.current
    if (!container || restoredConversationIdRef.current === conversationId) {
      return
    }
    restoredConversationIdRef.current = conversationId
    const restoredScrollTop = initialScrollTop
    container.scrollTop = restoredScrollTop
    const distanceFromBottom = container.scrollHeight - container.clientHeight - restoredScrollTop
    pinnedToBottomRef.current = distanceFromBottom <= 80
    restoredConversationRef.current = true
  }, [conversationId, initialScrollTop])

  useLayoutEffect(() => {
    const container = scrollRef.current
    if (!container) {
      return
    }
    if (restoredConversationRef.current) {
      restoredConversationRef.current = false
      return
    }
    if (pinnedToBottomRef.current) {
      container.scrollTop = container.scrollHeight
    }
  }, [lastMessageKey, messages.length])

  return (
    <div
      ref={scrollRef}
      role="log"
      aria-label="聊天消息"
      aria-live="polite"
      className="h-full min-w-0 overflow-y-auto overflow-x-hidden overscroll-contain"
      onScroll={(event) => {
        const container = event.currentTarget
        const distanceFromBottom = container.scrollHeight - container.clientHeight - container.scrollTop
        pinnedToBottomRef.current = distanceFromBottom <= 80
        if (!onScrollTopChange) {
          return
        }
        if (scrollCommitDelayMs <= 0) {
          onScrollTopChange(container.scrollTop)
          return
        }
        pendingScrollRef.current = {
          value: container.scrollTop,
          callback: onScrollTopChange,
        }
        if (scrollTimerRef.current !== null) {
          globalThis.clearTimeout(scrollTimerRef.current)
        }
        scrollTimerRef.current = globalThis.setTimeout(
          flushScrollPosition,
          scrollCommitDelayMs,
        )
      }}
    >
      <div className="mx-auto flex min-h-full w-full max-w-[760px] min-w-0 flex-col px-4 py-6 sm:px-5 sm:py-8">
        {messages.length === 0 ? (
          <div className="flex min-h-[45vh] flex-1 items-center justify-center text-center">
            <h1 className="text-2xl font-semibold sm:text-3xl">{emptyHeading}</h1>
          </div>
        ) : (
          <div className="flex min-w-0 flex-col gap-6">
            {messages.map((message) => (
              <ChatMessage
                key={message.id}
                message={message}
                attachments={attachments}
                allowAttachmentEdits={allowAttachmentEdits}
                onCopy={onCopy}
                onCopyError={onCopyError}
                onEditAndResend={onEditAndResend}
                onEditError={onEditError}
                onRetry={onRetry}
                onFeedback={onFeedback}
                onPreviewImage={onPreviewImage}
                onDownloadImage={onDownloadImage}
                onUseImageAsReference={onUseImageAsReference}
                onRetryImage={onRetryImage}
                onResumeImage={onResumeImage}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
