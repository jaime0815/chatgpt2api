<h1 align="center">ChatCanvas</h1>

<p align="center">自托管的聊天、文件理解与图像创作工作台</p>

> **来源说明**：ChatCanvas 是基于 [ChatGPT2API](https://github.com/basketikun/chatgpt2api) 的衍生工程，在保留其兼容 API、账号池、部署与图像能力基础上，扩展普通用户聊天、原生文件附件和模型目录刷新体验。ChatCanvas 不是 ChatGPT2API 或 OpenAI 的官方产品、附属项目或合作服务。

## 最新版本

> [!IMPORTANT]
> **ChatCanvas 现已提供完整的普通用户聊天工作台**
>
> - 普通用户登录后默认进入 `/chat`，获得接近 ChatGPT 的多轮聊天、流式回复、停止生成、编辑重发与助手回复重试体验。
> - 聊天页支持模型选择和手动刷新上游发现的模型目录；刷新失败会保留最近一次成功目录，不把静态模型名当作可用性承诺。
> - 普通聊天支持原生附件管线：图片以及 PDF、DOCX、XLSX、PPTX、TXT、MD、CSV 可随消息上传到同一原生 ChatGPT 上游会话。
> - 聊天内可切换图片生成或编辑模式，支持最多 **10 张**参考图、**1-100 张**生成数量，以及模型、质量、尺寸/比例等参数。
> - 会话、附件缓存、模型偏好、图片设置和滚动位置按登录用户的 `subject_id` 保存在当前浏览器；可删除单个会话或清空本地历史。
> - 高级 `/image` 工作台继续提供图片生成、编辑、多图参考、任务恢复、历史管理和大图查看。

> [!NOTE]
> **原生附件与模型目录边界**
>
> - 附件由服务端通过原生 ChatGPT 上游的创建、签名上传、确认与文档处理流程发送。要让上游实际读取 PDF、Office 或其他附件，部署必须配置可用的原生 ChatGPT 文本账号；通用兼容 API 提供方并不等同于原生文件读取能力。
> - 每条消息最多可引用 **10 张图片**和 **5 份文档**；图片单文件最大 **10 MiB**，文档单文件最大 **25 MiB**，该消息附件总量最大 **50 MiB**，一次请求中去重后的附件工作集最大 **100 MiB**。图片和文档混用时，这些上限同时生效。
> - 当前开发环境没有可用于真实上游附件验证的原生账号和夹具，因此没有把 PDF/Office 的外部实测结果当作已证明能力。下文的 opt-in 实测会在 `attachment_unavailable` 时直接失败，不能用跳过或预期失败替代成功。
> - 模型列表是“上游发现的模型目录”。账号订阅、额度、调度结果和上游状态仍会影响某个模型能否实际调用。

> [!WARNING]
> **使用边界**
>
> 本工程涉及对 ChatGPT 网页能力的研究与兼容实现，仅适合个人学习、技术研究和非商业技术交流。请遵守适用法律、服务条款和内容政策；请勿用于批量滥用、转售、欺诈、违法内容或其他不当用途。上游账号可能受限、临时封禁或永久封禁，请勿使用重要或高价值账号进行测试。

## 快速开始

### 本地构建并使用 Docker Compose

ChatCanvas 使用当前分支源码构建，保留 `chatgpt2api` 仓库名、容器配置和兼容 API 路径以维持部署兼容性：

```bash
git clone git@github.com:jaime0815/chatgpt2api.git chatcanvas
cd chatcanvas

# 在本地修改 config.json 的 auth-key，或通过部署环境覆盖。
# 不要把真实认证密钥、上游账号或第三方 API key 提交回仓库。
docker compose -f docker-compose.local.yml up -d --build
```

- Web 管理面板：`http://localhost:8000/chatgpt2api/`
- 普通用户聊天：`http://localhost:8000/chatgpt2api/chat/`
- 高级图片工作台：`http://localhost:8000/chatgpt2api/image/`
- OpenAI 兼容 API：`http://localhost:8000/chatgpt2api/v1`
- 本地数据目录：`./data`

Web 页面、`/_next` 静态资源、同源 `/api` 和 `/v1` 请求默认都位于 `/chatgpt2api` 子路径。需要其他反向代理路径时，在构建时设置 `NEXT_PUBLIC_BASE_PATH` 并重新构建前端。

> 仓库中的 `docker-compose.yml` 是保留的上游兼容定义，会拉取 `ghcr.io/basketikun/chatgpt2api:latest`。它不是 ChatCanvas 的预构建发布镜像；运行 ChatCanvas 请使用上面的 `docker-compose.local.yml` 本地构建命令。

### 本地开发

```bash
git clone git@github.com:jaime0815/chatgpt2api.git chatcanvas
cd chatcanvas
uv sync
uv run main.py
```

另开终端启动前端：

```bash
cd web
bun install
bun run dev
```

生产前端构建：

```bash
cd web
bun run build
```

更新源码后重新构建本地镜像：

```bash
git pull --ff-only
docker compose -f docker-compose.local.yml up -d --build
```

### WARP / FlareSolverr 稳定代理

图片链路遇到 Cloudflare 拦截时，可以启用仓库提供的 WARP + Privoxy + FlareSolverr 方案：

```bash
cp .env.example .env
docker compose -f docker-compose.warp.yml up -d --build
```

该 Compose 会启动 WARP 出口、HTTP 代理、clearance 刷新服务、幂等配置初始化与主服务。账号自身代理优先级最高，其次为稳定代理运行时，再其次为显式代理和旧版全局代理。

## 核心能力

| 能力 | 说明 |
|:--|:--|
| 普通用户聊天 | `/chat` 提供流式多轮对话、模型选择、停止、编辑重发、重试、会话删除和本地清空。 |
| 模型目录刷新 | `GET /v1/models` 每次从上游发现目录；聊天页可手动刷新，响应使用 `Cache-Control: no-store`。 |
| 原生文件附件 | PDF、DOCX、XLSX、PPTX、TXT、MD、CSV 及 PNG/JPEG/WebP/GIF 可通过 multipart 附在普通聊天消息中，并由同一原生上游会话处理。 |
| 聊天图片创作 | 聊天内图片生成/编辑复用模型、质量、尺寸/比例设置；参考图最多 10 张，生成数量为 1-100。 |
| 高级图片工作台 | `/image` 提供生成、编辑、多图参考、任务进度/恢复、历史、删除和大图查看。 |
| 兼容 API | 保留 `/v1/images/generations`、`/v1/images/edits`、`/v1/chat/completions`、`/v1/responses`、`/v1/models` 等 OpenAI 风格接口。 |
| 用户本地隔离 | 聊天会话、附件 Blob 缓存、偏好和图片任务按 `subject_id` 在浏览器中隔离；不作为服务端聊天历史同步。 |
| 账号与部署 | 保留账号池、CPA / `sub2api` 导入、代理、存储后端和 Docker 自托管能力。 |

## 普通用户聊天

普通用户登录后的默认入口为 `/chat`。默认部署地址为：

```text
http://localhost:8000/chatgpt2api/chat/
```

### 模型选择与刷新

- 初次进入聊天页会读取 `/v1/models`；用户可以通过聊天头部的刷新按钮重新获取目录。
- 服务端支持 `GET /v1/models?refresh=1`，并以 `Cache-Control: no-store` 返回结果。当前实现每次请求都会调用上游发现逻辑，`refresh=1` 用于表达用户主动刷新意图。
- 刷新成功时，聊天和图片模式的模型菜单会一起更新；刷新失败时保留最近一次成功列表，首次加载失败则保留 `auto` 并允许再次刷新。
- 目录只反映上游发现结果，不保证每个账号、订阅或额度都能调用其中所有模型。

### 文件上传与读取

普通文本聊天通过 `POST /api/chat/stream` 接收带 SHA-256 manifest 的 multipart 请求。后端仅在服务端执行原生 ChatGPT 文件创建、签名上传、确认上传及文档处理流程；签名 URL、上游 token 和上游 file ID 不会写入浏览器本地存储、SSE 数据或 README。

支持的文件类型：

- 图片：`.png`、`.jpg`、`.jpeg`、`.webp`、`.gif`。
- 文档：`.pdf`、`.docx`、`.xlsx`、`.pptx`、`.txt`、`.md`、`.csv`。

| 限制 | 值 |
|:--|:--|
| 单条消息图片数量 | 最多 10 张 |
| 单条消息文档数量 | 最多 5 份 |
| 单张图片大小 | 最大 10 MiB |
| 单份文档大小 | 最大 25 MiB |
| 单条消息附件总量 | 最大 50 MiB |
| 当前请求唯一附件工作集 | 最大 100 MiB |

同一消息可以混合图片和文档，但必须同时满足图片数、文档数和总字节数限制。编辑用户消息、重试助手回复和继续历史会话时，浏览器会重新发送当前消息历史实际引用的去重附件。

> 要真正读取附件内容，选择的服务端文本账号必须是可用的原生 ChatGPT 上游账号。上传协议已实现，但本仓库当前没有可用原生账号完成 PDF/Office 外部实测；部署者应运行下面的 opt-in 验收测试后再将该环境视为可用。

### 聊天内图片生成与编辑

- 图片模式只接受图片参考输入，文档附件不能作为图片模式输入。
- 一次最多使用 10 张参考图；生成数量为 1-100。该范围属于聊天交互，兼容图片 API 的 `n` 参数仍遵循下文接口限制。
- 图片任务支持恢复、重试、删除与历史清理。聊天图片设置独立于旧的全局画图设置，并按 `subject_id` 保存。

### 本地会话与清空

聊天数据不会自动同步到服务器或其他浏览器。当前浏览器会按 `subject_id` 分区保存：

- 会话、消息、当前会话、模型偏好和滚动位置。
- 附件 Blob 缓存及其会话引用关系。
- 聊天图片设置与仍在轮询的图片任务。

删除会话或使用“清空历史”会清理该用户的相关本地引用、缓存和进行中的图片任务，不会影响其他登录用户。

### 严格的可选实时附件验收

此测试会向明确配置的服务发送真实请求，默认不会运行。它要求可访问的部署、Bearer 授权、可用原生 ChatGPT 文本账号和本地真实夹具；`LIVE_CHAT_BASE_URL` 需要包含反向代理的 `basePath`。

```bash
RUN_LIVE_CHAT_ATTACHMENTS=1 \
LIVE_CHAT_BASE_URL=http://localhost:8000/chatgpt2api \
LIVE_CHAT_AUTHORIZATION='Bearer <auth-key>' \
LIVE_CHAT_MODEL=auto \
LIVE_CHAT_TIMEOUT_SECONDS=90 \
LIVE_CHAT_PDF=/absolute/path/to/sample.pdf \
LIVE_CHAT_CSV=/absolute/path/to/sample.csv \
LIVE_CHAT_DOCX=/absolute/path/to/sample.docx \
LIVE_CHAT_IMAGE_FILES='/absolute/path/to/image-01.png:/absolute/path/to/image-02.png:/absolute/path/to/image-03.png:/absolute/path/to/image-04.png:/absolute/path/to/image-05.png:/absolute/path/to/image-06.png:/absolute/path/to/image-07.png:/absolute/path/to/image-08.png:/absolute/path/to/image-09.png:/absolute/path/to/image-10.png' \
uv run pytest -q test/test_web_chat_live.py -s
```

Linux/macOS 以 `:` 分隔 `LIVE_CHAT_IMAGE_FILES`，Windows 使用 `;`。该 live suite 运行 PDF、CSV、DOCX、PDF 后续追问、图文混合和恰好 10 张图片的真实上游链路。缺少 opt-in、凭证、夹具或可用文本账号时会明确跳过；一旦收到 `attachment_unavailable` 或其他公开错误事件，测试会失败。请仅通过环境变量传入授权值，绝不把真实值写入仓库、配置模板、测试代码或文档。

## 高级图片工作台

`/image` 是独立于普通聊天的高级创作界面，保留以下能力：

- 图片生成、图片编辑和多图组图编辑。
- 模型、质量、尺寸/比例、参考图和生成数量设置。
- 本地历史、任务进度、超时后的继续等待、结果恢复和滚动位置记忆。
- 服务端图片 URL 缓存、图片懒加载和大图查看。

聊天和 `/image` 都可使用图片模型，但聊天的图片设置按 `subject_id` 隔离保存；不要假定旧版全局画图设置会自动迁移到聊天页。

## OpenAI 风格兼容 API

所有兼容接口需要授权头：

```http
Authorization: Bearer <auth-key>
```

### `GET /v1/models`

返回当前上游发现的模型目录。使用 `?refresh=1` 表达显式刷新，响应带 `Cache-Control: no-store`。返回目录会随账号和上游变化，不再在文档中维护静态模型名列表。

```bash
curl http://localhost:8000/chatgpt2api/v1/models \
  -H "Authorization: Bearer <auth-key>"
```

### `POST /v1/images/generations`

OpenAI 风格文生图接口：

```bash
curl http://localhost:8000/chatgpt2api/v1/images/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <auth-key>" \
  -d '{
    "model": "gpt-image-2",
    "prompt": "一只漂浮在太空里的猫",
    "n": 1,
    "response_format": "b64_json"
  }'
```

| 字段 | 说明 |
|:--|:--|
| `model` | 当前可用值以 `/v1/models` 返回结果为准。 |
| `prompt` | 图片生成提示词。 |
| `n` | 兼容图片 API 当前限制为 1-4；不同于聊天图片模式的 1-100。 |
| `response_format` | 当前默认 `b64_json`。 |

### `POST /v1/images/edits`

可使用 multipart 上传图片编辑：

```bash
curl http://localhost:8000/chatgpt2api/v1/images/edits \
  -H "Authorization: Bearer <auth-key>" \
  -F "model=gpt-image-2" \
  -F "prompt=把这张图改成赛博朋克夜景风格" \
  -F "n=1" \
  -F "image=@./input.png"
```

也支持 JSON 图片 URL：

```bash
curl http://localhost:8000/chatgpt2api/v1/images/edits \
  -H "Authorization: Bearer <auth-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-image-2",
    "prompt": "把这张图改成赛博朋克夜景风格",
    "images": [{"image_url": "https://example.com/input.png"}]
  }'
```

### `POST /v1/chat/completions` 与 `POST /v1/responses`

保留面向文本、网页搜索和图片场景的兼容层，而非完整通用代理。`/v1/chat/completions` 支持文本、搜索及图片请求内容；`/v1/responses` 支持 `image_generation`、`web_search`、`web_search_preview` 和 `web_search_preview_2025_03_11` 工具场景。实际模型、账号和上游可用性应以运行环境为准。

### 可选兼容 API 实测

真实网络测试默认不运行，避免常规测试依赖本机服务、上游账号或外部图片。需要验证已配置服务时，显式提供目标、授权、模型和图片夹具：

```bash
RUN_LIVE_COMPAT_API=1 \
LIVE_COMPAT_API_BASE_URL='https://service.example/v1' \
LIVE_COMPAT_API_AUTHORIZATION='Bearer <auth-key>' \
LIVE_COMPAT_API_TEXT_MODEL='<text-model>' \
LIVE_COMPAT_API_IMAGE_MODEL='<image-model>' \
LIVE_COMPAT_API_CODEX_IMAGE_MODEL='<codex-image-model>' \
LIVE_COMPAT_API_IMAGE_FILES='/absolute/path/to/image-01.png:/absolute/path/to/image-02.png' \
uv run pytest -q test/test_v1_chat_completions.py test/test_v1_images_generations.py test/test_v1_images_edits.py test/test_v1_messages.py test/test_v1_models.py test/test_v1_responses.py -s
```

该命令可能消耗真实账号额度。缺少 opt-in、必填环境变量或图片夹具时，对应用例会跳过且不会访问默认上游。

## 账号、存储与部署

### 账号池

- 自动刷新账号邮箱、类型、额度和恢复时间，支持异步进度追踪。
- 支持搜索、筛选、批量刷新、导出、手动编辑、清理和失效 token 自动移除。
- 支持本地 CPA JSON、远程 CPA、`sub2api` 与 `access_token` 导入。
- 支持全局 HTTP / HTTPS / SOCKS5 / SOCKS5H 代理及 WARP / FlareSolverr 运行时。

### 存储后端

通过 `STORAGE_BACKEND` 选择存储方式：

- `json`：本地 JSON（默认）
- `sqlite`：本地 SQLite
- `postgres`：外部 PostgreSQL，需要 `DATABASE_URL`
- `git`：Git 私有仓库，需要 `GIT_REPO_URL` 与 `GIT_TOKEN`

示例：

```yaml
environment:
  - STORAGE_BACKEND=postgres
  - DATABASE_URL=postgresql://user:password@host:5432/dbname
```

## 功能状态

完整的已实现、限制与待完善功能见 [功能状态](./docs/feature-status.en.md)。其中附件的“实现状态”和“当前环境尚未完成真实原生账号实测”会分开记录。

## 来源与许可证

- ChatCanvas 基于上游 [ChatGPT2API](https://github.com/basketikun/chatgpt2api) 发展而来；上游项目的兼容 API、账号池、图片与部署基础在本工程中继续保留和扩展。
- 本工程保留仓库中的 [LICENSE](./LICENSE)。使用、分发或二次开发前，请阅读并遵守该许可证及上游项目的适用条款。
- ChatCanvas 不代表 ChatGPT2API 或 OpenAI，也不与二者存在官方背书、附属或合作关系。
