import { afterEach, describe, expect, it, vi } from "vitest";

const electronAppMock = vi.hoisted(() => ({
    getVersion: vi.fn(() => "0.2.0"),
    isPackaged: true,
}));

vi.mock("electron", () => ({
    app: electronAppMock,
}));

vi.mock("electron-updater", () => ({
    AppImageUpdater: class {
        autoDownload = false;
        autoInstallOnAppQuit = false;
        forceDevUpdateConfig = false;
        logger: unknown = null;

        constructor(_options: unknown) {}
    },
    MacUpdater: class {
        autoDownload = false;
        autoInstallOnAppQuit = false;
        forceDevUpdateConfig = false;
        logger: unknown = null;

        constructor(_options: unknown) {}
    },
    NsisUpdater: class {
        autoDownload = false;
        autoInstallOnAppQuit = false;
        forceDevUpdateConfig = false;
        logger: unknown = null;

        constructor(_options: unknown) {}
    },
}));

import { ElectronAppUpdater } from "./updater";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
const originalArch = Object.getOwnPropertyDescriptor(process, "arch");
const updaterEnvKeys = [
    "APPIMAGE",
    "NEVERWRITE_UPDATER_ENDPOINT",
    "NEVERWRITE_UPDATER_BASE_URL",
    "NEVERWRITE_UPDATER_CHANNEL",
    "NEVERWRITE_UPDATER_ALLOWED_FEED_HOSTS",
    "NEVERWRITE_UPDATER_ALLOWED_DOWNLOAD_HOSTS",
    "NEVERWRITE_UPDATER_ALLOW_PRODUCTION_ENDPOINTS_IN_NON_PROD",
    "NEVERWRITE_UPDATER_VERBOSE_LOGS",
    "NEVERWRITE_UPDATER_DEBUG",
];

function setRuntimePlatform(platform: NodeJS.Platform, arch: string) {
    Object.defineProperty(process, "platform", {
        configurable: true,
        value: platform,
    });
    Object.defineProperty(process, "arch", {
        configurable: true,
        value: arch,
    });
}

afterEach(() => {
    electronAppMock.isPackaged = true;
    electronAppMock.getVersion.mockReturnValue("0.2.0");
    for (const key of updaterEnvKeys) {
        delete process.env[key];
    }
    if (originalPlatform) {
        Object.defineProperty(process, "platform", originalPlatform);
    }
    if (originalArch) {
        Object.defineProperty(process, "arch", originalArch);
    }
});

describe("ElectronAppUpdater configuration", () => {
    it("uses the public GitHub Pages feed by default in packaged macOS builds", () => {
        setRuntimePlatform("darwin", "arm64");

        const status = new ElectronAppUpdater().getConfiguration();

        expect(status).toMatchObject({
            enabled: true,
            channel: "stable",
            currentVersion: "0.2.0",
            endpoint:
                "https://jsgrrchg.github.io/NeverWrite/stable/darwin-universal/latest-mac.yml",
            message: null,
            update: null,
        });
    });

    it("keeps non-packaged builds local unless an updater endpoint is configured", () => {
        electronAppMock.isPackaged = false;
        setRuntimePlatform("darwin", "arm64");

        const status = new ElectronAppUpdater().getConfiguration();

        expect(status).toMatchObject({
            enabled: false,
            endpoint: null,
            message: null,
        });
    });

    it("allows the base feed URL to override the packaged default", () => {
        process.env.NEVERWRITE_UPDATER_BASE_URL = "https://updates.example.com/app";
        process.env.NEVERWRITE_UPDATER_ALLOWED_FEED_HOSTS = "example.com";
        setRuntimePlatform("win32", "x64");

        const status = new ElectronAppUpdater().getConfiguration();

        expect(status).toMatchObject({
            enabled: true,
            endpoint: "https://updates.example.com/app/stable/windows-x64/latest.yml",
            message: null,
        });
    });

    it("uses the Linux x64 AppImage feed in packaged Linux builds", () => {
        setRuntimePlatform("linux", "x64");
        process.env.APPIMAGE = "/tmp/NeverWrite.AppImage";

        const status = new ElectronAppUpdater().getConfiguration();

        expect(status).toMatchObject({
            enabled: true,
            endpoint:
                "https://jsgrrchg.github.io/NeverWrite/stable/linux-x64/latest-linux.yml",
            message: null,
        });
    });

    it("uses the Linux ARM64 AppImage feed in packaged Linux builds", () => {
        setRuntimePlatform("linux", "arm64");
        process.env.APPIMAGE = "/tmp/NeverWrite-arm64.AppImage";

        const status = new ElectronAppUpdater().getConfiguration();

        expect(status).toMatchObject({
            enabled: true,
            endpoint:
                "https://jsgrrchg.github.io/NeverWrite/stable/linux-arm64/latest-linux-arm64.yml",
            message: null,
        });
    });

    it("disables the Linux x64 updater outside AppImage builds", () => {
        setRuntimePlatform("linux", "x64");

        const status = new ElectronAppUpdater().getConfiguration();

        expect(status).toMatchObject({
            enabled: false,
            endpoint: null,
            message:
                "Updates for Debian packages are handled by apt when the NeverWrite APT repository is configured.",
            update: null,
        });
    });

    it("disables the Linux ARM64 updater outside AppImage builds", () => {
        setRuntimePlatform("linux", "arm64");

        const status = new ElectronAppUpdater().getConfiguration();

        expect(status).toMatchObject({
            enabled: false,
            endpoint: null,
            message:
                "Updates for Debian packages are handled by apt when the NeverWrite APT repository is configured.",
            update: null,
        });
    });
});
