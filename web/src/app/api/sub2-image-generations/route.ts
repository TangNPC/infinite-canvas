import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 900;

const DEFAULT_BASE_URL = process.env.SUB2_IMAGE_BASE_URL || "";

export async function POST(request: NextRequest) {
    try {
        const body = (await request.json()) as { baseUrl?: string; payload?: Record<string, unknown> };
        const apiKey = bearerToken(request.headers.get("Authorization"));
        if (!apiKey) return Response.json({ error: { message: "缺少 sub2 API Key" } }, { status: 400 });

        const baseUrl = requireBaseUrl(body.baseUrl || DEFAULT_BASE_URL);
        const upstream = await fetch(`${normalizeBaseUrl(baseUrl)}/images/generations`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(body.payload || {}),
        });
        return new Response(upstream.body, {
            status: upstream.status,
            statusText: upstream.statusText,
            headers: responseHeaders(upstream),
        });
    } catch (error) {
        return Response.json({ error: { message: error instanceof Error ? error.message : "sub2 图片生成失败" } }, { status: 502 });
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

function responseHeaders(response: Response) {
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    headers.delete("transfer-encoding");
    return headers;
}
