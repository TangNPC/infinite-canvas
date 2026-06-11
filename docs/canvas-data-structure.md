---
title: 画布数据结构
description: 画布本地存储、节点结构、图片文件与清理机制
---

# 画布数据结构

本文档说明当前纯生图分支画布在前端本地保存的数据结构、图片文件的存储和清理方式。

## 当前存储位置

- 画布项目 JSON：`localForage`，数据库名 `infinite-canvas`，storeName `app_state`，key 为 `infinite-canvas:canvas_store`。
- 我的素材 JSON：`localForage`，数据库名 `infinite-canvas`，storeName `app_state`，key 为 `infinite-canvas:asset_store`。
- 图片 Blob：`localForage`，数据库名 `infinite-canvas`，storeName `image_files`。

画布 JSON 不直接长期保存大体积 base64 图片。图片节点、助手图片和素材图片只保存展示 URL、`storageKey` 和元信息；有 `storageKey` 时通过图片存储读取。

## 画布项目结构

```ts
type CanvasProject = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  nodes: CanvasNodeData[];
  connections: CanvasConnection[];
  chatSessions: CanvasAssistantSession[];
  activeChatId: string | null;
  backgroundMode: "lines" | "dots" | "blank";
  viewport: { x: number; y: number; k: number };
};
```

## 节点结构

```ts
type CanvasNodeData = {
  id: string;
  type: "image" | "text" | "config";
  title: string;
  position: { x: number; y: number };
  width: number;
  height: number;
  metadata?: CanvasNodeMetadata;
};
```

`metadata` 常用字段：

```ts
type CanvasNodeMetadata = {
  content?: string;
  prompt?: string;
  status?: "idle" | "success" | "loading" | "error";
  errorDetails?: string;
  fontSize?: number;
  generationMode?: "text" | "image";
  model?: string;
  size?: string;
  count?: number;
  naturalWidth?: number;
  naturalHeight?: number;
  freeResize?: boolean;
  isBatchRoot?: boolean;
  batchRootId?: string;
  batchChildIds?: string[];
  primaryImageId?: string;
  imageBatchExpanded?: boolean;
  inputOrder?: string[];
  storageKey?: string;
  mimeType?: string;
  bytes?: number;
};
```

不同节点的使用方式：

- 图片节点：`content` 是当前可展示的图片 URL；`storageKey` 指向本地或服务端图片对象；`naturalWidth/naturalHeight/bytes/mimeType` 保存原图信息。
- 文本节点：`content` 保存文本内容；`fontSize` 保存字体大小；`prompt/status/errorDetails` 保存生成状态。
- 生成配置节点：`generationMode/model/size/count/inputOrder` 保存生成配置；`generationMode` 可选择文本或图片；上游输入通过 `connections` 计算。
- 图片组节点：根节点用 `isBatchRoot/batchChildIds/primaryImageId/imageBatchExpanded` 记录批量生成结果；子图节点用 `batchRootId` 指回根节点。

## 连线结构

```ts
type CanvasConnection = {
  id: string;
  fromNodeId: string;
  toNodeId: string;
};
```

连线只保存节点 ID，不保存端口坐标。渲染时根据节点位置和尺寸计算路径。

## 清理边界

- 删除图片节点时，只删除画布节点和连线。
- 删除“我的素材”或服务端素材时，系统会扫描引用后再决定是否清理图片对象。
- 当前纯生图分支不再维护视频/音频媒体缓存。
