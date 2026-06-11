import { useCallback, useEffect, useMemo, useState } from "react";
import { App } from "antd";
import { APP_VERSION } from "@/constant/env";
import { parseChangelog, type ReleaseInfo } from "@/lib/release";

const latestVersionUrl = "https://raw.githubusercontent.com/HuFakai/infinite-canvas/main/VERSION";
const latestChangelogUrl = "https://raw.githubusercontent.com/HuFakai/infinite-canvas/main/CHANGELOG.md";

function readLocalReleases(): ReleaseInfo[] {
    try {
        return JSON.parse(process.env.NEXT_PUBLIC_APP_RELEASES || "[]");
    } catch {
        return [];
    }
}

function toVersionParts(version: string) {
    const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
    return match ? match.slice(1).map(Number) : null;
}

function isNewerVersion(latestVersion: string, currentVersion: string) {
    return compareVersions(latestVersion, currentVersion) > 0;
}

function compareVersions(a: string, b: string) {
    if (a === "Unreleased" && b !== "Unreleased") return 1;
    if (b === "Unreleased" && a !== "Unreleased") return -1;
    const left = toVersionParts(a);
    const right = toVersionParts(b);
    if (!left || !right) return 0;
    for (let index = 0; index < left.length; index += 1) {
        if (left[index] !== right[index]) return left[index] > right[index] ? 1 : -1;
    }
    return 0;
}

function newerVersion(remoteVersion: string, currentVersion: string) {
    const remote = remoteVersion.trim() || currentVersion;
    return compareVersions(remote, currentVersion) > 0 ? remote : currentVersion;
}

function mergeReleases(local: ReleaseInfo[], remote: ReleaseInfo[]) {
    const map = new Map<string, ReleaseInfo>();
    [...local, ...remote].forEach((release) => {
        if (!map.has(release.version)) map.set(release.version, release);
    });
    return Array.from(map.values()).sort((a, b) => compareVersions(b.version, a.version));
}

export function useVersionCheck() {
    const currentVersion = APP_VERSION;
    const { message } = App.useApp();
    const localReleases = useMemo(readLocalReleases, []);
    const [latestVersion, setLatestVersion] = useState(currentVersion);
    const [releases, setReleases] = useState<ReleaseInfo[]>(localReleases);
    const [checking, setChecking] = useState(false);
    const [open, setOpen] = useState(false);
    const hasNewVersion = isNewerVersion(latestVersion, currentVersion);

    const checkLatestVersion = useCallback(async () => {
        try {
            const response = await fetch(latestVersionUrl);
            if (!response.ok) return false;
            const version = await response.text();
            setLatestVersion(newerVersion(version, currentVersion));
            return true;
        } catch {
            return false;
        }
    }, [currentVersion]);

    const checkLatestRelease = useCallback(
        async (showMessage = false) => {
            setChecking(true);
            try {
                const [versionResponse, changelogResponse] = await Promise.all([fetch(latestVersionUrl), fetch(latestChangelogUrl)]);
                if (!versionResponse.ok) throw new Error("版本读取失败");
                if (!changelogResponse.ok) throw new Error("更新日志读取失败");
                const [version, changelog] = await Promise.all([versionResponse.text(), changelogResponse.text()]);
                setLatestVersion(newerVersion(version, currentVersion));
                if (changelog.trim()) setReleases(mergeReleases(localReleases, parseChangelog(changelog)));
                if (showMessage) message.success("已获取最新版本信息");
                return true;
            } catch {
                setLatestVersion(currentVersion);
                setReleases(localReleases);
                if (showMessage) message.error("获取最新版本信息失败");
                return false;
            } finally {
                setChecking(false);
            }
        },
        [currentVersion, localReleases, message],
    );

    useEffect(() => {
        void checkLatestVersion();
    }, [checkLatestVersion]);

    const openReleaseModal = useCallback(() => {
        setOpen(true);
        void checkLatestRelease();
    }, [checkLatestRelease]);

    return {
        open,
        setOpen,
        openReleaseModal,
        latestVersion,
        releases,
        checking,
        hasNewVersion,
        checkLatestRelease,
    };
}
