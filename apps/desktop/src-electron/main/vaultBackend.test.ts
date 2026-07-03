import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ElectronVaultBackend } from "./vaultBackend";
import type { NativeBackendBridge } from "./nativeBackend";
import type { AppUpdaterBackend } from "./updater";

type VaultEntryForTest = {
    file_name: string;
    kind: string;
    mime_type: string | null;
    is_text_like: boolean | null;
    open_in_app: boolean | null;
    viewer_kind: string | null;
};

const electronAppMock = vi.hoisted(() => ({
    isPackaged: true,
}));

vi.mock("electron", () => ({
    app: electronAppMock,
}));

function createNativeBackend(): NativeBackendBridge & {
    invoke: ReturnType<typeof vi.fn>;
} {
    return {
        supports: vi.fn((command: string) =>
            [
                "get_app_update_configuration",
                "check_for_app_update",
                "download_and_install_app_update",
            ].includes(command),
        ),
        invoke: vi.fn(() =>
            Promise.resolve({
                source: "sidecar",
            }),
        ),
        dispose: vi.fn(),
    };
}

function createUpdater(): AppUpdaterBackend & {
    getConfiguration: ReturnType<typeof vi.fn>;
    checkForUpdates: ReturnType<typeof vi.fn>;
    downloadAndInstallUpdate: ReturnType<typeof vi.fn>;
} {
    return {
        getConfiguration: vi.fn(() => ({
            enabled: true,
            currentVersion: "0.2.0",
            channel: "stable",
            endpoint: "https://updates.example.test/latest.yml",
            message: null,
            update: null,
        })),
        checkForUpdates: vi.fn(() =>
            Promise.resolve({
                enabled: true,
                currentVersion: "0.2.0",
                channel: "stable",
                endpoint: "https://updates.example.test/latest.yml",
                message: null,
                update: {
                    body: null,
                    currentVersion: "0.2.0",
                    version: "0.3.0",
                    date: null,
                    target: "darwin-universal",
                    downloadUrl:
                        "https://updates.example.test/NeverWrite-0.3.0.zip",
                    rawJson: {},
                },
            }),
        ),
        downloadAndInstallUpdate: vi.fn(() => Promise.resolve()),
    };
}

describe("ElectronVaultBackend updater routing", () => {
    it("keeps updater commands owned by Electron even when the sidecar claims support", async () => {
        const nativeBackend = createNativeBackend();
        const updater = createUpdater();
        const backend = new ElectronVaultBackend(
            vi.fn(),
            updater,
            nativeBackend,
        );

        await expect(
            backend.invoke("get_app_update_configuration"),
        ).resolves.toMatchObject({
            enabled: true,
            currentVersion: "0.2.0",
        });
        await expect(backend.invoke("check_for_app_update")).resolves.toMatchObject(
            {
                update: {
                    version: "0.3.0",
                    target: "darwin-universal",
                },
            },
        );
        await expect(
            backend.invoke("download_and_install_app_update", {
                version: "0.3.0",
                target: "darwin-universal",
            }),
        ).resolves.toBeNull();

        expect(updater.getConfiguration).toHaveBeenCalledTimes(1);
        expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
        expect(updater.downloadAndInstallUpdate).toHaveBeenCalledWith(
            "0.3.0",
            "darwin-universal",
        );
        expect(nativeBackend.supports).not.toHaveBeenCalledWith(
            "check_for_app_update",
        );
        expect(nativeBackend.invoke).not.toHaveBeenCalled();
    });
});

describe("ElectronVaultBackend vault classification", () => {
    it("classifies Mermaid files as in-app diagram files in the fallback backend", async () => {
        const vaultPath = await fs.mkdtemp(
            path.join(os.tmpdir(), "neverwrite-mermaid-"),
        );
        await fs.writeFile(
            path.join(vaultPath, "flow.mmd"),
            "flowchart TD\nA --> B\n",
            "utf8",
        );
        await fs.writeFile(
            path.join(vaultPath, "sequence.mermaid"),
            "sequenceDiagram\nA->>B: hello\n",
            "utf8",
        );

        const backend = new ElectronVaultBackend(
            vi.fn(),
            createUpdater(),
            null,
        );

        await backend.invoke("start_open_vault", { path: vaultPath });
        const entries = (await backend.invoke("list_vault_entries", {
            vaultPath,
        })) as VaultEntryForTest[];

        for (const fileName of ["flow.mmd", "sequence.mermaid"]) {
            const entry = entries.find(
                (candidate) => candidate.file_name === fileName,
            );

            expect(entry).toMatchObject({
                kind: "file",
                mime_type: "text/plain",
                is_text_like: true,
                open_in_app: true,
                viewer_kind: "mermaid",
            });
        }
    });
});
