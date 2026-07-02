---
title: Docker 部署
description: 使用 Docker Compose 部署无限画布
---

# Docker 部署

如果你希望在自己的机器或服务器上运行项目，可以直接使用 Docker Compose。

## 部署当前纯生图主分支

当前 `main` 分支是纯生图平台，不包含视频/音频创作能力。

```bash
git clone https://github.com/TangNPC/infinite-canvas.git
cd infinite-canvas
cp .env.example .env
docker compose up -d --build
```

启动后访问：

```text
http://localhost:13000
```

默认管理员账号：

```text
用户名：admin
密码：.env 中的 ADMIN_PASSWORD
```

服务器更新当前主分支：

```bash
cd infinite-canvas
git fetch origin
git checkout main
git pull --ff-only origin main
docker compose up -d --build
```

## 部署视频/音频保留分支

`codex/video-audio-upstream-v0.3.3` 是本项目保留的视频/音频合并成果分支。该分支包含视频创作台、视频/音频画布节点、Seedance/Agnes 视频链路和音频相关能力，适合仍需要这些能力的用户自行拉取。

全新部署：

```bash
git clone -b codex/video-audio-upstream-v0.3.3 https://github.com/TangNPC/infinite-canvas.git infinite-canvas-video-audio
cd infinite-canvas-video-audio
cp .env.example .env
docker compose up -d --build
```

已有仓库切换到该分支：

```bash
cd infinite-canvas
git fetch origin
git checkout codex/video-audio-upstream-v0.3.3
git pull --ff-only origin codex/video-audio-upstream-v0.3.3
docker compose up -d --build
```

该分支与当前 `main` 的纯生图平台定位不同，不建议在同一个数据目录中频繁来回切换运行。

## 本地构建镜像

如果需要基于当前源码构建镜像：

```bash
cp .env.example .env
docker compose -f docker-compose.local.yml up -d --build
```

## 文档

项目文档使用 `docs/*.md` 根目录 Markdown 体系，不再单独构建 Next.js 文档站镜像。部署时只需要随源码保留这些 Markdown 文件。

## 数据目录

`docker-compose.yml` 会把本地 `./data` 挂载到容器内 `/app/data`，用于保存 SQLite 数据库、提示词数据和上传素材。

Docker 部署时建议把 `.env` 中的 SQLite 路径设置为：

```text
DATABASE_DSN=/app/data/infinite-canvas.db
```

如果需要让火山方舟拉取本地上传的 Seedance 参考素材，还需要把 `PUBLIC_BASE_URL` 设置为公网可访问的站点地址。
