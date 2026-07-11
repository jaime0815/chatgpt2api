import { withApiBasePath } from "@/lib/paths"
import { getStoredAuthKey } from "@/store/auth"

import { MAX_CHAT_WORKING_SET_BYTES, uniqueAttachmentBytes } from "./chat-attachments"
import type {
  ChatAttachmentManifest,
  ChatStreamEvent,
  ChatStreamRequest,
  PreparedChatAttachment,
} from "./chat-types"

const FRAME_BREAK_PATTERN = /\r\n\r\n|\n\n|\r\r/

type ErrorDetails = {
  message: string
  code?: string
}

export class ChatStreamHttpError extends Error {
  readonly status: number
  readonly code?: string

  constructor(status: number, message: string, code?: string) {
    super(message)
    this.name = "ChatStreamHttpError"
    this.status = status
    this.code = code
  }
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null
}

function errorDetails(value: unknown): ErrorDetails | null {
  if (typeof value === "string") {
    const message = value.trim()
    return message ? { message } : null
  }

  const item = objectValue(value)
  if (!item) {
    return null
  }

  const code = typeof item.code === "string" && item.code.trim() ? item.code.trim() : undefined
  for (const key of ["detail", "error"] as const) {
    const nested = errorDetails(item[key])
    if (nested) {
      return { message: nested.message, code: nested.code || code }
    }
  }

  if (typeof item.message === "string" && item.message.trim()) {
    return { message: item.message.trim(), code }
  }
  return null
}

function frameFields(frame: string) {
  let eventName = "message"
  const dataLines: string[] = []

  for (const line of frame.split(/\r\n|\r|\n/)) {
    if (!line || line.startsWith(":")) {
      continue
    }
    const separator = line.indexOf(":")
    const field = separator === -1 ? line : line.slice(0, separator)
    let value = separator === -1 ? "" : line.slice(separator + 1)
    if (value.startsWith(" ")) {
      value = value.slice(1)
    }
    if (field === "event") {
      eventName = value
    } else if (field === "data") {
      dataLines.push(value)
    }
  }

  return { eventName, data: dataLines.join("\n") }
}

function deltaContent(payload: Record<string, unknown>) {
  if (payload.type === "delta" && typeof payload.content === "string") {
    return payload.content
  }

  const choices = payload.choices
  if (!Array.isArray(choices)) {
    return null
  }
  const firstChoice = objectValue(choices[0])
  const delta = objectValue(firstChoice?.delta)
  return typeof delta?.content === "string" ? delta.content : null
}

function parseSseFrame(frame: string): ChatStreamEvent | null {
  const { eventName, data } = frameFields(frame)
  if (!data) {
    return null
  }
  if (data.trim() === "[DONE]") {
    return { type: "complete" }
  }

  let payload: unknown
  try {
    payload = JSON.parse(data)
  } catch {
    if (eventName === "error") {
      return { type: "error", message: data, code: "stream_error" }
    }
    return { type: "error", message: "聊天流返回了无效数据", code: "invalid_sse_payload" }
  }

  const item = objectValue(payload)
  if (!item) {
    return null
  }
  if (eventName === "error" || item.type === "error" || item.error !== undefined) {
    const details = errorDetails(item) || { message: "聊天流发生错误" }
    return { type: "error", ...details }
  }

  const content = deltaContent(item)
  return content === null ? null : { type: "delta", content }
}

function nextFrame(buffer: string) {
  const match = FRAME_BREAK_PATTERN.exec(buffer)
  if (!match || match.index === undefined) {
    return null
  }
  return {
    frame: buffer.slice(0, match.index),
    rest: buffer.slice(match.index + match[0].length),
  }
}

export async function* parseChatSse(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<ChatStreamEvent> {
  const decoder = new TextDecoder()
  const reader = stream.getReader()
  let buffer = ""
  let readerFinished = false

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        readerFinished = true
        break
      }

      buffer += decoder.decode(value, { stream: true })
      let parsed = nextFrame(buffer)
      while (parsed) {
        buffer = parsed.rest
        const event = parseSseFrame(parsed.frame)
        if (event) {
          yield event
          if (event.type === "complete" || event.type === "error") {
            return
          }
        }
        parsed = nextFrame(buffer)
      }
    }

    buffer += decoder.decode()
    if (buffer.trim()) {
      const event = parseSseFrame(buffer)
      if (event) {
        yield event
        if (event.type === "complete" || event.type === "error") {
          return
        }
      }
    }

    yield { type: "error", message: "聊天流意外中断", code: "stream_interrupted" }
  } finally {
    if (!readerFinished) {
      try {
        await reader.cancel()
      } catch {
        // The transport may already be closed or aborted.
      }
    }
    reader.releaseLock()
  }
}

function manifestMatches(
  manifest: ChatAttachmentManifest,
  attachment: PreparedChatAttachment,
) {
  return (
    manifest.id === attachment.id &&
    manifest.file_name === attachment.name &&
    manifest.mime_type === attachment.mimeType &&
    manifest.size === attachment.size &&
    manifest.sha256 === attachment.sha256 &&
    attachment.blob.size === attachment.size &&
    attachment.blob.type === attachment.mimeType
  )
}

function orderedRequestAttachments(
  request: ChatStreamRequest,
  attachments: readonly PreparedChatAttachment[],
) {
  if (request.attachments.length !== attachments.length) {
    throw new Error("附件 manifest 与待上传文件数量不一致")
  }

  const preparedById = new Map<string, PreparedChatAttachment>()
  for (const attachment of attachments) {
    if (preparedById.has(attachment.id)) {
      throw new Error(`附件 manifest 存在重复 ID：${attachment.id}`)
    }
    preparedById.set(attachment.id, attachment)
  }

  const referencedIds = new Set(request.messages.flatMap((message) => message.attachment_ids))
  const manifestIds = new Set<string>()
  const manifestHashes = new Set<string>()
  const ordered: PreparedChatAttachment[] = []
  for (const item of request.attachments) {
    const attachment = preparedById.get(item.id)
    if (
      manifestIds.has(item.id) ||
      manifestHashes.has(item.sha256) ||
      !referencedIds.has(item.id) ||
      !attachment ||
      !manifestMatches(item, attachment)
    ) {
      throw new Error(`附件 manifest 与待上传文件不匹配：${item.id}`)
    }
    manifestIds.add(item.id)
    manifestHashes.add(item.sha256)
    ordered.push(attachment)
  }

  if (referencedIds.size !== manifestIds.size || [...referencedIds].some((id) => !manifestIds.has(id))) {
    throw new Error("消息附件引用与附件 manifest 不匹配")
  }

  return ordered
}

async function httpError(response: Response) {
  const body = await response.text()
  let payload: unknown = body
  if (body) {
    try {
      payload = JSON.parse(body)
    } catch {
      // Keep the plain response body as the error message.
    }
  }
  const details = errorDetails(payload)
  return new ChatStreamHttpError(
    response.status,
    details?.message || `聊天请求失败 (${response.status})`,
    details?.code,
  )
}

export async function* streamChat(
  request: ChatStreamRequest,
  attachments: readonly PreparedChatAttachment[],
  signal?: AbortSignal,
  workspaceAuthKey?: string,
): AsyncGenerator<ChatStreamEvent> {
  const orderedAttachments = orderedRequestAttachments(request, attachments)
  if (uniqueAttachmentBytes(orderedAttachments) > MAX_CHAT_WORKING_SET_BYTES) {
    throw new Error("请求附件工作集不能超过 100 MB")
  }
  const formData = new FormData()
  formData.append("request", JSON.stringify(request))
  for (const attachment of orderedAttachments) {
    formData.append("files", attachment.blob, attachment.name)
  }

  const authKey = String(workspaceAuthKey || "").trim() || await getStoredAuthKey()
  const headers: Record<string, string> = {}
  if (authKey) {
    headers.Authorization = `Bearer ${authKey}`
  }

  const response = await fetch(withApiBasePath("/api/chat/stream"), {
    method: "POST",
    headers,
    body: formData,
    signal,
  })
  if (!response.ok) {
    throw await httpError(response)
  }
  if (!response.body) {
    throw new Error("聊天流响应为空")
  }

  yield* parseChatSse(response.body)
}
