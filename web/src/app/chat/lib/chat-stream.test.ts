import { beforeEach, describe, expect, it, vi } from "vitest"

import type {
  ChatAttachmentManifest,
  ChatStreamEvent,
  ChatStreamRequest,
  PreparedChatAttachment,
} from "./chat-types"

const mocks = vi.hoisted(() => ({
  getStoredAuthKey: vi.fn(),
  withApiBasePath: vi.fn(),
}))

vi.mock("@/store/auth", () => ({
  getStoredAuthKey: mocks.getStoredAuthKey,
}))

vi.mock("@/lib/paths", () => ({
  withApiBasePath: mocks.withApiBasePath,
}))

import { parseChatSse, streamChat } from "./chat-stream"

const encoder = new TextEncoder()

function byteStream(...chunks: string[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)))
      controller.close()
    },
  })
}

async function collect(events: AsyncIterable<ChatStreamEvent>) {
  const result: ChatStreamEvent[] = []
  for await (const event of events) {
    result.push(event)
  }
  return result
}

function delta(content: string) {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`
}

function preparedAttachment(id: string, content: string): PreparedChatAttachment {
  const blob = new Blob([content], { type: "text/plain" })
  return {
    id,
    name: `${id}.txt`,
    mimeType: "text/plain",
    size: blob.size,
    sha256: `${id}-sha`,
    kind: "document",
    blob,
  }
}

function manifest(attachment: PreparedChatAttachment): ChatAttachmentManifest {
  return {
    id: attachment.id,
    file_name: attachment.name,
    mime_type: attachment.mimeType,
    size: attachment.size,
    sha256: attachment.sha256,
  }
}

function request(attachments: PreparedChatAttachment[] = []): ChatStreamRequest {
  return {
    model: "gpt-5.4",
    messages: [
      {
        id: "message-1",
        role: "user",
        text: "hello",
        attachment_ids: attachments.map((attachment) => attachment.id),
      },
    ],
    attachments: attachments.map(manifest),
    thinking_effort: "high",
  }
}

describe("parseChatSse", () => {
  it("reassembles frames split across transport chunks", async () => {
    const payload = `${delta("Hel")}${delta("lo")}data: [DONE]\n\n`
    const events = await collect(
      parseChatSse(byteStream(payload.slice(0, 9), payload.slice(9, 41), payload.slice(41))),
    )

    expect(events).toEqual([
      { type: "delta", content: "Hel" },
      { type: "delta", content: "lo" },
      { type: "complete" },
    ])
  })

  it("parses multiple CRLF frames and ignores SSE comments", async () => {
    const payload = [
      ": keep-alive\r\n\r\n",
      `event: message\r\ndata: ${JSON.stringify({ choices: [{ delta: { content: "one" } }] })}\r\n\r\n`,
      `data: ${JSON.stringify({ type: "delta", content: "two" })}\r\n\r\n`,
      "data: [DONE]\r\n\r\n",
    ].join("")

    await expect(collect(parseChatSse(byteStream(payload)))).resolves.toEqual([
      { type: "delta", content: "one" },
      { type: "delta", content: "two" },
      { type: "complete" },
    ])
  })

  it("keeps an in-stream error terminal and ignores a later DONE", async () => {
    const payload = [
      delta("partial"),
      `event: error\ndata: ${JSON.stringify({ error: { message: "upstream failed", code: "upstream_error" } })}\n\n`,
      "data: [DONE]\n\n",
    ].join("")

    await expect(collect(parseChatSse(byteStream(payload)))).resolves.toEqual([
      { type: "delta", content: "partial" },
      { type: "error", message: "upstream failed", code: "upstream_error" },
    ])
  })

  it("turns an interrupted stream without a terminal frame into an error", async () => {
    await expect(collect(parseChatSse(byteStream(delta("partial"))))).resolves.toEqual([
      { type: "delta", content: "partial" },
      { type: "error", message: "聊天流意外中断", code: "stream_interrupted" },
    ])
  })

  it("cancels the underlying reader when the consumer stops early", async () => {
    const cancel = vi.fn()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(delta("partial")))
      },
      cancel,
    })
    const events = parseChatSse(stream)

    await expect(events.next()).resolves.toEqual({
      value: { type: "delta", content: "partial" },
      done: false,
    })
    await events.return(undefined)

    expect(cancel).toHaveBeenCalledOnce()
  })
})

describe("streamChat", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    mocks.getStoredAuthKey.mockReset().mockResolvedValue("secret-key")
    mocks.withApiBasePath.mockReset().mockReturnValue("/base/api/chat/stream")
  })

  it("sends native multipart files in manifest order with auth and AbortSignal", async () => {
    const first = preparedAttachment("first", "one")
    const second = preparedAttachment("second", "two")
    const streamRequest = request([second, first])
    const signal = new AbortController().signal
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(byteStream(`${delta("ok")}data: [DONE]\n\n`), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    )
    vi.stubGlobal("fetch", fetchMock)

    await expect(collect(streamChat(streamRequest, [first, second], signal))).resolves.toEqual([
      { type: "delta", content: "ok" },
      { type: "complete" },
    ])

    expect(mocks.getStoredAuthKey).toHaveBeenCalledOnce()
    expect(mocks.withApiBasePath).toHaveBeenCalledWith("/api/chat/stream")
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("/base/api/chat/stream")
    expect(init.method).toBe("POST")
    expect(init.signal).toBe(signal)
    expect(init.headers).toEqual({ Authorization: "Bearer secret-key" })

    const formData = init.body as FormData
    expect(Array.from(formData.keys())).toEqual(["request", "files", "files"])
    const serializedRequest = JSON.parse(String(formData.get("request")))
    expect(serializedRequest).toEqual(streamRequest)
    expect(serializedRequest).toMatchObject({ thinking_effort: "high" })
    expect(serializedRequest).not.toHaveProperty("reasoning_effort")
    expect(formData.getAll("files").map((entry) => (entry as File).name)).toEqual([
      "second.txt",
      "first.txt",
    ])
  })

  it("uses the workspace-bound auth key instead of reading the shared session", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(byteStream("data: [DONE]\n\n"), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    )
    vi.stubGlobal("fetch", fetchMock)

    await expect(collect(streamChat(request(), [], undefined, "workspace-a-key"))).resolves.toEqual([
      { type: "complete" },
    ])

    expect(mocks.getStoredAuthKey).not.toHaveBeenCalled()
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({
      Authorization: "Bearer workspace-a-key",
    })
  })

  it("aborts an active response stream through the provided AbortSignal", async () => {
    const abortController = new AbortController()
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      const signal = init.signal as AbortSignal
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(delta("partial")))
          signal.addEventListener(
            "abort",
            () => controller.error(new DOMException("The operation was aborted", "AbortError")),
            { once: true },
          )
        },
      })
      return Promise.resolve(new Response(body, { status: 200 }))
    })
    vi.stubGlobal("fetch", fetchMock)
    const events = streamChat(request(), [], abortController.signal)

    await expect(events.next()).resolves.toEqual({
      value: { type: "delta", content: "partial" },
      done: false,
    })
    abortController.abort()

    await expect(events.next()).rejects.toMatchObject({ name: "AbortError" })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it("rejects a missing or extra prepared file before fetch", async () => {
    const first = preparedAttachment("first", "one")
    const second = preparedAttachment("second", "two")
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    await expect(collect(streamChat(request([first]), [first, second]))).rejects.toThrow("manifest")
    await expect(collect(streamChat(request([first, second]), [first]))).rejects.toThrow("manifest")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("rejects a request attachment working set over 100 MiB before fetch", async () => {
    const attachments = Array.from({ length: 5 }, (_, index) => {
      const attachment = preparedAttachment(`document-${index}`, "")
      Object.defineProperty(attachment.blob, "size", { value: 21 * 1024 * 1024 })
      attachment.size = attachment.blob.size
      return attachment
    })
    const streamRequest: ChatStreamRequest = {
      model: "gpt-5.4",
      messages: [
        {
          id: "message-1",
          role: "user",
          text: "first",
          attachment_ids: attachments.slice(0, 2).map((attachment) => attachment.id),
        },
        {
          id: "message-2",
          role: "user",
          text: "second",
          attachment_ids: attachments.slice(2, 4).map((attachment) => attachment.id),
        },
        {
          id: "message-3",
          role: "user",
          text: "third",
          attachment_ids: attachments.slice(4).map((attachment) => attachment.id),
        },
      ],
      attachments: attachments.map(manifest),
    }
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    await expect(collect(streamChat(streamRequest, attachments))).rejects.toThrow("100 MB")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("parses a structured HTTP error response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ detail: { error: { message: "model unavailable", code: "model_error" } } }), {
          status: 422,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    )

    await expect(collect(streamChat(request(), []))).rejects.toMatchObject({
      message: "model unavailable",
      code: "model_error",
      status: 422,
    })
  })
})
