# 功能状态

本文记录 ChatCanvas 当前仓库的能力边界。ChatCanvas 是基于 [ChatGPT2API](https://github.com/basketikun/chatgpt2api) 的衍生工程；产品名称不改变既有 `/v1` 兼容接口、`/chatgpt2api` 默认部署路径或许可证。

> [!IMPORTANT]
> 本版本重点新增普通用户聊天、原生文件附件与模型目录刷新。附件上传协议已实现，但当前开发环境没有可用原生 ChatGPT 上游账号和真实夹具完成外部 PDF/Office 验收；“实现完成”不等同于当前环境已经证明上游读取成功。

## ChatCanvas 最新能力

| 功能 | 状态 | 说明 |
|:--|:--:|:--|
| 普通用户聊天入口 `/chat` | ✅ | 普通用户登录后默认进入 `basePath` 下的 `/chat`；默认地址为 `/chatgpt2api/chat/`。 |
| ChatGPT 式文本聊天交互 | ✅ | 支持多轮消息流、流式输出、停止、模型选择、助手回复重试和用户消息编辑后重发。 |
| 上游模型目录与手动刷新 | ✅ | `GET /v1/models` 从上游发现模型目录，响应使用 `Cache-Control: no-store`；`?refresh=1` 表达主动刷新。聊天页刷新失败会保留最近一次成功目录，首次失败保留 `auto`。目录不承诺所有账号均可调用其中每个模型。 |
| 普通用户聊天本地隔离 | ✅ | 会话、模型偏好、图片设置、滚动位置、附件 Blob 缓存与图片任务仅保存在当前浏览器，并按 `subject_id` 分区；支持删除单个会话和清空当前用户本地历史，不作为服务端聊天历史同步。 |
| 原生聊天附件上传管线 | ✅ | `/api/chat/stream` 接收带 SHA-256 manifest 的 multipart 附件；服务端执行原生 ChatGPT 创建文件、签名上传、确认上传和文档处理，再以同一上游会话发起聊天。签名 URL、上游 token 和 file ID 不进入浏览器持久化、SSE 或文档。 |
| 聊天附件类型 | ✅ | 图片：PNG、JPEG/JPG、WebP、GIF。文档：PDF、DOCX、XLSX、PPTX、TXT、MD、CSV。 |
| 聊天附件限制 | ✅ | 单条消息最多 10 张图片和 5 份文档；图片最大 10 MiB，文档最大 25 MiB，消息附件总量最大 50 MiB，请求去重附件工作集最大 100 MiB。混合输入时各限制同时适用。 |
| 原生附件真实上游读取验收 | ⚠️ | 实际读取需要已配置的可用原生 ChatGPT 文本账号。当前环境未执行真实 PDF/Office 验收，不能把它写成已得到外部实测证明。`RUN_LIVE_CHAT_ATTACHMENTS=1` 的 opt-in live suite 会在 `attachment_unavailable` 或其他公开错误时失败；仅在缺少开关、夹具、凭证或可用账号时跳过。 |
| 聊天内图片生成 / 编辑 | ✅ | 复用图片模型、质量、尺寸/比例和任务恢复能力；聊天图片设置按 `subject_id` 独立保存。图片参考输入最多 10 张，生成数量为 1-100。图片模式不接受文档附件。 |
| 高级图片工作台 `/image` | ✅ | 支持图片生成、图片编辑、多图参考、模型选择、历史管理、懒加载、任务进度、超时续轮询、结果恢复和大图查看。 |

## 兼容 API 与图片能力

| 功能 | 状态 | 说明 |
|:--|:--:|:--|
| OpenAI 兼容 `POST /v1/images/generations` | ✅ | 支持图片生成，并可通过 `n` 返回多张结果。 |
| OpenAI 兼容 `POST /v1/images/edits` | ✅ | 支持 multipart 图片编辑及 JSON 图片 URL 输入。 |
| 面向图片工作流的 `POST /v1/chat/completions` | ✅ | 支持文本、搜索和图片相关请求，不是完整通用聊天代理。 |
| 面向图片工作流的 `POST /v1/responses` | ✅ | 支持文本、搜索与图片生成工具调用，不是完整通用 Responses API 代理。 |
| `GET /v1/models` | ✅ | 返回上游发现的当前目录，不维护静态模型名列表；账号订阅、额度和上游状态决定实际可调用性。 |
| 兼容接口多参考图 | ✅ | 已实现，兼容图片接口可传入多参考图。 |
| 同时生成多张图片 | ✅ | 已支持；兼容图片 API 当前 `n` 范围为 1-4，聊天图片交互范围为 1-100。 |
| 图片并行生成 | ✅ | 多张图片可使用独立线程和账号并行生成，可通过 `image_parallel_generation` 配置关闭。 |
| 图片生成进度追踪 | ✅ | 显示上传、预热、获取 token、生成中等步骤及耗时。 |
| 图片超时续轮询 | ✅ | 超时任务可继续等待，前端显示继续等待操作，后端提供 resume-poll。 |
| 图片二次确认与先 check 再 hit | ✅ | 可通过 `image_settle_enabled` 和 `image_check_before_hit_enabled` 配置。 |
| 服务端图片 URL 缓存 | ✅ | 已实现。 |
| Codex 画图接口逆向 | ✅ | 支持符合条件的 Plus / Team / Pro 订阅；模型标识以当前 `/v1/models` 目录为准。 |
| `/v1/complete` 文本补全与流式输出 | ✅ | 已实现。 |
| 文本补全缓存与重复请求合并 | ✅ | `/v1/chat/completions` 文本链路默认支持短缓存、流式回放、in-flight 合并和相邻重复消息清理，可通过 `chat_completion_cache` 配置调整。 |
| OpenAI 兼容图片尺寸参数 | ❌ | 待完善。 |
| Anthropic 协议支持 | ❌ | 待实现。 |

## 账号、存储与部署

| 功能 | 状态 | 说明 |
|:--|:--:|:--|
| 账号池管理 | ✅ | 支持列表、筛选、批量操作、导出、手动编辑、刷新和删除。 |
| 账号刷新与恢复时间同步 | ✅ | 支持异步进度追踪；限流账号可继续检查，密码重新登录后可自动恢复异常账号。 |
| 失效 Token 自动清理 | ✅ | 已支持。 |
| CPA 连接、文件浏览与导入 | ✅ | 支持远程文件浏览、筛选、勾选导入和进度跟踪。 |
| `sub2api` 连接与导入 | ✅ | 支持连接管理、账号浏览和 OpenAI OAuth `access_token` 批量导入。 |
| 全局代理与稳定代理运行时 | ✅ | 支持 HTTP / HTTPS / SOCKS5 / SOCKS5H，以及 WARP / FlareSolverr 运行时。 |
| Docker 自托管部署 | ✅ | 支持 Docker Compose。本仓库的 ChatCanvas 运行应使用 `docker-compose.local.yml` 本地构建；保留的 `docker-compose.yml` 会拉取上游镜像，不是 ChatCanvas 发布镜像。 |
| 存储后端 | ✅ | 支持 JSON、SQLite、PostgreSQL 与 Git 存储后端。 |
| 更高级的 Token 调度策略 | ⚠️ | 当前有基础轮询和限流刷新，更复杂的调度策略仍在完善。 |
| Render / Vercel 等部署说明 | ⚠️ | 当前以 Docker 为主，其他平台暂未重点维护。 |
| `rt_token` 刷新 | ❌ | 待实现。 |

## 验证原则

- 默认离线测试不访问真实上游，也不读取本地凭证。
- 真实兼容 API 验证需显式设置 `RUN_LIVE_COMPAT_API=1` 并以环境变量提供服务地址、授权、模型和夹具。
- 原生聊天附件验证需显式设置 `RUN_LIVE_CHAT_ATTACHMENTS=1`；未满足环境条件时跳过，真正执行后任何 `attachment_unavailable` 都是失败，不是 `xfail`。
- 不要把 API key、Bearer 授权、原生账号 token、签名上传 URL 或真实夹具路径提交进代码、配置模板或文档。
