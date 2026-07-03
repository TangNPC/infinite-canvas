import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 900;

type Sub2ResponsesProxyBody = {
    baseUrl?: string;
    payload?: Record<string, unknown>;
};

const DEFAULT_BASE_URL = process.env.SUB2_CHAT_BASE_URL || "";

export async function POST(request: NextRequest) {
    try {
        const apiKey = bearerToken(request.headers.get("Authorization"));
        if (!apiKey) return Response.json({ error: { message: "缺少 sub2 API Key" } }, { status: 400 });

        const body = (await request.json()) as Sub2ResponsesProxyBody;
        const baseUrl = normalizeBaseUrl(requireBaseUrl(body.baseUrl || DEFAULT_BASE_URL));
        const upstream = await fetch(`${baseUrl}/responses`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
                Accept: request.headers.get("Accept") || "text/event-stream",
            },
            body: JSON.stringify(body.payload || {}),
        });

        return new Response(upstream.body, {
            status: upstream.status,
            statusText: upstream.statusText,
            headers: responseHeaders(upstream),
        });
    } catch (error) {
        return Response.json({ error: { message: error instanceof Error ? error.message : "sub2 对话请求失败" } }, { status: 502 });
    }
}

export function OPTIONS() {
    return new Response(null, { status: 204 });
}

function normalizeBaseUrl(value: string) {
    const normalized = value.trim().replace(/\/+$/, "");
    return normalized.toLowerCase().endsWith("/v1") ? normalized : `${normalized}/v1`;
}

function requireBaseUrl(value: string) {
    const baseUrl = value.trim();
    if (!baseUrl) throw new Error("缺少 sub2 对话接口地址，请在渠道配置或 SUB2_CHAT_BASE_URL 中设置");
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
