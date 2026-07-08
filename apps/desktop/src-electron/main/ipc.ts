import fs from "node:fs/promises";
import { realpathSync } from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import {
    ELECTRON_IPC,
    type IpcAppLogEnvelope,
    type IpcInvokeEnvelope,
    type IpcRuntimeEventEnvelope,
    type IpcWindowCommandEnvelope,
} from "../shared/ipc";
import { writeRendererLog } from "./appLogger";
import {
    createAppWindow,
    emitToWindow,
    getAllWindowInfos,
    getWindowLabel,
    windowCommand,
} from "./window";
import {
    ElectronVaultBackend,
    previewMimeType,
    resolvePreviewFilePath,
} from "./vaultBackend";
import { createNativeBackendSidecar } from "./nativeBackend";
import { getSystemUsername } from "./systemUser";
import { ElectronAppUpdater } from "./updater";
import { installWebClipperRuntime } from "./webClipper";
import { installDeepLinkRuntime } from "./deepLink";

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object"
        ? (value as Record<string, unknown>)
        : {};
}

function getSenderWindow(event: Electron.IpcMainInvokeEvent) {
    return BrowserWindow.fromWebContents(event.sender);
}

function resolveTargetWindow(
    event: Electron.IpcMainInvokeEvent,
    label: string | null,
) {
    if (label) return label;
    return getWindowLabel(getSenderWindow(event));
}

function mapOpenDialogProperties(options: Record<string, unknown>) {
    const properties: Electron.OpenDialogOptions["properties"] = [];
    if (options.directory) {
        properties.push("openDirectory");
    } else {
        properties.push("openFile");
    }
    if (options.multiple) properties.push("multiSelections");
    return properties;
}

async function showOpenDialogForEvent(
    event: Electron.IpcMainInvokeEvent,
    options: Electron.OpenDialogOptions,
) {
    const parent = getSenderWindow(event);
    return parent
        ? dialog.showOpenDialog(parent, options)
        : dialog.showOpenDialog(options);
}

async function showMessageBoxForEvent(
    event: Electron.IpcMainInvokeEvent,
    options: Electron.MessageBoxOptions,
) {
    const parent = getSenderWindow(event);
    return parent
        ? dialog.showMessageBox(parent, options)
        : dialog.showMessageBox(options);
}

function registerDialogHandlers() {
    ipcMain.handle(ELECTRON_IPC.dialogOpen, async (event, rawOptions) => {
        const options = asRecord(rawOptions);
        const result = await showOpenDialogForEvent(event, {
            title: typeof options.title === "string" ? options.title : undefined,
            defaultPath:
                typeof options.defaultPath === "string"
                    ? options.defaultPath
                    : undefined,
            properties: mapOpenDialogProperties(options),
            filters: Array.isArray(options.filters)
                ? (options.filters as Electron.FileFilter[])
                : undefined,
        });

        if (result.canceled) return null;
        if (options.multiple) return result.filePaths;
        return result.filePaths[0] ?? null;
    });

    ipcMain.handle(ELECTRON_IPC.dialogConfirm, async (event, message, rawOptions) => {
        const options = asRecord(rawOptions);
        const result = await showMessageBoxForEvent(event, {
            type: options.kind === "error" ? "error" : options.kind === "warning" ? "warning" : "question",
            title: typeof options.title === "string" ? options.title : "Confirm",
            message: String(message),
            buttons: [
                typeof options.okLabel === "string" ? options.okLabel : "OK",
                typeof options.cancelLabel === "string" ? options.cancelLabel : "Cancel",
            ],
            cancelId: 1,
            defaultId: 0,
        });
        return result.response === 0;
    });
}

function registerOpenerHandlers() {
    ipcMain.handle(ELECTRON_IPC.openerOpenPath, async (_event, filePath) => {
        const error = await shell.openPath(String(filePath));
        if (error) throw new Error(error);
    });
    ipcMain.handle(ELECTRON_IPC.openerRevealItem, (_event, filePath) => {
        shell.showItemInFolder(String(filePath));
    });
    ipcMain.handle(ELECTRON_IPC.openerOpenUrl, async (_event, url) => {
        await shell.openExternal(String(url));
    });
}

function registerWindowHandlers() {
    ipcMain.handle(ELECTRON_IPC.currentWindowLabel, (event) =>
        getWindowLabel(getSenderWindow(event)),
    );
    ipcMain.handle(ELECTRON_IPC.allWindows, () => getAllWindowInfos());
    ipcMain.handle(ELECTRON_IPC.createWindow, (_event, rawInput) => {
        const input = asRecord(rawInput);
        const label =
            typeof input.label === "string" && input.label.trim()
                ? input.label
                : `window-${Date.now()}`;
        createAppWindow(label, asRecord(input.options));
    });
    ipcMain.handle(ELECTRON_IPC.windowCommand, (event, rawEnvelope) => {
        const envelope = asRecord(rawEnvelope) as Partial<IpcWindowCommandEnvelope>;
        const targetLabel = resolveTargetWindow(
            event,
            typeof envelope.label === "string" ? envelope.label : null,
        );
        return windowCommand(
            targetLabel,
            String(envelope.command ?? ""),
            asRecord(envelope.args),
        );
    });
}

function registerRuntimeEventHandlers() {
    ipcMain.handle(ELECTRON_IPC.emitTo, (_event, rawEnvelope) => {
        const envelope = asRecord(rawEnvelope) as Partial<IpcRuntimeEventEnvelope> & {
            targetLabel?: unknown;
        };
        const targetLabel = String(envelope.targetLabel ?? "");
        if (!targetLabel) return false;
        return emitToWindow(
            targetLabel,
            String(envelope.eventName ?? ""),
            envelope.payload,
        );
    });
}

function isAppLogLevel(value: unknown): value is IpcAppLogEnvelope["level"] {
    return (
        value === "debug" ||
        value === "info" ||
        value === "warn" ||
        value === "error"
    );
}

function registerAppLogHandlers() {
    ipcMain.handle(ELECTRON_IPC.appLog, (_event, rawEnvelope) => {
        const envelope = asRecord(rawEnvelope) as Partial<IpcAppLogEnvelope>;
        if (
            !isAppLogLevel(envelope.level) ||
            typeof envelope.scope !== "string" ||
            typeof envelope.message !== "string"
        ) {
            return false;
        }
        writeRendererLog({
            level: envelope.level,
            scope: envelope.scope,
            message: envelope.message,
            detail: envelope.detail,
            windowLabel:
                typeof envelope.windowLabel === "string"
                    ? envelope.windowLabel
                    : null,
        });
        return true;
    });
}

function registerInvokeHandler() {
    const emitRuntimeEvent = (eventName: string, payload: unknown) => {
        for (const window of BrowserWindow.getAllWindows()) {
            if (window.isDestroyed()) continue;
            window.webContents.send(ELECTRON_IPC.event, { eventName, payload });
        }
    };
    const nativeBackend = createNativeBackendSidecar(emitRuntimeEvent);
    const backend = new ElectronVaultBackend(
        emitRuntimeEvent,
        new ElectronAppUpdater(),
        nativeBackend,
    );
    installWebClipperRuntime(backend, emitRuntimeEvent);
    installDeepLinkRuntime(emitRuntimeEvent);

    ipcMain.handle(ELECTRON_IPC.invoke, async (_event, rawEnvelope) => {
        const envelope = asRecord(rawEnvelope) as Partial<IpcInvokeEnvelope>;
        if (typeof envelope.command !== "string" || !envelope.command) {
            throw new Error("Invalid invoke envelope.");
        }
        // System info commands are answered here at the IPC layer so they
        // work identically whether a vault uses the native sidecar or the
        // pure TS backend.
        if (envelope.command === "get_system_username") {
            return getSystemUsername();
        }
        return backend.invoke(envelope.command, asRecord(envelope.args));
    });
}

function decodeBase64UrlSegment(value: string) {
    return Buffer.from(
        value.replace(/-/g, "+").replace(/_/g, "/"),
        "base64",
    ).toString("utf8");
}

function generatedImageMimeType(filePath: string) {
    switch (path.extname(filePath).toLowerCase()) {
        case ".png":
            return "image/png";
        case ".jpg":
        case ".jpeg":
        case ".jpe":
        case ".jfif":
            return "image/jpeg";
        case ".gif":
            return "image/gif";
        case ".webp":
            return "image/webp";
        case ".avif":
            return "image/avif";
        case ".bmp":
            return "image/bmp";
        default:
            return null;
    }
}

function normalizeGeneratedImageInputPath(value: string) {
    if (value.startsWith("file://")) {
        return fileURLToPath(value);
    }

    return value;
}

function generatedImageRootCandidates() {
    const roots = [path.join(os.homedir(), ".codex", "generated_images")];
    const codexHome = process.env.CODEX_HOME?.trim();
    if (codexHome) {
        roots.unshift(path.join(codexHome, "generated_images"));
    }

    return [...new Set(roots)];
}

function sha256Hex(value: string) {
    return crypto.createHash("sha256").update(value).digest("hex");
}

function stableVaultKeyPath(vaultPath: string) {
    const absolutePath = path.resolve(vaultPath);
    try {
        return realpathSync.native(absolutePath);
    } catch {
        return absolutePath;
    }
}

function aiAttachmentRootCandidates(encodedVaultPath: string) {
    const vaultPath = stableVaultKeyPath(
        decodeBase64UrlSegment(encodedVaultPath),
    );
    return [
        path.join(
            app.getPath("userData"),
            "ai",
            "attachments",
            sha256Hex(vaultPath),
        ),
    ];
}

function isPathInside(parent: string, child: string) {
    const relative = path.relative(parent, child);
    return (
        relative === "" ||
        (!relative.startsWith("..") && !path.isAbsolute(relative))
    );
}

export async function resolveCodexGeneratedImagePreviewPath(
    encodedPath: string,
) {
    return resolveLocalImagePreviewPath(encodedPath, generatedImageRootCandidates());
}

export async function resolveAiAttachmentPreviewPath(
    encodedPath: string,
    encodedVaultPath: string,
) {
    return resolveLocalImagePreviewPath(
        encodedPath,
        aiAttachmentRootCandidates(encodedVaultPath),
    );
}

async function resolveLocalImagePreviewPath(encodedPath: string, roots: string[]) {
    const requestedPath = normalizeGeneratedImageInputPath(
        decodeBase64UrlSegment(encodedPath),
    );
    if (!path.isAbsolute(requestedPath)) {
        return null;
    }

    const mimeType = generatedImageMimeType(requestedPath);
    if (!mimeType) {
        return { status: 415 as const, filePath: null, mimeType: null };
    }

    const realFilePath = await fs.realpath(requestedPath).catch(() => null);
    if (!realFilePath) {
        return null;
    }

    for (const root of roots) {
        const realRoot = await fs.realpath(root).catch(() => null);
        if (realRoot && isPathInside(realRoot, realFilePath)) {
            return {
                status: 200 as const,
                filePath: realFilePath,
                mimeType,
            };
        }
    }

    return null;
}

export function registerPreviewProtocolHandler() {
    return async (request: Request) => {
        try {
            const url = new URL(request.url);
            const segments = url.pathname.split("/");
            const [, scope, encodedVaultPath, encodedRelativePath] = segments;
            if (scope === "vault" && encodedVaultPath && encodedRelativePath) {
                const vaultPath = decodeBase64UrlSegment(encodedVaultPath);
                const relativePath =
                    decodeBase64UrlSegment(encodedRelativePath);
                const filePath = resolvePreviewFilePath(
                    vaultPath,
                    relativePath,
                );
                const data = await fs.readFile(filePath);
                return new Response(new Uint8Array(data), {
                    headers: {
                        "content-type": previewMimeType(filePath),
                        "cache-control": "no-store",
                    },
                });
            }

            if (scope === "assets" && encodedVaultPath && segments.length > 3) {
                const vaultPath = decodeBase64UrlSegment(encodedVaultPath);
                const relativePath = segments
                    .slice(3)
                    .map((segment) => decodeURIComponent(segment))
                    .join("/");
                const filePath = resolvePreviewFilePath(
                    vaultPath,
                    relativePath,
                );
                const data = await fs.readFile(filePath);
                const mimeType = previewMimeType(filePath);
                const headers: Record<string, string> = {
                    "content-type": mimeType,
                    "cache-control": "no-store",
                };
                if (mimeType === "text/html") {
                    headers["content-security-policy"] =
                        "default-src 'self' 'unsafe-inline' 'unsafe-eval' neverwrite-file: data: blob:; " +
                        "connect-src 'self' neverwrite-file:; " +
                        "img-src 'self' neverwrite-file: data: blob:; " +
                        "media-src 'self' neverwrite-file: data: blob:; " +
                        "frame-src 'self' neverwrite-file:; " +
                        "form-action 'none'";
                }
                return new Response(new Uint8Array(data), { headers });
            }

            if (scope === "codex-image" && encodedVaultPath) {
                const resolved =
                    await resolveCodexGeneratedImagePreviewPath(
                        encodedVaultPath,
                    );
                if (!resolved) {
                    return new Response("Not found", { status: 404 });
                }
                if (resolved.status === 415 || !resolved.filePath) {
                    return new Response("Unsupported media type", {
                        status: 415,
                    });
                }

                const data = await fs.readFile(resolved.filePath);
                return new Response(new Uint8Array(data), {
                    headers: {
                        "content-type": resolved.mimeType,
                        "cache-control": "no-store",
                    },
                });
            }

            if (scope === "ai-attachment" && encodedVaultPath && encodedRelativePath) {
                const resolved = await resolveAiAttachmentPreviewPath(
                    encodedRelativePath,
                    encodedVaultPath,
                );
                if (!resolved) {
                    return new Response("Not found", { status: 404 });
                }
                if (resolved.status === 415 || !resolved.filePath) {
                    return new Response("Unsupported media type", {
                        status: 415,
                    });
                }

                const data = await fs.readFile(resolved.filePath);
                return new Response(new Uint8Array(data), {
                    headers: {
                        "content-type": resolved.mimeType,
                        "cache-control": "no-store",
                    },
                });
            }

            return new Response("Not found", { status: 404 });
        } catch {
            return new Response("Not found", { status: 404 });
        }
    };
}

export function registerIpcHandlers() {
    registerInvokeHandler();
    registerDialogHandlers();
    registerOpenerHandlers();
    registerWindowHandlers();
    registerRuntimeEventHandlers();
    registerAppLogHandlers();
}
