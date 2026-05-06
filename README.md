# ChainCloud Image Studio

ChainCloud Image Studio 是面向链路云场景的图片生成与编辑工作台。前端负责交互、历史记录和本地图片缓存，后端负责长耗时图片任务的排队、执行、重试、取消和状态观测。

当前项目已经不是纯静态 playground。核心链路是：浏览器提交任务到本应用 `/api/*`，Flask 后端把任务写入 Postgres 和 Redis，worker 从队列取任务后请求 `DEFAULT_IMAGE_API_URL`，前端轮询任务结果并把成功图片写入浏览器 IndexedDB。

## 核心能力

- 文本生图、参考图编辑、遮罩编辑。
- Images API 与 Responses API 两种接口模式。
- 后端任务队列，避免浏览器长连接等待上游图片接口。
- 任务状态观测：排队、运行、重试、失败原因、后端任务 ID、耗时阶段。
- 后端 worker 日志：任务开始、请求上游、成功、失败、重试。
- 幂等提交，降低刷新或重复点击造成重复任务的概率。
- 任务取消、失败重试、最近任务状态和任务摘要。
- Redis 保存任务 payload/result，Postgres 保存任务元数据。
- 前端 IndexedDB 保存用户设置、任务历史和图片数据。
- 支持嵌入 Sub2API 场景，通过 `user_id` 和 `token` 获取用户 keys。
- 提示词模板、收藏、最近使用和主题跟随。

## 架构

```text
Browser
  |
  | GET /
  | POST /api/tasks
  | GET /api/tasks/:id
  v
Nginx
  |-- /        -> static frontend
  |-- /api/*   -> Flask 127.0.0.1:8787
                  |
                  | metadata
                  v
                Postgres
                  |
                  | payload/result/queue
                  v
                Redis
                  |
                  | worker request
                  v
                DEFAULT_IMAGE_API_URL
```

`/api/*` 是本应用后端接口，必须保留。它不是上游图片 API 代理，也不是旧的 `/api-proxy`。

Nginx 当前只承担两个职责：托管前端静态文件，以及把同域 `/api/*` 转发给本机 Flask。Flask 可以只监听 `127.0.0.1:8787`，不需要直接暴露公网。

推荐 Cloudflare Tunnel 入口：

```text
CF Tunnel -> Nginx :80
             |-- /      前端
             |-- /api/* Flask 后端
```

## 本地开发

安装前端依赖：

```bash
npm install
```

仅启动前端：

```bash
npm run dev
```

启动 Flask 后端：

```bash
npm run dev:server
```

本地 Vite 会把 `/api` 代理到 `http://127.0.0.1:8787`。如果只启动前端而没有后端，页面可以打开，但后端任务队列相关功能不可用。

测试和构建：

```bash
npm test
npm run build
```

## Docker 部署

复制环境变量示例：

```bash
cd deploy
cp .env.example .env
```

启动：

```bash
docker compose -f docker-compose.chaincloud.yml up -d --build
```

默认服务：

- 应用入口：`http://<server>:80`
- Flask 后端：容器内 `127.0.0.1:8787`
- Postgres：容器内 `postgres:5432`
- Redis：容器内 `redis:6379`

## 环境变量

主要变量在 `deploy/.env.example` 中维护。

| 变量 | 说明 |
| --- | --- |
| `DEFAULT_IMAGE_API_URL` | worker 实际请求的 OpenAI-compatible / Sub2API 根地址，例如 `http://127.0.0.1:8080/v1` |
| `IMAGE_STUDIO_HTTP_PORT` | Nginx 对外暴露端口，默认 `80` |
| `IMAGE_STUDIO_PORT` | Flask 内部监听端口，默认 `8787` |
| `POSTGRES_DSN` | 后端连接 Postgres 的 DSN |
| `REDIS_URL` | 后端连接 Redis 的地址 |
| `IMAGE_STUDIO_WORKER_COUNT` | worker 数量 |
| `IMAGE_STUDIO_MAX_CONCURRENT` | 全局并发上限 |
| `IMAGE_STUDIO_MAX_CONCURRENT_PER_USER` | 单用户并发上限 |
| `IMAGE_STUDIO_MAX_CONCURRENT_PER_KEY` | 单 API key 并发上限 |
| `IMAGE_STUDIO_MAX_CONCURRENT_PER_PROFILE` | 单 profile 并发上限 |
| `IMAGE_STUDIO_PAYLOAD_TTL_SECONDS` | Redis 任务输入保留时间 |
| `IMAGE_STUDIO_RESULT_TTL_SECONDS` | Redis 任务结果保留时间 |
| `IMAGE_STUDIO_CANCEL_TTL_SECONDS` | 取消信号保留时间 |
| `IMAGE_STUDIO_TASK_METADATA_TTL_SECONDS` | 旧任务元数据保留时间 |
| `IMAGE_STUDIO_CLEANUP_INTERVAL_SECONDS` | 后台清理间隔 |

已移除旧配置：

- `DEFAULT_API_URL`
- `ENABLE_API_PROXY`
- `API_PROXY_URL`
- `HTTP_PROXY`
- `HTTPS_PROXY`
- `NO_PROXY`
- `/api-proxy`
- `__DEV_PROXY_CONFIG__`

## 设置项

当前设置弹窗只保留用户真正需要修改的项目：

- API 凭证
- API 接口：Images API 或 Responses API
- Codex CLI 兼容模式
- 提交后清空输入框

设置持久化在浏览器 IndexedDB。图片历史、任务历史和生成结果也保存在浏览器本地，后端只短期保留任务 payload/result。

在嵌入 Sub2API 场景下，URL 携带 `user_id` 和 `token` 后，前端会请求本应用 `/api/embedded/keys`。后端用 `DEFAULT_IMAGE_API_URL` 推导 Sub2API origin，携带 token 获取用户 keys。此时 API 凭证输入会变成 keys 下拉选择。

## 请求链路

创建任务：

```text
POST /api/tasks
  -> 校验 payload
  -> 写入 Postgres
  -> 输入图片/payload 写入 Redis
  -> 任务 ID 推入 Redis 队列
```

执行任务：

```text
worker brpop queue
  -> claim task
  -> 读取 Redis payload
  -> 请求 DEFAULT_IMAGE_API_URL
  -> 写入 Redis result
  -> 更新 Postgres 状态
```

前端轮询：

```text
GET /api/tasks/:id
  -> 读取 Postgres 状态
  -> 如果成功，附带 Redis result
  -> 前端写入 IndexedDB
```

轮询不会重新触发 worker，也不会重复请求上游。

## 未来优化

### 任务系统

- 增加更完整的上游中断能力，取消任务时尽量中断正在进行的上游请求。
- 把幂等 key 的生成规则继续稳定化，覆盖更多重复提交场景。
- 继续完善按用户、key、profile 的队列隔离和调度策略。
- 将失败分类细化到账号不可用、限流、上游超时、图片下载失败、payload 过期等稳定枚举。
- 为任务状态增加更完整的审计事件表，方便排查偶发问题。

### 可观测性

- 管理员页增加任务列表、队列长度、worker 状态和失败分布。
- 后端日志增加结构化字段，便于接入 Loki、ELK 或 CloudWatch。
- 增加 Prometheus metrics：队列等待时长、运行时长、成功率、失败类型、重试次数。
- 对 Redis payload/result TTL、Postgres 清理数量做周期性统计。

### 前端体验

- 成功生成后自动高亮新图，并提供更自然的滚动定位。
- 提示词模板继续补充中文分类、收藏、最近使用和一键套用生成。
- 设置页保持精简，同时补充保存失败、key 不可用、接口不可达等明确反馈。
- 最近任务弹窗增加筛选、复制任务 ID、快速重试和取消。

### 部署维护

- 拆分前端静态镜像和后端 worker 镜像，降低发布耦合。
- 增加 GitHub Actions：测试、构建、Docker 镜像构建和版本发布。
- 镜像使用版本标签，不只依赖 `local`。
- 为 31 服务器部署补充 Cloudflare Tunnel + Nginx 的标准配置示例。
- 增加数据库迁移策略，避免后续 schema 演进依赖启动时自动修补。

## 开发注意

- `/api/*` 是本应用后端接口，保留。
- `/api-proxy` 已删除，不再用于上游图片 API 转发。
- 前端不要直接请求内网 `DEFAULT_IMAGE_API_URL`，应通过后端任务系统提交图片任务。
- Nginx 保留，但只做静态文件服务和 `/api/*` 转发。
- 后端 Flask 可绑定本机地址，由 Nginx 或 Cloudflare Tunnel 入口转发。
