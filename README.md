# ChainCloud Image Studio

ChainCloud Image Studio 是一个面向 ChainCloud/Sub2API 场景的图片生成与编辑工作台。前端负责交互、任务历史和本地图片缓存；后端负责长耗时图片任务的排队、执行、重试、取消和状态观测。

当前主链路是：

```text
Browser
  -> Nginx
  -> Flask /api/*
  -> Postgres task metadata
  -> Redis payload/result/queue
  -> Worker
  -> DEFAULT_IMAGE_API_URL
```

前端不会直接请求内网图片接口，也不再使用旧的 `/api-proxy`。所有生成任务都通过本应用 `/api/*` 后端进入队列，worker 再请求 `DEFAULT_IMAGE_API_URL`。

## 功能

- 文本生图、参考图编辑、遮罩编辑。
- Images API 与 Responses API 两种接口模式。
- 后端任务队列，避免浏览器长连接等待上游图片接口。
- 任务卡片展示队列、运行、重试、失败原因、后端任务 ID、耗时阶段。
- 按 requesterId 限制任务详情、取消和重试访问。
- 幂等提交，降低刷新或重复点击造成重复任务的概率。
- 失败原因中文映射。
- Redis 保存短期 payload/result，Postgres 保存任务元数据。
- 前端 IndexedDB 保存用户设置、任务历史和图片数据。
- 支持嵌入 Sub2API：URL 携带 `user_id` 和 `token` 后，前端通过 `/api/embedded/keys` 获取该用户 keys。
- 提示词模板、收藏、最近使用和主题跟随。

## 架构说明

```text
Cloudflare Tunnel / browser
  |
  v
Nginx :80
  |-- /      static frontend
  |-- /api/* Flask 127.0.0.1:8787
                  |
                  | task metadata
                  v
              Postgres
                  |
                  | queue + payload/result
                  v
               Redis
                  |
                  v
              Worker process
                  |
                  v
        DEFAULT_IMAGE_API_URL
```

`/api/*` 必须保留，它是本应用后端接口，不是上游图片 API 代理。Nginx 当前只承担两个职责：托管前端静态文件，以及把同域 `/api/*` 转发给本机 Flask。Flask 可以只监听容器内或本机地址，由 Nginx/Cloudflare Tunnel 对外承接入口。

Web 和 Worker 已经拆成独立进程：

- `app` service：Nginx + Flask，只接收前端请求和读写任务元数据。
- `worker` service：运行 `backend/worker.py`，消费 Redis 队列并请求上游图片 API。

轮询任务状态只读取 Postgres/Redis，不会重新触发 worker，也不会重复请求上游。

## 本地开发

安装依赖：

```bash
npm install
```

只启动前端：

```bash
npm run dev
```

启动 Flask 后端和 worker：

```bash
npm run dev:server
npm run dev:worker
```

也可以一次启动前端、Flask 和 worker：

```bash
npm run dev:full
```

本地 Vite 会把 `/api` 转发到 `http://127.0.0.1:8787`。如果只启动前端，页面可以打开，但后端任务队列相关能力不可用；如果只启动 Flask、不启动 worker，任务可以创建和排队，但不会被消费执行。

测试和构建：

```bash
npm test
python -m unittest discover backend/tests
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
- Flask：容器内 `127.0.0.1:8787`
- Postgres：容器内 `postgres:5432`
- Redis：容器内 `redis:6379`
- Worker：独立 `worker` service

## 环境变量

主要变量在 `deploy/.env.example` 维护。

| 变量 | 说明 |
| --- | --- |
| `IMAGE_STUDIO_IMAGE` | Docker 镜像名 |
| `IMAGE_STUDIO_TAG` | Docker 镜像标签 |
| `IMAGE_STUDIO_HTTP_PORT` | Nginx 对外端口 |
| `DEFAULT_IMAGE_API_URL` | worker 实际请求的 OpenAI-compatible/Sub2API 地址 |
| `IMAGE_STUDIO_PORT` | Flask 内部监听端口 |
| `POSTGRES_DSN` | Flask/worker 连接 Postgres 的 DSN |
| `REDIS_URL` | Flask/worker 连接 Redis 的地址 |
| `IMAGE_STUDIO_WORKER_COUNT` | worker 线程数 |
| `IMAGE_STUDIO_MAX_CONCURRENT` | 全局并发上限 |
| `IMAGE_STUDIO_MAX_CONCURRENT_PER_USER` | 单 requester 并发上限 |
| `IMAGE_STUDIO_MAX_CONCURRENT_PER_KEY` | 单 API key 并发上限 |
| `IMAGE_STUDIO_MAX_CONCURRENT_PER_PROFILE` | 单 profile 指纹并发上限 |
| `IMAGE_STUDIO_PAYLOAD_TTL_SECONDS` | Redis 输入 payload 保留时间 |
| `IMAGE_STUDIO_RESULT_TTL_SECONDS` | Redis 结果 payload 保留时间 |
| `IMAGE_STUDIO_CANCEL_TTL_SECONDS` | 取消信号保留时间 |
| `IMAGE_STUDIO_CANCEL_POLL_INTERVAL_SECONDS` | worker 检测取消信号的间隔 |
| `IMAGE_STUDIO_TASK_METADATA_TTL_SECONDS` | 旧任务元数据保留时间 |
| `IMAGE_STUDIO_TASK_EVENT_TTL_SECONDS` | 任务事件日志保留时间，默认 3 天 |
| `IMAGE_STUDIO_CLEANUP_INTERVAL_SECONDS` | 清理循环间隔 |

已移除的旧配置：

- `DEFAULT_API_URL`
- `ENABLE_API_PROXY`
- `API_PROXY_URL`
- `HTTP_PROXY`
- `HTTPS_PROXY`
- `NO_PROXY`
- `/api-proxy`
- `__DEV_PROXY_CONFIG__`
- fal.ai provider/profile 配置

## 设置页

当前设置弹窗只保留用户真正需要改的四项：

- API 凭证
- API 接口：Images API 或 Responses API
- Codex CLI 兼容模式
- 提交后清空输入框

设置持久化在浏览器 IndexedDB。运行时的上游地址、模型、超时等由环境变量和后端默认配置决定，不再写入前端用户设置。

嵌入 Sub2API 时，URL 携带 `user_id` 和 `token` 后，前端会请求本应用 `/api/embedded/keys`。后端根据 `DEFAULT_IMAGE_API_URL` 推导 Sub2API origin，携带 token 获取用户 keys。此时 API 凭证输入会变成 keys 下拉选择，任务 requesterId 使用 `sub2api:<user_id>`。

非嵌入场景下，前端会在 localStorage 保存一个本地 client id，任务 requesterId 使用 `client:<uuid>`。

## 任务 API 摘要

创建任务：

```text
POST /api/tasks
  -> 校验 requesterId、payload、idempotency key
  -> 写入 Postgres
  -> payload 写入 Redis
  -> task id 推入 Redis queue
```

查询任务：

```text
GET /api/tasks/:id?requesterId=...
```

默认只返回结果摘要，避免反复传输大图 payload。前端需要领取成功图片时使用：

```text
GET /api/tasks/:id?requesterId=...&includeResult=1
```

取消任务：

```text
POST /api/tasks/:id/cancel?requesterId=...
```

重试任务：

```text
POST /api/tasks/:id/retry?requesterId=...
```

## 未来优化

任务系统：

- 增强上游中断能力，取消正在运行的任务时尽量中断正在进行的上游请求。
- 把幂等 key 策略继续稳定化，覆盖更多重复提交场景。
- 继续完善按 requester、API key、profile 指纹的隔离和调度策略。
- 细化失败分类：账号不可用、限流、上游超时、图片下载失败、payload 过期。
- 扩展任务事件表查询接口，便于排查偶发问题。

可观测性：

- 增加队列长度、worker 状态、失败分布和任务延迟统计。
- 后端日志改为结构化字段，便于接入 Loki、ELK 或 CloudWatch。
- 增加 Prometheus metrics：排队时间、运行时间、成功率、失败类型、重试次数。
- 周期统计 Redis payload/result TTL、Postgres 清理数量。

前端体验：

- 成功生成后高亮新图，并提供更自然的滚动定位。
- 提示词模板继续补充中文分类、收藏、最近使用和一键套用生成。
- 设置页继续保持精简，同时补充 key 不可用、接口不可达等明确反馈。
- 任务详情增加更完整的复制任务 ID、复制错误、快速重试入口。

部署维护：

- 拆分纯前端静态镜像和后端 worker 镜像，降低发布耦合。
- 增加 GitHub Actions：前端测试、后端测试、构建、Docker 镜像构建。
- 镜像使用版本标签，不只依赖 `local`。
- 为 31 服务器部署补充 Cloudflare Tunnel + Nginx 标准配置示例。
- 增加数据库迁移策略，避免 schema 演进依赖启动时自动修补。
