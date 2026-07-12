import { describe, expect, it, vi } from "vitest"

import type { PreparedChatAttachment } from "./chat-types"
import {
  prepareChatAttachment,
  prepareChatAttachments,
  uniqueAttachmentBytes,
  validateChatAttachments,
} from "./chat-attachments"

const MIB = 1024 * 1024

function preparedAttachment(
  id: string,
  kind: PreparedChatAttachment["kind"],
  size: number,
  sha256 = id,
): PreparedChatAttachment {
  const mimeType = kind === "image" ? "image/png" : "application/pdf"
  const name = kind === "image" ? `${id}.png` : `${id}.pdf`
  return {
    id,
    name,
    mimeType,
    size,
    sha256,
    kind,
    blob: new Blob([], { type: mimeType }),
  }
}

describe("prepareChatAttachment", () => {
  it.each([
    ["sample.png", "image/png", "image"],
    ["sample.jpeg", "image/jpeg", "image"],
    ["sample.jpg", "image/jpeg", "image"],
    ["sample.webp", "image/webp", "image"],
    ["sample.gif", "image/gif", "image"],
    ["sample.pdf", "application/pdf", "document"],
    ["sample.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "document"],
    ["sample.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "document"],
    ["sample.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation", "document"],
    ["sample.txt", "text/plain", "document"],
    ["sample.md", "text/markdown", "document"],
    ["sample.csv", "text/csv", "document"],
  ])("accepts %s with its canonical MIME", async (name, mimeType, kind) => {
    const attachment = await prepareChatAttachment(new File(["content"], name, { type: mimeType }))

    expect(attachment).toMatchObject({
      id: attachment.sha256,
      name,
      mimeType,
      kind,
      size: 7,
    })
    expect(attachment.sha256).toMatch(/^[a-f\d]{64}$/)
    expect(attachment.blob.type).toBe(mimeType)
  })

  it("normalizes an empty browser MIME from the extension", async () => {
    const attachment = await prepareChatAttachment(new File(["image"], "PHOTO.JPG"))

    expect(attachment.mimeType).toBe("image/jpeg")
    expect(attachment.kind).toBe("image")
    expect(attachment.blob.type).toBe("image/jpeg")
  })

  it.each([
    ["notes.md", "text/plain", "text/markdown"],
    ["notes.md", "text/markdown", "text/markdown"],
    ["data.csv", "text/plain", "text/csv"],
    ["data.csv", "text/csv", "text/csv"],
    ["data.csv", "application/vnd.ms-excel", "text/csv"],
    ["document.docx", "application/octet-stream", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["sheet.xlsx", "application/octet-stream", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ["slides.pptx", "application/octet-stream", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  ])("normalizes trusted browser MIME %s (%s)", async (name, browserMime, canonicalMime) => {
    const attachment = await prepareChatAttachment(
      new File(["content"], name, { type: browserMime }),
    )

    expect(attachment.mimeType).toBe(canonicalMime)
    expect(attachment.blob.type).toBe(canonicalMime)
  })

  it.each(["sample.png", "sample.pdf", "sample.txt", "sample.csv"])(
    "rejects application/octet-stream for unrelated extension %s",
    async (name) => {
      await expect(
        prepareChatAttachment(new File(["content"], name, { type: "application/octet-stream" })),
      ).rejects.toMatchObject({ code: "mime_mismatch" })
    },
  )

  it("keeps the original File when its MIME is already canonical", async () => {
    const file = new File(["content"], "sample.pdf", { type: "application/pdf" })

    const attachment = await prepareChatAttachment(file)

    expect(attachment.blob).toBe(file)
  })

  it("rejects an oversized file before reading or hashing its bytes", async () => {
    const file = new File([], "large.png", { type: "image/png" })
    const arrayBuffer = vi.fn().mockRejectedValue(new Error("file bytes should not be read"))
    Object.defineProperties(file, {
      size: { value: 10 * MIB + 1 },
      arrayBuffer: { value: arrayBuffer },
    })

    await expect(prepareChatAttachment(file)).rejects.toMatchObject({ code: "image_too_large" })
    expect(arrayBuffer).not.toHaveBeenCalled()
  })

  it("falls back to a compatible SHA-256 implementation when WebCrypto is unavailable", async () => {
    const file = new File(["content"], "sample.pdf", { type: "application/pdf" })
    const arrayBuffer = vi.fn().mockResolvedValue(new TextEncoder().encode("content").buffer)
    Object.defineProperty(file, "arrayBuffer", { value: arrayBuffer })
    vi.stubGlobal("crypto", {})

    await expect(prepareChatAttachment(file)).resolves.toMatchObject({
      id: "ed7002b439e9ac845f22357d822bac1444730fbdb6016d3ec9432297b9ec9f73",
      sha256: "ed7002b439e9ac845f22357d822bac1444730fbdb6016d3ec9432297b9ec9f73",
    })
    expect(arrayBuffer).toHaveBeenCalledOnce()
  })

  it("rejects a non-empty MIME that does not match the extension", async () => {
    await expect(
      prepareChatAttachment(new File(["not an image"], "sample.png", { type: "text/plain" })),
    ).rejects.toThrow("MIME")
  })

  it.each([
    ["legacy.doc", "application/msword"],
    ["legacy.xls", "application/vnd.ms-excel"],
    ["legacy.ppt", "application/vnd.ms-powerpoint"],
  ])("rejects unsupported legacy Office file %s", async (name, mimeType) => {
    await expect(prepareChatAttachment(new File(["legacy"], name, { type: mimeType }))).rejects.toThrow(
      "不支持",
    )
  })
})

describe("prepareChatAttachments", () => {
  it("rejects a metadata total over 50 MiB without reading any file", async () => {
    const reads: ReturnType<typeof vi.fn>[] = []
    const files = Array.from({ length: 3 }, (_, index) => {
      const file = new File([], `document-${index}.pdf`, { type: "application/pdf" })
      const arrayBuffer = vi.fn().mockResolvedValue(Uint8Array.of(index).buffer)
      Object.defineProperties(file, {
        size: { value: 20 * MIB },
        arrayBuffer: { value: arrayBuffer },
      })
      reads.push(arrayBuffer)
      return file
    })

    await expect(prepareChatAttachments(files)).rejects.toMatchObject({ code: "message_too_large" })
    reads.forEach((read) => expect(read).not.toHaveBeenCalled())
  })
})

describe("validateChatAttachments", () => {
  it("allows at most 10 images and 5 documents", () => {
    const tenImages = Array.from({ length: 10 }, (_, index) =>
      preparedAttachment(`image-${index}`, "image", 1),
    )
    const fiveDocuments = Array.from({ length: 5 }, (_, index) =>
      preparedAttachment(`document-${index}`, "document", 1),
    )

    expect(validateChatAttachments([...tenImages, ...fiveDocuments])).toHaveLength(15)
    expect(() =>
      validateChatAttachments([...tenImages, preparedAttachment("image-10", "image", 1)]),
    ).toThrow("10")
    expect(() =>
      validateChatAttachments([...fiveDocuments, preparedAttachment("document-5", "document", 1)]),
    ).toThrow("5")
  })

  it("enforces 10 MiB per image and 25 MiB per document", () => {
    expect(() => validateChatAttachments([preparedAttachment("image", "image", 10 * MIB)])).not.toThrow()
    expect(() =>
      validateChatAttachments([preparedAttachment("image", "image", 10 * MIB + 1)]),
    ).toThrow("10 MB")

    expect(() =>
      validateChatAttachments([preparedAttachment("document", "document", 25 * MIB)]),
    ).not.toThrow()
    expect(() =>
      validateChatAttachments([preparedAttachment("document", "document", 25 * MIB + 1)]),
    ).toThrow("25 MB")
  })

  it("enforces the 50 MiB total for newly added attachments", () => {
    const attachments = [
      preparedAttachment("document-a", "document", 25 * MIB),
      preparedAttachment("document-b", "document", 25 * MIB),
    ]

    expect(() => validateChatAttachments(attachments)).not.toThrow()
    expect(() =>
      validateChatAttachments([
        preparedAttachment("document-a", "document", 25 * MIB),
        preparedAttachment("document-b", "document", 25 * MIB),
        preparedAttachment("image", "image", 1),
      ]),
    ).toThrow("50 MB")
  })

  it("enforces the 100 MiB unique conversation working set", () => {
    const existingAttachments = [
      preparedAttachment("existing-a", "document", 25 * MIB),
      preparedAttachment("existing-b", "document", 25 * MIB),
      preparedAttachment("existing-c", "document", 25 * MIB),
    ]

    expect(() =>
      validateChatAttachments(
        [
          preparedAttachment("new-a", "document", 12 * MIB),
          preparedAttachment("new-b", "document", 13 * MIB),
        ],
        {
          existingAttachments,
        },
      ),
    ).not.toThrow()
    expect(() =>
      validateChatAttachments(
        [
          preparedAttachment("new-a", "document", 12 * MIB),
          preparedAttachment("new-b", "document", 13 * MIB + 1),
        ],
        {
          existingAttachments,
        },
      ),
    ).toThrow("100 MB")
  })

  it("deduplicates by SHA-256 before counting or returning attachments", () => {
    const original = preparedAttachment("first", "image", 4, "same-hash")
    const duplicate = preparedAttachment("second", "image", 4, "same-hash")

    expect(validateChatAttachments([original, duplicate])).toEqual([original])
    expect(uniqueAttachmentBytes([original, duplicate])).toBe(4)
  })

  it("rejects documents while image generation mode is active", () => {
    expect(() =>
      validateChatAttachments([preparedAttachment("document", "document", 1)], {
        mode: "image",
      }),
    ).toThrow("文档")
  })
})
