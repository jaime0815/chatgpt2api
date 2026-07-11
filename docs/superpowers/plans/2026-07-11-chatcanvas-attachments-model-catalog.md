# ChatCanvas 附件与模型目录 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让普通用户聊天可将支持格式的文件上传给同一原生上游账号读取，手动刷新上游发现的模型目录，并将 README 重构为带来源声明的 ChatCanvas 文档。

**Architecture:** 附件在后端由独立 uploader 转成仅服务端可见的上游描述符，随后由既有会话编排使用同一个 backend 发送。模型目录保持 `/v1/models` OpenAI 响应格式，增加无缓存刷新与前端刷新状态。README 在最终验证后再高亮真实可用能力。

**Tech Stack:** FastAPI、curl-cffi、pytest、Next.js、React、Vitest、IndexedDB/localforage。

---

### Task 1: 原生聊天附件上传与上游消息桥接

**Files:**
- Create: `services/chat_attachments.py`
- Create: `test/test_chat_attachments.py`
- Modify: `services/openai_backend_api.py`
- Modify: `services/chat_stream_service.py`
- Modify: `api/chat.py`
- Modify: `test/test_chat_stream_service.py`
- Modify: `test/test_chat_stream_api.py`

- [ ] **Step 1: 写失败的上传协议和消息结构测试**

```python
def test_document_upload_processes_before_conversation() -> None:
    uploader = ChatAttachmentUploader()
    backend = FakeBackend(create_then_put_then_confirm_then_process=True)
    uploaded = uploader.resolve(backend, (pdf_attachment(),))
    assert uploaded["pdf-1"]["metadata_attachment"]["mime_type"] == "application/pdf"
    assert backend.calls == ["create", "put", "confirm", "process"]
```

- [ ] **Step 2: 运行 RED 测试**

Run: `PYTHONDONTWRITEBYTECODE=1 uv run --with pytest python -m pytest -q test/test_chat_attachments.py --tb=short`

Expected: FAIL，因为 `ChatAttachmentUploader` 和上游描述符尚不存在。

- [ ] **Step 3: 实现 uploader 和 backend 公共上传接口**

```python
class ChatAttachmentUploader:
    def resolve(self, backend: OpenAIBackendAPI, attachments: tuple[ChatAttachmentBlob, ...]) -> Mapping[str, Mapping[str, Any]]:
        return {
            attachment.id: backend.upload_chat_attachment_bytes(
                attachment.data, attachment.file_name, attachment.mime_type, attachment.kind
            )
            for attachment in attachments
        }
```

`OpenAIBackendAPI.upload_chat_attachment_bytes()` 完成创建、签名 PUT、确认；文档调用处理流并在失败时抛出结构化上游异常。消息转换对 document 只写 metadata，对 image 写 asset pointer 加 metadata。默认 `ChatStreamSession` 注入 uploader，鉴权失效映射到 `InvalidAccessTokenError`。

- [ ] **Step 4: 运行 GREEN 与现有聊天服务测试**

Run: `PYTHONDONTWRITEBYTECODE=1 uv run --with pytest python -m pytest -q test/test_chat_attachments.py test/test_chat_stream_service.py test/test_chat_stream_api.py --tb=short`

Expected: PASS；测试断言签名 URL、上游 file ID 和 token 不出现在错误/SSE/log payload。

- [ ] **Step 5: 提交后端附件任务**

```bash
git add services/chat_attachments.py services/openai_backend_api.py services/chat_stream_service.py api/chat.py test/test_chat_attachments.py test/test_chat_stream_service.py test/test_chat_stream_api.py
git commit -m "feat(chat): 接入原生文件附件上传"
```

### Task 2: 普通聊天附件与模型目录前端交互

**Files:**
- Modify: `web/src/app/chat/page.tsx`
- Modify: `web/src/app/chat/hooks/use-chat-controller.ts`
- Modify: `web/src/lib/api.ts`
- Modify: `web/src/app/chat/components/chat-header.tsx`
- Modify: `web/src/app/chat/page.test.tsx`
- Modify: `web/src/app/chat/hooks/use-chat-controller.test.tsx`
- Modify: `web/src/app/chat/components/chat-thread.tsx`

- [ ] **Step 1: 写失败的前端附件与模型刷新测试**

```tsx
it("sends a PDF attachment with a normal chat message", async () => {
  await result.current.sendText({ text: "总结文件", attachments: [pdfAttachment] })
  expect(streamChat).toHaveBeenCalledWith(expect.objectContaining({
    attachments: [pdfAttachment],
    messages: [expect.objectContaining({ attachment_ids: [pdfAttachment.id] })],
  }), expect.anything())
})

it("keeps the last successful model catalog when refresh fails", async () => {
  render(<ChatPage />)
  await refreshCatalogFailure()
  expect(screen.getByRole("combobox")).toHaveTextContent("gpt-5.5")
  expect(screen.getByRole("button", { name: "刷新模型" })).toBeEnabled()
})
```

- [ ] **Step 2: 运行 RED 测试**

Run: `bunx vitest run src/app/chat/page.test.tsx src/app/chat/hooks/use-chat-controller.test.tsx`

Expected: FAIL，因为页面和 controller 当前剥离普通文本附件。

- [ ] **Step 3: 保留附件引用并接通页面操作**

页面提交调用 `controller.sendText({ text, attachments: draftAttachments })`；编辑重发允许保留或替换附件；重试使用历史 attachment IDs 解析 Blob。移除 `TEXT_ATTACHMENT_UNAVAILABLE` 分支，允许 `ChatThread` 进入附件编辑流程。图片生成模式继续拒绝文档，现有图片参考图最多 10 张的约束不变。

`fetchModels({ refresh: true })` 使用 `/v1/models?refresh=1` 和无缓存请求；聊天头部增加带 tooltip 的刷新图标。刷新成功原子替换聊天和图片模型菜单，失败时保留最近成功列表并显示可重试错误；首次加载失败时保留 `auto`。

- [ ] **Step 4: 运行 GREEN、聊天与类型测试**

Run: `bunx vitest run src/app/chat/page.test.tsx src/app/chat/hooks/use-chat-controller.test.tsx src/app/chat/lib/chat-stream.test.ts`

Run: `bunx tsc --noEmit --pretty false`

Expected: PASS；发送、编辑、重试、清空、subject 切换均不能串用附件，模型刷新失败不清空最后一次成功目录。

- [ ] **Step 5: 提交前端附件任务**

```bash
git add web/src/app/chat/page.tsx web/src/app/chat/hooks/use-chat-controller.ts web/src/app/chat/components/chat-thread.tsx web/src/app/chat/components/chat-header.tsx web/src/lib/api.ts web/src/app/chat/page.test.tsx web/src/app/chat/hooks/use-chat-controller.test.tsx
git commit -m "feat(web): 支持普通聊天文件附件"
```

### Task 3: 可刷新最新模型目录后端语义

**Files:**
- Modify: `api/ai.py`
- Modify: `services/protocol/openai_v1_models.py`
- Modify: `test/test_v1_models.py`

- [ ] **Step 1: 写失败的无缓存刷新响应测试**

```python
def test_models_refresh_sets_no_store_header(client, monkeypatch) -> None:
    response = client.get("/v1/models?refresh=1", headers=AUTH_HEADERS)
    assert response.headers["cache-control"] == "no-store"
```

- [ ] **Step 2: 运行 RED 测试**

Run: `PYTHONDONTWRITEBYTECODE=1 uv run --with pytest python -m pytest -q test/test_v1_models.py --tb=short`

Expected: FAIL，因为当前响应没有刷新缓存语义。

- [ ] **Step 3: 实现目录刷新**

`/v1/models` 接受可选 `refresh` 参数，响应设置 `Cache-Control: no-store`，保留当前上游发现及图片别名逻辑。该接口不承诺目录中每个模型都具有当前账号额度。

- [ ] **Step 4: 运行 GREEN 与模型回归**

Run: `PYTHONDONTWRITEBYTECODE=1 uv run --with pytest python -m pytest -q test/test_v1_models.py --tb=short`

Expected: PASS；接口不承诺每个目录模型都具有当前账号额度。

- [ ] **Step 5: 提交模型目录任务**

```bash
git add api/ai.py services/protocol/openai_v1_models.py test/test_v1_models.py
git commit -m "feat(chat): 支持刷新上游模型目录"
```

### Task 4: ChatCanvas README 与可选真实附件验证

**Files:**
- Modify: `README.md`
- Modify: `docs/feature-status.en.md`
- Modify: `test/test_web_chat_live.py`

- [ ] **Step 1: 写或更新附件 live gate 期望**

```python
def test_live_pdf_attachment_requires_a_completed_reply():
    assert "attachment_unavailable" not in collected_sse_error_codes
```

- [ ] **Step 2: 运行 opt-in gate 的默认跳过验证**

Run: `PYTHONDONTWRITEBYTECODE=1 uv run --with pytest python -m pytest -q test/test_web_chat_live.py --tb=short`

Expected: SKIPPED without `RUN_LIVE_CHAT_ATTACHMENTS=1` and real fixtures.

- [ ] **Step 3: 更新 README 和功能状态**

以 `ChatCanvas` 为 README 标题；标题下和文末加入 ChatGPT2API 来源与 LICENSE 说明。更新新功能高亮、附件格式/限制、模型刷新和真实上游依赖；删除或改名旧上游贡献者/Star History 展示，避免以 ChatCanvas 名义呈现。只有在显式 live PDF/Office 验证成功时才标记附件为可用。

- [ ] **Step 4: 验证 Markdown 与无凭证文档**

Run: `git diff --check && git grep -Il -E 'sk-[A-Za-z0-9_-]{20,}' -- README.md docs/feature-status.en.md`

Expected: diff check PASS，grep 无真实密钥命中。

- [ ] **Step 5: 提交文档与 live gate 任务**

```bash
git add README.md docs/feature-status.en.md test/test_web_chat_live.py
git commit -m "docs(chatcanvas): 更新文件聊天与模型目录说明"
```

### Task 5: 集成验证与浏览器验收

**Files:**
- No production file changes expected

- [ ] **Step 1: 运行默认后端全套**

Run: `PYTHONDONTWRITEBYTECODE=1 uv run --with pytest python -m pytest -q test`

Expected: 无失败；真实上游用例只在明确 opt-in 时运行。

- [ ] **Step 2: 运行前端全套与生产构建**

Run: `bun run test && bunx tsc --noEmit --pretty false && bun run build`

Expected: PASS，静态路由包含 `/chat`。

- [ ] **Step 3: 浏览器验证**

Run the local Playwright QA against `/chat`: ordinary user login, refresh models, attach PDF/DOCX and images, edit/retry attachment message, 10 image limit, 5 document limit, mobile sidebar, clear history, and `/image` regression.

- [ ] **Step 4: 提交仅限必要的集成修复**

只在集成验证发现并修复问题时，先用 `git diff --name-only` 列出实际修改文件，再逐个 `git add` 这些已审阅路径；提交信息使用 `fix(chat): 修复附件与模型目录集成问题`。若没有集成修复，不创建空提交。
