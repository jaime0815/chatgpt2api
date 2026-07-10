# Ordinary User Chat Interface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a production-quality `/chat` experience for ordinary users with streaming text chat, model selection, native image/document attachments, persistent local conversations, and full reuse of the existing image-generation parameters and task APIs.

**Architecture:** Keep the OpenAI-compatible APIs unchanged and add a web-only multipart streaming endpoint that selects one upstream account, resolves attachments on that account, and streams OpenAI-style SSE chunks. Build the frontend as focused protocol, persistence, controller, image-task, and presentational modules; `/chat` uses a route-aware immersive shell while `/image` keeps its existing advanced workflow.

**Tech Stack:** Python 3.13, FastAPI, Pydantic, requests/curl-cffi, unittest/pytest, Next.js 16, React 19, TypeScript, Tailwind 4, Radix/shadcn, localforage, Vitest, React Testing Library.

**Design spec:** `docs/superpowers/specs/2026-07-10-user-chat-interface-design.md`

---

## Parallel Execution Map

Use one isolated worktree and branch per atomic task. The root agent coordinates contracts, cherry-picks finished commits, and runs integration gates. Keep three child agents active whenever task dependencies permit.

Initial parallel queue: Task 1 (protocol capture), Task 2A (multipart parser), and Task 2B (same-account stream service). Refill freed slots from this ready queue:

- Task 2C after 2A and 2B.
- Task 4 after Task 1.
- Task 3A at the first free frontend slot, then Task 3B.
- Tasks 5 and 6 after 3B/3A respectively.
- Tasks 7, 8, and 9 once their frontend dependencies are merged.
- Task 10 after Tasks 5 and 6.
- Task 11 after Tasks 7-10.
- Task 12 is split among backend, browser, and `/image` regression agents after Task 11.

Every numbered or lettered task produces its own Chinese Conventional Commit. Tasks 2 and 3 are deliberately split into lettered atomic commits. Do not squash. A later integration fix gets a separate `fix` commit.

## File Map

Backend:

- `scripts/probe_chat_file_attachment.py`: opt-in current-upstream protocol probe and sanitised fixture generator.
- `test/fixtures/chat_file_attachment/`: sanitised upstream request/response fixtures.
- `services/chat_attachments.py`: attachment dataclasses, validation, upload cache, and concrete upstream adapter.
- `services/chat_types.py`: stable multipart command and attachment dataclasses.
- `api/chat_inputs.py`: ordered multipart parsing, hashing, and limits.
- `services/chat_stream_service.py`: account retry, attachment resolution, stream lifecycle, and cancellation.
- `api/chat.py`: authenticated multipart `/api/chat/stream` endpoint.
- `api/app.py`: router registration and base-path registration.
- `test/test_chat_attachment_probe.py`: fixture contract checks.
- `test/test_chat_attachments.py`: uploader, cache, and message conversion tests.
- `test/test_chat_inputs.py`: multipart manifest and limit tests.
- `test/test_chat_stream_service.py`: account and stream-lifecycle tests.
- `test/test_chat_stream_api.py`: authenticated SSE API tests.

Frontend foundation:

- `web/vitest.config.ts`: Vitest aliases and jsdom configuration.
- `web/src/test/setup.ts`: jest-dom and browser API test setup.
- `web/src/app/chat/lib/chat-types.ts`: stable conversation/message/attachment/image types.
- `web/src/app/chat/lib/chat-models.ts`: text/image model classification.
- `web/src/app/chat/lib/chat-attachments.ts`: accepted formats, limits, hashing, and manifest generation.
- `web/src/app/chat/lib/chat-stream.ts`: multipart request and SSE state-safe parser.
- `web/src/store/chat-conversations.ts`: subject-scoped conversations and attachment Blob persistence.

Frontend UI and orchestration:

- `web/src/app/image/components/image-settings.ts`: shared image settings constants and normalisation.
- `web/src/app/image/components/image-settings-panel.tsx`: shared settings panel/sheet body.
- `web/src/app/image/components/image-composer.tsx`: reuse shared settings instead of local duplicated definitions.
- `web/src/app/chat/components/*.tsx`: shell, sidebar, header, thread, messages, composer, attachment picker, model selector.
- `web/src/app/chat/hooks/use-chat-controller.ts`: text-chat state machine, edit/retry/stop semantics.
- `web/src/app/chat/hooks/use-chat-image-tasks.ts`: image task submission, polling, recovery, and URL-only results.
- `web/src/app/chat/page.tsx`: authenticated page composition.
- `web/src/components/app-shell.tsx`: route-aware global shell.
- `web/src/app/layout.tsx`: render `AppShell`.
- `web/src/components/top-nav.tsx`: add ordinary-user Chat entry outside `/chat`.
- `web/src/store/auth.ts`: ordinary-user default route `/chat`.

---

### Task 1: Capture and Lock the Native Document Attachment Protocol

**Files:**
- Create: `scripts/probe_chat_file_attachment.py`
- Create: `test/fixtures/chat_file_attachment/pdf-upload.json`
- Create: `test/test_chat_attachment_probe.py`

- [ ] **Step 1: Write the failing fixture contract test**

```python
def test_pdf_fixture_contains_complete_native_attachment_contract() -> None:
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    assert fixture["create_file"]["request"]["file_name"] == "sample.pdf"
    assert fixture["create_file"]["response"]["file_id"].startswith("file-")
    assert fixture["uploaded_confirmation"]["status_code"] in {200, 201}
    part = fixture["conversation"]["content_part"]
    assert part["content_type"] != "image_asset_pointer"
    assert fixture["conversation"]["metadata_attachment"]["mime_type"] == "application/pdf"
```

- [ ] **Step 2: Run the test and verify RED**

Run: `uv run pytest -q test/test_chat_attachment_probe.py`

Expected: FAIL because the fixture does not exist.

- [ ] **Step 3: Implement the opt-in probe**

The script must:

```python
def main() -> int:
    token = account_service.get_text_access_token()
    pdf_path = Path(os.environ.get("CHAT_ATTACHMENT_PROBE_PDF", "")).expanduser()
    if not token or not pdf_path.is_file():
        raise SystemExit("set CHAT_ATTACHMENT_PROBE_PDF and configure a text account")
    # Capture current create-file, blob PUT, uploaded confirmation,
    # and conversation attachment payloads. Redact tokens, signed URLs,
    # account identifiers, file IDs, and conversation IDs before writing.
    return 0
```

Write only the sanitised fixture under `test/fixtures/chat_file_attachment/`; raw capture stays under `/tmp` and is not committed.

- [ ] **Step 4: Run the real probe and inspect the fixture**

Run: `CHAT_ATTACHMENT_PROBE_PDF=/tmp/chatgpt2api-sample.pdf uv run python scripts/probe_chat_file_attachment.py`

Expected: fixture contains create/upload/confirm/conversation shapes with all secrets replaced by stable placeholders.

- [ ] **Step 5: Run the fixture test and verify GREEN**

Run: `uv run pytest -q test/test_chat_attachment_probe.py`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/probe_chat_file_attachment.py test/fixtures/chat_file_attachment/pdf-upload.json test/test_chat_attachment_probe.py
git commit -m "test: 固化聊天文档附件上游协议"
```

---

### Task 2A: Parse and Validate Web Chat Multipart Input

**Files:**
- Create: `services/chat_types.py`
- Create: `api/chat_inputs.py`
- Create: `test/test_chat_inputs.py`

- [ ] **Step 1: Write failing parser tests**

Add exact tests for ordered manifest/file matching, duplicate IDs, unknown references, extension/MIME pairs, 10 images, 5 documents, 10/25 MB per-file limits, 50 MB per-message total, 100 MB request working set, and `UploadFile.close()` on both success and failure.

- [ ] **Step 2: Run and verify RED**

Run: `uv run pytest -q test/test_chat_inputs.py`

Expected: FAIL because `parse_chat_stream_request` does not exist.

- [ ] **Step 3: Implement stable command types**

```python
@dataclass(frozen=True, slots=True)
class ChatAttachmentBlob:
    id: str
    file_name: str
    mime_type: str
    size: int
    sha256: str
    kind: Literal["image", "document"]
    data: bytes

@dataclass(frozen=True, slots=True)
class ChatStreamCommand:
    model: str
    messages: tuple[ChatMessage, ...]
    attachments: tuple[ChatAttachmentBlob, ...]
    thinking_effort: str
```

- [ ] **Step 4: Implement `parse_chat_stream_request`**

Use `await request.form()`, read repeated `files` in order, compute SHA-256 while reading, compare every manifest field, and close every upload in `finally`.

- [ ] **Step 5: Run tests and commit**

Run: `uv run pytest -q test/test_chat_inputs.py`

```bash
git add services/chat_types.py api/chat_inputs.py test/test_chat_inputs.py
git commit -m "feat: 校验聊天 multipart 附件请求"
```

---

### Task 2B: Orchestrate Same-Account Attachment Chat Streaming

**Files:**
- Create: `services/chat_stream_service.py`
- Create: `test/test_chat_stream_service.py`

- [ ] **Step 1: Write failing orchestration tests**

Test one backend instance uploads and streams, duplicate references upload once, invalid token before first delta selects another account and reuploads, failure after first delta never replays, and success/error/cancel all close the backend.

- [ ] **Step 2: Run and verify RED**

Run: `uv run pytest -q test/test_chat_stream_service.py`

Expected: FAIL because `ChatStreamSession` does not exist.

- [ ] **Step 3: Implement the injectable session**

```python
class AttachmentUploaderProtocol(Protocol):
    def resolve(self, backend, attachments):
        pass

class ChatStreamSession:
    def __iter__(self) -> Iterator[dict[str, Any]]:
        return self.iter_chunks()

    def cancel(self) -> None:
        self.close()
```

Use `account_service.get_text_access_token`, existing invalid-token refresh/removal helpers, `mark_text_used`, and an injected backend factory. Only retry before the first emitted delta.

- [ ] **Step 4: Run tests and commit**

Run: `uv run pytest -q test/test_chat_stream_service.py`

```bash
git add services/chat_stream_service.py test/test_chat_stream_service.py
git commit -m "feat: 编排同账号附件聊天流"
```

---

### Task 2C: Expose a Cancellation-Safe SSE API

**Files:**
- Create: `api/chat.py`
- Modify: `api/app.py`
- Modify: `services/openai_backend_api.py`
- Create: `test/test_chat_stream_api.py`

- [ ] **Step 1: Write failing API/cancellation tests**

Test authentication, normal chunks plus `[DONE]`, stream errors plus `[DONE]`, disconnect cancellation, active response closure, and secret-safe logging.

- [ ] **Step 2: Run and verify RED**

Run: `uv run pytest -q test/test_chat_stream_api.py`

Expected: FAIL because the router and active-response cancellation do not exist.

- [ ] **Step 3: Implement the async bridge and router**

Authenticate and parse multipart before returning `StreamingResponse`. Use `anyio.to_thread.run_sync` to pull the synchronous session iterator. In `CancelledError`, disconnect, and `finally`, call `session.cancel()` and `session.close()`.

- [ ] **Step 4: Make upstream response closure explicit**

Track the current streaming response in `OpenAIBackendAPI`; `close()` closes it before the requests session, and `stream_conversation()` clears it in `finally`.

- [ ] **Step 5: Register router, run tests, and commit**

Run: `uv run pytest -q test/test_chat_stream_api.py test/test_web_base_path.py`

```bash
git add api/chat.py api/app.py services/openai_backend_api.py test/test_chat_stream_api.py
git commit -m "feat: 提供可取消的普通用户聊天 SSE 接口"
```

---

### Task 3A: Establish the Frontend Test Baseline

**Files:**
- Modify: `web/package.json`
- Modify: `web/bun.lock`
- Create: `web/vitest.config.ts`
- Create: `web/src/test/setup.ts`
- Create: `web/src/lib/paths.test.ts`

- [ ] **Step 1: Add test dependencies and scripts**

Run from `web`: `bun add -d vitest jsdom @vitejs/plugin-react @testing-library/react @testing-library/jest-dom @testing-library/user-event fake-indexeddb`.

Add `"test": "vitest run"` and `"test:watch": "vitest"`.

- [ ] **Step 2: Configure jsdom and test setup**

Use the React plugin, `@` alias to `web/src`, `setupFiles: ["./src/test/setup.ts"]`, `@testing-library/jest-dom/vitest`, `fake-indexeddb/auto`, and RTL cleanup.

- [ ] **Step 3: Write and run the baseline path tests**

Test that base paths are applied once and absolute API URLs are preserved.

Run: `cd web && bun run test -- src/lib/paths.test.ts`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add web/package.json web/bun.lock web/vitest.config.ts web/src/test/setup.ts web/src/lib/paths.test.ts
git commit -m "test(web): 建立 Vitest 与组件测试基线"
```

---

### Task 3B: Implement the Frontend Chat Protocol Layer

**Files:**
- Create: `web/src/app/chat/lib/chat-types.ts`
- Create: `web/src/app/chat/lib/chat-models.ts`
- Create: `web/src/app/chat/lib/chat-models.test.ts`
- Create: `web/src/app/chat/lib/chat-attachments.ts`
- Create: `web/src/app/chat/lib/chat-attachments.test.ts`
- Create: `web/src/app/chat/lib/chat-stream.ts`
- Create: `web/src/app/chat/lib/chat-stream.test.ts`

- [ ] **Step 1: Write failing protocol tests**

Cover split SSE frames, multiple frames, CRLF/comments, error terminal precedence, multipart order/auth/abort, chat model filtering, disappeared stored models, every allowed MIME/extension pair, 10 images, 5 documents, 10/25 MB file limits, 50/100 MB totals, hash dedupe, and image-mode document rejection.

- [ ] **Step 2: Run and verify RED**

Run: `cd web && bun run test -- src/app/chat/lib`

Expected: FAIL because chat protocol modules do not exist.

- [ ] **Step 3: Implement the stable network contract**

Use `messages[].attachment_ids` and `attachments[]` entries with `id`, `file_name`, `mime_type`, `size`, and `sha256`. Define `ChatConversation`, `ChatMessage`, `PreparedChatAttachment`, `ChatMessageStatus`, `ChatImageSettingsSnapshot`, and terminal `ChatStreamEvent` variants.

- [ ] **Step 4: Implement model and attachment helpers**

Expose `isImageModelId`, `filterChatModels`, `resolveChatModelSelection`, `prepareChatAttachment`, `validateChatAttachments`, and `uniqueAttachmentBytes`.

- [ ] **Step 5: Implement the SSE client**

Use `getStoredAuthKey`, `withApiBasePath("/api/chat/stream")`, native `fetch`, ordered FormData, `AbortSignal`, incremental decoding, and terminal-state precedence.

- [ ] **Step 6: Run tests/build and commit**

Run: `cd web && bun run test -- src/app/chat/lib`

Run: `cd web && bun run build`

```bash
git add web/src/app/chat/lib
git commit -m "feat(web): 实现聊天流协议与附件校验"
```

---

### Task 4: Implement the Concrete Native Attachment Adapter

**Files:**
- Create: `services/chat_attachments.py`
- Modify: `services/openai_backend_api.py`
- Create: `test/test_chat_attachments.py`

- [ ] **Step 1: Write failing uploader/cache/message tests**

```python
def test_document_attachment_never_uses_image_pointer() -> None:
    uploaded = uploader_with_fixture("pdf-upload.json").upload(
        backend=fake_backend(),
        data=b"%PDF-1.7",
        file_name="sample.pdf",
        mime_type="application/pdf",
    )
    assert uploaded.content_part["content_type"] != "image_asset_pointer"
    assert uploaded.metadata_attachment["mime_type"] == "application/pdf"

def test_cache_is_scoped_by_account_fingerprint_and_sha256() -> None:
    cache = ChatAttachmentCache(ttl_seconds=60, max_entries=8)
    cache.put("account-a", "sha", resolved_attachment("file-a"))
    assert cache.get("account-a", "sha") is not None
    assert cache.get("account-b", "sha") is None

def test_logs_never_include_signed_url_or_raw_file_id(caplog) -> None:
    uploader_with_fixture("pdf-upload.json").upload(
        backend=fake_backend(), data=b"%PDF", file_name="sample.pdf", mime_type="application/pdf"
    )
    assert "sig=" not in caplog.text
    assert "file-secret" not in caplog.text
```

Add equally explicit tests for the captured create/upload/confirm request contract, image width/height preservation, and re-upload after an account-scoped cache miss.

- [ ] **Step 2: Run tests and verify RED**

Run: `uv run pytest -q test/test_chat_attachments.py`

Expected: FAIL because `services.chat_attachments` does not exist.

- [ ] **Step 3: Implement stable attachment dataclasses**

```python
@dataclass(frozen=True)
class UploadedChatAttachment:
    file_id: str
    file_name: str
    mime_type: str
    file_size: int
    asset_pointer: str
    content_part: dict[str, Any]
    metadata_attachment: dict[str, Any]
```

Implement a bounded TTL cache keyed by `(account_fingerprint, sha256)`; cache upstream metadata only, never raw bytes.

- [ ] **Step 4: Implement generic upstream upload methods**

Extract blob creation/PUT/confirmation from `_upload_image` into a generic byte uploader. Preserve `_upload_image` behaviour by delegating to the generic method, then implement document-specific parts from Task 1's fixture.

- [ ] **Step 5: Implement the concrete adapter**

The adapter validates manifest hashes, uploads with the selected backend, returns resolved content parts/metadata, and never exposes raw upstream IDs to the API response.

- [ ] **Step 6: Run focused and image regression tests**

Run: `uv run pytest -q test/test_chat_attachments.py test/test_chat_completion_cache.py test/test_v1_images_edits_api.py`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add services/chat_attachments.py services/openai_backend_api.py test/test_chat_attachments.py
git commit -m "feat: 支持聊天原生文档附件上传"
```

---

### Task 5: Add Subject-Scoped Conversation and Blob Persistence

**Files:**
- Create: `web/src/store/chat-conversations.ts`
- Create: `web/src/store/chat-conversations.test.ts`

- [ ] **Step 1: Write failing persistence tests**

Cover subject isolation, latest-write ordering, SHA-256 dedupe, reference cleanup, 100 MB working-set calculation, quota failure, and URL-only image normalisation.

```ts
it("drops b64_json while preserving image URL and task id", async () => {
  await saveChatConversation("user-a", conversationWithImage({ taskId: "task-1", url: "/images/a.png", b64_json: "large" }))
  const [stored] = await listChatConversations("user-a")
  expect(stored.messages[0].images?.[0]).toEqual({ taskId: "task-1", url: "/images/a.png" })
})

it("never returns another subject's conversations", async () => {
  await saveChatConversation("user-a", conversation("a"))
  await saveChatConversation("user-b", conversation("b"))
  expect((await listChatConversations("user-a")).map((item) => item.id)).toEqual(["a"])
})

it("removes an attachment blob after its final conversation reference", async () => {
  await saveChatAttachment("user-a", attachment("file-1"))
  await saveChatConversation("user-a", conversationReferencing("chat-1", "file-1"))
  await deleteChatConversation("user-a", "chat-1")
  expect(await loadChatAttachment("user-a", "file-1")).toBeNull()
})
```

- [ ] **Step 2: Run and verify RED**

Run: `cd web && bun run test -- src/store/chat-conversations.test.ts`

Expected: FAIL because the store does not exist.

- [ ] **Step 3: Implement separate localforage stores**

Use `chat_conversations` and `chat_attachments`; every key begins with `${subjectId}:`. Store attachment metadata and Blob separately. Queue writes as the image store does.

- [ ] **Step 4: Implement lifecycle operations**

Expose `listChatConversations`, `saveChatConversation`, `renameChatConversation`, `deleteChatConversation`, `clearChatConversations`, `saveChatAttachment`, `loadChatAttachment`, `releaseUnreferencedAttachments`, and `getConversationAttachmentBytes`.

- [ ] **Step 5: Run tests and verify GREEN**

Run: `cd web && bun run test -- src/store/chat-conversations.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/store/chat-conversations.ts web/src/store/chat-conversations.test.ts
git commit -m "feat(web): 按用户持久化聊天会话与附件"
```

---

### Task 6: Extract and Reuse Image Generation Settings

**Files:**
- Create: `web/src/app/image/components/image-settings.ts`
- Create: `web/src/app/image/components/image-settings-panel.tsx`
- Create: `web/src/app/image/components/image-settings.test.ts`
- Modify: `web/src/app/image/components/image-composer.tsx`

- [ ] **Step 1: Write failing settings tests**

Test quality labels, every current aspect preset, custom dimensions, count `1-100`, summary labels, stored-value normalisation, and Codex-only 2k/4k disabling.

- [ ] **Step 2: Run and verify RED**

Run: `cd web && bun run test -- src/app/image/components/image-settings.test.ts`

Expected: FAIL because the shared module does not exist.

- [ ] **Step 3: Move constants and pure logic**

Export `qualityOptions`, `aspectOptions`, `countOptions`, `normalizeImageSettings`, `imageSettingsSummary`, and `isImagePresetDisabled` without changing values or labels.

- [ ] **Step 4: Extract the reusable panel**

`ImageSettingsPanel` receives controlled values/callbacks and a `presentation: "popover" | "sheet"` prop. Keep lucide icons and existing shadcn controls.

- [ ] **Step 5: Refactor `ImageComposer` to use the shared modules**

Do not change the existing `/image` storage keys, default values, drag/paste behaviour, or task submission.

- [ ] **Step 6: Run tests and production build**

Run: `cd web && bun run test -- src/app/image/components/image-settings.test.ts`

Run: `cd web && bun run build`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add web/src/app/image/components/image-settings.ts web/src/app/image/components/image-settings-panel.tsx web/src/app/image/components/image-settings.test.ts web/src/app/image/components/image-composer.tsx
git commit -m "refactor(web): 共享聊天与画图参数组件"
```

---

### Task 7: Build the Chat Presentational Components

**Files:**
- Create: `web/src/app/chat/components/chat-sidebar.tsx`
- Create: `web/src/app/chat/components/chat-header.tsx`
- Create: `web/src/app/chat/components/chat-thread.tsx`
- Create: `web/src/app/chat/components/chat-message.tsx`
- Create: `web/src/app/chat/components/chat-composer.tsx`
- Create: `web/src/app/chat/components/chat-attachment-picker.tsx`
- Create: `web/src/app/chat/components/chat-model-select.tsx`
- Create: `web/src/app/chat/components/chat-shell.tsx`
- Test: `web/src/app/chat/components/*.test.tsx`

- [ ] **Step 1: Write failing component interaction tests**

Test desktop sidebar selection, mobile drawer, model selection, attachment removal, document/image conflict, Markdown/code copy, edit/retry actions, stop button, and image settings popover/sheet.

- [ ] **Step 2: Run and verify RED**

Run: `cd web && bun run test -- src/app/chat/components`

Expected: FAIL because the components do not exist.

- [ ] **Step 3: Implement focused controlled components**

No component owns API calls or localforage. Use lucide icons with tooltips, `react-markdown`, `remark-gfm`, existing shadcn primitives, stable responsive dimensions, and no nested card layout.

- [ ] **Step 4: Implement classic ChatGPT responsive shell**

Desktop: fixed 248px sidebar, max 760px thread, max 780px composer. Mobile: sidebar in `Sheet`, header menu/model/new-chat controls, composer above safe-area inset.

- [ ] **Step 5: Run tests and build**

Run: `cd web && bun run test -- src/app/chat/components`

Run: `cd web && bun run build`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/app/chat/components
git commit -m "feat(web): 构建 ChatGPT 式聊天界面组件"
```

---

### Task 8: Implement the Text Chat Controller and Message State Machine

**Files:**
- Create: `web/src/app/chat/hooks/use-chat-controller.ts`
- Create: `web/src/app/chat/hooks/use-chat-controller.test.tsx`

- [ ] **Step 1: Write failing state-machine tests**

Cover optimistic user messages, streaming accumulation, error/DONE precedence, stop terminal state, retry without duplicate user messages, edit-and-truncate, title generation, scroll-position updates, and storage quota warnings.

- [ ] **Step 2: Run and verify RED**

Run: `cd web && bun run test -- src/app/chat/hooks/use-chat-controller.test.tsx`

Expected: FAIL because the hook does not exist.

- [ ] **Step 3: Implement reducer and commands**

Expose `createConversation`, `selectConversation`, `renameConversation`, `deleteConversation`, `sendText`, `stop`, `retryAssistant`, `editAndResend`, and `clearHistory`. Keep `error`, `stopped`, and `complete` terminal.

- [ ] **Step 4: Connect protocol and persistence through injected dependencies**

The hook receives `streamChatFn` and storage functions by default imports but allows test injection. Persist after terminal transitions and debounced stream checkpoints; never persist `b64_json`.

- [ ] **Step 5: Run and verify GREEN**

Run: `cd web && bun run test -- src/app/chat/hooks/use-chat-controller.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/app/chat/hooks/use-chat-controller.ts web/src/app/chat/hooks/use-chat-controller.test.tsx
git commit -m "feat(web): 实现流式聊天消息状态机"
```

---

### Task 9: Add the Route-Aware App Shell and Ordinary-User Entry

**Files:**
- Create: `web/src/components/app-shell.tsx`
- Create: `web/src/components/app-shell.test.tsx`
- Modify: `web/src/app/layout.tsx`
- Modify: `web/src/components/top-nav.tsx`
- Modify: `web/src/store/auth.ts`
- Create: `web/src/store/auth.test.ts`

- [ ] **Step 1: Write failing route/auth tests**

```ts
expect(getDefaultRouteForRole("user")).toBe("/chat")
expect(getDefaultRouteForRole("admin")).toBe("/accounts")
```

Test that `AppShell` hides `TopNav` and uses full-height styling on `/chat`, while `/image` and admin pages preserve the current shell. Test ordinary-user nav contains both Chat and Draw links.

- [ ] **Step 2: Run and verify RED**

Run: `cd web && bun run test -- src/components/app-shell.test.tsx src/store/auth.test.ts`

Expected: FAIL with current `/image` default and missing shell.

- [ ] **Step 3: Implement `AppShell` and update layout**

Move the current main/container classes into the non-chat branch. The chat branch renders children in a full-height neutral work surface without global `TopNav`.

- [ ] **Step 4: Update routing and navigation**

Change only ordinary-user default route. Add `/chat` to user nav and retain `/image`. Keep admin nav and base-path behaviour.

- [ ] **Step 5: Run tests, build, and base-path regression**

Run: `cd web && bun run test -- src/components/app-shell.test.tsx src/store/auth.test.ts`

Run: `cd web && bun run build`

Run: `uv run pytest -q test/test_web_base_path.py`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/app-shell.tsx web/src/components/app-shell.test.tsx web/src/app/layout.tsx web/src/components/top-nav.tsx web/src/store/auth.ts web/src/store/auth.test.ts
git commit -m "feat(web): 将普通用户默认入口切换到聊天页"
```

---

### Task 10: Integrate Existing Image Tasks into Chat

**Files:**
- Create: `web/src/app/chat/hooks/use-chat-image-tasks.ts`
- Create: `web/src/app/chat/hooks/use-chat-image-tasks.test.tsx`
- Create: `web/src/app/chat/lib/chat-images.ts`
- Create: `web/src/app/chat/lib/chat-images.test.ts`

- [ ] **Step 1: Write failing image workflow tests**

Cover generate vs edit selection, full settings snapshot, counts up to 100, task polling/recovery, retry, URL-only persistence, dropping `b64_json`, and “use as reference” URL-to-Blob conversion.

- [ ] **Step 2: Run and verify RED**

Run: `cd web && bun run test -- src/app/chat/hooks/use-chat-image-tasks.test.tsx src/app/chat/lib/chat-images.test.ts`

Expected: FAIL because modules do not exist.

- [ ] **Step 3: Implement URL-only normalisation**

```ts
export function taskImageToChatImage(task: ImageTask): ChatGeneratedImage[] {
  return (task.data ?? []).flatMap((item) => item.url ? [{ url: item.url, revisedPrompt: item.revised_prompt }] : [])
}
```

- [ ] **Step 4: Implement submit/poll/recover hook**

Reuse `createImageGenerationTask`, `createImageEditTask`, `fetchImageTasks`, and `resumeImagePoll`. Create one task per requested image as the existing page does. Save every turn's model, quality, dimensions, ratio, tier, count, and reference attachment IDs.

- [ ] **Step 5: Run tests and verify GREEN**

Run: `cd web && bun run test -- src/app/chat/hooks/use-chat-image-tasks.test.tsx src/app/chat/lib/chat-images.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/app/chat/hooks/use-chat-image-tasks.ts web/src/app/chat/hooks/use-chat-image-tasks.test.tsx web/src/app/chat/lib/chat-images.ts web/src/app/chat/lib/chat-images.test.ts
git commit -m "feat(web): 在聊天中复用现有生图任务"
```

---

### Task 11: Compose the Authenticated `/chat` Page

**Files:**
- Create: `web/src/app/chat/page.tsx`
- Create: `web/src/app/chat/page.test.tsx`

- [ ] **Step 1: Write failing page workflow tests**

Test auth loading, model fetch, subject-scoped history load, empty conversation, text send, image-mode send, attachment display, refresh recovery, and role-aware sidebar links.

- [ ] **Step 2: Run and verify RED**

Run: `cd web && bun run test -- src/app/chat/page.test.tsx`

Expected: FAIL because the page does not exist.

- [ ] **Step 3: Compose the page**

Use `useAuthGuard()`, `fetchModels`, `useChatController`, `useChatImageTasks`, and the controlled components. Store the last chat model and image settings by `subjectId`. Keep page code as composition glue.

- [ ] **Step 4: Implement lifecycle recovery**

On load, restore the active conversation, scroll position, attachment object URLs, and unfinished image task IDs. Revoke object URLs on removal/unmount.

- [ ] **Step 5: Run page tests and build**

Run: `cd web && bun run test -- src/app/chat/page.test.tsx`

Run: `cd web && bun run build`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/app/chat/page.tsx web/src/app/chat/page.test.tsx
git commit -m "feat(web): 上线普通用户统一聊天工作台"
```

---

### Task 12: Integrate, Validate, Document, and Fix Regressions

**Files:**
- Modify as required by real integration failures only.
- Modify: `README.md`
- Modify: `docs/feature-status.en.md`
- Create: `test/test_web_chat_live.py`

- [ ] **Step 1: Wire the concrete uploader into the web chat service**

Replace the Task 2 default stub with Task 4's concrete `ChatAttachmentUploader`. Add one integration test proving the same fake backend instance uploads and streams.

- [ ] **Step 2: Run the focused backend matrix**

Run: `uv run pytest -q test/test_chat_attachment_probe.py test/test_chat_attachments.py test/test_web_chat_service.py test/test_web_chat_api.py test/test_chat_completion_cache.py test/test_image_tasks_api.py test/test_web_base_path.py`

Expected: PASS.

- [ ] **Step 3: Run the full frontend matrix**

Run: `cd web && bun run test`

Run: `cd web && bun run build`

Expected: PASS without uncaught warnings or type/build errors introduced by this feature.

- [ ] **Step 4: Run full backend tests**

Run: `uv run pytest -q test --ignore=test/test_v1_chat_completions.py`

Expected: PASS for the offline suite. Existing manual/live HTTP scripts remain opt-in.

- [ ] **Step 5: Run live attachment smoke tests**

Create opt-in `test/test_web_chat_live.py` guarded by `RUN_LIVE_CHAT_ATTACHMENTS=1`. Validate a PDF follow-up, DOCX, XLSX/CSV, mixed image/document input, and exactly 10 images.

Run: `RUN_LIVE_CHAT_ATTACHMENTS=1 uv run pytest -q test/test_web_chat_live.py -s`

Expected: PASS. If no real account exists, do not claim document support complete.

- [ ] **Step 6: Run browser QA**

Start backend and frontend, then verify `/chatgpt2api/chat/` at desktop and mobile sizes: ordinary-user redirect, sidebar/drawer, model selection, streaming/stop/error, edit/retry, local history isolation, attachments, image settings, image result recovery, and `/image` regression. Capture screenshots and inspect them with `view_image`.

- [ ] **Step 7: Update documentation**

Document the `/chat` user flow, supported attachment formats/limits, local-only history, image parameter reuse, and live-test command. Do not expose upstream implementation secrets.

- [ ] **Step 8: Commit integration/docs**

```bash
git add api services web test README.md docs/feature-status.en.md
git commit -m "feat: 完成普通用户聊天工作台集成"
```

If QA requires fixes after this commit, create separate scoped `fix` commits; never amend or squash task commits.

---

## Final Gates

1. `git log --oneline` shows one commit per task plus any explicit fixes.
2. `git status --short` is clean.
3. Offline backend tests pass.
4. Frontend Vitest suite and production build pass.
5. Live PDF attachment smoke passes before document support is reported complete.
6. Browser screenshots verify desktop/mobile layout and the existing `/image` workflow.
