"use client";

import {
    AlertCircle,
    BookOpen,
    CheckSquare,
    ChevronDown,
    ChevronUp,
    ClipboardPaste,
    CloudUpload,
    Copy,
    Download,
    FolderPlus,
    History,
    LoaderCircle,
    PanelBottom,
    PanelLeft,
    Plus,
    RotateCcw,
    SlidersHorizontal,
    Sparkles,
    Trash2,
    Upload,
    VideoIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { App, Button, Checkbox, Empty, Image, Input, Modal, Segmented, Tag, Typography } from "antd";
import localforage from "localforage";
import { nanoid } from "nanoid";
import { saveAs } from "file-saver";

import { AssetPickerModal, type InsertAssetPayload } from "@/app/(user)/canvas/components/asset-picker-modal";
import { ModelPicker } from "@/components/model-picker";
import { PromptSelectDialog } from "@/components/prompts/prompt-select-dialog";
import { VideoSettingsPanel, normalizeVideoResolutionValue, normalizeVideoSizeValue, videoResolutionLabel, videoSecondsLabel, videoSizeLabel } from "@/components/video-settings-panel";
import { canvasThemes } from "@/lib/canvas-theme";
import { formatBytes, formatDuration } from "@/lib/image-utils";
import { deleteStoredMedia, downloadRemoteMedia, resolveMediaUrl, uploadRemoteMediaToServer } from "@/services/file-storage";
import { deleteStoredImages, resolveImageUrl, uploadImage } from "@/services/image-storage";
import { fetchUserConfig, syncUserVideoHistory } from "@/services/api/user-config";
import { requestVideoGeneration, VideoRequestError, type VideoGenerationResult } from "@/services/api/video";
import { useAssetStore } from "@/stores/use-asset-store";
import { useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { useUserStore } from "@/stores/use-user-store";
import type { ReferenceImage } from "@/types/image";

type GeneratedVideo = {
    id: string;
    url: string;
    storageKey?: string;
    durationMs: number;
    width: number;
    height: number;
    bytes: number;
    mimeType: string;
    source?: "ai" | "cloud" | "local";
};

type GenerationLogConfig = Pick<AiConfig, "model" | "videoModel" | "size" | "vquality" | "videoSeconds" | "videoCount">;

type GenerationResult = {
    id: string;
    status: "pending" | "success" | "failed";
    createdAt: number;
    prompt: string;
    model: string;
    config: GenerationLogConfig;
    references: ReferenceImage[];
    progress?: number;
    video?: GeneratedVideo;
    error?: string;
    errorDetail?: string;
    durationMs?: number;
};

type GenerationLog = {
    id: string;
    createdAt: number;
    title: string;
    prompt: string;
    time: string;
    model: string;
    config: GenerationLogConfig;
    references: ReferenceImage[];
    durationMs: number;
    size: string;
    resolution: string;
    seconds: string;
    status: "成功" | "失败";
    video?: GeneratedVideo;
    error?: string;
    errorDetail?: string;
};

type RequestSnapshot = { text: string; requestConfig: AiConfig; displayConfig: GenerationLogConfig; references: ReferenceImage[]; taskCount: number };
type UpdateAiConfig = <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => void;
type WorkbenchLayout = "side" | "bottom";
type CollapsibleSectionKey = "prompt" | "references" | "settings";
type CollapsedSections = Record<CollapsibleSectionKey, boolean>;

const WORKBENCH_LAYOUT_KEY = "infinite-canvas:video-workbench-layout";
const logStore = localforage.createInstance({ name: "infinite-canvas", storeName: "video_generation_logs" });
const defaultCollapsedSections: CollapsedSections = { prompt: false, references: true, settings: true };

const quickResolutionOptions = [
    { value: "720", label: "720p" },
    { value: "480", label: "480p" },
];

const quickSizeOptions = [
    { value: "1280x720", label: "横屏" },
    { value: "720x1280", label: "竖屏" },
    { value: "1024x1024", label: "方形" },
    { value: "1792x1024", label: "宽屏" },
    { value: "1024x1792", label: "长图" },
    { value: "auto", label: "auto" },
];

export default function VideoPage() {
    const { message, modal } = App.useApp();
    const fileInputRef = useRef<HTMLInputElement>(null);
    const effectiveConfig = useEffectiveConfig();
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const addAsset = useAssetStore((state) => state.addAsset);
    const token = useUserStore((state) => state.token);
    const isUserReady = useUserStore((state) => state.isReady);
    const [prompt, setPrompt] = useState("");
    const [references, setReferences] = useState<ReferenceImage[]>([]);
    const [uploadingCount, setUploadingCount] = useState(0);
    const [results, setResults] = useState<GenerationResult[]>([]);
    const [logs, setLogs] = useState<GenerationLog[]>([]);
    const [workbenchLayout, setWorkbenchLayoutState] = useState<WorkbenchLayout>("bottom");
    const [collapsedSections, setCollapsedSections] = useState<CollapsedSections>(defaultCollapsedSections);
    const [promptDialogOpen, setPromptDialogOpen] = useState(false);
    const [assetPickerOpen, setAssetPickerOpen] = useState(false);
    const [selectedLogIds, setSelectedLogIds] = useState<string[]>([]);
    const [previewLog, setPreviewLog] = useState<GenerationLog | null>(null);
    const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
    const [bottomSettingsCollapsed, setBottomSettingsCollapsed] = useState(true);
    const [syncingVideoIds, setSyncingVideoIds] = useState<string[]>([]);
    const [now, setNow] = useState(Date.now());
    const accountHistorySyncEnabledRef = useRef(false);
    const resultVideoOverridesRef = useRef<Record<string, GeneratedVideo>>({});

    const model = effectiveConfig.videoModel || effectiveConfig.model;
    const canGenerate = Boolean(prompt.trim());
    const pendingCount = results.filter((item) => item.status === "pending").length;

    useEffect(() => {
        void refreshLogs();
        try {
            const storedLayout = window.localStorage?.getItem(WORKBENCH_LAYOUT_KEY);
            if (storedLayout === "side" || storedLayout === "bottom") setWorkbenchLayoutState(storedLayout);
        } catch {
            // Local storage can be unavailable in restricted browser contexts.
        }
    }, []);

    useEffect(() => {
        if (!isUserReady || !token) return;
        void loadAccountVideoHistory(token);
    }, [isUserReady, token]);

    useEffect(() => {
        if (!pendingCount) return;
        const timer = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(timer);
    }, [pendingCount]);

    const setWorkbenchLayout = (layout: WorkbenchLayout) => {
        setWorkbenchLayoutState(layout);
        try {
            window.localStorage?.setItem(WORKBENCH_LAYOUT_KEY, layout);
        } catch {
            // Keep the in-memory layout even when persistence is unavailable.
        }
    };

    const toggleCollapsedSection = (section: CollapsibleSectionKey) => {
        setCollapsedSections((value) => ({ ...value, [section]: !value[section] }));
    };

    const addReferences = async (files?: FileList | null) => {
        const imageFiles = Array.from(files || []).filter((file) => file.type.startsWith("image/"));
        if (!imageFiles.length) return;
        setUploadingCount(imageFiles.length);
        const hideLoading = message.loading("正在上传参考图...", 0);
        try {
            const nextReferences = await Promise.all(
                imageFiles.map(async (file) => {
                    const image = await uploadImage(file);
                    return { id: nanoid(), name: file.name, type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey, source: "upload" as const, temporary: true };
                }),
            );
            setReferences((value) => [...value, ...nextReferences].slice(0, 7));
            message.success("参考图上传成功");
        } catch (error) {
            message.error(error instanceof Error ? `上传参考图失败：${error.message}` : "上传参考图失败");
        } finally {
            hideLoading();
            setUploadingCount(0);
        }
    };

    const addReferencesFromClipboard = async () => {
        try {
            const items = await navigator.clipboard.read();
            const blobs = await Promise.all(items.flatMap((item) => item.types.filter((type) => type.startsWith("image/")).map((type) => item.getType(type))));
            if (!blobs.length) {
                message.error("剪切板里没有可读取的图片");
                return;
            }
            setUploadingCount(blobs.length);
            const hideLoading = message.loading("正在上传并读取参考图...", 0);
            try {
                const nextReferences = await Promise.all(
                    blobs.slice(0, 7 - references.length).map(async (blob, index) => {
                        const image = await uploadImage(blob);
                        return { id: nanoid(), name: `clipboard-${index + 1}.png`, type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey, source: "clipboard" as const, temporary: true };
                    }),
                );
                setReferences((value) => [...value, ...nextReferences].slice(0, 7));
                message.success(`已成功上传并读取 ${nextReferences.length} 张参考图`);
            } finally {
                hideLoading();
                setUploadingCount(0);
            }
        } catch {
            message.error("剪切板里没有可读取的图片");
            setUploadingCount(0);
        }
    };

    const removeReference = async (id: string) => {
        const reference = references.find((item) => item.id === id);
        setReferences((value) => value.filter((ref) => ref.id !== id));
        if (!reference || !shouldDeleteReferenceFile(reference, logs, results)) {
            message.success("已从工作台移除参考图");
            return;
        }
        if (reference.storageKey) {
            try {
                await deleteStoredImages([reference.storageKey]);
            } catch (error) {
                message.error(error instanceof Error ? error.message : "参考图文件删除失败");
            }
        }
    };

    const pastePromptFromClipboard = async () => {
        try {
            const text = (await navigator.clipboard.readText()).trim();
            if (!text) {
                message.error("剪切板里没有可读取的文本");
                return;
            }
            setPrompt(text);
            setCollapsedSections((value) => ({ ...value, prompt: false }));
            message.success("已读取剪切板文本");
        } catch {
            message.error("剪切板里没有可读取的文本");
        }
    };

    const generate = async () => {
        const snapshot = buildRequestSnapshot();
        if (!snapshot) return;
        setPrompt("");
        setCollapsedSections((value) => ({ ...value, prompt: false }));
        await submitGenerationBatch(snapshot);
    };

    const submitGenerationBatch = async (snapshot: RequestSnapshot) => {
        setPreviewLog(null);
        const taskIds = Array.from({ length: snapshot.taskCount }, () => nanoid());
        setResults((value) => [...taskIds.map((id) => createPendingResult(id, snapshot)), ...value]);
        setNow(Date.now());
        const taskStartedAt = taskIds.reduce<Record<string, number>>((acc, id) => {
            acc[id] = performance.now();
            return acc;
        }, {});
        const tasks = taskIds.map((id) => runVideoTask(id, snapshot));
        const settled = await Promise.allSettled(tasks);
        const nextLogs = settled.map((item, index) => {
            const resultId = taskIds[index];
            const durationMs = performance.now() - (taskStartedAt[resultId] || performance.now());
            if (item.status === "fulfilled") {
                const video = resultVideoOverridesRef.current[resultId] || item.value;
                return buildLog({ prompt: snapshot.text, model: snapshot.displayConfig.videoModel || snapshot.displayConfig.model, config: snapshot.displayConfig, references: snapshot.references, durationMs: video.durationMs, status: "成功", video });
            }
            return buildLog({ prompt: snapshot.text, model: snapshot.displayConfig.videoModel || snapshot.displayConfig.model, config: snapshot.displayConfig, references: snapshot.references, durationMs, status: "失败", error: errorMessage(item.reason), errorDetail: errorDetail(item.reason) });
        });
        await Promise.all(nextLogs.map((log) => logStore.setItem(log.id, serializeLog(log))));
        const storedLogs = await readStoredLogs();
        const mergedLogs = await mergeVideoLogs(nextLogs, storedLogs);
        setResults((value) => value.filter((item) => !taskIds.includes(item.id)));
        setLogs(mergedLogs);
        await persistVideoHistory(mergedLogs);
        await refreshLogs();
        taskIds.forEach((id) => {
            delete resultVideoOverridesRef.current[id];
        });
        const successCount = settled.filter((item) => item.status === "fulfilled").length;
        successCount ? message.success(`已生成 ${successCount} 个视频`) : message.error("视频生成失败");
    };

    const runVideoTask = async (resultId: string, snapshot: RequestSnapshot) => {
        const itemStartedAt = performance.now();
        try {
            const result = await requestVideoGeneration(
                snapshot.requestConfig,
                snapshot.text,
                snapshot.references,
                (progress) => {
                    setResults((value) => updateResult(value, resultId, { progress }));
                }
            );
            const video = videoFromGenerationResult(result, performance.now() - itemStartedAt);
            setResults((value) => updateResult(value, resultId, { status: "success", video, durationMs: video.durationMs }));
            return video;
        } catch (error) {
            setResults((value) => updateResult(value, resultId, { status: "failed", error: errorMessage(error), errorDetail: errorDetail(error), durationMs: performance.now() - itemStartedAt }));
            throw error;
        }
    };

    const buildRequestSnapshot = ({ promptText = prompt, referenceItems = references, taskCount = normalizeVideoCount(effectiveConfig.videoCount) }: { promptText?: string; referenceItems?: ReferenceImage[]; taskCount?: number } = {}) => {
        const text = promptText.trim();
        if (!text) {
            message.error("请输入视频提示词");
            return null;
        }
        if (!isAiConfigReady(effectiveConfig, model)) {
            message.warning("请先完成配置");
            openConfigDialog(true);
            return null;
        }
        return {
            text,
            requestConfig: buildVideoConfig(effectiveConfig, model),
            displayConfig: buildGenerationLogConfig({ ...effectiveConfig, model, videoModel: model, videoCount: String(taskCount) }),
            references: [...referenceItems].slice(0, 7),
            taskCount,
        };
    };

    const retryResult = (result: GenerationResult) => {
        const snapshot = buildRequestSnapshot({ promptText: result.prompt, referenceItems: result.references, taskCount: 1 });
        if (!snapshot) return;
        setResults((value) => value.filter((item) => item.id !== result.id));
        void submitGenerationBatch(snapshot);
    };

    const retryLog = (log: GenerationLog) => {
        const snapshot = buildRequestSnapshot({ promptText: log.prompt, referenceItems: log.references, taskCount: 1 });
        if (!snapshot) return;
        void submitGenerationBatch(snapshot);
    };

    const downloadVideo = async (video: GeneratedVideo, index: number) => {
        const hideLoading = message.loading("正在下载视频...", 0);
        try {
            saveAs(await downloadRemoteMedia(video.url), `video-${index + 1}.mp4`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "视频下载失败");
        } finally {
            hideLoading();
        }
    };

    const syncVideo = async (video: GeneratedVideo, index: number) => {
        if (isCloudVideo(video)) return video;
        setSyncingVideoIds((ids) => [...ids, video.id]);
        const hideLoading = message.loading("正在同步视频到云端存储...", 0);
        try {
            const uploaded = await uploadRemoteMediaToServer(video.url, `video-${index + 1}.mp4`);
            message.success("视频已同步到云端存储");
            return { ...video, url: uploaded.url, storageKey: uploaded.storageKey, width: uploaded.width || video.width, height: uploaded.height || video.height, bytes: uploaded.bytes || video.bytes, mimeType: uploaded.mimeType || video.mimeType, source: "cloud" as const };
        } catch (error) {
            message.error(error instanceof Error ? error.message : "视频同步失败");
            return null;
        } finally {
            hideLoading();
            setSyncingVideoIds((ids) => ids.filter((id) => id !== video.id));
        }
    };

    const syncResultVideo = async (resultId: string, video: GeneratedVideo, index: number) => {
        const synced = await syncVideo(video, index);
        if (!synced) return;
        resultVideoOverridesRef.current[resultId] = synced;
        setResults((value) => updateResult(value, resultId, { video: synced }));
    };

    const syncLogVideo = async (log: GenerationLog, video: GeneratedVideo, index: number) => {
        const synced = await syncVideo(video, index);
        if (!synced) return;
        const nextLog = { ...log, video: synced };
        await logStore.setItem(log.id, serializeLog(nextLog));
        const nextLogs = logs.map((item) => (item.id === log.id ? nextLog : item));
        setLogs(nextLogs);
        await persistVideoHistory(nextLogs);
        if (previewLog?.id === log.id) setPreviewLog(nextLog);
    };

    const saveResultToAssets = (video: GeneratedVideo, index: number) => {
        addAsset({
            kind: "video",
            title: `生成视频 ${index + 1}`,
            coverUrl: "",
            tags: [],
            source: "视频创作台",
            data: { url: video.url, storageKey: video.storageKey, width: video.width, height: video.height, bytes: video.bytes, mimeType: video.mimeType },
            metadata: { source: "video-page", prompt },
        });
        message.success("已加入我的素材");
    };

    const insertPickedAsset = async (payload: InsertAssetPayload) => {
        if (payload.kind === "text") {
            setPrompt(payload.content);
        } else if (payload.kind === "image") {
            const resolvedUrl = await resolveImageUrl(payload.storageKey, payload.dataUrl);
            const safeUrl = resolvedUrl || "";
            const reference =
                payload.storageKey || payload.source === "asset"
                    ? {
                          id: nanoid(),
                          name: payload.title,
                          type: payload.mimeType || "image/png",
                          dataUrl: safeUrl,
                          storageKey: payload.storageKey,
                          source: "asset" as const,
                          assetId: payload.assetId,
                          temporary: false,
                      }
                    : null;
            if (reference) {
                if (!reference.dataUrl) {
                    message.error("引入素材失败：图片数据为空");
                    return;
                }
                setReferences((value) => [...value, reference].slice(0, 7));
            } else {
                const stored = await uploadImage(payload.dataUrl);
                setReferences((value) => [...value, { id: nanoid(), name: payload.title, type: stored.mimeType, dataUrl: stored.url, storageKey: stored.storageKey, source: (payload.source === "library" ? "library" : "upload") as "library" | "upload", temporary: payload.source !== "library" }].slice(0, 7));
            }
        } else {
            message.warning("视频素材不能作为视频参考图");
        }
        setAssetPickerOpen(false);
        setCollapsedSections((value) => ({ ...value, references: false }));
    };

    const createSession = () => {
        setPrompt("");
        setReferences([]);
        setResults((value) => value.filter((item) => item.status === "pending"));
        setSelectedLogIds([]);
        setPreviewLog(null);
    };

    const deleteSelectedLogs = async () => {
        const deletedLogs = logs.filter((log) => selectedLogIds.includes(log.id));
        const nextLogs = logs.filter((log) => !selectedLogIds.includes(log.id));
        const keys = disposableLogStorageKeys(deletedLogs, nextLogs, references, results);
        await Promise.all([deleteStoredMedia(keys.media), deleteStoredImages(keys.images), ...selectedLogIds.map((id) => logStore.removeItem(id))]);
        setLogs(nextLogs);
        setReferences((value) => value.filter((item) => !item.storageKey || !keys.images.includes(item.storageKey)));
        if (previewLog && selectedLogIds.includes(previewLog.id)) setPreviewLog(null);
        setSelectedLogIds([]);
        setDeleteConfirmOpen(false);
        await persistVideoHistory(nextLogs);
        await refreshLogs();
    };

    const deleteLog = (log: GenerationLog) => {
        modal.confirm({
            title: "删除生成结果",
            content: "确定删除这条视频生成结果吗？",
            okText: "删除",
            cancelText: "取消",
            okButtonProps: { danger: true },
            onOk: async () => {
                const nextLogs = logs.filter((item) => item.id !== log.id);
                const keys = disposableLogStorageKeys([log], nextLogs, references, results);
                await Promise.all([deleteStoredMedia(keys.media), deleteStoredImages(keys.images), logStore.removeItem(log.id)]);
                setLogs(nextLogs);
                setReferences((value) => value.filter((item) => !item.storageKey || !keys.images.includes(item.storageKey)));
                setSelectedLogIds((value) => value.filter((id) => id !== log.id));
                if (previewLog?.id === log.id) setPreviewLog(null);
                await persistVideoHistory(nextLogs);
                await refreshLogs();
            },
        });
    };

    const refreshLogs = async () => setLogs(await readStoredLogs());

    const loadAccountVideoHistory = async (currentToken: string) => {
        try {
            const config = await fetchUserConfig(currentToken);
            accountHistorySyncEnabledRef.current = config.syncCapabilities?.userData === true;
            const remote = config.videoHistory as { logs?: GenerationLog[] } | undefined;
            const remoteLogs = Array.isArray(remote?.logs) ? remote.logs : [];
            const localLogs = await readStoredLogs();
            const localHasData = localLogs.length > 0;
            const remoteHasData = remoteLogs.length > 0;

            if (accountHistorySyncEnabledRef.current) {
                const remoteNormalized = await mergeVideoLogs(remoteLogs, []);
                await replaceStoredVideoHistory(remoteNormalized);
                setLogs(remoteNormalized);
                return;
            } else if (remoteHasData && !localHasData) {
                const remoteNormalized = await mergeVideoLogs(remoteLogs, []);
                await replaceStoredVideoHistory(remoteNormalized);
                setLogs(remoteNormalized);
            }
        } catch {
            // Keep local video history available when account sync fails.
        }
    };

    const persistVideoHistory = async (nextLogs: GenerationLog[]) => {
        if (!token || !accountHistorySyncEnabledRef.current) return;
        await syncUserVideoHistory(token, videoHistorySnapshot(nextLogs)).catch(() => {
            accountHistorySyncEnabledRef.current = false;
        });
    };

    const previewGenerationLog = (log: GenerationLog) => {
        setPreviewLog(log);
        setPrompt(log.prompt);
        setReferences(log.references || []);
        setCollapsedSections((value) => ({ ...value, prompt: false, references: !log.references?.length }));
        if (log.config.videoModel || log.model) updateConfig("videoModel", log.config.videoModel || log.model);
        if (log.config.size) updateConfig("size", log.config.size);
        if (log.config.vquality) updateConfig("vquality", log.config.vquality);
        if (log.config.videoSeconds) updateConfig("videoSeconds", log.config.videoSeconds);
        if (log.config.videoCount) updateConfig("videoCount", log.config.videoCount);
    };

    const copyPrompt = async (text: string) => {
        await navigator.clipboard.writeText(text);
        message.success("提示词已复制");
    };

    return (
        <div className="flex h-full flex-col overflow-hidden bg-stone-50 text-stone-900 dark:bg-stone-950 dark:text-stone-100">
            <main className={`${workbenchLayout === "side" ? "grid grid-cols-1 lg:grid-cols-[420px_minmax(0,1fr)]" : "relative flex flex-col"} min-h-0 flex-1 gap-3 overflow-y-auto p-3 lg:overflow-hidden`}>
                {workbenchLayout === "side" ? (
                    <>
                        <WorkbenchPanel
                            layout="side"
                            currentLayout={workbenchLayout}
                            collapsedSections={collapsedSections}
                            prompt={prompt}
                            references={references}
                            config={effectiveConfig}
                            model={model}
                            canGenerate={canGenerate}
                            pendingCount={pendingCount}
                            updateConfig={updateConfig}
                            openConfigDialog={openConfigDialog}
                            onLayoutChange={setWorkbenchLayout}
                            onToggleSection={toggleCollapsedSection}
                            onPromptChange={setPrompt}
                            onOpenPromptLibrary={() => setPromptDialogOpen(true)}
                            onOpenAssetPicker={() => setAssetPickerOpen(true)}
                            onPastePrompt={() => void pastePromptFromClipboard()}
                            onClearPrompt={() => setPrompt("")}
                            onPasteReferences={() => void addReferencesFromClipboard()}
                            onUploadReferences={() => fileInputRef.current?.click()}
                            onRemoveReference={(id) => void removeReference(id)}
                            onGenerate={() => void generate()}
                            bottomSettingsCollapsed={bottomSettingsCollapsed}
                            setBottomSettingsCollapsed={setBottomSettingsCollapsed}
                            uploadingCount={uploadingCount}
                        />
                        <ResultsPanel
                            results={results}
                            logs={logs}
                            pendingCount={pendingCount}
                            now={now}
                            selectedLogIds={selectedLogIds}
                            activeLogId={previewLog?.id}
                            onSelectedLogIdsChange={setSelectedLogIds}
                            onCreateSession={createSession}
                            onDeleteSelected={() => setDeleteConfirmOpen(true)}
                            onDeleteLog={deleteLog}
                            onPreviewLog={previewGenerationLog}
                            onRetryLog={retryLog}
                            onCopyPrompt={copyPrompt}
                            onDownload={downloadVideo}
                            onSyncResult={syncResultVideo}
                            onSyncLog={syncLogVideo}
                            onSaveAsset={saveResultToAssets}
                            syncingVideoIds={syncingVideoIds}
                            onRetry={retryResult}
                        />
                    </>
                ) : (
                    <>
                        <ResultsPanel
                            className="min-h-[360px] flex-1 pb-40 lg:pb-44"
                            results={results}
                            logs={logs}
                            pendingCount={pendingCount}
                            now={now}
                            selectedLogIds={selectedLogIds}
                            activeLogId={previewLog?.id}
                            onSelectedLogIdsChange={setSelectedLogIds}
                            onCreateSession={createSession}
                            onDeleteSelected={() => setDeleteConfirmOpen(true)}
                            onDeleteLog={deleteLog}
                            onPreviewLog={previewGenerationLog}
                            onRetryLog={retryLog}
                            onCopyPrompt={copyPrompt}
                            onDownload={downloadVideo}
                            onSyncResult={syncResultVideo}
                            onSyncLog={syncLogVideo}
                            onSaveAsset={saveResultToAssets}
                            syncingVideoIds={syncingVideoIds}
                            onRetry={retryResult}
                        />
                        <WorkbenchPanel
                            layout="bottom"
                            currentLayout={workbenchLayout}
                            collapsedSections={collapsedSections}
                            prompt={prompt}
                            references={references}
                            config={effectiveConfig}
                            model={model}
                            canGenerate={canGenerate}
                            pendingCount={pendingCount}
                            updateConfig={updateConfig}
                            openConfigDialog={openConfigDialog}
                            onLayoutChange={setWorkbenchLayout}
                            onToggleSection={toggleCollapsedSection}
                            onPromptChange={setPrompt}
                            onOpenPromptLibrary={() => setPromptDialogOpen(true)}
                            onOpenAssetPicker={() => setAssetPickerOpen(true)}
                            onPastePrompt={() => void pastePromptFromClipboard()}
                            onClearPrompt={() => setPrompt("")}
                            onPasteReferences={() => void addReferencesFromClipboard()}
                            onUploadReferences={() => fileInputRef.current?.click()}
                            onRemoveReference={(id) => void removeReference(id)}
                            onGenerate={() => void generate()}
                            bottomSettingsCollapsed={bottomSettingsCollapsed}
                            setBottomSettingsCollapsed={setBottomSettingsCollapsed}
                            uploadingCount={uploadingCount}
                        />
                    </>
                )}
            </main>
            <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(event) => {
                    void addReferences(event.target.files);
                    event.target.value = "";
                }}
            />
            <PromptSelectDialog open={promptDialogOpen} onOpenChange={setPromptDialogOpen} onSelect={setPrompt} />
            <AssetPickerModal open={assetPickerOpen} defaultTab="my-assets" onInsert={(payload) => void insertPickedAsset(payload)} onClose={() => setAssetPickerOpen(false)} />
            <Modal title="删除生成记录" open={deleteConfirmOpen} onCancel={() => setDeleteConfirmOpen(false)} onOk={() => void deleteSelectedLogs()} okText="删除" okButtonProps={{ danger: true }} cancelText="取消">
                确定删除选中的 {selectedLogIds.length} 条生成记录吗？
            </Modal>
        </div>
    );
}

function WorkbenchPanel({
    layout,
    currentLayout,
    collapsedSections,
    prompt,
    references,
    config,
    model,
    canGenerate,
    pendingCount,
    updateConfig,
    openConfigDialog,
    onLayoutChange,
    onToggleSection,
    onPromptChange,
    onOpenPromptLibrary,
    onOpenAssetPicker,
    onPastePrompt,
    onClearPrompt,
    onPasteReferences,
    onUploadReferences,
    onRemoveReference,
    onGenerate,
    bottomSettingsCollapsed,
    setBottomSettingsCollapsed,
    uploadingCount,
}: {
    layout: WorkbenchLayout;
    currentLayout: WorkbenchLayout;
    collapsedSections: CollapsedSections;
    prompt: string;
    references: ReferenceImage[];
    config: AiConfig;
    model: string;
    canGenerate: boolean;
    pendingCount: number;
    updateConfig: UpdateAiConfig;
    openConfigDialog: (shouldPromptContinue?: boolean) => void;
    onLayoutChange: (layout: WorkbenchLayout) => void;
    onToggleSection: (section: CollapsibleSectionKey) => void;
    onPromptChange: (value: string) => void;
    onOpenPromptLibrary: () => void;
    onOpenAssetPicker: () => void;
    onPastePrompt: () => void;
    onClearPrompt: () => void;
    onPasteReferences: () => void;
    onUploadReferences: () => void;
    onRemoveReference: (id: string) => void;
    onGenerate: () => void;
    bottomSettingsCollapsed: boolean;
    setBottomSettingsCollapsed: (value: boolean) => void;
    uploadingCount: number;
}) {
    if (layout === "bottom") {
        return (
            <div className="pointer-events-none fixed inset-x-0 bottom-5 z-40 flex justify-center px-5 sm:bottom-7 sm:px-10 lg:px-16">
                <div className="pointer-events-auto w-full max-w-5xl rounded-[24px] bg-white/65 p-4 shadow-[0_32px_100px_rgba(15,23,42,.22),0_10px_34px_rgba(15,23,42,.10)] ring-1 ring-white/50 backdrop-blur-2xl dark:bg-stone-950/60 dark:ring-white/10 dark:shadow-[0_34px_110px_rgba(0,0,0,.58)]">
                    <div className="flex flex-col gap-3">
                        <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
                            <Input.TextArea
                                value={prompt}
                                onChange={(event) => onPromptChange(event.target.value)}
                                placeholder="描述镜头运动、主体动作、场景氛围和画面风格"
                                autoSize={{ minRows: 2, maxRows: 4 }}
                                className="rounded-2xl"
                                onPressEnter={(event) => {
                                    if (!event.shiftKey && canGenerate) onGenerate();
                                }}
                            />
                            <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                                <Button title="清空输入" icon={<Trash2 className="size-4" />} onClick={onClearPrompt} />
                                <Button title="提示词库" icon={<BookOpen className="size-4" />} onClick={onOpenPromptLibrary} />
                                <Button title="我的素材" icon={<FolderPlus className="size-4" />} onClick={onOpenAssetPicker} />
                                <Button
                                    title="参数配置"
                                    className={`lg:hidden ${!bottomSettingsCollapsed ? "!bg-sky-500/10 !text-sky-500 !border-sky-500/30" : ""}`}
                                    icon={<SlidersHorizontal className="size-4" />}
                                    onClick={() => setBottomSettingsCollapsed(!bottomSettingsCollapsed)}
                                />
                                <Button title="切换到侧边工作台" icon={<PanelLeft className="size-4" />} onClick={() => onLayoutChange("side")} />
                                <Button type="primary" className="h-9 rounded-xl lg:!hidden font-medium px-4" icon={<Sparkles className="size-4" />} disabled={!canGenerate} onClick={onGenerate}>
                                    {pendingCount ? `${pendingCount} 生成中` : "开始创作"}
                                </Button>
                            </div>
                        </div>
                        <div className={`grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-[1.3fr_0.8fr_0.8fr_0.7fr_0.7fr_auto_auto] ${bottomSettingsCollapsed ? "hidden lg:grid" : "grid"}`}>
                            <label className="grid gap-1 text-xs text-stone-500 dark:text-stone-400">
                                模型
                                <ModelPicker
                                    config={config}
                                    value={model}
                                    channelId={config.videoChannelId}
                                    onChange={(value, channelId) => {
                                        updateConfig("videoModel", value);
                                        if (channelId) updateConfig("videoChannelId", channelId);
                                    }}
                                    className="canvas-compact-control !h-11 !rounded-xl"
                                    onMissingConfig={() => openConfigDialog(false)}
                                    fullWidth
                                />
                            </label>
                            <QuickSelect label="清晰度" value={normalizeVideoResolutionValue(config.vquality)} options={quickResolutionOptions} onChange={(value) => updateConfig("vquality", value)} />
                            <QuickSelect label="尺寸" value={normalizeVideoSizeValue(config.size)} options={quickSizeOptions} onChange={(value) => updateConfig("size", value)} />
                            <QuickNumber label="秒数" value={normalizeVideoSeconds(config.videoSeconds)} min={1} max={20} onChange={(value) => updateConfig("videoSeconds", value)} />
                            <QuickNumber label="任务" value={String(normalizeVideoCount(config.videoCount))} min={1} max={6} onChange={(value) => updateConfig("videoCount", value)} />
                            <ReferenceQuickActions references={references} onPasteReferences={onPasteReferences} onUploadReferences={onUploadReferences} />
                            <Button type="primary" className="h-11 min-w-28 rounded-xl hidden lg:flex items-center justify-center gap-1.5" icon={<Sparkles className="size-4" />} disabled={!canGenerate} onClick={onGenerate}>
                                {pendingCount ? `${pendingCount} 生成中` : "开始创作"}
                            </Button>
                        </div>
                        {references.length || uploadingCount > 0 ? <ReferenceStrip className="mt-3" references={references} compact onRemoveReference={onRemoveReference} uploadingCount={uploadingCount} /> : null}
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="flex min-h-[420px] flex-col overflow-hidden rounded-lg border border-stone-200 bg-card shadow-sm dark:border-stone-800 lg:min-h-0">
            <div className="shrink-0 p-4 pb-3">
                <WorkbenchHeader currentLayout={currentLayout} onLayoutChange={onLayoutChange} />
            </div>
            <div className="thin-scrollbar min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pb-3">
                <CollapsibleWorkbenchSection title="提示词" collapsed={collapsedSections.prompt} summary={prompt.trim() || "未填写提示词"} onToggle={() => onToggleSection("prompt")}>
                    <div className="space-y-2">
                        <div className="flex flex-wrap gap-2">
                            <Button size="small" icon={<ClipboardPaste className="size-3.5" />} onClick={onPastePrompt}>
                                读取剪贴板
                            </Button>
                            <Button size="small" icon={<Trash2 className="size-3.5" />} onClick={onClearPrompt}>
                                清空
                            </Button>
                            <Button size="small" icon={<BookOpen className="size-3.5" />} onClick={onOpenPromptLibrary}>
                                查看提示词库
                            </Button>
                            <Button size="small" icon={<FolderPlus className="size-3.5" />} onClick={onOpenAssetPicker}>
                                查看我的素材
                            </Button>
                        </div>
                        <Input.TextArea value={prompt} onChange={(event) => onPromptChange(event.target.value)} rows={6} placeholder="描述镜头运动、主体动作、场景氛围和画面风格" />
                    </div>
                </CollapsibleWorkbenchSection>

                <CollapsibleWorkbenchSection title="参考图" count={references.length} collapsed={collapsedSections.references} summary={references.length ? `已选择 ${references.length} 张参考图` : "暂无参考图"} onToggle={() => onToggleSection("references")}>
                    <div className="space-y-2">
                        <div className="flex flex-wrap gap-2">
                            <Button size="small" icon={<ClipboardPaste className="size-3.5" />} onClick={onPasteReferences}>
                                剪切板
                            </Button>
                            <Button size="small" icon={<Upload className="size-3.5" />} onClick={onUploadReferences}>
                                上传
                            </Button>
                            <Button size="small" icon={<FolderPlus className="size-3.5" />} onClick={onOpenAssetPicker}>
                                从素材选择
                            </Button>
                        </div>
                        <ReferenceStrip references={references} onRemoveReference={onRemoveReference} uploadingCount={uploadingCount} />
                    </div>
                </CollapsibleWorkbenchSection>

                <CollapsibleWorkbenchSection title="参数" collapsed={collapsedSections.settings} summary={settingsSummary(config, model)} onToggle={() => onToggleSection("settings")}>
                    <GenerationSettings config={config} model={model} updateConfig={updateConfig} openConfigDialog={openConfigDialog} />
                </CollapsibleWorkbenchSection>
            </div>
            <div className="shrink-0 border-t border-stone-200 p-4 dark:border-stone-800">
                <Button type="primary" size="large" block icon={<Sparkles className="size-4" />} disabled={!canGenerate} onClick={onGenerate}>
                    {pendingCount ? `继续提交（${pendingCount} 个生成中）` : "开始生成"}
                </Button>
            </div>
        </div>
    );
}

function ResultsPanel({
    className = "",
    results,
    logs,
    pendingCount,
    now,
    selectedLogIds,
    activeLogId,
    onSelectedLogIdsChange,
    onCreateSession,
    onDeleteSelected,
    onDeleteLog,
    onPreviewLog,
    onRetryLog,
    onCopyPrompt,
    onDownload,
    onSyncResult,
    onSyncLog,
    onSaveAsset,
    syncingVideoIds,
    onRetry,
}: {
    className?: string;
    results: GenerationResult[];
    logs: GenerationLog[];
    pendingCount: number;
    now: number;
    selectedLogIds: string[];
    activeLogId?: string;
    onSelectedLogIdsChange: (ids: string[]) => void;
    onCreateSession: () => void;
    onDeleteSelected: () => void;
    onDeleteLog: (log: GenerationLog) => void;
    onPreviewLog: (log: GenerationLog) => void;
    onRetryLog: (log: GenerationLog) => void;
    onCopyPrompt: (text: string) => void | Promise<void>;
    onDownload: (video: GeneratedVideo, index: number) => void;
    onSyncResult: (resultId: string, video: GeneratedVideo, index: number) => void;
    onSyncLog: (log: GenerationLog, video: GeneratedVideo, index: number) => void;
    onSaveAsset: (video: GeneratedVideo, index: number) => void;
    syncingVideoIds: string[];
    onRetry: (result: GenerationResult) => void;
}) {
    const liveVideoIds = new Set(results.map((result) => result.video?.id).filter((id): id is string => Boolean(id)));
    const visibleLogs = logs.filter((log) => !log.video?.id || !liveVideoIds.has(log.video.id));
    const totalCount = results.length + visibleLogs.length;
    const allSelected = Boolean(visibleLogs.length) && visibleLogs.every((log) => selectedLogIds.includes(log.id));
    const toggleVisibleLogs = () => onSelectedLogIdsChange(allSelected ? selectedLogIds.filter((id) => !visibleLogs.some((log) => log.id === id)) : Array.from(new Set([...selectedLogIds, ...visibleLogs.map((log) => log.id)])));

    return (
        <div className={`thin-scrollbar rounded-lg border border-stone-200 bg-card p-4 shadow-sm dark:border-stone-800 lg:min-h-0 lg:overflow-y-auto lg:p-5 ${className}`}>
            <div className="mb-4 flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                    <History className="size-4 text-stone-400" />
                    <h2 className="truncate text-xl font-semibold">全部成果</h2>
                    <Tag className="m-0">{totalCount}</Tag>
                    {pendingCount ? <Tag className="m-0 px-2 py-1">{pendingCount} 个生成中</Tag> : null}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                    <Button size="small" icon={<Plus className="size-3.5" />} onClick={onCreateSession}>
                        新建
                    </Button>
                    <Button size="small" icon={<CheckSquare className="size-3.5" />} disabled={!visibleLogs.length} onClick={toggleVisibleLogs}>
                        {allSelected ? "取消" : "全选"}
                    </Button>
                    <Button size="small" danger icon={<Trash2 className="size-3.5" />} disabled={!selectedLogIds.length} onClick={onDeleteSelected}>
                        删除
                    </Button>
                </div>
            </div>
            {totalCount ? (
                <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
                    {results.map((result, index) =>
                        result.status === "success" && result.video ? (
                            <ResultVideoCard key={result.id} result={result} video={result.video} index={index} syncing={syncingVideoIds.includes(result.video.id)} onCopyPrompt={onCopyPrompt} onDownload={onDownload} onSync={(video) => onSyncResult(result.id, video, index)} onSaveAsset={onSaveAsset} />
                        ) : result.status === "failed" ? (
                            <FailedVideoCard key={result.id} result={result} error={result.error || "生成失败"} onCopyPrompt={onCopyPrompt} onRetry={() => onRetry(result)} />
                        ) : (
                            <PendingVideoCard key={result.id} result={result} now={now} onCopyPrompt={onCopyPrompt} />
                        ),
                    )}
                    {visibleLogs.map((log, index) => (
                        <HistoryLogCard key={log.id} log={log} index={index} selected={selectedLogIds.includes(log.id)} active={activeLogId === log.id} syncing={Boolean(log.video && syncingVideoIds.includes(log.video.id))} onSelectedChange={(checked) => onSelectedLogIdsChange(checked ? [...selectedLogIds, log.id] : selectedLogIds.filter((id) => id !== log.id))} onDelete={() => onDeleteLog(log)} onPreview={() => onPreviewLog(log)} onRetry={() => onRetryLog(log)} onCopyPrompt={onCopyPrompt} onDownload={onDownload} onSync={(video) => onSyncLog(log, video, index)} onSaveAsset={onSaveAsset} />
                    ))}
                </div>
            ) : (
                <div className="flex min-h-[320px] flex-col items-center justify-center rounded-lg border border-dashed border-stone-300 text-center dark:border-stone-700 lg:min-h-[560px]">
                    <VideoIcon className="mb-4 size-11 text-stone-400" />
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有生成视频" />
                </div>
            )}
        </div>
    );
}

function WorkbenchHeader({ currentLayout, onLayoutChange }: { currentLayout: WorkbenchLayout; onLayoutChange: (layout: WorkbenchLayout) => void }) {
    return (
        <div className="flex items-center justify-between gap-3">
            <h1 className="text-2xl font-semibold text-stone-950 dark:text-stone-100">视频创作台</h1>
            <div className="flex shrink-0 rounded-lg border border-stone-200 bg-stone-50 p-1 dark:border-stone-800 dark:bg-stone-900">
                <Button size="small" type={currentLayout === "side" ? "primary" : "text"} icon={<PanelLeft className="size-3.5" />} onClick={() => onLayoutChange("side")}>
                    侧边
                </Button>
                <Button size="small" type={currentLayout === "bottom" ? "primary" : "text"} icon={<PanelBottom className="size-3.5" />} onClick={() => onLayoutChange("bottom")}>
                    底部
                </Button>
            </div>
        </div>
    );
}

function CollapsibleWorkbenchSection({ title, count, collapsed, summary, children, onToggle }: { title: string; count?: number; collapsed: boolean; summary: string; children: ReactNode; onToggle: () => void }) {
    return (
        <section className="rounded-lg border border-stone-200 bg-background dark:border-stone-800">
            <button type="button" className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left" onClick={onToggle}>
                <span className="flex min-w-0 items-center gap-2">
                    <span className="font-semibold">{title}</span>
                    {typeof count === "number" ? <Tag className="m-0 text-xs">{count}</Tag> : null}
                    {collapsed ? <span className="truncate text-xs text-stone-500 dark:text-stone-400">{summary}</span> : null}
                </span>
                {collapsed ? <ChevronDown className="size-4 shrink-0 text-stone-400" /> : <ChevronUp className="size-4 shrink-0 text-stone-400" />}
            </button>
            {!collapsed ? <div className="border-t border-stone-200 p-3 dark:border-stone-800">{children}</div> : null}
        </section>
    );
}

function ReferenceStrip({ references, compact = false, className = "", onRemoveReference, uploadingCount = 0 }: { references: ReferenceImage[]; compact?: boolean; className?: string; onRemoveReference: (id: string) => void; uploadingCount?: number }) {
    return (
        <div
            className={`hover-scrollbar hover-scrollbar-hint flex w-full min-w-0 max-w-full gap-2 overflow-x-scroll overflow-y-hidden rounded-lg border border-dashed border-stone-300 p-2 overscroll-x-contain dark:border-stone-700 ${compact ? "min-h-14" : "min-h-24 pb-3"} ${className}`}
            onWheel={(event) => {
                if (event.currentTarget.scrollWidth <= event.currentTarget.clientWidth) return;
                event.preventDefault();
                event.currentTarget.scrollLeft += event.deltaY;
            }}
        >
            {references.map((item) => (
                <div key={item.id} className={`${compact ? "size-12" : "size-20"} group relative shrink-0 overflow-hidden rounded-md border border-stone-200 dark:border-stone-800`}>
                    <Image
                        src={item.dataUrl || undefined}
                        alt={item.name}
                        className="size-full object-cover cursor-pointer"
                        style={{ width: "100%", height: "100%", objectFit: "cover" }}
                        preview={{
                            mask: "点击预览",
                        }}
                    />
                    <button type="button" className="absolute right-1 top-1 hidden z-10 size-6 items-center justify-center rounded bg-black/60 text-white group-hover:flex" onClick={() => onRemoveReference(item.id)} aria-label="移除参考图">
                        <Trash2 className="size-3.5" />
                    </button>
                </div>
            ))}
            {Array.from({ length: uploadingCount }).map((_, i) => (
                <div key={`loading-${i}`} className={`${compact ? "size-12" : "size-20"} shrink-0 flex items-center justify-center rounded-md border border-stone-200 dark:border-stone-800 bg-stone-100/50 dark:bg-stone-900/50`}>
                    <LoaderCircle className="size-5 animate-spin text-stone-400" />
                </div>
            ))}
            {!references.length && !uploadingCount ? <div className="flex min-w-full items-center justify-center text-sm text-stone-500">暂无参考图</div> : null}
        </div>
    );
}

function ReferenceQuickActions({ references, onPasteReferences, onUploadReferences }: { references: ReferenceImage[]; onPasteReferences: () => void; onUploadReferences: () => void }) {
    return (
        <div className="flex h-11 items-center gap-1 rounded-xl border border-stone-200 bg-background px-2 dark:border-stone-800">
            {references[0] ? <img src={references[0].dataUrl || undefined} alt={references[0].name} className="size-7 rounded object-cover" /> : null}
            {references.length ? <span className="min-w-7 text-xs text-stone-500">{references.length} 张</span> : null}
            <Button title="读取剪切板" size="small" type="text" icon={<ClipboardPaste className="size-3.5" />} onClick={onPasteReferences} />
            <Button title="上传参考图" size="small" type="text" icon={<Upload className="size-3.5" />} onClick={onUploadReferences} />
        </div>
    );
}

function QuickSelect({ label, value, options, onChange }: { label: string; value: string; options: { value: string; label: string }[]; onChange: (value: string) => void }) {
    return (
        <label className="grid gap-1 text-xs text-stone-500 dark:text-stone-400">
            {label}
            <select className="h-11 min-w-0 rounded-xl border border-stone-200 bg-background px-3 text-sm text-stone-900 outline-none dark:border-stone-800 dark:text-stone-100" value={value} onChange={(event) => onChange(event.target.value)}>
                {options.map((item) => (
                    <option key={item.value} value={item.value}>
                        {item.label}
                    </option>
                ))}
            </select>
        </label>
    );
}

function QuickNumber({ label, value, min, max, onChange }: { label: string; value: string; min: number; max: number; onChange: (value: string) => void }) {
    return (
        <label className="grid gap-1 text-xs text-stone-500 dark:text-stone-400">
            {label}
            <input className="h-11 min-w-0 rounded-xl border border-stone-200 bg-background px-3 text-sm text-stone-900 outline-none dark:border-stone-800 dark:text-stone-100" type="number" min={min} max={max} value={value} onChange={(event) => onChange(String(Math.max(min, Math.min(max, Number(event.target.value) || min))))} />
        </label>
    );
}

function GenerationSettings({ config, model, updateConfig, openConfigDialog }: { config: AiConfig; model: string; updateConfig: UpdateAiConfig; openConfigDialog: (shouldPromptContinue?: boolean) => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const [modelCollapsed, setModelCollapsed] = useState(false);

    return (
        <div className="space-y-3">
            <SettingSubsection title="模型" summary={model || "未选择模型"} collapsed={modelCollapsed} onToggle={() => setModelCollapsed((value) => !value)}>
                <ModelPicker config={config} value={model} channelId={config.videoChannelId} onChange={(value, channelId) => { updateConfig("videoModel", value); if (channelId) updateConfig("videoChannelId", channelId); }} fullWidth onMissingConfig={() => openConfigDialog(false)} />
            </SettingSubsection>
            <VideoSettingsPanel config={config} onConfigChange={(key, value) => updateConfig(key, value)} theme={theme} showTitle={false} className="space-y-3" />
            <SettingSubsection title="并行任务" summary={`${normalizeVideoCount(config.videoCount)} 个`} collapsed={false} onToggle={() => undefined}>
                <QuickNumber label="任务数量" value={String(normalizeVideoCount(config.videoCount))} min={1} max={6} onChange={(value) => updateConfig("videoCount", value)} />
            </SettingSubsection>
        </div>
    );
}

function SettingSubsection({ title, summary, collapsed, children, onToggle }: { title: string; summary: string; collapsed: boolean; children: ReactNode; onToggle: () => void }) {
    return (
        <section className="overflow-hidden rounded-lg border border-stone-200 bg-background dark:border-stone-800">
            <button type="button" className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left" onClick={onToggle}>
                <span className="min-w-0">
                    <span className="font-medium">{title}</span>
                    {collapsed ? <span className="ml-2 text-xs text-stone-500 dark:text-stone-400">{summary}</span> : null}
                </span>
                {collapsed ? <ChevronDown className="size-4 shrink-0 text-stone-400" /> : <ChevronUp className="size-4 shrink-0 text-stone-400" />}
            </button>
            {!collapsed ? <div className="border-t border-stone-200 p-3 dark:border-stone-800">{children}</div> : null}
        </section>
    );
}

function ResultVideoCard({ result, video, index, syncing, onCopyPrompt, onDownload, onSync, onSaveAsset }: { result: GenerationResult; video: GeneratedVideo; index: number; syncing: boolean; onCopyPrompt: (text: string) => void | Promise<void>; onDownload: (video: GeneratedVideo, index: number) => void; onSync: (video: GeneratedVideo) => void; onSaveAsset: (video: GeneratedVideo, index: number) => void }) {
    return (
        <div className="overflow-hidden rounded-lg border border-stone-200 bg-background dark:border-stone-800">
            <div className="relative aspect-video bg-black">
                <div className="absolute right-1.5 top-1.5 z-10 flex gap-1">
                    <VideoSourceTag video={video} />
                    <Tag className="m-0 text-[10px]" color="blue">
                        新生成
                    </Tag>
                </div>
                <ReferenceThumbnailOverlay references={result.references} className="left-1.5 top-1.5" />
                <video src={video.url} controls className="size-full object-contain" />
            </div>
            <TaskInfo result={result} onCopyPrompt={onCopyPrompt} />
            <VideoMetaBar video={video} index={index} syncing={syncing} onDownload={onDownload} onSync={onSync} onSaveAsset={onSaveAsset} />
        </div>
    );
}

function PendingVideoCard({ result, now, onCopyPrompt }: { result: GenerationResult; now: number; onCopyPrompt: (text: string) => void | Promise<void> }) {
    return (
        <div className="overflow-hidden rounded-lg border border-dashed border-stone-300 bg-stone-50 dark:border-stone-700 dark:bg-stone-900">
            <div className="relative aspect-video">
                <div className="absolute inset-0 opacity-60" style={{ backgroundImage: "radial-gradient(circle, rgba(120,113,108,0.35) 1.4px, transparent 1.6px)", backgroundSize: "16px 16px" }} />
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-stone-500 dark:text-stone-400">
                    <LoaderCircle className="size-6 animate-spin" />
                    {typeof result.progress === "number" ? (
                        <span className="font-semibold text-sky-500 animate-pulse">正在创作 {Math.floor(result.progress)}%</span>
                    ) : (
                        <span>生成中</span>
                    )}
                    <span className="rounded-full bg-white/80 px-2 py-1 text-xs text-stone-600 shadow-sm dark:bg-stone-950/70 dark:text-stone-300">{formatDuration(Math.max(0, now - result.createdAt))}</span>
                </div>
                {typeof result.progress === "number" ? (
                    <div className="absolute inset-x-4 bottom-4 z-10 flex flex-col gap-1">
                        <div className="flex items-center justify-between text-[10px] text-stone-500 dark:text-stone-400 font-medium">
                            <span>当前创作进度</span>
                            <span>{Math.floor(result.progress)}%</span>
                        </div>
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-stone-200 dark:bg-stone-800">
                            <div className="h-full rounded-full bg-sky-500 transition-all duration-300 shadow-[0_0_8px_rgba(14,165,233,0.5)]" style={{ width: `${Math.floor(result.progress)}%` }} />
                        </div>
                    </div>
                ) : null}
            </div>
            <TaskInfo result={{ ...result, durationMs: Math.max(0, now - result.createdAt) }} onCopyPrompt={onCopyPrompt} />
        </div>
    );
}

function FailedVideoCard({ result, error, onCopyPrompt, onRetry }: { result: GenerationResult; error: string; onCopyPrompt: (text: string) => void | Promise<void>; onRetry: () => void }) {
    const [detailOpen, setDetailOpen] = useState(false);
    const detail = result.errorDetail || error;
    return (
        <div className="overflow-hidden rounded-lg border border-red-200 bg-red-50 dark:border-red-950 dark:bg-red-950/20">
            <div className="relative flex aspect-video flex-col items-center justify-center gap-3 p-5 text-center">
                <ReferenceThumbnailOverlay references={result.references} className="left-1.5 top-1.5" />
                <AlertCircle className="size-7 text-red-500" />
                <div className="text-sm font-medium text-red-600 dark:text-red-300">生成失败</div>
                <Typography.Paragraph ellipsis={{ rows: 4 }} className="!mb-0 !text-xs !text-red-500 dark:!text-red-300">
                    {error}
                </Typography.Paragraph>
            </div>
            <TaskInfo result={result} error={error} onCopyPrompt={onCopyPrompt} />
            <div className="flex justify-end gap-2 border-t border-red-200 p-3 dark:border-red-950">
                <Button size="small" onClick={() => setDetailOpen(true)}>
                    详情
                </Button>
                <Button size="small" danger onClick={onRetry}>
                    重试
                </Button>
            </div>
            <Modal title="失败详情" open={detailOpen} width={760} onCancel={() => setDetailOpen(false)} footer={null}>
                <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-md bg-stone-950 p-3 text-xs text-stone-100">{detail}</pre>
            </Modal>
        </div>
    );
}

function HistoryLogCard({ log, index, selected, active, syncing, onSelectedChange, onDelete, onPreview, onRetry, onCopyPrompt, onDownload, onSync, onSaveAsset }: { log: GenerationLog; index: number; selected: boolean; active: boolean; syncing: boolean; onSelectedChange: (checked: boolean) => void; onDelete: () => void; onPreview: () => void; onRetry: () => void; onCopyPrompt: (text: string) => void | Promise<void>; onDownload: (video: GeneratedVideo, index: number) => void; onSync: (video: GeneratedVideo) => void; onSaveAsset: (video: GeneratedVideo, index: number) => void }) {
    const [expanded, setExpanded] = useState(false);
    const [detailOpen, setDetailOpen] = useState(false);

    return (
        <div className={`overflow-hidden rounded-lg border bg-background dark:bg-stone-950 ${active ? "border-stone-900 dark:border-stone-100" : "border-stone-200 dark:border-stone-800"}`}>
            <div className="relative aspect-video bg-stone-100 dark:bg-stone-900">
                <div className="absolute left-1.5 top-1.5 z-10 flex items-center gap-1 rounded-md bg-white/85 px-1.5 py-1 shadow-sm dark:bg-stone-950/80">
                    <Checkbox checked={selected} onChange={(event) => onSelectedChange(event.target.checked)} />
                    <Button size="small" type="text" danger title="删除" className="!h-6 !w-6 !p-0" icon={<Trash2 className="size-3.5" />} onClick={onDelete} />
                </div>
                <div className="absolute right-1.5 top-1.5 z-10 flex gap-1">
                    {log.video ? <VideoSourceTag video={log.video} /> : null}
                    <Tag className="m-0 text-[10px]" color={log.status === "成功" ? "blue" : "red"}>
                        {log.status}
                    </Tag>
                </div>
                {log.video ? (
                    <video src={log.video.url} controls className="size-full bg-black object-contain" />
                ) : (
                    <div className="flex size-full flex-col items-center justify-center gap-2 p-5 text-center text-sm text-red-500">
                        <AlertCircle className="size-7" />
                        <span>{log.error || "没有可显示的视频"}</span>
                    </div>
                )}
                <ReferenceThumbnailOverlay references={log.references} className="bottom-1.5 right-1.5" />
            </div>
            <div className="space-y-2 border-t border-stone-200 p-2.5 text-xs dark:border-stone-800">
                <div className={`${expanded ? "" : "line-clamp-2"} whitespace-pre-wrap text-stone-700 dark:text-stone-200`}>{log.prompt}</div>
                <div className="flex items-center justify-end gap-1">
                    <Button size="small" type="text" icon={<Copy className="size-3.5" />} onClick={() => void onCopyPrompt(log.prompt)}>
                        复制
                    </Button>
                    <Button size="small" type="text" icon={expanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />} onClick={() => setExpanded((value) => !value)}>
                        {expanded ? "收起" : "展开"}
                    </Button>
                </div>
                <div className="flex flex-wrap gap-1">
                    <Tag className="m-0 text-[10px]">{formatLogTime(log.createdAt)}</Tag>
                    <Tag className="m-0 text-[10px]">{log.model}</Tag>
                    <Tag className="m-0 text-[10px]">{log.size}</Tag>
                    <Tag className="m-0 text-[10px]">{log.resolution}p</Tag>
                    <Tag className="m-0 text-[10px]">{log.seconds}s</Tag>
                    <Tag className="m-0 text-[10px]">{formatDuration(log.durationMs)}</Tag>
                </div>
                {log.error ? (
                    <div className="flex items-start justify-between gap-2 rounded-md bg-red-100 px-2 py-1 text-red-600 dark:bg-red-950/40 dark:text-red-300">
                        <span className="line-clamp-2 min-w-0">{log.error}</span>
                        <Button size="small" type="text" className="!h-auto !p-0 text-xs" onClick={() => setDetailOpen(true)}>
                            详情
                        </Button>
                    </div>
                ) : null}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-2 border-t border-stone-200 px-2.5 py-2 dark:border-stone-800">
                <div className="flex flex-wrap gap-1">
                    <Button size="small" onClick={onPreview}>
                        载入
                    </Button>
                    <Button size="small" icon={<RotateCcw className="size-3.5" />} onClick={onRetry}>
                        重试
                    </Button>
                </div>
                {log.video ? (
                    <div className="flex shrink-0 gap-1">
                        <Button size="small" title="同步到云端存储" icon={<CloudUpload className="size-3.5" />} loading={syncing} disabled={isCloudVideo(log.video)} onClick={() => onSync(log.video!)} />
                        <Button size="small" icon={<FolderPlus className="size-3.5" />} onClick={() => onSaveAsset(log.video!, index)} />
                        <Button size="small" icon={<Download className="size-3.5" />} onClick={() => onDownload(log.video!, index)} />
                    </div>
                ) : null}
            </div>
            <Modal title="失败详情" open={detailOpen} width={760} onCancel={() => setDetailOpen(false)} footer={null}>
                <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-md bg-stone-950 p-3 text-xs text-stone-100">{log.errorDetail || log.error || "没有详情"}</pre>
            </Modal>
        </div>
    );
}

function VideoMetaBar({ video, index, syncing, onDownload, onSync, onSaveAsset }: { video: GeneratedVideo; index: number; syncing: boolean; onDownload: (video: GeneratedVideo, index: number) => void; onSync: (video: GeneratedVideo) => void; onSaveAsset: (video: GeneratedVideo, index: number) => void }) {
    return (
        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-2 border-t border-stone-200 px-2.5 py-2 dark:border-stone-800">
            <div className="flex min-w-0 flex-wrap gap-x-1.5 gap-y-1 text-[10px] text-stone-500 dark:text-stone-400">
                <span>
                    {video.width}x{video.height}
                </span>
                {video.bytes ? <span>{formatBytes(video.bytes)}</span> : <span>远端地址</span>}
                <span>{formatDuration(video.durationMs)}</span>
            </div>
            <div className="flex shrink-0 gap-1">
                <Button size="small" title="同步到云端存储" icon={<CloudUpload className="size-3.5" />} loading={syncing} disabled={isCloudVideo(video)} onClick={() => onSync(video)} />
                <Button size="small" icon={<FolderPlus className="size-3.5" />} onClick={() => onSaveAsset(video, index)} />
                <Button size="small" icon={<Download className="size-3.5" />} onClick={() => onDownload(video, index)} />
            </div>
        </div>
    );
}

function VideoSourceTag({ video }: { video: GeneratedVideo }) {
    const source = videoSource(video);
    if (source === "cloud") return <Tag className="m-0 text-[10px]" color="green">云端存储</Tag>;
    if (source === "local") return <Tag className="m-0 text-[10px]">本地缓存</Tag>;
    return <Tag className="m-0 text-[10px]" color="gold">AI 临时URL</Tag>;
}

function TaskInfo({ result, error, onCopyPrompt }: { result: GenerationResult; error?: string; onCopyPrompt: (text: string) => void | Promise<void> }) {
    const [expanded, setExpanded] = useState(false);
    return (
        <div className="space-y-2 border-t border-stone-200 px-3 py-2.5 text-xs text-stone-500 dark:border-stone-800 dark:text-stone-400">
            <div className="rounded-md bg-stone-50 p-2 dark:bg-stone-900">
                <div className={`${expanded ? "" : "line-clamp-2"} whitespace-pre-wrap text-stone-700 dark:text-stone-200`}>{result.prompt}</div>
                <div className="mt-2 flex justify-end gap-1">
                    <Button size="small" type="text" icon={<Copy className="size-3.5" />} onClick={() => void onCopyPrompt(result.prompt)}>
                        复制
                    </Button>
                    <Button size="small" type="text" icon={expanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />} onClick={() => setExpanded((value) => !value)}>
                        {expanded ? "收起" : "展开"}
                    </Button>
                </div>
            </div>
            <div className="flex flex-wrap gap-1.5">
                <Tag className="m-0">{formatLogTime(result.createdAt)}</Tag>
                <Tag className="m-0">{result.model}</Tag>
                <Tag className="m-0">{videoSizeLabel(result.config.size || "auto")}</Tag>
                <Tag className="m-0">{videoResolutionLabel(result.config.vquality || "720")}</Tag>
                <Tag className="m-0">{videoSecondsLabel(result.config.videoSeconds || "6")}</Tag>
                <Tag className="m-0">任务 {result.config.videoCount || "1"}</Tag>
                {result.durationMs ? <Tag className="m-0">{formatDuration(result.durationMs)}</Tag> : null}
            </div>
            {error ? <div className="rounded-md bg-red-100 px-2 py-1.5 text-red-600 dark:bg-red-950/40 dark:text-red-300">{error}</div> : null}
        </div>
    );
}

function ReferenceThumbnailOverlay({ references, className = "" }: { references?: ReferenceImage[]; className?: string }) {
    const visibleReferences = (references || []).filter((item) => Boolean(item.dataUrl)).slice(0, 3);
    if (!visibleReferences.length) return null;
    return (
        <div className={`absolute z-10 flex items-center gap-1 rounded-md bg-black/55 p-1 shadow-sm backdrop-blur ${className}`}>
            {visibleReferences.map((item) => (
                <img key={item.id} src={item.dataUrl} alt={item.name} className="size-7 rounded border border-white/60 object-cover" />
            ))}
            {(references || []).length > visibleReferences.length ? <span className="px-1 text-[10px] text-white">+{(references || []).length - visibleReferences.length}</span> : null}
        </div>
    );
}

function createPendingResult(id: string, snapshot: RequestSnapshot): GenerationResult {
    return { id, status: "pending", createdAt: Date.now(), prompt: snapshot.text, model: snapshot.displayConfig.videoModel || snapshot.displayConfig.model, config: snapshot.displayConfig, references: snapshot.references };
}

function videoFromGenerationResult(result: VideoGenerationResult, durationMs = result.durationMs): GeneratedVideo {
    return { id: result.id || nanoid(), url: result.url, durationMs, width: result.width || 1280, height: result.height || 720, bytes: result.bytes || 0, mimeType: result.mimeType || "video/mp4", source: "ai" };
}

async function readStoredLogs() {
    if (typeof window === "undefined") return [];
    try {
        const logs: GenerationLog[] = [];
        await logStore.iterate<GenerationLog, void>((value) => {
            logs.push(value);
        });
        return (await Promise.all(logs.map(normalizeLog))).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    } catch {
        return [];
    }
}

async function replaceStoredVideoHistory(logs: GenerationLog[]) {
    if (typeof window === "undefined") return;
    await logStore.clear();
    await Promise.all(logs.map((log) => logStore.setItem(log.id, serializeLog(log))));
}

function videoHistorySnapshot(logs: GenerationLog[]) {
    return {
        logs: logs.map(serializeLog),
    };
}

function videoHistorySnapshotText(logs: GenerationLog[]) {
    return JSON.stringify(videoHistorySnapshot(logs));
}

async function mergeVideoLogs(remoteLogs: GenerationLog[], localLogs: GenerationLog[]) {
    const normalized = await Promise.all([...remoteLogs, ...localLogs].map(normalizeLog));
    const byId = new Map<string, GenerationLog>();
    for (const log of normalized) {
        const existing = byId.get(log.id);
        if (!existing || videoLogScore(log) > videoLogScore(existing) || (videoLogScore(log) === videoLogScore(existing) && log.createdAt >= existing.createdAt)) {
            byId.set(log.id, log);
        }
    }
    return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt);
}

function videoLogScore(log: GenerationLog) {
    const source = log.video ? videoSource(log.video) : "";
    return (log.status === "成功" ? 4 : 0) + (log.video ? 4 : 0) + (source === "cloud" ? 3 : source === "local" ? 2 : source === "ai" ? 1 : 0) + (log.errorDetail ? 1 : 0);
}

async function normalizeLog(log: Partial<GenerationLog>): Promise<GenerationLog> {
    const video = log.video?.storageKey ? { ...log.video, source: videoSource(log.video), url: await resolveMediaUrl(log.video.storageKey, log.video.url) } : log.video ? { ...log.video, source: videoSource(log.video) } : log.video;
    const references = await Promise.all((log.references || []).map(async (item) => ({ ...item, dataUrl: await resolveImageUrl(item.storageKey, item.dataUrl) })));
    const config = normalizeLogConfig(log);
    return {
        id: log.id || nanoid(),
        createdAt: log.createdAt || Date.now(),
        title: log.title || log.model || "未命名",
        prompt: log.prompt || "",
        time: log.time || new Date().toLocaleString("zh-CN", { hour12: false }),
        model: log.model || config.videoModel || "",
        config,
        references,
        durationMs: log.durationMs || 0,
        size: log.size || config.size || "",
        resolution: normalizeResolution(log.resolution || config.vquality || ""),
        seconds: log.seconds || config.videoSeconds || "",
        status: log.status || "成功",
        video,
        error: log.error,
        errorDetail: log.errorDetail,
    };
}

function serializeLog(log: GenerationLog): GenerationLog {
    return { ...log, references: log.references.map((item) => ({ ...item, dataUrl: item.storageKey ? "" : item.dataUrl })), video: log.video?.storageKey ? { ...log.video, url: "" } : log.video };
}

function normalizeLogConfig(log: Partial<GenerationLog>): GenerationLogConfig {
    return {
        model: log.config?.model || log.model || "",
        videoModel: log.config?.videoModel || log.model || "",
        size: log.config?.size || log.size || "",
        vquality: normalizeResolution(log.config?.vquality || log.resolution || ""),
        videoSeconds: log.config?.videoSeconds || log.seconds || "",
        videoCount: log.config?.videoCount || "1",
    };
}

function buildGenerationLogConfig(config: AiConfig): GenerationLogConfig {
    return { model: config.model, videoModel: config.videoModel, size: normalizeVideoSize(config.size), vquality: normalizeResolution(config.vquality), videoSeconds: normalizeVideoSeconds(config.videoSeconds), videoCount: String(normalizeVideoCount(config.videoCount)) };
}

function buildLog({ prompt, model, config, references, durationMs, status, video, error, errorDetail }: { prompt: string; model: string; config: GenerationLogConfig; references: ReferenceImage[]; durationMs: number; status: GenerationLog["status"]; video?: GeneratedVideo; error?: string; errorDetail?: string }): GenerationLog {
    return {
        id: nanoid(),
        createdAt: Date.now(),
        title: prompt.slice(0, 12) || "未命名",
        prompt,
        time: new Date().toLocaleString("zh-CN", { hour12: false }),
        model,
        config,
        references,
        durationMs,
        size: config.size,
        resolution: config.vquality,
        seconds: config.videoSeconds,
        status,
        video,
        error,
        errorDetail,
    };
}

function buildVideoConfig(config: AiConfig, model: string): AiConfig {
    return { ...config, model, videoModel: model, activeChannelId: config.videoChannelId, size: normalizeVideoSize(config.size), videoSeconds: normalizeVideoSeconds(config.videoSeconds), vquality: normalizeResolution(config.vquality), videoCount: String(normalizeVideoCount(config.videoCount)) };
}

function generationLogStorageKeys(log: GenerationLog) {
    return { media: [log.video?.storageKey].filter((key): key is string => Boolean(key)), images: log.references.filter(isDisposableReferenceFile).map((image) => image.storageKey).filter((key): key is string => Boolean(key)) };
}

function isCloudVideo(video: GeneratedVideo) {
    return videoSource(video) === "cloud";
}

function videoSource(video: Pick<GeneratedVideo, "source" | "storageKey">) {
    if (video.source) return video.source;
    if (video.storageKey?.startsWith("server:")) return "cloud";
    if (video.storageKey) return "local";
    return "ai";
}

function referenceUsedByGeneration(reference: ReferenceImage, logs: GenerationLog[], results: GenerationResult[]) {
    if (!reference.storageKey) return false;
    return logs.some((log) => log.references.some((item) => item.storageKey === reference.storageKey)) || results.some((result) => result.references.some((item) => item.storageKey === reference.storageKey));
}

function shouldDeleteReferenceFile(reference: ReferenceImage, logs: GenerationLog[], results: GenerationResult[]) {
    if (!reference.storageKey) return false;
    if (!isDisposableReferenceFile(reference)) return false;
    return !referenceUsedByGeneration(reference, logs, results);
}

function isDisposableReferenceFile(reference: ReferenceImage) {
    return reference.temporary === true || reference.source === "upload" || reference.source === "clipboard";
}

function disposableLogStorageKeys(deletedLogs: GenerationLog[], remainingLogs: GenerationLog[], currentReferences: ReferenceImage[], results: GenerationResult[]) {
    const deleted = deletedLogs.reduce(
        (keys, log) => {
            const next = generationLogStorageKeys(log);
            next.media.forEach((key) => keys.media.add(key));
            next.images.forEach((key) => keys.images.add(key));
            return keys;
        },
        { media: new Set<string>(), images: new Set<string>() },
    );
    const retained = remainingLogs.reduce(
        (keys, log) => {
            const next = generationLogStorageKeys(log);
            next.media.forEach((key) => keys.media.add(key));
            next.images.forEach((key) => keys.images.add(key));
            return keys;
        },
        { media: new Set<string>(), images: new Set<string>() },
    );
    currentReferences.forEach((reference) => {
        if (reference.storageKey) retained.images.add(reference.storageKey);
    });
    results.forEach((result) => {
        if (result.video?.storageKey) retained.media.add(result.video.storageKey);
        result.references.forEach((reference) => {
            if (reference.storageKey) retained.images.add(reference.storageKey);
        });
    });
    return { media: [...deleted.media].filter((key) => !retained.media.has(key)), images: [...deleted.images].filter((key) => !retained.images.has(key)) };
}

function updateResult(results: GenerationResult[], id: string, next: Partial<GenerationResult>) {
    return results.map((item) => (item.id === id ? { ...item, ...next } : item));
}

function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : "生成失败";
}

function errorDetail(error: unknown) {
    if (error instanceof VideoRequestError && error.detail) return error.detail;
    if (error instanceof Error) return error.stack || error.message;
    try {
        return JSON.stringify(error, null, 2);
    } catch {
        return String(error || "生成失败");
    }
}

function settingsSummary(config: AiConfig, model: string) {
    return [model, videoSizeLabel(config.size || "auto"), videoResolutionLabel(config.vquality || "720"), videoSecondsLabel(config.videoSeconds || "6"), `${normalizeVideoCount(config.videoCount)} 个任务`].join(" · ");
}

function normalizeVideoSeconds(value: string) {
    const seconds = Math.floor(Number(value) || 6);
    return String(Math.max(1, Math.min(20, seconds)));
}

function normalizeVideoCount(value: string) {
    const count = Math.floor(Number(value) || 1);
    return Math.max(1, Math.min(6, count));
}

function normalizeVideoSize(value: string) {
    return normalizeVideoSizeValue(value);
}

function normalizeResolution(value: string) {
    return normalizeVideoResolutionValue(value);
}

function formatLogTime(value: number) {
    return new Date(value).toLocaleString("zh-CN", { hour12: false });
}
