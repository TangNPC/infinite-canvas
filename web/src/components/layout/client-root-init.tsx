"use client";

import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { App } from "antd";

import { useConfigStore, type AiConfig } from "@/stores/use-config-store";
import { useAssetStore } from "@/stores/use-asset-store";
import { useUserStore } from "@/stores/use-user-store";
import { fetchUserConfig } from "@/services/api/user-config";
import { defaultUserStorageProvider, saveUserStorageProvider } from "@/services/image-storage";

export function ClientRootInit({ children }: { children: ReactNode }) {
    const { message } = App.useApp();
    const handledConfigParams = useRef(false);
    const pathname = usePathname();
    const hydrateUser = useUserStore((state) => state.hydrateUser);
    const token = useUserStore((state) => state.token);
    const user = useUserStore((state) => state.user);
    const loadPublicSettings = useConfigStore((state) => state.loadPublicSettings);
    const publicSettings = useConfigStore((state) => state.publicSettings);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const hydrateAccountAssets = useAssetStore((state) => state.hydrateAccountAssets);
    const stopAccountAssetSync = useAssetStore((state) => state.stopAccountAssetSync);
    const isLoginPage = pathname === "/login" || pathname === "/admin/login";

    useEffect(() => {
        void loadPublicSettings();
    }, [loadPublicSettings]);

    useEffect(() => {
        if (!isLoginPage) void hydrateUser();
    }, [hydrateUser, isLoginPage]);

    useEffect(() => {
        if (!publicSettings?.site) return;
        const { name, faviconUrl } = publicSettings.site;
        if (name) document.title = name;
        if (faviconUrl) {
            let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
            if (!link) {
                link = document.createElement("link");
                link.rel = "icon";
                document.head.appendChild(link);
            }
            link.href = faviconUrl;
        }
    }, [publicSettings?.site]);

    useEffect(() => {
        if (handledConfigParams.current) return;
        const searchParams = new URLSearchParams(window.location.search);
        const baseUrl = searchParams.get("baseUrl") || searchParams.get("baseurl");
        const apiKey = searchParams.get("apiKey") || searchParams.get("apikey");
        if (!baseUrl && !apiKey) return;
        if (!publicSettings) return;
        handledConfigParams.current = true;
        searchParams.delete("baseUrl");
        searchParams.delete("baseurl");
        searchParams.delete("apiKey");
        searchParams.delete("apikey");
        window.history.replaceState(null, "", `${window.location.pathname}${searchParams.size ? `?${searchParams}` : ""}${window.location.hash}`);
        if (!publicSettings.modelChannel.allowCustomChannel) {
            openConfigDialog(false);
            message.error("后台未允许用户自定义渠道，请联系管理员进行配置");
            return;
        }
        updateConfig("channelMode", "local");
        if (baseUrl) updateConfig("baseUrl", baseUrl);
        if (apiKey) updateConfig("apiKey", apiKey);
        openConfigDialog(false);
    }, [message, openConfigDialog, publicSettings, updateConfig]);

    useEffect(() => {
        if (token && user?.id) {
            void fetchUserConfig(token)
                .then((payload) => {
                    const syncAssets = payload.syncCapabilities?.assets === true;
                    void hydrateAccountAssets(token, syncAssets);

                    const syncUserData = payload.syncCapabilities?.userData === true;
                    void import("@/app/(user)/canvas/stores/use-canvas-store").then(({ useCanvasStore }) => {
                        void useCanvasStore.getState().syncWithRemote(token, payload.canvasData, syncUserData);
                    });

                    let syncModel = false;
                    let syncStorage = false;
                    if (payload.modelConfig) {
                        syncModel = !!payload.modelConfig.syncModelConfig;
                        syncStorage = !!payload.modelConfig.syncStorageConfig;

                        if (syncModel) {
                            Object.entries(payload.modelConfig).forEach(([key, value]) => updateConfig(key as keyof AiConfig, value as never));
                        } else {
                            updateConfig("syncModelConfig", false);
                        }

                        if (syncStorage) {
                            updateConfig("syncStorageConfig", true);
                        } else {
                            updateConfig("syncStorageConfig", false);
                        }
                    } else {
                        updateConfig("syncModelConfig", false);
                        updateConfig("syncStorageConfig", false);
                    }

                    if (syncStorage && payload.storageProvider) {
                        const next = {
                            ...defaultUserStorageProvider(),
                            ...payload.storageProvider,
                            enabled: payload.storageProvider.enabled !== undefined ? payload.storageProvider.enabled : true,
                        };
                        saveUserStorageProvider(next);
                    }
                })
                .catch(() => {
                    void hydrateAccountAssets(token, false);
                    void import("@/app/(user)/canvas/stores/use-canvas-store").then(({ useCanvasStore }) => {
                        useCanvasStore.getState().setSyncEnabled(false);
                    });
                });
            return;
        }
        stopAccountAssetSync();
        void import("@/app/(user)/canvas/stores/use-canvas-store").then(({ useCanvasStore }) => {
            useCanvasStore.getState().setSyncEnabled(false);
        });
    }, [hydrateAccountAssets, stopAccountAssetSync, token, user?.id, updateConfig]);

    return <>{children}</>;
}
