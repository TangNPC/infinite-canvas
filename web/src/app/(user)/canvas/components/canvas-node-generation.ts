import type { ChatCompletionMessage } from "@/services/api/image";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "../types";

export type NodeGenerationContext = {
    prompt: string;
    referenceImages: ReferenceImage[];
    referenceVideos: ReferenceVideo[];
    referenceAudios: ReferenceAudio[];
    textCount: number;
    imageCount: number;
};

export type NodeGenerationInput = {
    nodeId: string;
    type: "text" | "image" | "video" | "audio";
    title: string;
    text?: string;
    image?: ReferenceImage;
    video?: ReferenceVideo;
    audio?: ReferenceAudio;
};

export function buildNodeGenerationContext(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[], prompt: string): NodeGenerationContext {
    const inputs = buildNodeGenerationInputs(nodeId, nodes, connections);
    const upstreamText = inputs
        .map((input) => input.text)
        .filter(Boolean)
        .join("\n\n");
    const referenceImages = inputs.map((input) => input.image).filter((image): image is ReferenceImage => Boolean(image));
    const referenceVideos = inputs.map((input) => input.video).filter((video): video is ReferenceVideo => Boolean(video));
    const referenceAudios = inputs.map((input) => input.audio).filter((audio): audio is ReferenceAudio => Boolean(audio));

    return {
        prompt: upstreamText ? `${prompt}\n\n${upstreamText}` : prompt,
        referenceImages,
        referenceVideos,
        referenceAudios,
        textCount: inputs.filter((input) => input.type === "text").length,
        imageCount: referenceImages.length,
    };
}

export function buildNodeGenerationInputs(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]): NodeGenerationInput[] {
    return getOrderedUpstreamNodes(nodeId, nodes, connections).flatMap((node): NodeGenerationInput[] => {
        const image = readReferenceImage(node);
        if (image) return [{ nodeId: node.id, type: "image" as const, title: node.title, image }];
        const video = readReferenceVideo(node);
        if (video) return [{ nodeId: node.id, type: "video" as const, title: node.title, video }];
        const audio = readReferenceAudio(node);
        if (audio) return [{ nodeId: node.id, type: "audio" as const, title: node.title, audio }];
        const text = readNodeTextInput(node);
        if (text) return [{ nodeId: node.id, type: "text" as const, title: node.title, text }];
        return [];
    });
}

export function buildNodeChatMessages(context: NodeGenerationContext): ChatCompletionMessage[] {
    if (!context.referenceImages.length) {
        return [{ role: "user", content: context.prompt }];
    }

    return [
        {
            role: "user",
            content: [{ type: "text" as const, text: context.prompt }, ...context.referenceImages.map((image) => ({ type: "image_url" as const, image_url: { url: image.dataUrl } }))],
        },
    ];
}

export async function hydrateNodeGenerationContext(context: NodeGenerationContext) {
    const { imageToDataUrl } = await import("@/services/image-storage");
    const { resolveMediaUrl } = await import("@/services/file-storage");
    return {
        ...context,
        referenceImages: await Promise.all(context.referenceImages.map(async (image) => ({ ...image, dataUrl: await imageToDataUrl(image) }))),
        referenceVideos: await Promise.all(context.referenceVideos.map(async (video) => ({ ...video, url: await resolveMediaUrl(video.storageKey, video.url) }))),
        referenceAudios: await Promise.all(context.referenceAudios.map(async (audio) => ({ ...audio, url: await resolveMediaUrl(audio.storageKey, audio.url) }))),
    };
}

function readNodeTextInput(node: CanvasNodeData) {
    if (node.type === CanvasNodeType.Text) return node.metadata?.content || node.metadata?.prompt || "";
    return node.metadata?.prompt || "";
}

function readReferenceImage(node: CanvasNodeData): ReferenceImage | null {
    if (node.type !== CanvasNodeType.Image || !node.metadata?.content) return null;
    return {
        id: node.id,
        name: `${node.title || node.id}.png`,
        type: node.metadata.mimeType || "image/png",
        dataUrl: node.metadata.content,
        storageKey: node.metadata.storageKey,
    };
}

function readReferenceVideo(node: CanvasNodeData): ReferenceVideo | null {
    if (node.type !== CanvasNodeType.Video || !node.metadata?.content) return null;
    return {
        id: node.id,
        name: `${node.title || node.id}.mp4`,
        type: node.metadata.mimeType || "video/mp4",
        url: node.metadata.content,
        storageKey: node.metadata.storageKey,
        bytes: node.metadata.bytes,
        width: Math.round(node.metadata.naturalWidth || node.width),
        height: Math.round(node.metadata.naturalHeight || node.height),
    };
}

function readReferenceAudio(node: CanvasNodeData): ReferenceAudio | null {
    if (node.type !== CanvasNodeType.Audio || !node.metadata?.content) return null;
    return {
        id: node.id,
        name: `${node.title || node.id}.mp3`,
        type: node.metadata.mimeType || "audio/mpeg",
        url: node.metadata.content,
        storageKey: node.metadata.storageKey,
    };
}

function getOrderedUpstreamNodes(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    const target = nodes.find((node) => node.id === nodeId);
    if (!target) return [];

    // 辅助函数：获取某个节点的直接上游并按输入顺序排序
    const getDirectUpstream = (id: string): CanvasNodeData[] => {
        const directs = connections
            .filter((connection) => connection.toNodeId === id)
            .map((connection) => nodes.find((node) => node.id === connection.fromNodeId))
            .filter((node): node is CanvasNodeData => Boolean(node));
        
        const nodeTarget = nodes.find((n) => n.id === id);
        const order = nodeTarget?.metadata?.inputOrder || [];
        return [
            ...order.map((oid) => directs.find((n) => n.id === oid)).filter((n): n is CanvasNodeData => Boolean(n)),
            ...directs.filter((n) => !order.includes(n.id))
        ];
    };

    const directUpstream = getDirectUpstream(nodeId);
    const finalNodes: CanvasNodeData[] = [];
    const visited = new Set<string>([nodeId]);

    for (const directNode of directUpstream) {
        if (visited.has(directNode.id)) continue;
        visited.add(directNode.id);

        if (directNode.type === CanvasNodeType.Image || directNode.type === CanvasNodeType.Video || directNode.type === CanvasNodeType.Audio) {
            // 直接上游是媒体资源，保留作为参考输入，并在本分支立即截止溯源
            finalNodes.push(directNode);
        } else if (directNode.type === CanvasNodeType.Text) {
            // 直接上游是文本，保留作为提示词输入
            finalNodes.push(directNode);

            // 仅穿透一层文本，寻找直接连在这个文本节点上的图片作为其参考图
            const textUpstream = getDirectUpstream(directNode.id);
            for (const upNode of textUpstream) {
                if (visited.has(upNode.id)) continue;
                visited.add(upNode.id);

                if (upNode.type === CanvasNodeType.Image) {
                    // 找到了图片作为文本的参考图，将其保留，并在本分支立即截止溯源
                    finalNodes.push(upNode);
                }
            }
        }
    }

    return finalNodes;
}
