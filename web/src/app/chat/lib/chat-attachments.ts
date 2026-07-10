import type { ChatAttachmentKind, PreparedChatAttachment } from "./chat-types"

const MIB = 1024 * 1024

export const MAX_CHAT_IMAGES = 10
export const MAX_CHAT_DOCUMENTS = 5
export const MAX_CHAT_IMAGE_BYTES = 10 * MIB
export const MAX_CHAT_DOCUMENT_BYTES = 25 * MIB
export const MAX_CHAT_MESSAGE_ATTACHMENT_BYTES = 50 * MIB
export const MAX_CHAT_WORKING_SET_BYTES = 100 * MIB

type SupportedAttachmentType = {
  mimeType: string
  kind: ChatAttachmentKind
}

const SUPPORTED_ATTACHMENT_TYPES: Readonly<Record<string, SupportedAttachmentType>> = {
  png: { mimeType: "image/png", kind: "image" },
  jpeg: { mimeType: "image/jpeg", kind: "image" },
  jpg: { mimeType: "image/jpeg", kind: "image" },
  webp: { mimeType: "image/webp", kind: "image" },
  gif: { mimeType: "image/gif", kind: "image" },
  pdf: { mimeType: "application/pdf", kind: "document" },
  docx: {
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    kind: "document",
  },
  xlsx: {
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    kind: "document",
  },
  pptx: {
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    kind: "document",
  },
  txt: { mimeType: "text/plain", kind: "document" },
  md: { mimeType: "text/markdown", kind: "document" },
  csv: { mimeType: "text/csv", kind: "document" },
}

export type ChatAttachmentValidationCode =
  | "unsupported_type"
  | "mime_mismatch"
  | "too_many_images"
  | "too_many_documents"
  | "image_too_large"
  | "document_too_large"
  | "message_too_large"
  | "working_set_too_large"
  | "document_in_image_mode"

export class ChatAttachmentValidationError extends Error {
  readonly code: ChatAttachmentValidationCode

  constructor(code: ChatAttachmentValidationCode, message: string) {
    super(message)
    this.name = "ChatAttachmentValidationError"
    this.code = code
  }
}

export type ChatAttachmentValidationOptions = {
  existingAttachments?: readonly PreparedChatAttachment[]
  mode?: "chat" | "image"
}

function extensionOf(fileName: string) {
  const match = String(fileName || "").trim().toLowerCase().match(/\.([^.]+)$/)
  return match?.[1] || ""
}

function supportedTypeFor(file: File) {
  const extension = extensionOf(file.name)
  const supportedType = SUPPORTED_ATTACHMENT_TYPES[extension]
  if (!supportedType) {
    throw new ChatAttachmentValidationError("unsupported_type", `不支持的附件格式：${file.name}`)
  }

  const browserMimeType = String(file.type || "").trim().toLowerCase()
  if (browserMimeType && browserMimeType !== supportedType.mimeType) {
    throw new ChatAttachmentValidationError(
      "mime_mismatch",
      `附件 MIME 与扩展名不匹配：${file.name}`,
    )
  }

  return supportedType
}

async function readBlobBuffer(blob: Blob) {
  if (typeof blob.arrayBuffer === "function") {
    return blob.arrayBuffer()
  }

  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.onerror = () => reject(reader.error || new Error("读取附件失败"))
    reader.readAsArrayBuffer(blob)
  })
}

async function readBlobBytes(blob: Blob) {
  const buffer = await readBlobBuffer(blob)
  const source = new Uint8Array(buffer)
  const bytes = new Uint8Array(source.byteLength)
  bytes.set(source)
  return bytes
}

function hexDigest(bytes: ArrayBuffer) {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

function deduplicateAttachments(attachments: readonly PreparedChatAttachment[]) {
  const seen = new Set<string>()
  const unique: PreparedChatAttachment[] = []

  for (const attachment of attachments) {
    const key = String(attachment.sha256 || "").trim().toLowerCase() || `id:${attachment.id}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    unique.push(attachment)
  }

  return unique
}

function validateAttachmentSize(kind: ChatAttachmentKind, size: number, name: string) {
  if (kind === "image" && size > MAX_CHAT_IMAGE_BYTES) {
    throw new ChatAttachmentValidationError("image_too_large", `单张图片不能超过 10 MB：${name}`)
  }
  if (kind === "document" && size > MAX_CHAT_DOCUMENT_BYTES) {
    throw new ChatAttachmentValidationError("document_too_large", `单个文档不能超过 25 MB：${name}`)
  }
}

export function uniqueAttachmentBytes(attachments: readonly PreparedChatAttachment[]) {
  return deduplicateAttachments(attachments).reduce((total, attachment) => total + attachment.size, 0)
}

export function validateChatAttachments(
  attachments: readonly PreparedChatAttachment[],
  options: ChatAttachmentValidationOptions = {},
) {
  const uniqueAttachments = deduplicateAttachments(attachments)
  const imageCount = uniqueAttachments.filter((attachment) => attachment.kind === "image").length
  const documentCount = uniqueAttachments.length - imageCount

  if (imageCount > MAX_CHAT_IMAGES) {
    throw new ChatAttachmentValidationError("too_many_images", `单条消息最多添加 ${MAX_CHAT_IMAGES} 张图片`)
  }
  if (documentCount > MAX_CHAT_DOCUMENTS) {
    throw new ChatAttachmentValidationError(
      "too_many_documents",
      `单条消息最多添加 ${MAX_CHAT_DOCUMENTS} 个文档`,
    )
  }
  if (options.mode === "image" && documentCount > 0) {
    throw new ChatAttachmentValidationError("document_in_image_mode", "生成图片模式不能添加文档附件")
  }

  for (const attachment of uniqueAttachments) {
    validateAttachmentSize(attachment.kind, attachment.size, attachment.name)
  }

  if (uniqueAttachmentBytes(uniqueAttachments) > MAX_CHAT_MESSAGE_ATTACHMENT_BYTES) {
    throw new ChatAttachmentValidationError("message_too_large", "单条消息新增附件总量不能超过 50 MB")
  }

  const workingSet = [...(options.existingAttachments || []), ...uniqueAttachments]
  if (uniqueAttachmentBytes(workingSet) > MAX_CHAT_WORKING_SET_BYTES) {
    throw new ChatAttachmentValidationError(
      "working_set_too_large",
      "当前会话附件工作集不能超过 100 MB，请新建对话或移除较早的附件",
    )
  }

  return uniqueAttachments
}

export async function prepareChatAttachment(file: File): Promise<PreparedChatAttachment> {
  const supportedType = supportedTypeFor(file)
  validateAttachmentSize(supportedType.kind, file.size, file.name)
  const bytes = await readBlobBytes(file)
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes)
  const sha256 = hexDigest(digest)
  const attachment: PreparedChatAttachment = {
    id: sha256,
    name: file.name,
    mimeType: supportedType.mimeType,
    size: file.size,
    sha256,
    kind: supportedType.kind,
    blob: new Blob([bytes], { type: supportedType.mimeType }),
  }

  validateChatAttachments([attachment])
  return attachment
}

export async function prepareChatAttachments(
  files: readonly File[],
  options: ChatAttachmentValidationOptions = {},
) {
  const attachments = await Promise.all(files.map((file) => prepareChatAttachment(file)))
  return validateChatAttachments(attachments, options)
}
