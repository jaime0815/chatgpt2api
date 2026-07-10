export type ChatMessageRole = "system" | "user" | "assistant"

export type ChatMessageStatus =
  | "draft"
  | "sending"
  | "streaming"
  | "complete"
  | "stopped"
  | "error"
  | "queued"
  | "running"

export type ChatAttachmentKind = "image" | "document"

export type PreparedChatAttachment = {
  id: string
  name: string
  mimeType: string
  size: number
  sha256: string
  kind: ChatAttachmentKind
  blob: Blob
}

export type ChatAttachmentManifest = {
  id: string
  file_name: string
  mime_type: string
  size: number
  sha256: string
}

export type ChatRequestMessage = {
  id: string
  role: ChatMessageRole
  text: string
  attachment_ids: string[]
}

export type ChatStreamRequest = {
  model: string
  messages: ChatRequestMessage[]
  attachments: ChatAttachmentManifest[]
  reasoning_effort?: string
}

export type ChatStreamEvent =
  | { type: "delta"; content: string }
  | { type: "complete" }
  | { type: "error"; message: string; code?: string }

export type ChatImageSettingsSnapshot = {
  mode: "generate" | "edit"
  model: string
  quality: string
  width: string
  height: string
  ratio: string
  tier: string
  count: number
}

export type ChatGeneratedImage = {
  id: string
  taskId?: string
  url?: string
  status: "queued" | "running" | "success" | "error"
  width?: number
  height?: number
  revisedPrompt?: string
  error?: string
}

export type ChatMessage = {
  id: string
  role: ChatMessageRole
  text: string
  attachmentIds: string[]
  status: ChatMessageStatus
  createdAt: string
  updatedAt?: string
  error?: string
  images?: ChatGeneratedImage[]
  imageSettings?: ChatImageSettingsSnapshot
}

export type ChatConversation = {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  model: string
  reasoningEffort?: string
  messages: ChatMessage[]
  scrollTop: number
}
