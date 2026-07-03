import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 900;

const DEFAULT_BASE_URL = process.env.SUB2_IMAGE_BASE_URL || "";

export async function POST(request: NextRequest) {
    try {
        const inbound = await request.formData();
        const baseUrl = requireBaseUrl(stringField(inbound, "baseUrl") || DEFAULT_BASE_URL);
        const apiKey = bearerToken(request.headers.get("Authorization")) || stringField(inbound, "apiKey");
        if (!apiKey) return Response.json({ error: { message: "缺少 sub2 API Key" } }, { status: 400 });

        const form = new FormData();
        copyStringField(inbound, form, "model", "gpt-image-2");
        copyStringField(inbound, form, "prompt", "");
        copyStringField(inbound, form, "size", "");
        copyStringField(inbound, form, "quality", "");
        copyStringField(inbound, form, "output_format", "png");
        copyStringField(inbound, form, "response_format", "");
        copyStringField(inbound, form, "n", "");
        copyStringField(inbound, form, "moderation", "");
        copyStringField(inbound, form, "output_compression", "");
        for (const file of inbound.getAll("image")) {
            if (file instanceof File) form.append("image", file, file.name || "image.png");
        }
        const mask = inbound.get("mask");
        if (mask instanceof File) form.set("mask", mask, mask.name || "mask.png");

        const upstream = await fetch(`${normalizeBaseUrl(baseUrl)}/images/edits`, {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}` },
            body: form,
        });
        return new Response(upstream.body, {
            status: upstream.status,
            statusText: upstream.statusText,
            headers: responseHeaders(upstream),
        });
    } catch (error) {
        return Response.json({ error: { message: error instanceof Error ? error.message : "sub2 图片编辑失败" } }, { status: 502 });
    }
}

function normalizeBaseUrl(value: string) {
    const normalized = value.trim().replace(/\/+$/, "");
    return normalized.toLowerCase().endsWith("/v1") ? normalized : `${normalized}/v1`;
}

function requireBaseUrl(value: string) {
    const baseUrl = value.trim();
    if (!baseUrl) throw new Error("缺少 sub2 图片接口地址，请在渠道配置或 SUB2_IMAGE_BASE_URL 中设置");
    return baseUrl;
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

function responseHeaders(response: Response) {
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    headers.delete("transfer-encoding");
    return headers;
}
