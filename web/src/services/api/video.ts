import axios from "axios";

import { dataUrlToFile } from "@/lib/image-utils";
import { boolConfig, buildSeedancePromptText, isSeedanceVideoConfig, normalizeSeedanceDuration, normalizeSeedanceRatio, normalizeSeedanceResolution, seedanceVideoReferenceError, SEEDANCE_REFERENCE_LIMITS } from "@/lib/seedance-video";
import { getMediaBlob, type UploadedFile } from "@/services/file-storage";
import { imageToDataUrl } from "@/services/image-storage";
import { buildApiUrl, channelIdForActiveModel, localChannelForActiveModel, type AiConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";

type OpenAIVideoResponse = { id: string; status?: string; video_url?: string; url?: string; progress?: number; error?: { message?: string } };
type ApiVideoEnvelope = { code: number; data?: OpenAIVideoResponse | null; msg?: string; message?: string };
type ApiVideoResponse = OpenAIVideoResponse | ApiVideoEnvelope;
type SeedanceTask = {
    id: string;
    status?: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "expired";
    error?: { code?: string; message?: string } | null;
    content?: { video_url?: string; last_frame_url?: string } | null;
};
type ApiEnvelope<T> = T | { code?: number; data?: T | null; msg?: string; message?: string };
type ReferenceMediaUploadResponse = { id: string; url: string; mimeType: string; bytes: number };

export type VideoResponse = OpenAIVideoResponse | SeedanceTask;
export type VideoGenerationTask = { id: string; provider: "openai" | "seedance"; model: string };
export type VideoGenerationTaskState = { status: "pending"; progress?: number } | { status: "completed"; result: VideoGenerationResult } | { status: "failed"; error: string; detail?: unknown };
export type VideoGenerationResult = { id: string; url: string; durationMs: number; width: number; height: number; bytes: number; mimeType: string; task: VideoResponse };

export class VideoRequestError extends Error {
    detail?: string;

    constructor(message: string, detail?: unknown) {
        super(message);
        this.name = "VideoRequestError";
        this.detail = formatErrorDetail(detail);
    }
}

function aiApiUrl(config: AiConfig, path: string) {
    if (config.channelMode === "remote") return `/api/v1${path}`;
    const channel = localChannelForActiveModel(config);
    return buildApiUrl(channel?.baseUrl || config.baseUrl, path);
}

function aiHeaders(config: AiConfig, contentType?: string) {
    const token = useUserStore.getState().token;
    if (config.channelMode === "remote" && !token) throw new Error("请先登录后再使用云端渠道");
    return config.channelMode === "remote"
        ? { Authorization: `Bearer ${token}`, ...(channelIdForActiveModel(config) ? { "X-Model-Channel-ID": channelIdForActiveModel(config) } : {}), ...(contentType ? { "Content-Type": contentType } : {}) }
        : { Authorization: `Bearer ${localChannelForActiveModel(config)?.apiKey || config.apiKey}`, ...(contentType ? { "Content-Type": contentType } : {}) };
}

function refreshRemoteUser(config: AiConfig) {
    if (config.channelMode === "remote") void useUserStore.getState().hydrateUser();
}

export async function requestVideoGeneration(config: AiConfig, prompt: string, references: ReferenceImage[] = [], videoReferences: ReferenceVideo[] = [], audioReferences: ReferenceAudio[] = [], onProgress?: (progress: number) => void) {
    const startedAt = Date.now();
    const task = await withAiRequestRetry(config, () => createVideoGenerationTask(config, prompt, references, videoReferences, audioReferences, startedAt));
    const delayMs = task.provider === "seedance" ? 5000 : 2500;
    for (let attempt = 0; attempt < 120; attempt += 1) {
        const state = await withAiRequestRetry(config, () => pollVideoGenerationTask(config, task, startedAt));
        if (state.status === "completed") return { ...state.result, durationMs: Date.now() - startedAt };
        if (state.status === "failed") throw new VideoRequestError(state.error, state.detail);
        if (typeof state.progress === "number") onProgress?.(state.progress);
        if (attempt === 119) throw new VideoRequestError(`${task.provider === "seedance" ? "Seedance " : ""}视频生成超时，请稍后重试`, task);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    throw new VideoRequestError("视频生成超时，请稍后重试", task);
}

async function withAiRequestRetry<T>(config: AiConfig, run: () => Promise<T>): Promise<T> {
    const retries = normalizeRetryAttempts(config.retryAttempts);
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
            return await run();
        } catch (error) {
            lastError = error;
            if (attempt >= retries) break;
            await new Promise((resolve) => setTimeout(resolve, 300 * 2 ** attempt));
        }
    }
    throw lastError;
}

function normalizeRetryAttempts(value: string) {
    const count = Math.floor(Number(value) || 0);
    return Math.max(0, Math.min(5, count));
}

export async function createVideoGenerationTask(config: AiConfig, prompt: string, references: ReferenceImage[] = [], videoReferences: ReferenceVideo[] = [], audioReferences: ReferenceAudio[] = [], logStartedAt = Date.now()): Promise<VideoGenerationTask> {
    const model = (config.model || config.videoModel).trim();
    assertVideoConfig(config, model);
    const systemPrompt = (config.systemPrompts.video || config.systemPrompt).trim();
    const fullPrompt = systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
    if (isSeedanceVideoConfig({ ...config, model })) {
        return createSeedanceTask(config, model, fullPrompt, references, videoReferences, audioReferences, logStartedAt);
    }
    if (videoReferences.length || audioReferences.length) {
        throw new VideoRequestError("当前视频接口不支持参考视频或参考音频，请切换到 Seedance 2.0 / 火山 Agent Plan 模型，或移除参考素材");
    }
    return createOpenAIVideoTask(config, model, fullPrompt, references, logStartedAt);
}

export async function pollVideoGenerationTask(config: AiConfig, task: VideoGenerationTask, logStartedAt = Date.now()): Promise<VideoGenerationTaskState> {
    assertVideoConfig(config, task.model);
    return task.provider === "seedance" ? pollSeedanceTask(config, task, logStartedAt) : pollOpenAIVideoTask(config, task, logStartedAt);
}

export async function storeGeneratedVideo(result: VideoGenerationResult): Promise<UploadedFile> {
    return { url: result.url, storageKey: "", bytes: result.bytes, mimeType: result.mimeType, width: result.width, height: result.height };
}

async function createOpenAIVideoTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], startedAt: number): Promise<VideoGenerationTask> {
    const body = await createOpenAIVideoRequestBody(config, model, prompt, references);
    try {
        const created = unwrapVideoResponse((await axios.post<ApiVideoResponse>(aiApiUrl(config, "/videos"), body, { headers: aiHeaders(config) })).data);
        if (!created.id) throw new VideoRequestError("视频接口没有返回任务 ID", created);
        void writeVideoAICallLog(config, model, "/videos", "POST", startedAt, 200, stringifyLogPayload(summarizeVideoRequestBody(body)), stringifyLogPayload(created), "");
        return { id: created.id, provider: "openai", model };
    } catch (error) {
        const { message, detail, status } = readAxiosError(error, "视频任务创建失败");
        void writeVideoAICallLog(config, model, "/videos", "POST", startedAt, status, stringifyLogPayload(summarizeVideoRequestBody(body)), stringifyLogPayload(detail), message);
        throw new VideoRequestError(message, detail);
    }
}

async function pollOpenAIVideoTask(config: AiConfig, task: VideoGenerationTask, startedAt: number): Promise<VideoGenerationTaskState> {
    try {
        const video = unwrapVideoResponse((await axios.get<ApiVideoResponse>(aiApiUrl(config, `/videos/${task.id}`), { headers: aiHeaders(config), params: config.channelMode === "remote" ? { model: task.model } : undefined })).data);
        void writeVideoAICallLog(config, task.model, `/videos/${task.id}`, "GET", startedAt, 200, stringifyLogPayload({ model: task.model }), stringifyLogPayload(video), "");
        if (isFailedVideoStatus(video.status)) return { status: "failed", error: video.error?.message || "视频生成失败", detail: video };
        const url = video.video_url || video.url || firstVideoUrl(video);
        if (isCompletedVideoStatus(video.status) || url) {
            if (url) {
                refreshRemoteUser(config);
                return { status: "completed", result: buildVideoGenerationResult(video, url, Date.now() - startedAt) };
            }
            const content = await axios.get<Blob>(aiApiUrl(config, `/videos/${task.id}/content`), { headers: aiHeaders(config), params: config.channelMode === "remote" ? { model: task.model } : undefined, responseType: "blob" });
            await assertVideoBlob(content.data);
            const objectUrl = URL.createObjectURL(content.data);
            refreshRemoteUser(config);
            return { status: "completed", result: { id: task.id, url: objectUrl, durationMs: Date.now() - startedAt, width: 1280, height: 720, bytes: content.data.size, mimeType: content.data.type || "video/mp4", task: video } };
        }
        return { status: "pending", progress: video.progress };
    } catch (error) {
        const { message, detail, status } = readAxiosError(error, "视频任务查询失败");
        void writeVideoAICallLog(config, task.model, `/videos/${task.id}`, "GET", startedAt, status, stringifyLogPayload({ model: task.model }), stringifyLogPayload(detail), message);
        throw new VideoRequestError(message, detail);
    }
}

async function createSeedanceTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], videoReferences: ReferenceVideo[], audioReferences: ReferenceAudio[], startedAt: number): Promise<VideoGenerationTask> {
    if (audioReferences.length && !references.length && !videoReferences.length) throw new VideoRequestError("Seedance 参考音频不能单独使用，请同时添加参考图或参考视频");
    assertSeedanceVideoReferences(videoReferences);
    assertSeedanceAudioReferences(audioReferences);
    const content = await buildSeedanceContent(config, prompt, references, videoReferences, audioReferences);
    if (!content.length) throw new VideoRequestError("请输入视频提示词，或连接参考图片/视频/音频");
    const payload = {
        model,
        content,
        ratio: normalizeSeedanceRatio(config.size),
        resolution: normalizeSeedanceResolution(config.vquality, model),
        duration: normalizeSeedanceDuration(config.videoSeconds),
        generate_audio: boolConfig(config.videoGenerateAudio, true),
        watermark: boolConfig(config.videoWatermark, false),
    };

    try {
        const created = unwrapSeedanceTask((await axios.post<ApiEnvelope<SeedanceTask>>(seedanceApiUrl(config), payload, { headers: aiHeaders(config, "application/json") })).data);
        if (!created.id) throw new VideoRequestError("Seedance 接口没有返回任务 ID", created);
        void writeVideoAICallLog(config, model, "/contents/generations/tasks", "POST", startedAt, 200, stringifyLogPayload(payload), stringifyLogPayload(created), "");
        return { id: created.id, provider: "seedance", model };
    } catch (error) {
        const { message, detail, status } = readAxiosError(error, "Seedance 任务创建失败");
        void writeVideoAICallLog(config, model, "/contents/generations/tasks", "POST", startedAt, status, stringifyLogPayload(payload), stringifyLogPayload(detail), message);
        throw new VideoRequestError(message, detail);
    }
}

async function pollSeedanceTask(config: AiConfig, task: VideoGenerationTask, startedAt: number): Promise<VideoGenerationTaskState> {
    try {
        const state = unwrapSeedanceTask((await axios.get<ApiEnvelope<SeedanceTask>>(seedanceApiUrl(config, task.id), { headers: aiHeaders(config), params: config.channelMode === "remote" ? { model: task.model } : undefined })).data);
        void writeVideoAICallLog(config, task.model, `/contents/generations/tasks/${task.id}`, "GET", startedAt, 200, stringifyLogPayload({ model: task.model }), stringifyLogPayload(state), "");
        if (state.status === "succeeded") {
            const url = state.content?.video_url;
            if (!url) return { status: "failed", error: "Seedance 任务成功但没有返回视频 URL", detail: state };
            refreshRemoteUser(config);
            return { status: "completed", result: buildVideoGenerationResult(state, url, Date.now() - startedAt) };
        }
        if (state.status === "failed" || state.status === "cancelled" || state.status === "expired") return { status: "failed", error: state.error?.message || `Seedance 视频生成${state.status === "expired" ? "超时" : "失败"}`, detail: state };
        return { status: "pending" };
    } catch (error) {
        const { message, detail, status } = readAxiosError(error, "Seedance 任务查询失败");
        void writeVideoAICallLog(config, task.model, `/contents/generations/tasks/${task.id}`, "GET", startedAt, status, stringifyLogPayload({ model: task.model }), stringifyLogPayload(detail), message);
        throw new VideoRequestError(message, detail);
    }
}

async function createOpenAIVideoRequestBody(config: AiConfig, model: string, prompt: string, references: ReferenceImage[]) {
    const body = new FormData();
    body.append("model", model);
    body.append("prompt", prompt);
    body.append("seconds", normalizeOpenAIVideoSeconds(config.videoSeconds));
    const size = normalizeOpenAIVideoSize(config.size);
    if (size) body.append("size", size);
    body.append("resolution_name", normalizeOpenAIVideoResolution(config.vquality));
    body.append("preset", "normal");
    const files = await Promise.all(references.slice(0, 7).map(async (image) => dataUrlToFile({ ...image, dataUrl: await imageToDataUrl(image) })));
    files.forEach((file) => body.append("input_reference[]", file));
    return body;
}

async function buildSeedanceContent(config: AiConfig, prompt: string, references: ReferenceImage[], videoReferences: ReferenceVideo[], audioReferences: ReferenceAudio[]) {
    const content: Array<Record<string, unknown>> = [];
    const text = buildSeedancePromptText(prompt, references, videoReferences, audioReferences);
    if (text) content.push({ type: "text", text });
    for (const image of references.slice(0, SEEDANCE_REFERENCE_LIMITS.images)) {
        content.push({ type: "image_url", image_url: { url: await resolveSeedanceImageUrl(config, image) }, role: "reference_image" });
    }
    for (const video of videoReferences.slice(0, SEEDANCE_REFERENCE_LIMITS.videos)) {
        content.push({ type: "video_url", video_url: { url: await resolveSeedanceVideoUrl(video) }, role: "reference_video" });
    }
    for (const audio of audioReferences.slice(0, SEEDANCE_REFERENCE_LIMITS.audios)) {
        content.push({ type: "audio_url", audio_url: { url: await resolveSeedanceAudioUrl(audio) }, role: "reference_audio" });
    }
    return content;
}

async function resolveSeedanceImageUrl(config: AiConfig, image: ReferenceImage) {
    const directUrl = image.url || image.dataUrl;
    if (isPublicMediaUrl(directUrl) || directUrl.startsWith("asset://")) return directUrl;
    const dataUrl = await imageToDataUrl(image);
    if (!dataUrl) throw new VideoRequestError("参考图读取失败，请换一张图片或重新上传");
    if (config.channelMode === "remote" || isSeedanceVideoConfig(config)) return uploadReferenceMedia(dataUrlToFile({ ...image, dataUrl }));
    return dataUrl;
}

async function resolveSeedanceVideoUrl(video: ReferenceVideo) {
    if (isPublicMediaUrl(video.url) || video.url.startsWith("asset://")) return video.url;
    let blob: Blob | null = null;
    if (video.storageKey) blob = await getMediaBlob(video.storageKey);
    if (!blob && video.url?.startsWith("blob:")) blob = await (await fetch(video.url)).blob();
    if (!blob) throw new VideoRequestError("参考视频必须是公网 URL、素材 ID，或本地已保存的视频");
    return uploadReferenceMedia(new File([blob], video.name || "reference-video.mp4", { type: video.type || blob.type || "video/mp4" }));
}

async function resolveSeedanceAudioUrl(audio: ReferenceAudio) {
    if (isPublicMediaUrl(audio.url) || audio.url.startsWith("asset://")) return audio.url;
    let blob: Blob | null = null;
    if (audio.storageKey) blob = await getMediaBlob(audio.storageKey);
    if (!blob && audio.url?.startsWith("blob:")) blob = await (await fetch(audio.url)).blob();
    if (!blob) throw new VideoRequestError("参考音频必须是公网 URL、素材 ID，或本地已保存的音频");
    return uploadReferenceMedia(new File([blob], audio.name || "reference-audio.mp3", { type: audio.type || blob.type || "audio/mpeg" }));
}

async function uploadReferenceMedia(file: File) {
    const token = useUserStore.getState().token;
    if (!token) throw new VideoRequestError("使用本地参考素材需要先登录，并在服务端配置 PUBLIC_BASE_URL");
    const body = new FormData();
    body.append("file", file, file.name);
    const response = await axios.post<ApiEnvelope<ReferenceMediaUploadResponse>>("/api/v1/media/references", body, { headers: { Authorization: `Bearer ${token}` } });
    const payload = unwrapEnvelope(response.data, "参考素材上传失败");
    if (!payload.url) throw new VideoRequestError("参考素材上传后没有返回公网 URL", payload);
    return payload.url;
}

function seedanceApiUrl(config: AiConfig, taskId?: string) {
    if (config.channelMode === "remote") return taskId ? `/api/v1/videos/${encodeURIComponent(taskId)}` : "/api/v1/videos";
    return buildApiUrl(localChannelForActiveModel(config)?.baseUrl || config.baseUrl, `/contents/generations/tasks${taskId ? `/${encodeURIComponent(taskId)}` : ""}`);
}

function assertVideoConfig(config: AiConfig, model: string) {
    if (!model) throw new VideoRequestError("请先配置视频模型");
    const channel = localChannelForActiveModel(config);
    if (config.channelMode === "local" && !(channel?.baseUrl || config.baseUrl).trim()) throw new VideoRequestError("请先配置 Base URL");
    if (config.channelMode === "local" && !(channel?.apiKey || config.apiKey).trim()) throw new VideoRequestError("请先配置 API Key");
}

function assertSeedanceVideoReferences(videoReferences: ReferenceVideo[]) {
    const error = seedanceVideoReferenceError(videoReferences);
    if (error) throw new VideoRequestError(error);
}

function assertSeedanceAudioReferences(audioReferences: ReferenceAudio[]) {
    let total = 0;
    for (const audio of audioReferences) {
        if (audio.durationMs) {
            if (audio.durationMs < 2000 || audio.durationMs > 15000) throw new VideoRequestError("Seedance 参考音频单个时长需要在 2-15 秒之间");
            total += audio.durationMs;
        }
    }
    if (total > 15000) throw new VideoRequestError("Seedance 参考音频总时长不能超过 15 秒");
}

function isPublicMediaUrl(value?: string) {
    if (!value || value.startsWith("blob:") || value.startsWith("data:")) return false;
    if (value.startsWith("asset://")) return true;
    try {
        const url = new URL(value, typeof window === "undefined" ? undefined : window.location.origin);
        return ["http:", "https:"].includes(url.protocol) && !["localhost", "127.0.0.1", "::1"].includes(url.hostname);
    } catch {
        return false;
    }
}

function unwrapEnvelope<T>(payload: ApiEnvelope<T>, fallback: string): T {
    if (!payload) throw new VideoRequestError(fallback);
    if (typeof payload === "object" && "code" in payload) {
        const envelope = payload as { code?: number; data?: T | null; msg?: string; message?: string };
        if (typeof envelope.code === "number" && envelope.code !== 0) throw new VideoRequestError(envelope.msg || envelope.message || fallback, payload);
        if (!envelope.data) throw new VideoRequestError(envelope.msg || envelope.message || fallback, payload);
        return envelope.data;
    }
    return payload as T;
}

function unwrapSeedanceTask(payload: ApiEnvelope<SeedanceTask>): SeedanceTask {
    const task = unwrapEnvelope(payload, "Seedance 接口没有返回任务");
    return { ...task, id: firstString(task.id, (task as Record<string, unknown>).task_id, (task as Record<string, unknown>).request_id) };
}

function unwrapVideoResponse(payload: ApiVideoResponse): OpenAIVideoResponse {
    if (!payload) throw new VideoRequestError("接口没有返回视频任务");
    if (isVideoEnvelope(payload)) {
        if (payload.code !== 0) throw new VideoRequestError(payload.msg || payload.message || "请求失败", payload);
        if (!payload.data) throw new VideoRequestError("接口没有返回视频任务", payload);
        return normalizeVideoResponse(payload.data);
    }
    const error = videoPayloadErrorMessage(payload);
    if (error) throw new VideoRequestError(error, payload);
    return normalizeVideoResponse(payload);
}

function isVideoEnvelope(payload: ApiVideoResponse): payload is ApiVideoEnvelope {
    return "code" in payload && typeof payload.code === "number";
}

async function assertVideoBlob(blob: Blob) {
    if (!blob.type.includes("json") && !blob.type.startsWith("text/")) return;
    let payload: { code?: number; msg?: string; error?: { message?: string } };
    try {
        payload = JSON.parse(await blob.text()) as { code?: number; msg?: string; error?: { message?: string } };
    } catch {
        return;
    }
    if (typeof payload.code === "number" && payload.code !== 0) throw new VideoRequestError(payload.msg || "视频下载失败", payload);
    if (payload.error?.message) throw new VideoRequestError(payload.error.message, payload);
}

function readAxiosError(error: unknown, fallback: string) {
    if (error instanceof VideoRequestError) return { message: error.message, detail: error.detail || error.stack || error.message, status: 0 };
    if (axios.isAxiosError<{ error?: { message?: string }; msg?: string; message?: string; code?: number }>(error)) {
        const responseData = error.response?.data;
        return { message: responseData?.msg || responseData?.error?.message || responseData?.message || (error.response?.status ? `${fallback}：${error.response.status}` : fallback), detail: responseData || error.message, status: error.response?.status || 0 };
    }
    return { message: error instanceof Error ? error.message : fallback, detail: error instanceof Error ? error.stack || error.message : error, status: 0 };
}

async function writeVideoAICallLog(config: AiConfig, model: string, endpoint: string, method: "GET" | "POST", startedAt: number, status: number, requestBody: string, responseBody: string, error: string) {
    if (config.channelMode !== "local") return;
    const token = useUserStore.getState().token;
    if (!token) return;
    const channel = localChannelForActiveModel(config);
    await fetch("/api/v1/ai-logs", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
            endpoint,
            method,
            model,
            channelId: channel?.id || config.activeChannelId || "",
            channelName: channel?.name || "本地直连",
            status,
            durationMs: Date.now() - startedAt,
            credits: 0,
            requestBody,
            responseBody,
            error,
        }),
    }).catch(() => {});
}

function summarizeVideoRequestBody(value: unknown) {
    if (value instanceof FormData) {
        const fields: Record<string, string[]> = {};
        const files: Array<{ field: string; name: string; size: number; type: string }> = [];
        value.forEach((item, key) => {
            if (item instanceof File) {
                files.push({ field: key, name: item.name, size: item.size, type: item.type });
                return;
            }
            fields[key] = [...(fields[key] || []), String(item)];
        });
        return { fields, files };
    }
    return value;
}

function stringifyLogPayload(value: unknown) {
    if (typeof value === "string") return value;
    try {
        const cloned = JSON.parse(JSON.stringify(value)) as unknown;
        redactLogMedia(cloned);
        return JSON.stringify(cloned, null, 2);
    } catch {
        return String(value || "");
    }
}

function redactLogMedia(value: unknown) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
        value.forEach(redactLogMedia);
        return;
    }
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
        const item = record[key];
        if (typeof item === "string" && (item.startsWith("data:image/") || item.includes("data:image/") || (item.length > 2048 && looksLikeBase64(item)))) {
            record[key] = `[redacted media/string len=${item.length}]`;
            continue;
        }
        redactLogMedia(item);
    }
}

function looksLikeBase64(value: string) {
    return /^[A-Za-z0-9+/=]+$/.test(value.slice(0, 200));
}

function normalizeVideoResponse(value: unknown): OpenAIVideoResponse {
    const record = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
    const id = firstString(record.id, record.request_id, record.task_id, record.video_id, firstTaskId(record));
    return {
        ...(record as OpenAIVideoResponse),
        id,
        status: firstString(record.status, record.state),
        video_url: firstString(record.video_url, record.videoUrl, record.remixed_from_video_id, record.output_url, record.download_url, firstVideoUrl(record)),
        progress: typeof record.progress === "number" ? record.progress : typeof record.progress === "string" ? parseFloat(record.progress) : undefined,
    };
}

function buildVideoGenerationResult(task: VideoResponse, url: string, durationMs: number): VideoGenerationResult {
    const size = parseVideoSize((task as Record<string, unknown>).size);
    return { id: task.id, url, durationMs, width: size.width, height: size.height, bytes: 0, mimeType: "video/mp4", task };
}

function parseVideoSize(value: unknown) {
    const match = typeof value === "string" ? value.match(/^(\d+)x(\d+)$/) : null;
    return { width: match ? Number(match[1]) : 1280, height: match ? Number(match[2]) : 720 };
}

function firstString(...values: unknown[]) {
    return values.find((value): value is string => typeof value === "string" && !!value.trim())?.trim() || "";
}

function isCompletedVideoStatus(status?: string) {
    return ["completed", "complete", "done", "succeeded", "success"].includes((status || "").toLowerCase());
}

function isFailedVideoStatus(status?: string) {
    return ["failed", "fail", "error", "cancelled", "canceled"].includes((status || "").toLowerCase());
}

function videoPayloadErrorMessage(value: unknown): string {
    const record = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
    if (typeof record.code === "number" && record.code !== 0) return firstString(record.msg, record.message, nestedMessage(record.error)) || "视频请求失败";
    if (typeof record.code === "string" && /fail|error/i.test(record.code)) return firstString(nestedMessage(record.error), record.msg, record.message, record.code);
    return firstString(nestedMessage(record.error));
}

function nestedMessage(value: unknown) {
    if (typeof value === "string") return value;
    if (!value || typeof value !== "object") return "";
    return firstString((value as Record<string, unknown>).message);
}

function firstVideoUrl(value: unknown, depth = 0): string {
    if (depth > 5 || value == null) return "";
    if (typeof value === "string") return /^https?:\/\//.test(value) ? value : "";
    if (Array.isArray(value)) {
        for (const item of value) {
            const found = firstVideoUrl(item, depth + 1);
            if (found) return found;
        }
        return "";
    }
    if (typeof value !== "object") return "";
    const record = value as Record<string, unknown>;
    const direct = firstString(record.video_url, record.videoUrl, record.url, record.remixed_from_video_id, record.output_url, record.download_url, record.file_url);
    if (/^https?:\/\//.test(direct)) return direct;
    for (const key of ["video", "data", "output", "result", "content"]) {
        const found = firstVideoUrl(record[key], depth + 1);
        if (found) return found;
    }
    return "";
}

function firstTaskId(value: unknown, depth = 0): string {
    if (depth > 4 || value == null) return "";
    if (Array.isArray(value)) {
        for (const item of value) {
            const found = firstTaskId(item, depth + 1);
            if (found) return found;
        }
        return "";
    }
    if (typeof value !== "object") return "";
    const record = value as Record<string, unknown>;
    const direct = firstString(record.id, record.request_id, record.task_id, record.video_id);
    if (direct) return direct;
    for (const key of ["data", "result", "output", "video"]) {
        const found = firstTaskId(record[key], depth + 1);
        if (found) return found;
    }
    return "";
}

function normalizeOpenAIVideoSeconds(value: string) {
    const seconds = Math.floor(Number(value) || 6);
    return String(Math.max(1, Math.min(20, seconds)));
}

function normalizeOpenAIVideoSize(value: string) {
    if (value === "auto" || value === "adaptive") return null;
    const size = value || "1280x720";
    if (/^\d+x\d+$/.test(size)) return size;
    return ["9:16", "2:3", "3:4"].includes(size) ? "720x1280" : "1280x720";
}

function normalizeOpenAIVideoResolution(value: string) {
    if (value === "low") return "480p";
    if (value === "auto" || value === "high" || value === "medium") return "720p";
    const resolution = value.replace(/p$/i, "") || "720";
    return `${resolution}p`;
}

function formatErrorDetail(detail: unknown) {
    if (detail == null) return "";
    if (typeof detail === "string") return detail;
    try {
        return JSON.stringify(detail, null, 2);
    } catch {
        return String(detail);
    }
}
