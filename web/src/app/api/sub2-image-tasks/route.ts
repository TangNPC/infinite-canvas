import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 900;

type Sub2SubmitResponse = {
    task_id?: string;
    poll_url?: string;
    status?: string;
    error?: { message?: string };
    message?: string;
    msg?: string;
};

type Sub2ReadyImage = {
    image_url?: string;
    imageUrl?: string;
    url?: string;
    b64_json?: string;
    status?: string;
};

type Sub2PollResponse = {
    task_id?: string;
    status?: string;
    image_url?: string;
    imageUrl?: string;
    ready_images?: Sub2ReadyImage[];
    images?: Sub2ReadyImage[];
    error?: { message?: string };
    message?: string;
    msg?: string;
};

const DEFAULT_BASE_URL = process.env.SUB2_IMAGE_BASE_URL || "";
const MAX_POLL_INTERVAL_MS = 3000;

export async function POST(request: NextRequest) {
    try {
        const inbound = await request.formData();
        const baseUrl = requireBaseUrl(stringField(inbound, "baseUrl") || DEFAULT_BASE_URL);
        const apiKey = bearerToken(request.headers.get("Authorization")) || stringField(inbound, "apiKey");
        if (!apiKey) return Response.json({ error: { message: "缺少 sub2 API Key" } }, { status: 400 });

        const timeoutSeconds = boundedInteger(stringField(inbound, "timeoutSeconds"), 600, 1, 3600);
        const outputFormat = stringField(inbound, "output_format") || "png";
        const submitForm = new FormData();
        copyStringField(inbound, submitForm, "model", "gpt-image-2");
        copyStringField(inbound, submitForm, "prompt", "");
        copyStringField(inbound, submitForm, "size", "");
        copyStringField(inbound, submitForm, "quality", "");
        submitForm.set("output_format", outputFormat);
        submitForm.set("count", stringField(inbound, "count") || stringField(inbound, "n") || "1");
        submitForm.set("batch_concurrency", stringField(inbound, "batch_concurrency") || "1");
        for (const file of inbound.getAll("image")) {
            if (file instanceof File) submitForm.append("image", file, file.name || "image.png");
        }

        const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
        const submitPayload = await fetchJson<Sub2SubmitResponse>(`${normalizedBaseUrl}/batch-image-tasks`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${apiKey}`,
                "Idempotency-Key": request.headers.get("Idempotency-Key") || randomUUID(),
            },
            body: submitForm,
        });
        if (!submitPayload.task_id) {
            throw new Error(sub2ErrorMessage(submitPayload) || "sub2 未返回 task_id");
        }

        const startedAt = Date.now();
        const timeoutMs = timeoutSeconds * 1000;
        let lastPayload: Sub2PollResponse = submitPayload;
        while (Date.now() - startedAt < timeoutMs) {
            const pollPath = submitPayload.poll_url || `/batch-image-tasks/${encodeURIComponent(submitPayload.task_id)}`;
            lastPayload = await fetchJson<Sub2PollResponse>(resolveSub2Url(normalizedBaseUrl, pollPath), {
                method: "GET",
                headers: { Authorization: `Bearer ${apiKey}` },
            });
            const images = collectImages(lastPayload, outputFormat, normalizedBaseUrl);
            if (images.length) return Response.json({ data: images, task_id: submitPayload.task_id, status: lastPayload.status });
            if (lastPayload.status === "failed") throw new Error(sub2ErrorMessage(lastPayload) || "sub2 图片任务失败");
            await delay(Math.min(MAX_POLL_INTERVAL_MS, Math.max(1000, Math.floor(timeoutMs / 120))));
        }

        return Response.json({ error: { message: "sub2 图片任务轮询超时", detail: lastPayload } }, { status: 504 });
    } catch (error) {
        return Response.json({ error: { message: error instanceof Error ? error.message : "sub2 图片任务失败" } }, { status: 502 });
    }
}

function normalizeBaseUrl(value: string) {
    return value.trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
}

function requireBaseUrl(value: string) {
    const baseUrl = value.trim();
    if (!baseUrl) throw new Error("缺少 sub2 图片接口地址，请在渠道配置或 SUB2_IMAGE_BASE_URL 中设置");
    return baseUrl;
}

function resolveSub2Url(baseUrl: string, value: string) {
    if (/^https?:\/\//i.test(value)) return value;
    return `${baseUrl}${value.startsWith("/") ? value : `/${value}`}`;
}

function bearerToken(value: string | null) {
    const match = value?.match(/^Bearer\s+(.+)$/i);
    return match?.[1]?.trim() || "";
}

function stringField(form: FormData, key: string) {
    const value = form.get(key);
    return typeof value === "string" ? value.trim() : "";
}

function copyStringField(from: FormData, to: FormData, key: string, fallback: string) {
    const value = stringField(from, key) || fallback;
    if (value) to.set(key, value);
}

function boundedInteger(value: string, fallback: number, min: number, max: number) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
}

async function fetchJson<T>(url: string, init: RequestInit): Promise<T> {
    const response = await fetch(url, init);
    const text = await response.text();
    const payload = text ? JSON.parse(text) : {};
    if (!response.ok) throw new Error(sub2ErrorMessage(payload) || `sub2 请求失败：${response.status}`);
    return payload as T;
}

function sub2ErrorMessage(payload: unknown) {
    if (!payload || typeof payload !== "object") return "";
    const record = payload as Record<string, unknown>;
    const error = record.error;
    if (error && typeof error === "object" && typeof (error as Record<string, unknown>).message === "string") return (error as Record<string, string>).message;
    return typeof record.message === "string" ? record.message : typeof record.msg === "string" ? record.msg : "";
}

function collectImages(payload: Sub2PollResponse, outputFormat: string, baseUrl: string) {
    const sources = [...(payload.ready_images || []), ...(payload.images || []), payload]
        .filter((item) => !item.status || item.status === "completed")
        .map((item) => item.image_url || item.imageUrl || item.url || item.b64_json)
        .filter((value): value is string => Boolean(value));
    return Array.from(new Set(sources)).map((source) => {
        if (source.startsWith("data:") || /^https?:\/\//i.test(source)) return { url: source };
        if (source.startsWith("/") || source.startsWith("generated-images/") || source.startsWith("images/")) return { url: resolveSub2Url(baseUrl, source) };
        return { b64_json: source, mime_type: `image/${outputFormat}` };
    });
}

function delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
