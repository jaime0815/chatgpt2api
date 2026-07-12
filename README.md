<h1 align="center">ChatCanvas</h1>

<p align="center">自托管的聊天、文件理解与图像创作工作台</p>

> ChatCanvas 基于 [ChatGPT2API](https://github.com/basketikun/chatgpt2api) 构建，保留兼容 API、账号池和自托管基础，并扩展为面向普通用户的聊天工作台。它不是 ChatGPT2API 或 OpenAI 的官方产品、附属项目或合作服务。

## 新版亮点

- **ChatGPT 式聊天**：普通用户登录后默认进入 `/chat`，支持多轮流式回复、停止生成、编辑重发、助手回复重试和本地会话管理。
- **上游模型目录**：在聊天和图像模式中选择模型，并手动刷新上游发现的目录；刷新失败时保留最近一次成功结果，不把静态模型名当作可用性承诺。
- **原生文件附件**：图片、PDF、DOCX、XLSX、PPTX、TXT、MD、CSV 可随普通聊天消息发送到同一原生上游会话。
- **更多图片与参数复用**：聊天内可生成或编辑图片，沿用模型、质量、尺寸或比例和数量参数；一次最多引用 **10 张**参考图。
- **高级图像工作台**：`/image` 保留生成、编辑、多图参考、任务恢复、历史管理和大图查看。

## 快速开始

### Docker 自托管

```bash
git clone git@github.com:jaime0815/chatgpt2api.git chatcanvas
cd chatcanvas

# 首次启动前编辑 config.json，将 auth-key 改为高强度随机值。
./scripts/docker-up.sh
```

默认访问地址：

| 入口 | 地址 |
| --- | --- |
| 管理面板 | `http://localhost:3000/chatgpt2api/` |
| 普通用户聊天 | `http://localhost:3000/chatgpt2api/chat/` |
| 高级图像工作台 | `http://localhost:3000/chatgpt2api/image/` |
| OpenAI 风格 API | `http://localhost:3000/chatgpt2api/v1` |

启动脚本会使用当前源码构建镜像，并默认持久化到宿主机的 `/etc/chatgpt2api/data` 与 `/etc/chatgpt2api/config.json`。首次运行时会从仓库的 `config.json` 和 `data/` 初始化这两个位置；后续请直接保护和备份宿主机路径。可通过 `CHATGPT2API_HOST_DATA_DIR` 与 `CHATGPT2API_HOST_CONFIG_FILE` 改写位置。

```bash
# 拉取代码后重建并更新
git pull --ff-only
./scripts/docker-up.sh

# 使用现有镜像启动、停止，或启用 WARP / FlareSolverr
./scripts/docker-up.sh --no-build
./scripts/docker-stop.sh
cp .env.example .env
./scripts/docker-up.sh --warp
```

`docker-up.sh` 和 `docker-stop.sh` 同时兼容 Docker Compose v1 与 v2。保留的 `docker-compose.yml` 会拉取上游镜像，不是 ChatCanvas 的发布方式；运行本项目请使用上述脚本。

### 本地开发

```bash
uv sync
uv run main.py
```

另开终端启动前端：

```bash
cd web
bun install
bun run dev
```

默认部署路径为 `/chatgpt2api`。需要修改反向代理子路径时，在前端构建前设置 `NEXT_PUBLIC_BASE_PATH`；详细说明见[部署与维护指南](./docs/deployment.md)。

## 能力一览

| 能力 | 说明 |
| --- | --- |
| 普通用户聊天 | `/chat` 提供流式多轮会话、模型选择、停止、编辑重发、重试、会话删除和本地清空。 |
| 最新模型列表 | `GET /v1/models` 按上游发现模型并使用 `Cache-Control: no-store`；可使用 `?refresh=1` 表达主动刷新。 |
| 文件上传 | 普通文本聊天接受 PNG、JPEG、WebP、GIF 以及 PDF、DOCX、XLSX、PPTX、TXT、MD、CSV。 |
| 图像创作 | 聊天和 `/image` 支持生成、编辑、多图参考、模型、质量、尺寸或比例和任务恢复。 |
| 兼容 API | 保留 `/v1/models`、`/v1/chat/completions`、`/v1/responses`、`/v1/images/generations` 与 `/v1/images/edits`。 |
| 账号与部署 | 保留账号池、CPA / `sub2api` 导入、代理、存储后端和 Docker 自托管能力。 |

## 聊天、文件与图片

普通用户登录后从 `/chat` 开始。聊天记录、模型偏好、附件缓存、图片设置和滚动位置按浏览器登录用户的 `subject_id` 隔离；删除会话或清空历史会删除对应的本地引用。

附件在服务端通过原生 ChatGPT 文件创建、签名上传、确认与文档处理流程发送；要让上游实际读取文件，部署必须配置可用的原生 ChatGPT 文本账号。单条消息最多可引用 **10 张图片**和 **5 份文档**：图片最大 10 MiB，文档最大 25 MiB，消息附件总量最大 50 MiB，去重后的请求工作集最大 100 MiB。聊天图片模式只接受图片参考输入，支持 1-100 张生成结果；兼容图片 API 的 `n` 范围为 1-4。

模型目录反映上游发现结果，账号订阅、额度、调度和上游状态仍决定实际能否调用。附件协议已经实现，但 PDF 和 Office 的真实上游读取尚未在本仓库开发环境中以可用原生账号完成外部验收；部署前请按[功能状态](./docs/feature-status.en.md)运行适用的 opt-in 验证。

## API

所有兼容接口均需要授权头：

```http
Authorization: Bearer <auth-key>
```

从当前环境读取模型目录：

```bash
curl http://localhost:3000/chatgpt2api/v1/models \
  -H "Authorization: Bearer <auth-key>"
```

接口覆盖范围、图像参数和真实服务验证方式见[功能状态](./docs/feature-status.en.md)。兼容层面向本项目支持的文本、搜索和图像工作流，并非完整的通用 API 代理。

## 部署与维护

- [部署与维护指南](./docs/deployment.md)：Docker、WARP / FlareSolverr、存储、备份、升级与回滚。
- [功能状态](./docs/feature-status.en.md)：已实现能力、限制、附件边界和验证原则。
- [生产部署脚本](./scripts/deploy-production.sh)：通过 SSH 将当前 Git 提交构建并部署到受控生产主机，包含远端工作树、容器与健康检查保护。

## 安全与使用边界

- 在任何网络暴露前更换 `config.json` 中的默认 `auth-key`。本地 Compose 启动会在首次运行时将该文件复制到宿主机配置路径；仅设置 `.env` 中的 `CHATGPT2API_AUTH_KEY` 不会覆盖本地 Compose 配置。
- 将 `/etc/chatgpt2api/config.json`、`/etc/chatgpt2api/data`、账号 token、上传文件和日志视为敏感数据，限制宿主机权限，并且绝不提交认证信息、上游账号、Bearer token 或签名上传 URL。
- 浏览器会话状态不作为服务端聊天历史同步，但服务调用日志可能保存最多 1,000 个字符的请求摘要及调用元数据。处理敏感内容前，请根据部署环境配置保留与访问策略。
- 本工程适合个人学习、技术研究和合规的内部使用。请遵守适用法律、服务条款和内容政策，不要用于批量滥用、转售、欺诈或违法活动。

## 来源与许可证

ChatCanvas 是 [ChatGPT2API](https://github.com/basketikun/chatgpt2api) 的衍生工程，沿用仓库中的 [LICENSE](./LICENSE)。使用、分发或二次开发前，请同时阅读并遵守本项目许可证与上游项目的适用条款。
