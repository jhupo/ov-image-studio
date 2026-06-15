# 链路云

基于 [CookSleep/gpt_image_playground](https://github.com/CookSleep/gpt_image_playground) 修改的图片生成前端，保留原项目 MIT 许可与署名。

当前项目包含静态前端和一个 Go 队列服务。前端只向同源 `/api/tasks` 创建任务并轮询状态，Go 服务在服务器内部请求 `.env` 中配置的 sub2api。这样 Cloudflare 小黄云看到的都是短请求，不会等待长耗时生图连接。

默认 API Base URL 在构建时写入，当前默认值是 `/`。前端设置页不会展示 API URL。

## 功能

- 使用 GPT Image Playground 前端体验。
- 保留当前项目的生图提示词模板。
- 保留 sub2api embedded token 获取 key 的能力。
- Go 内存队列代理 OpenAI-compatible 图片请求，避免 Cloudflare 长请求超时。
- 在线更新检查指向 [jhupo/ov-image-studio](https://github.com/jhupo/ov-image-studio) 的 GitHub Release。

## 本地开发

```bash
npm ci
cp deploy/.env.example .env
npm run dev
npm run dev:server
```

Vite 前端默认只负责开发页面。Go 服务读取 `.env`，默认把队列任务转给：

```text
http://127.0.0.1:8080
```

## Docker

镜像内运行 Go 服务，负责静态页面和 `/api/tasks` 队列接口，容器内监听 `0.0.0.0:80`。`BASE_URL` 是构建参数，不是运行时注入参数；`SUB2API_BASE_URL` 是运行时环境变量，用来配置服务器内部的 sub2api 地址。

```bash
docker build --build-arg BASE_URL=/ -f deploy/Dockerfile -t ov-image-studio .
docker run -d --name ov-image-studio -p 8081:80 --env-file .env ov-image-studio
```

如果 sub2api 只监听宿主机 `127.0.0.1:8080`，容器内不能直接用这个地址访问宿主机。推荐让 sub2api 监听宿主机内网地址，或使用 host 网络运行：

```bash
docker run -d --name ov-image-studio --network host --env-file .env ov-image-studio
```

GitHub Actions 发布镜像时会读取仓库变量 `BASE_URL`，未配置时使用 `/`。

发布后的镜像地址：

```bash
ghcr.io/jhupo/ov-image-studio:latest
```

## Caddy

同一台机器推荐这样配：

```caddyfile
image.ovload.com {
  handle /api/tasks* {
    reverse_proxy 127.0.0.1:8081
  }

  handle /api/v1/* {
    reverse_proxy 127.0.0.1:8080
  }

  handle {
    reverse_proxy 127.0.0.1:8081
  }
}
```

这里 `127.0.0.1:8080` 是 sub2api，`127.0.0.1:8081` 是链路云容器映射出来的端口。Go 服务会把前端提交的 `/images/generations`、`/images/edits`、`/responses` 等长耗时请求转发到 `SUB2API_BASE_URL`，所以这些路径不需要暴露给浏览器，也不需要在 Caddy 单独转给 sub2api。

## Release 更新

前端的更新提示读取：

```text
https://api.github.com/repos/jhupo/ov-image-studio/releases/latest
```

发布新版本时创建 `v*` 标签或在 GitHub Actions 手动运行 Docker workflow 即可构建镜像。
