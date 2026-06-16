# 链路云 Image Studio

基于 `CookSleep/gpt_image_playground` 改造的图片生成前端。当前项目采用前后端一体 Docker：React/Vite 负责 UI，Go 负责业务任务、队列、临时资产和本机 sub2api 调用。

## 架构

```text
Browser
  -> React UI
  -> /api/image/jobs 短轮询
  -> /api/assets/{id} 下载临时图片
  -> IndexedDB 长期保存图片
  -> /api/image/jobs/{id}/ack 通知后端清理临时图片

Go API
  -> Postgres 保存任务、临时图片字节、Agent 表
  -> Redis Stream 做任务队列
  -> SUB2API_BASE_URL 调用本机 sub2api
```

浏览器不直连 sub2api，也不展示 API URL。Cloudflare 只看到短请求，不需要等待长时间生图连接。

## 本地开发

```bash
npm ci
cp deploy/.env.example .env
npm run dev
npm run dev:server
```

启用新版后端需要 Postgres、Redis、`APP_SECRET`：

```bash
docker compose -f deploy/docker-compose.image.yml up -d image-postgres image-redis
```

## Docker

```bash
docker build --build-arg BASE_URL=/ -f deploy/Dockerfile -t ov-image-studio .
docker run -d --name chaincloud-image --network host --env-file .env ov-image-studio
```

关键环境变量：

```env
DATABASE_URL=postgres://image:image_password@127.0.0.1:5433/image_studio?sslmode=disable
REDIS_URL=redis://127.0.0.1:6380/0
SUB2API_BASE_URL=http://127.0.0.1:8080
APP_SECRET=change-this-to-a-long-random-secret
DELETE_ASSETS_ON_ACK=true
SITE_NAME=链路云
SITE_URL=https://dash.ovload.com
PROMPT_TEMPLATE_SOURCE_URL=https://raw.githubusercontent.com/YouMind-OpenLab/awesome-gpt-image-2/main/README_zh.md
```

`APP_SECRET` 用来短期加密任务内的 API Key。任务完成后后端会清理密文，只保留 key 指纹；前端持久化设置时也不会长期保存完整 `sk-...`。临时图片保存在 Postgres，前端下载写入 IndexedDB 后 ACK，后端会清空对应图片字节；未 ACK 的图片会按 `ASSET_TTL_SECONDS` 过期清理。

## Caddy

同一台机器推荐只反代 Image Studio：

```caddyfile
image.ovload.com {
  reverse_proxy 127.0.0.1:8082
}
```

sub2api 保持本机 `127.0.0.1:8080` 给 Go 后端访问，不暴露给浏览器。

## 状态

- 画廊生图已切到 `/api/image/jobs`。
- 图片结果由前端写入 IndexedDB 后 ACK，后端清理临时资产。
- Postgres/Redis 是新版后端主路径，临时图片不再依赖本地资产目录。
- Agent 后端 runner 表和路由已预留，当前不会再让浏览器直连上游执行 Agent；完整 runner 需要继续实现 `agent_runs` 消费和事件流。
