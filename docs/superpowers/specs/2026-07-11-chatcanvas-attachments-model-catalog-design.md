# ChatCanvas 附件与模型目录设计

日期：2026-07-11

## 目标

在不改变现有仓库、镜像、`/v1` 兼容接口名称或部署路径的前提下，将 README 以 **ChatCanvas** 作为衍生产品名称展示，并完成两项普通用户聊天能力：

1. PDF、DOCX、XLSX、PPTX、TXT、MD、CSV 与图片随普通聊天消息上传，由同一原生 ChatGPT 上游账号读取。
2. 聊天页可以手动重新获取上游发现的最新模型目录，并在失败时保留最近一次可用目录。

README 必须在标题下和文末明确说明 ChatCanvas 是基于 [ChatGPT2API](https://github.com/basketikun/chatgpt2api) 的衍生工程，保留原 LICENSE，且不暗示与上游项目或 OpenAI 存在官方关联。

## 附件上传架构

浏览器继续以 multipart 发送经过 SHA-256 校验的附件 manifest 和文件 Blob。现有前后端限制不放宽：每条消息最多 10 张图片或 5 份文档；图片最大 10 MiB，文档最大 25 MiB，消息附件合计最大 50 MiB，请求唯一附件工作集最大 100 MiB。

后端新增 `ChatAttachmentUploader`，作为 `ChatStreamSession` 的默认 `AttachmentUploaderProtocol` 实现。它必须使用最终发起对话的同一个 `OpenAIBackendAPI` 实例，并执行：

1. `POST /backend-api/files` 创建上游文件。
2. 对签名 `upload_url` 发送原始字节 `PUT`。
3. `POST /backend-api/files/{file_id}/uploaded` 确认上传。
4. 对文档等待 `/backend-api/files/process_upload_stream` 的成功事件；图片不等待文档检索处理。
5. 返回仅供服务端使用的上游附件描述符。

描述符包含文件名、MIME、大小、上游文件 ID、文档 metadata 和可选图片 asset pointer。 `OpenAIBackendAPI._api_messages_to_conversation_messages()` 必须消费这些描述符：文档只进入 `metadata.attachments`，图片同时进入 `multimodal_text` 的 `image_asset_pointer` 和 metadata。签名 URL、裸 token、裸 file ID 不得写入浏览器 IndexedDB、SSE、应用日志或 README。

确认的鉴权失效应转换为既有 `InvalidAccessTokenError`，从而仅在第一个输出 token 前重选账号并对新账号重新上传。其他上传、检索或协议错误不得盲目切换账号。

## 前端附件交互

普通聊天解除当前的附件阻断。提交、编辑重发、助手重试和历史回放均保留普通文本消息的附件 ID，并通过既有 `streamChat()` multipart 传输附件。图片生成模式仍只接受图片参考输入，文档与图片生成模式保持互斥。

成功发送后，附件 Blob 按当前 `subjectId` 的 IndexedDB 存储与会话引用关系持久化；删除会话或清空历史时保留现有未引用附件清理策略。用户切换、慢存储和流式重试都不得让另一个 `subjectId` 的附件回写到当前会话。

## 最新模型目录

`GET /v1/models` 继续返回 OpenAI 格式模型列表。服务端为该响应设置 `Cache-Control: no-store`，并接受 `refresh=1` 作为显式刷新意图；每次刷新请求都重新调用当前的上游发现逻辑。前端在首次加载和用户点击刷新图标时调用该接口。

成功刷新时，聊天和图片模型菜单原子替换，当前选择仍沿用已有“模型消失则回退 `auto` 并提示”的逻辑。刷新失败时，保留最近一次成功目录；首次加载失败时仅保留 `auto` 并提供刷新操作。

目录文案必须称为“上游发现的模型目录”。它不承诺每个模型对当前调度账号、额度或订阅都可用；本期不做逐账号能力交集或修改文本调度策略。

## README 与来源说明

README 改为 ChatCanvas 的用户入口文档：产品标题、最新能力、快速开始、核心能力、普通用户聊天、来源与许可证。现有兼容接口、账号池、部署和高级画图能力仍保留准确说明。原项目贡献者和 Star History 不再以 ChatCanvas 名义展示；README 改为明确的上游来源链接。

附件功能只在 mock 协议测试、完整离线回归和显式 opt-in 原生 PDF/Office 冒烟均通过后标记为“已可用”。没有可用原生账号时，README 只能说明为依赖上游账号的可选验证，不得把通用 Chat Completions 提供商误描述为文件上传支持。

## 验收

- 后端单测覆盖图片、PDF、混合输入的 create/PUT/confirm/process 协议顺序、上游消息结构、鉴权重传和无密钥日志。
- 前端单测覆盖附件发送、编辑重发、重试、历史恢复、用户隔离、10 图/5 文档和模型刷新成功/失败。
- 默认后端、前端测试与生产构建通过。
- 显式 `RUN_LIVE_CHAT_ATTACHMENTS=1` 且存在原生账号和夹具时，PDF、DOCX、XLSX/CSV、混合附件和 10 图边界通过；否则该套件明确跳过，不能伪造通过。
- README 以 ChatCanvas 展示且在顶部、文末均可见 ChatGPT2API 来源与许可证说明。
