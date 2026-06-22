---
title: 上游非视频音频功能合并说明
description: 记录 Gemini、停止生成和 Canvas Agent 合并范围
---

# 上游非视频音频功能合并说明

本次从上游 `basketikun/infinite-canvas@8cbe00e` 继续合入非视频/音频功能，当前分支仍保持纯生图平台定位，并保留本地 Go 后端、会员/支付、账号同步、算力点、后台管理和对象存储能力。

## 已合入能力

- Gemini API 格式：模型渠道新增 `protocol: openai | gemini`，后台管理和配置弹窗都可以选择协议。
- Gemini 渠道：支持模型列表拉取、文本问答、文生图、参考图图生图和 Agent 工具调用。
- 后端 Gemini 代理：云端 Gemini 渠道继续经过 `/api/v1/*`，后端完成 Gemini 请求/响应转换，并保留 AI 日志与算力点消费/返还逻辑。
- 生成停止：画布配置节点和提示词浮层生成中可点击“停止”，取消请求后节点恢复空闲，不标记失败。
- Canvas Agent：新增 `canvas-agent` 本地子项目、画布 Agent store、Agent UI 和纯生图 ops。
- 网页 Agent Loop：画布助手新增 Agent 模式，使用当前文本模型渠道调用工具；工具只开放读取画布、读取选区、创建文本节点、创建生图流程、选择节点和触发文本/图片生成。

## 未合入能力

- 视频/音频和 Seedance：当前主线是纯生图平台，相关能力保留在 `codex/video-audio-upstream-v0.3.3`。
- WebDAV：暂不合入。它需要先设计与账号同步、R2/对象存储、删除传播和冲突合并的关系。
- 上游纯前端化架构：暂不合入。当前项目继续保留 Go 后端、数据库、会员支付、后台管理、算力点和代理计费链路。
- 新文档站结构：不合入 `docs/content/docs/...`，继续维护根目录 Markdown 文档体系。

## 验收重点

- Gemini 渠道模型拉取、文生图、参考图图生图、文本问答和 Agent 工具调用。
- Gemini 蒙版局部重绘应明确提示不支持，不应降级到其他接口。
- 停止生成后不应出现失败卡片或错误状态。
- 本地 Canvas Agent 能连接并执行纯生图 ops。
- 网页 Agent Loop 不应出现视频/音频工具或文案。

## 本次审查结论

- 当前分支相对 `main@v0.3.4` 已包含大图 Blob 修复、Gemini 协议、生成停止、Canvas Agent、网页 Agent Loop 和后续本地 Agent 稳定性修复。
- 当前上游 `basketikun/infinite-canvas@8cbe00e` 的 Gemini 能力已合入；上游后续 `v0.4.0` 中的纯前端化、WebDAV、视频/音频和部署结构调整仍按约定未进入当前分支。
- 审查中删除了旧文档站残留的 `docs/next.config.mjs`、`docs/.dockerignore`、`docs/.gitignore` 和系统垃圾 `.DS_Store`。
- 审查中清理了纯生图分支里已不可达的视频素材提示文案，避免误导为当前主线仍支持视频素材。
