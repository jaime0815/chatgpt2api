import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { ImageSettings } from "@/app/image/components/image-settings"
import type { ChatMessage } from "@/app/chat/lib/chat-types"

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  clearStoredAuthSession: vi.fn(),
  fetchModels: vi.fn(),
  getChatAttachments: vi.fn(),
  chatImageUrlToFile: vi.fn(),
  prepareChatAttachments: vi.fn(),
  authGuard: {
    isCheckingAuth: false,
    session: null as {
      key: string
      role: "admin" | "user"
      subjectId: string
      name: string
    } | null,
  },
  controller: null as unknown,
  controllerOptions: null as unknown,
  imageOptions: null as unknown,
  imageTasks: null as unknown,
  composerOptions: null as unknown,
}))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace }),
}))

vi.mock("@/lib/use-auth-guard", () => ({
  useAuthGuard: () => mocks.authGuard,
}))

vi.mock("@/lib/api", () => ({
  fetchModels: mocks.fetchModels,
}))

vi.mock("@/store/auth", () => ({
  clearStoredAuthSession: mocks.clearStoredAuthSession,
}))

vi.mock("@/store/chat-conversations", () => ({
  getChatAttachments: mocks.getChatAttachments,
}))

vi.mock("@/app/chat/lib/chat-images", () => ({
  chatImageUrlToFile: mocks.chatImageUrlToFile,
}))

vi.mock("@/app/chat/lib/chat-attachments", () => ({
  prepareChatAttachments: mocks.prepareChatAttachments,
  validateChatAttachments: (attachments: unknown[]) => attachments,
}))

vi.mock("./hooks/use-chat-controller", () => ({
  useChatController: (options: unknown) => {
    mocks.controllerOptions = options
    return mocks.controller
  },
}))

vi.mock("./hooks/use-chat-image-tasks", () => ({
  useChatImageTasks: (options: unknown) => {
    mocks.imageOptions = options
    return mocks.imageTasks
  },
}))

vi.mock("./components/chat-shell", () => ({
  ChatShell: ({ sidebar, header, thread, composer }: { sidebar: React.ReactNode; header: React.ReactNode; thread: React.ReactNode; composer: React.ReactNode }) => (
    <section data-testid="chat-shell">
      {sidebar}
      {header}
      {thread}
      {composer}
    </section>
  ),
}))

vi.mock("./components/chat-sidebar", () => ({
  ChatSidebar: ({
    chatHref,
    imageHref,
    onSignOut,
    onToggleTheme,
    onDeleteConversation,
    onClearHistory,
  }: {
    chatHref?: string
    imageHref?: string
    onSignOut: () => void
    onToggleTheme: () => void
    onDeleteConversation: (conversationId: string) => void
    onClearHistory: () => void
  }) => (
    <aside>
      <a data-testid="chat-link" href={`/chatgpt2api${chatHref}`}>聊天</a>
      <a data-testid="image-link" href={`/chatgpt2api${imageHref}`}>高级画图</a>
      <button type="button" onClick={onToggleTheme}>切换主题</button>
      <button type="button" onClick={onSignOut}>退出登录</button>
      <button type="button" onClick={() => onDeleteConversation("conversation-1")}>删除对话</button>
      <button type="button" onClick={onClearHistory}>清空聊天记录</button>
    </aside>
  ),
}))

vi.mock("./components/chat-header", () => ({
  ChatHeader: ({ onModelChange, onNewConversation }: { onModelChange: (model: string) => void; onNewConversation: () => void }) => (
    <header>
      <button type="button" onClick={() => onModelChange("gpt-5.2")}>选择模型</button>
      <button type="button" onClick={onNewConversation}>新对话</button>
    </header>
  ),
}))

vi.mock("./components/chat-thread", () => ({
  ChatThread: ({
    onRetry,
    onUseImageAsReference,
  }: {
    onRetry?: (id: string) => void
    onUseImageAsReference?: (image: { id: string; url?: string }) => void
  }) => (
    <section>
      <button type="button" onClick={() => onRetry?.("assistant-1")}>重新生成</button>
      <button type="button" onClick={() => onUseImageAsReference?.({ id: "image-1", url: "/images/image-1.png" })}>用作参考图</button>
    </section>
  ),
}))

vi.mock("./components/chat-composer", () => ({
  ChatComposer: ({
    mode,
    onValueChange,
    onSubmit,
    onStop,
    onModeChange,
    onFilesSelected,
    onRemoveAttachment,
    attachmentError,
    imageSettings,
    value,
    disabled,
  }: {
    mode: string
    value: string
    disabled?: boolean
    onValueChange: (value: string) => void
    onSubmit: () => void
    onStop: () => void
    onModeChange: (mode: "chat" | "image") => void
    onFilesSelected: (files: File[]) => void | Promise<void>
    onRemoveAttachment: (attachmentId: string) => void
    attachmentError?: string | null
    imageSettings: { width: string; height: string; ratio: string; tier: string; count: string }
  }) => {
    mocks.composerOptions = {
      onValueChange,
      onSubmit,
      onFilesSelected,
      onRemoveAttachment,
      onModeChange,
      value,
      disabled,
    }
    return (
    <section>
      <output data-testid="composer-mode">{mode}</output>
      <output data-testid="composer-value">{value}</output>
      <output data-testid="composer-disabled">{String(Boolean(disabled))}</output>
      <output data-testid="attachment-error">{attachmentError}</output>
      <output data-testid="image-settings">
        {imageSettings.width}x{imageSettings.height} {imageSettings.ratio}/{imageSettings.tier} {imageSettings.count}
      </output>
      <button type="button" onClick={() => onValueChange("hello")}>输入消息</button>
      <button type="button" onClick={onSubmit}>提交</button>
      <button type="button" onClick={onStop}>停止</button>
      <button type="button" onClick={() => onModeChange("image")}>切换图片模式</button>
      <button
        type="button"
        onClick={() =>
          void onFilesSelected([new File(["image"], "attachment.png", { type: "image/png" })])
        }
      >
        添加附件
      </button>
    </section>
    )
  },
}))

import ChatPage from "./page"
import { loadChatImageSettings, saveChatImageSettings } from "./lib/chat-image-settings"

const IMAGE_SETTINGS: ImageSettings = {
  model: "gpt-image-2",
  quality: "high",
  width: "1536",
  height: "1024",
  ratio: "3:2",
  tier: "1k",
  count: "3",
}

const activeConversation = {
  id: "conversation-1",
  title: "Existing conversation",
  createdAt: "2026-07-11T08:00:00.000Z",
  updatedAt: "2026-07-11T08:01:00.000Z",
  model: "missing-model",
  scrollTop: 23,
  messages: [
    {
      id: "assistant-1",
      role: "assistant" as const,
      text: "",
      attachmentIds: [],
      status: "running" as const,
      createdAt: "2026-07-11T08:00:00.000Z",
      images: [{ id: "image-1", taskId: "task-1", status: "running" as const }],
    },
  ],
}

function controller() {
  return {
    state: {
      subjectId: "subject-user",
      conversations: [activeConversation],
      activeConversationId: activeConversation.id,
      selectedModel: "missing-model",
      scrollPositions: { [activeConversation.id]: 23 },
      activeStream: null,
      isLoading: false,
      storageWarning: null,
    },
    activeConversation,
    isStreaming: false,
    createConversation: vi.fn(),
    selectConversation: vi.fn(),
    renameConversation: vi.fn(),
    deleteConversation: vi.fn(),
    sendText: vi.fn(),
    stop: vi.fn(),
    retryAssistant: vi.fn(),
    editAndResend: vi.fn(),
    clearHistory: vi.fn(),
    setSelectedModel: vi.fn(),
    setScrollPosition: vi.fn(),
    clearStorageWarning: vi.fn(),
    upsertMessage: vi.fn(),
  }
}

function imageTasks() {
  return {
    activeTaskIds: [],
    isGenerating: false,
    submit: vi.fn(),
    recoverImageMessages: vi.fn(),
    discardImageMessages: vi.fn(),
    resumeImageTask: vi.fn(),
    retryImageTask: vi.fn(),
  }
}

function deferred<Value>() {
  let resolve!: (value: Value) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe("ChatPage", () => {
  beforeEach(() => {
    localStorage.clear()
    mocks.replace.mockReset()
    mocks.clearStoredAuthSession.mockReset()
    mocks.fetchModels.mockReset()
    mocks.fetchModels.mockResolvedValue({
      data: [{ id: "gpt-5.2" }, { id: "gpt-image-2" }],
    })
    mocks.getChatAttachments.mockReset()
    mocks.getChatAttachments.mockResolvedValue([])
    mocks.chatImageUrlToFile.mockReset()
    mocks.prepareChatAttachments.mockReset()
    mocks.prepareChatAttachments.mockResolvedValue([])
    mocks.authGuard = {
      isCheckingAuth: false,
      session: {
        key: "user-key",
        role: "user",
        subjectId: "subject-user",
        name: "Alice",
      },
    }
    mocks.controller = controller()
    mocks.imageTasks = imageTasks()
    mocks.imageOptions = null
    mocks.controllerOptions = null
    mocks.composerOptions = null
    document.documentElement.classList.remove("dark")
  })

  it("composes the authenticated workspace and routes controller/image-task events", async () => {
    render(<ChatPage />)

    await waitFor(() => expect(mocks.fetchModels).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId("chat-shell")).toBeInTheDocument()
    expect(screen.getByTestId("chat-link")).toHaveAttribute("href", "/chatgpt2api/chat")
    expect(screen.getByTestId("image-link")).toHaveAttribute("href", "/chatgpt2api/image")
    expect(mocks.controllerOptions).toMatchObject({
      subjectId: "subject-user",
      authKey: "user-key",
    })
    expect((mocks.imageTasks as ReturnType<typeof imageTasks>).recoverImageMessages).toHaveBeenCalledWith(
      activeConversation.messages,
    )

    fireEvent.click(screen.getByRole("button", { name: "选择模型" }))
    expect((mocks.controller as ReturnType<typeof controller>).setSelectedModel).toHaveBeenCalledWith("gpt-5.2")

    fireEvent.click(screen.getByRole("button", { name: "输入消息" }))
    fireEvent.click(screen.getByRole("button", { name: "提交" }))
    await waitFor(() =>
      expect((mocks.controller as ReturnType<typeof controller>).sendText).toHaveBeenCalledWith({ text: "hello" }),
    )

    fireEvent.click(screen.getByRole("button", { name: "停止" }))
    fireEvent.click(screen.getByRole("button", { name: "重新生成" }))
    expect((mocks.controller as ReturnType<typeof controller>).stop).toHaveBeenCalledTimes(1)
    expect((mocks.controller as ReturnType<typeof controller>).retryAssistant).toHaveBeenCalledWith("assistant-1")

    const imageMessage: ChatMessage = activeConversation.messages[0]
    const imageOptions = mocks.imageOptions as {
      onMessageChange: (message: ChatMessage) => Promise<void>
    }
    await act(async () => {
      await imageOptions.onMessageChange(imageMessage)
    })
    expect((mocks.controller as ReturnType<typeof controller>).upsertMessage).toHaveBeenCalledWith(
      imageMessage,
      [],
      { conversationId: activeConversation.id },
    )

    fireEvent.click(screen.getByRole("button", { name: "删除对话" }))
    expect((mocks.imageTasks as ReturnType<typeof imageTasks>).discardImageMessages).toHaveBeenCalledWith(
      ["assistant-1"],
    )
    expect((mocks.controller as ReturnType<typeof controller>).deleteConversation).toHaveBeenCalledWith(
      activeConversation.id,
    )

    fireEvent.click(screen.getByRole("button", { name: "切换主题" }))
    expect(document.documentElement.classList.contains("dark")).toBe(true)
    expect(localStorage.getItem("chatgpt2api-theme")).toBe("dark")

    fireEvent.click(screen.getByRole("button", { name: "退出登录" }))
    await waitFor(() => expect(mocks.clearStoredAuthSession).toHaveBeenCalledTimes(1))
    expect(mocks.replace).toHaveBeenCalledWith("/login")
  })

  it("binds image task lifecycle to the authenticated workspace key", async () => {
    render(<ChatPage />)

    const imageOptions = mocks.imageOptions as {
      authKey: string
    }
    expect(imageOptions.authKey).toBe("user-key")
  })

  it("keeps chat image settings isolated by subject without inheriting legacy shared settings", () => {
    localStorage.setItem("chatgpt2api:image_last_model", "legacy-image-model")
    localStorage.setItem("chatgpt2api:image_last_quality", "high")
    localStorage.setItem("chatgpt2api:image_last_ratio", "16:9")
    localStorage.setItem("chatgpt2api:image_last_tier", "2k")
    localStorage.setItem("chatgpt2api:image_last_count", "12")

    expect(loadChatImageSettings("alice@example.com")).toMatchObject({ count: "1" })
    expect(loadChatImageSettings("alice@example.com").model).not.toBe("legacy-image-model")
    expect(loadChatImageSettings("bob@example.com").model).not.toBe("legacy-image-model")

    const aliceSettings = { ...IMAGE_SETTINGS, model: "alice-image", count: "6" }
    const bobSettings = { ...IMAGE_SETTINGS, model: "bob-image", ratio: "1:1", width: "1024", height: "1024", count: "2" }
    saveChatImageSettings("alice@example.com", aliceSettings)
    saveChatImageSettings("bob@example.com", bobSettings)
    localStorage.setItem("chatgpt2api:image_last_model", "changed-legacy-model")

    expect(loadChatImageSettings("alice@example.com")).toMatchObject(aliceSettings)
    expect(loadChatImageSettings("bob@example.com")).toMatchObject(bobSettings)
    expect(loadChatImageSettings("alice@example.com").model).not.toBe("changed-legacy-model")
  })

  it("clears local chat history and discards active image messages", async () => {
    const reference = {
      id: "clear-reference",
      name: "clear-reference.png",
      mimeType: "image/png",
      size: 5,
      sha256: "c".repeat(64),
      kind: "image" as const,
      blob: new Blob(["image"], { type: "image/png" }),
    }
    mocks.prepareChatAttachments.mockResolvedValue([reference])
    render(<ChatPage />)

    const composer = mocks.composerOptions as {
      onModeChange: (mode: "chat" | "image") => void
    }
    await act(async () => {
      composer.onModeChange("image")
    })
    const imageComposer = mocks.composerOptions as {
      onFilesSelected: (files: File[]) => Promise<void>
    }
    await act(async () => {
      await imageComposer.onFilesSelected([new File(["image"], "clear-reference.png", { type: "image/png" })])
    })

    fireEvent.click(screen.getByRole("button", { name: "清空聊天记录" }))

    expect((mocks.imageTasks as ReturnType<typeof imageTasks>).discardImageMessages).toHaveBeenCalledWith(
      ["assistant-1"],
    )
    expect((mocks.controller as ReturnType<typeof controller>).clearHistory).toHaveBeenCalledOnce()

    const imageOptions = mocks.imageOptions as {
      onMessageChange: (message: ChatMessage) => Promise<void>
    }
    const afterClear: ChatMessage = {
      id: "assistant-1",
      role: "assistant",
      text: "draw",
      attachmentIds: [reference.id],
      status: "queued",
      createdAt: "2026-07-11T08:00:00.000Z",
      images: [{ id: "image-1", taskId: "task-1", status: "success" }],
    }
    await act(async () => {
      await imageOptions.onMessageChange(afterClear)
    })
    expect((mocks.controller as ReturnType<typeof controller>).upsertMessage).not.toHaveBeenCalled()
  })

  it("holds the page while authentication is still resolving", () => {
    mocks.authGuard = { isCheckingAuth: true, session: null }

    render(<ChatPage />)

    expect(screen.queryByTestId("chat-shell")).not.toBeInTheDocument()
  })

  it("waits for the model catalog before normalizing a hydrated chat model", async () => {
    const models = deferred<{ data: Array<{ id: string }> }>()
    const hydratedController = controller()
    hydratedController.state.selectedModel = "gpt-5.2"
    mocks.controller = hydratedController
    mocks.fetchModels.mockReturnValue(models.promise)

    render(<ChatPage />)

    await waitFor(() => expect(mocks.fetchModels).toHaveBeenCalledTimes(1))
    expect(hydratedController.setSelectedModel).not.toHaveBeenCalled()

    await act(async () => {
      models.resolve({ data: [{ id: "gpt-5.2" }, { id: "gpt-image-2" }] })
    })
    await waitFor(() => expect(hydratedController.setSelectedModel).not.toHaveBeenCalled())
  })

  it("keeps a hydrated chat model when the model catalog cannot be loaded", async () => {
    const hydratedController = controller()
    hydratedController.state.selectedModel = "gpt-5.2"
    mocks.controller = hydratedController
    const catalog = deferred<{ data: Array<{ id: string }> }>()
    mocks.fetchModels.mockReturnValue(catalog.promise)

    render(<ChatPage />)

    await waitFor(() => expect(mocks.fetchModels).toHaveBeenCalledTimes(1))
    await act(async () => {
      catalog.reject(new Error("catalog unavailable"))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(hydratedController.setSelectedModel).not.toHaveBeenCalled()
  })

  it("submits one image task while an earlier submit is still pending and releases the guard after failure", async () => {
    const pendingSubmit = deferred<unknown>()
    const tasks = imageTasks()
    tasks.submit = vi.fn(() => pendingSubmit.promise)
    mocks.imageTasks = tasks
    render(<ChatPage />)

    const initialComposer = mocks.composerOptions as {
      onModeChange: (mode: "chat" | "image") => void
    }
    await act(async () => {
      initialComposer.onModeChange("image")
    })
    const imageComposer = mocks.composerOptions as {
      onValueChange: (value: string) => void
      onSubmit: () => Promise<void>
    }
    await act(async () => {
      imageComposer.onValueChange("draw once")
    })
    const readyComposer = mocks.composerOptions as {
      onSubmit: () => Promise<void>
    }

    let first!: Promise<void>
    let second!: Promise<void>
    act(() => {
      first = readyComposer.onSubmit()
      second = readyComposer.onSubmit()
    })
    await waitFor(() => expect(tasks.submit).toHaveBeenCalledTimes(1))
    const firstMessageId = tasks.submit.mock.calls[0]?.[0]?.messageId

    await act(async () => {
      pendingSubmit.reject(new Error("submit rejected"))
      await Promise.all([first, second])
    })

    await act(async () => {
      await readyComposer.onSubmit()
    })
    expect(tasks.submit).toHaveBeenCalledTimes(2)
    expect(tasks.submit.mock.calls[1]?.[0]?.messageId).not.toBe(firstMessageId)
  })

  it("keeps a newer image draft when its initial persistence settles", async () => {
    const pendingSubmit = deferred<unknown>()
    const tasks = imageTasks()
    tasks.submit = vi.fn(() => pendingSubmit.promise)
    mocks.imageTasks = tasks
    render(<ChatPage />)

    const initialComposer = mocks.composerOptions as {
      onModeChange: (mode: "chat" | "image") => void
    }
    act(() => {
      initialComposer.onModeChange("image")
    })
    const imageComposer = mocks.composerOptions as {
      onValueChange: (value: string) => void
      onSubmit: () => Promise<void>
    }
    act(() => {
      imageComposer.onValueChange("P")
    })

    const submit = (mocks.composerOptions as { onSubmit: () => Promise<void> }).onSubmit()
    await waitFor(() => expect(tasks.submit).toHaveBeenCalledOnce())
    expect(screen.getByTestId("composer-disabled")).toHaveTextContent("true")

    act(() => {
      ;(mocks.composerOptions as { onValueChange: (value: string) => void }).onValueChange("Q")
    })
    await act(async () => {
      pendingSubmit.resolve({})
      await submit
    })

    expect(screen.getByTestId("composer-value")).toHaveTextContent("Q")
  })

  it("keeps a newer text draft after its stream completes", async () => {
    const pendingStream = deferred<void>()
    const textController = controller()
    textController.sendText = vi.fn(() => pendingStream.promise)
    mocks.controller = textController
    render(<ChatPage />)

    act(() => {
      ;(mocks.composerOptions as { onValueChange: (value: string) => void }).onValueChange("P")
    })
    const send = (mocks.composerOptions as { onSubmit: () => Promise<void> }).onSubmit()
    await waitFor(() => expect(textController.sendText).toHaveBeenCalledWith({ text: "P" }))
    expect(screen.getByTestId("composer-value")).toBeEmptyDOMElement()

    act(() => {
      ;(mocks.composerOptions as { onValueChange: (value: string) => void }).onValueChange("Q")
    })
    await act(async () => {
      pendingStream.resolve()
      await send
    })

    expect(screen.getByTestId("composer-value")).toHaveTextContent("Q")
  })

  it("keeps the text draft when starting its stream throws synchronously", async () => {
    const textController = controller()
    textController.sendText = vi.fn(() => {
      throw new Error("stream start failed")
    })
    mocks.controller = textController
    render(<ChatPage />)

    act(() => {
      ;(mocks.composerOptions as { onValueChange: (value: string) => void }).onValueChange("P")
    })
    await act(async () => {
      await (mocks.composerOptions as { onSubmit: () => Promise<void> }).onSubmit()
    })

    expect(screen.getByTestId("composer-value")).toHaveTextContent("P")
  })

  it("restores image dimensions from the shared ratio and tier when older preferences omit them", async () => {
    saveChatImageSettings("subject-user", {
      ...IMAGE_SETTINGS,
      ratio: "16:9",
      tier: "2k",
      count: "12",
      width: "2560",
      height: "1440",
    })

    render(<ChatPage />)

    expect(screen.getByTestId("image-settings")).toHaveTextContent("2560x1440 16:9/2k 12")
  })

  it("blocks ordinary chat attachments while preserving image-reference preparation and retry resolution", async () => {
    const reference = {
      id: "reference-attachment",
      name: "reference.png",
      mimeType: "image/png",
      size: 5,
      sha256: "a".repeat(64),
      kind: "image" as const,
      blob: new Blob(["image"], { type: "image/png" }),
    }
    mocks.prepareChatAttachments.mockResolvedValue([reference])
    mocks.chatImageUrlToFile.mockResolvedValue(
      new File(["image"], "reference-image.png", { type: "image/png" }),
    )

    render(<ChatPage />)

    const imageOptions = mocks.imageOptions as {
      resolveAttachments: (attachmentIds: readonly string[]) => Promise<unknown>
    }
    await imageOptions.resolveAttachments([reference.id])
    expect(mocks.getChatAttachments).toHaveBeenCalledWith("subject-user", [reference.id])

    fireEvent.click(screen.getByRole("button", { name: "添加附件" }))
    await waitFor(() =>
      expect(screen.getByTestId("attachment-error")).toHaveTextContent(
        "当前版本暂不支持带附件的普通聊天",
      ),
    )
    fireEvent.click(screen.getByRole("button", { name: "输入消息" }))
    fireEvent.click(screen.getByRole("button", { name: "提交" }))
    expect((mocks.controller as ReturnType<typeof controller>).sendText).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: "用作参考图" }))
    await waitFor(() => expect(mocks.chatImageUrlToFile).toHaveBeenCalledWith(
      "/images/image-1.png",
      "reference-image-1.png",
    ))
    expect(mocks.prepareChatAttachments).toHaveBeenLastCalledWith(
      expect.any(Array),
      { mode: "image" },
    )
    expect(screen.getByTestId("composer-mode")).toHaveTextContent("image")
  })

  it("releases temporary image references after removal and after their first persistence", async () => {
    const reference = {
      id: "temporary-reference",
      name: "temporary.png",
      mimeType: "image/png",
      size: 5,
      sha256: "b".repeat(64),
      kind: "image" as const,
      blob: new Blob(["image"], { type: "image/png" }),
    }
    mocks.prepareChatAttachments.mockResolvedValue([reference])
    render(<ChatPage />)

    const composer = mocks.composerOptions as {
      onModeChange: (mode: "chat" | "image") => void
      onFilesSelected: (files: File[]) => Promise<void>
      onRemoveAttachment: (attachmentId: string) => void
    }
    await act(async () => {
      composer.onModeChange("image")
    })
    const imageComposer = mocks.composerOptions as {
      onFilesSelected: (files: File[]) => Promise<void>
      onRemoveAttachment: (attachmentId: string) => void
    }
    await act(async () => {
      await imageComposer.onFilesSelected([new File(["image"], "temporary.png", { type: "image/png" })])
    })
    await act(async () => {
      imageComposer.onRemoveAttachment(reference.id)
    })

    const imageOptions = mocks.imageOptions as {
      onMessageChange: (message: ChatMessage) => Promise<void>
    }
    const removedMessage: ChatMessage = {
      id: "removed-reference-message",
      role: "assistant",
      text: "draw",
      attachmentIds: [reference.id],
      status: "queued",
      createdAt: "2026-07-11T08:00:00.000Z",
      images: [{ id: "removed-image", taskId: "removed-task", status: "queued" }],
    }
    await act(async () => {
      await imageOptions.onMessageChange(removedMessage)
    })
    expect((mocks.controller as ReturnType<typeof controller>).upsertMessage).toHaveBeenLastCalledWith(
      removedMessage,
      [],
      undefined,
    )

    await act(async () => {
      await imageComposer.onFilesSelected([new File(["image"], "temporary.png", { type: "image/png" })])
    })
    const persistedMessage = { ...removedMessage, id: "persisted-reference-message" }
    await act(async () => {
      await imageOptions.onMessageChange(persistedMessage)
    })
    expect((mocks.controller as ReturnType<typeof controller>).upsertMessage).toHaveBeenLastCalledWith(
      persistedMessage,
      [reference],
      undefined,
    )
    await act(async () => {
      await imageOptions.onMessageChange({ ...persistedMessage, status: "running" })
    })
    expect((mocks.controller as ReturnType<typeof controller>).upsertMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: persistedMessage.id, status: "running" }),
      [],
      undefined,
    )
  })
})
