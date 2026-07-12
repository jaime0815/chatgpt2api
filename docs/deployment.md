# ChatCanvas 部署与维护

ChatCanvas 是基于 ChatGPT2API 的衍生工程。产品名称不改变既有 `/v1` 兼容接口、`/chatgpt2api` 默认部署路径、容器和环境变量中的 `chatgpt2api` 技术标识。

## 部署前准备

服务器需要安装 Git、Docker，以及 Docker Compose v1 或 v2。统一启动脚本会自动识别 Compose 实现和当前 CPU 架构。

```bash
docker version
git --version
./scripts/docker-up.sh --help
```

运行数据包含上游账号、应用配置、上传文件、图片任务和调用日志，应按敏感数据管理。不要把 `config.json`、`data/`、`.env`、账号 token 或 API 密钥提交到仓库。

## Docker 快速部署

```bash
git clone git@github.com:jaime0815/chatgpt2api.git chatcanvas
cd chatcanvas

# 在首次启动前编辑 config.json，将 auth-key 改为高强度随机值。
./scripts/docker-up.sh
```

默认地址：

| 入口 | 地址 |
| --- | --- |
| 管理面板 | `http://localhost:3000/chatgpt2api/` |
| 普通用户聊天 | `http://localhost:3000/chatgpt2api/chat/` |
| 图像工作台 | `http://localhost:3000/chatgpt2api/image/` |
| 兼容 API | `http://localhost:3000/chatgpt2api/v1` |

`./scripts/docker-up.sh` 使用 `docker-compose.local.yml` 构建并启动本项目。请不要用保留的 `docker-compose.yml` 部署 ChatCanvas：该文件会拉取上游镜像，而不是当前源码构建的镜像。

### 持久化路径

本地部署默认把容器目录挂载到宿主机：

| 宿主机路径 | 容器路径 | 内容 |
| --- | --- | --- |
| `/etc/chatgpt2api/data` | `/app/data` | 账号、上传文件、图片、任务、日志和本地数据库 |
| `/etc/chatgpt2api/config.json` | `/app/config.json` | 应用与后台配置 |

首次启动时，脚本仅在宿主机目标不存在或数据目录为空时，从仓库的 `config.json` 和 `data/` 初始化内容。后续更新不会覆盖这两个位置。需要自定义路径时，在运行脚本前设置：

```bash
export CHATGPT2API_HOST_DATA_DIR=/srv/chatcanvas/data
export CHATGPT2API_HOST_CONFIG_FILE=/srv/chatcanvas/config.json
./scripts/docker-up.sh
```

当前用户无法写入 `/etc/chatgpt2api` 时，也应使用上述变量指定自己可管理且已受权限保护的目录。

本地 Compose 配置直接使用宿主机配置文件；单独在 `.env` 设置 `CHATGPT2API_AUTH_KEY` 不会覆盖本地部署的 `auth-key`。请在首次启动前修改 `config.json`，或直接修改持久化后的宿主机配置文件并重启服务。

### 日常操作

```bash
# 拉取已推送的代码后重建镜像并更新
git pull --ff-only
./scripts/docker-up.sh

# 不重建镜像启动
./scripts/docker-up.sh --no-build

# 停止服务
./scripts/docker-stop.sh

# 查看容器与日志
docker ps --filter name=chatgpt2api-local
docker logs -f chatgpt2api-local
```

## WARP / FlareSolverr 模式

当上游请求遇到 Cloudflare 拦截时，可启用 WARP、Privoxy 和 FlareSolverr：

```bash
cp .env.example .env
# 根据部署环境编辑 .env；不要提交其中的敏感值。
./scripts/docker-up.sh --warp
```

该模式的主服务仍默认提供 `http://localhost:3000/chatgpt2api/`，并额外启动本地回环地址上的 WARP、Privoxy 和 FlareSolverr 组件。停止和排查命令：

```bash
./scripts/docker-stop.sh --warp
docker ps --filter name=chatgpt2api
docker logs -f chatgpt2api-warp
docker logs -f chatgpt2api-flaresolverr
```

账号自身代理优先于稳定代理运行时；稳定代理优先于显式代理和旧版全局代理。详细运行时配置见 `.env.example` 与后台设置页。

## 源码开发与子路径

后端：

```bash
uv sync
uv run main.py
```

前端开发服务：

```bash
cd web
bun install
bun run dev
```

默认前端与同源 API 位于 `/chatgpt2api`，包括静态资源、`/api` 和 `/v1`。需要其他反向代理子路径时，在构建前设置 `NEXT_PUBLIC_BASE_PATH`：

```bash
cd web
NEXT_PUBLIC_BASE_PATH=/custom-path bun run build
```

预构建前端会把该路径写入静态产物，修改后必须重新构建镜像或前端。

## 存储后端

可用后端为 `json`、`sqlite`、`postgres` 和 `git`。不同部署配置的默认值不同：`docker-compose.local.yml` 固定使用 SQLite，WARP 配置在未设置时使用 JSON；不要假定所有模式共享同一个默认值。

外部 PostgreSQL 示例：

```yaml
environment:
  STORAGE_BACKEND: postgres
  DATABASE_URL: postgresql://user:password@host:5432/dbname
```

切换存储后端前先备份数据，并确认运行模式实际将相关环境变量传入容器。

## 备份、升级与回滚

部署脚本默认使用宿主机挂载，因此备份应覆盖持久化位置：

```bash
sudo tar -czf chatcanvas-$(date +%Y%m%d-%H%M%S).tgz \
  /etc/chatgpt2api/config.json \
  /etc/chatgpt2api/data
```

使用自定义挂载路径时，替换为实际路径。WARP 部署如使用 `.env` 保存运行时配置，也应单独安全备份该文件。

升级：

```bash
git pull --ff-only
./scripts/docker-up.sh
```

WARP 模式使用：

```bash
git pull --ff-only
./scripts/docker-up.sh --warp
```

回滚前先停止服务、确认目标提交和备份可用，再切换到目标提交并通过对应启动脚本重建。不要用重置或强制覆盖替代受控的 Git 历史操作。

## 受控生产部署

`scripts/deploy-production.sh` 用于已经配置 SSH 目标的生产环境。它要求本地 `main` 已推送到指定 Git remote，随后通过 Git bundle 传输提交，不要求服务器访问 GitHub；远端工作树有未提交改动时会拒绝继续。

```bash
./scripts/deploy-production.sh --dry-run
./scripts/deploy-production.sh
```

脚本在远端执行受控 fast-forward、调用统一启动脚本、检查容器和健康接口，并且仅删除没有容器引用的旧镜像。部署前确认 `DEPLOY_HOST`、`DEPLOY_PORT`、`DEPLOY_PATH`、`DEPLOY_SOURCE_REMOTE` 和 `DEPLOY_HEALTH_URL` 的环境覆盖值符合目标环境。

## 聊天附件与安全

普通聊天可发送图片、PDF 和 Office 文档，但实际读取依赖可用的原生 ChatGPT 文本账号。上传协议已经实现；本仓库开发环境尚未用可用原生账号完成 PDF/Office 的外部读取验收。上线前请按[功能状态](./feature-status.en.md)执行适用的 opt-in 验证。

浏览器会话状态不会作为服务端聊天历史同步，但服务调用日志可能保留请求摘要和调用元数据。请依据所在组织的保留策略配置数据目录权限、日志访问和备份范围。
