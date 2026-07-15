import { describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
    ElectronVaultBackend,
    resolveElectronAiAttachmentsRoot,
} from "./vaultBackend";
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
    getPath: vi.fn(() => "/tmp/neverwrite-test-user-data"),
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

function sha256Hex(value: string) {
    return crypto.createHash("sha256").update(value).digest("hex");
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

describe("ElectronVaultBackend AI history move", () => {
    it("routes the all-history move to the native persistence layer", async () => {
        const nativeBackend: NativeBackendBridge & {
            invoke: ReturnType<typeof vi.fn>;
        } = {
            supports: vi.fn(
                (command: string) =>
                    command === "ai_move_all_session_histories",
            ),
            invoke: vi.fn(() =>
                Promise.resolve({ completed: true, histories_moved: 1 }),
            ),
            dispose: vi.fn(),
        };
        const backend = new ElectronVaultBackend(
            vi.fn(),
            createUpdater(),
            nativeBackend,
        );
        const args = {
            vaultPath: "/vault",
            fromScope: "device",
            toScope: "vault",
        };

        await expect(
            backend.invoke("ai_move_all_session_histories", args),
        ).resolves.toEqual({ completed: true, histories_moved: 1 });
        expect(nativeBackend.invoke).toHaveBeenCalledWith(
            "ai_move_all_session_histories",
            args,
        );
    });

    it("does not fall back to rewriting indexed histories in Node", async () => {
        const backend = new ElectronVaultBackend(vi.fn(), createUpdater(), null);

        await expect(
            backend.invoke("ai_move_all_session_histories", {
                vaultPath: "/vault",
                fromScope: "device",
                toScope: "vault",
            }),
        ).rejects.toThrow("requires the native backend");
    });

    it("uses the real vault path for device AI attachment namespaces", async () => {
        const userDataPath = await fs.mkdtemp(
            path.join(os.tmpdir(), "neverwrite-user-data-"),
        );
        electronAppMock.getPath.mockReturnValue(userDataPath);

        const realVaultPath = await fs.mkdtemp(
            path.join(os.tmpdir(), "neverwrite-real-vault-"),
        );
        const linkRoot = await fs.mkdtemp(
            path.join(os.tmpdir(), "neverwrite-link-root-"),
        );
        const linkPath = path.join(linkRoot, "vault-link");
        await fs.symlink(realVaultPath, linkPath, "dir");

        const backend = new ElectronVaultBackend(vi.fn(), createUpdater(), null);
        const saved = (await backend.invoke("ai_save_attachment", {
            vaultPath: linkPath,
            sessionId: "session-1",
            fileName: "pasted-image-source.png",
            bytes: [112, 110, 103],
        })) as { path: string };

        expect(saved.path).toContain(sha256Hex(await fs.realpath(realVaultPath)));
        expect(saved.path).not.toContain(sha256Hex(path.resolve(linkPath)));
        expect(
            saved.path.startsWith(resolveElectronAiAttachmentsRoot(linkPath)),
        ).toBe(true);
    });
});

describe("ElectronVaultBackend OKF frontmatter", () => {
    it("reads status and type from note frontmatter for list_notes and read_note", async () => {
        const vaultPath = await fs.mkdtemp(
            path.join(os.tmpdir(), "neverwrite-okf-"),
        );
        await fs.writeFile(
            path.join(vaultPath, "with-meta.md"),
            "---\ntitle: Alpha\nstatus: published\ntype: runbook\n---\n\nBody\n",
            "utf8",
        );
        await fs.writeFile(
            path.join(vaultPath, "blank-status.md"),
            "---\ntitle: Beta\nstatus:   \n---\n\nBody\n",
            "utf8",
        );
        await fs.writeFile(
            path.join(vaultPath, "no-meta.md"),
            "# Gamma\n\nBody\n",
            "utf8",
        );

        const backend = new ElectronVaultBackend(vi.fn(), createUpdater(), null);
        await backend.invoke("start_open_vault", { path: vaultPath });

        const notes = (await backend.invoke("list_notes", {
            vaultPath,
        })) as Array<{ id: string; status: string | null; okf_type: string | null }>;

        const withMeta = notes.find((note) => note.id === "with-meta");
        expect(withMeta).toMatchObject({
            status: "published",
            okf_type: "runbook",
        });

        const blank = notes.find((note) => note.id === "blank-status");
        expect(blank).toMatchObject({ status: null, okf_type: null });

        const noMeta = notes.find((note) => note.id === "no-meta");
        expect(noMeta).toMatchObject({ status: null, okf_type: null });

        const detail = (await backend.invoke("read_note", {
            vaultPath,
            noteId: "with-meta",
        })) as { status: string | null; okf_type: string | null };
        expect(detail.status).toBe("published");
        expect(detail.okf_type).toBe("runbook");

        // The save_note response must carry the updated status too: the
        // renderer ignores user-origin change events and syncs its store
        // from this response.
        const saved = (await backend.invoke("save_note", {
            vaultPath,
            noteId: "with-meta",
            content:
                "---\ntitle: Alpha\nstatus: archived\ntype: runbook\n---\n\nBody\n",
        })) as { status: string | null; okf_type: string | null };
        expect(saved.status).toBe("archived");
        expect(saved.okf_type).toBe("runbook");
    });

    it("reads status and type from CRLF frontmatter", async () => {
        const vaultPath = await fs.mkdtemp(
            path.join(os.tmpdir(), "neverwrite-okf-crlf-"),
        );
        await fs.writeFile(
            path.join(vaultPath, "crlf.md"),
            "---\r\ntitle: Alpha\r\nstatus: published\r\ntype: runbook\r\n---\r\n\r\nBody\r\n",
            "utf8",
        );

        const backend = new ElectronVaultBackend(vi.fn(), createUpdater(), null);
        await backend.invoke("start_open_vault", { path: vaultPath });

        const notes = (await backend.invoke("list_notes", {
            vaultPath,
        })) as Array<{
            id: string;
            title: string;
            status: string | null;
            okf_type: string | null;
        }>;

        const note = notes.find((candidate) => candidate.id === "crlf");
        expect(note).toMatchObject({
            title: "Alpha",
            status: "published",
            okf_type: "runbook",
        });
    });

    it("detects okf_version from the vault-root index.md on open", async () => {
        const vaultPath = await fs.mkdtemp(
            path.join(os.tmpdir(), "neverwrite-okf-version-"),
        );
        await fs.writeFile(
            path.join(vaultPath, "index.md"),
            "---\nokf_version: \"0.1\"\n---\n\n# Bundle\n",
            "utf8",
        );

        const backend = new ElectronVaultBackend(vi.fn(), createUpdater(), null);
        await backend.invoke("start_open_vault", { path: vaultPath });

        const openState = (await backend.invoke("get_vault_open_state", {
            vaultPath,
        })) as { stage: string; okf_version: string | null };
        expect(openState.stage).toBe("ready");
        expect(openState.okf_version).toBe("0.1");
    });

    it("reports a null okf_version for vaults without a root index.md declaration", async () => {
        const vaultPath = await fs.mkdtemp(
            path.join(os.tmpdir(), "neverwrite-okf-none-"),
        );
        await fs.writeFile(
            path.join(vaultPath, "note.md"),
            "# Plain vault\n",
            "utf8",
        );

        const backend = new ElectronVaultBackend(vi.fn(), createUpdater(), null);
        await backend.invoke("start_open_vault", { path: vaultPath });

        const openState = (await backend.invoke("get_vault_open_state", {
            vaultPath,
        })) as { stage: string; okf_version: string | null };
        expect(openState.stage).toBe("ready");
        expect(openState.okf_version).toBeNull();
    });
});
