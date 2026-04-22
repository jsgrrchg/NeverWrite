/// <reference lib="dom" />

import { contextBridge, ipcRenderer, webFrame, webUtils } from "electron";
import {
    ELECTRON_IPC,
    type IpcInvokeEnvelope,
    type IpcRuntimeEventEnvelope,
    type IpcWindowCommandEnvelope,
} from "../shared/ipc";
import type {
    ConfirmDialogOptions,
    ElectronPreloadApi,
    OpenDialogOptions,
    RuntimeDragDropEvent,
    RuntimeEventHandler,
    UnlistenFn,
} from "../../src/app/runtime/types";

declare global {
    interface Window {
        neverwriteWindowLabel?: string;
    }
}

const runtimeListeners = new Map<string, Set<RuntimeEventHandler<unknown>>>();
const windowEventListeners = new Map<string, Set<() => void>>();
const dragDropListeners = new Set<(event: RuntimeDragDropEvent) => void>();

function notifyRuntimeListeners(envelope: IpcRuntimeEventEnvelope) {
    const listeners = runtimeListeners.get(envelope.eventName);
    if (!listeners) return;
    for (const listener of [...listeners]) {
        listener({
            event: envelope.eventName,
            payload: envelope.payload,
            windowLabel: window.neverwriteWindowLabel,
        });
    }
}

function notifyWindowEventListeners(eventName: string) {
    const listeners = windowEventListeners.get(eventName);
    if (!listeners) return;
    for (const listener of [...listeners]) listener();
}

function readDroppedPaths(event: DragEvent) {
    const files = [...(event.dataTransfer?.files ?? [])];
    return files
        .map((file) => {
            try {
                return webUtils.getPathForFile(file);
            } catch {
                return "";
            }
        })
        .filter((value) => value.length > 0);
}

function emitDragDrop(type: RuntimeDragDropEvent["payload"]["type"], event: DragEvent) {
    if (dragDropListeners.size === 0) return;
    const payload = {
        type,
        paths: type === "drop" ? readDroppedPaths(event) : [],
        position: {
            x: event.clientX,
            y: event.clientY,
        },
    };
    for (const listener of [...dragDropListeners]) {
        listener({ payload });
    }
}

function installDragDropBridge() {
    window.addEventListener("dragenter", (event) => {
        event.preventDefault();
        emitDragDrop("enter", event);
    });
    window.addEventListener("dragover", (event) => {
        event.preventDefault();
        emitDragDrop("over", event);
    });
    window.addEventListener("dragleave", (event) => {
        emitDragDrop("leave", event);
    });
    window.addEventListener("drop", (event) => {
        event.preventDefault();
        emitDragDrop("drop", event);
    });
}

function listenToRuntimeEvent<T>(
    eventName: string,
    handler: RuntimeEventHandler<T>,
): Promise<UnlistenFn> {
    const listeners = runtimeListeners.get(eventName) ?? new Set();
    const wrapped = handler as RuntimeEventHandler<unknown>;
    listeners.add(wrapped);
    runtimeListeners.set(eventName, listeners);

    return Promise.resolve(() => {
        listeners.delete(wrapped);
        if (listeners.size === 0) {
            runtimeListeners.delete(eventName);
        }
    });
}

function listenToWindowEvent(
    eventName: string,
    handler: () => void,
): Promise<UnlistenFn> {
    const listeners = windowEventListeners.get(eventName) ?? new Set();
    listeners.add(handler);
    windowEventListeners.set(eventName, listeners);

    return Promise.resolve(() => {
        listeners.delete(handler);
        if (listeners.size === 0) {
            windowEventListeners.delete(eventName);
        }
    });
}

ipcRenderer.on(ELECTRON_IPC.event, (_event, rawEnvelope) => {
    const envelope = rawEnvelope as Partial<IpcRuntimeEventEnvelope>;
    if (typeof envelope.eventName !== "string") return;
    notifyRuntimeListeners({
        eventName: envelope.eventName,
        payload: envelope.payload,
    });
});

ipcRenderer.on(ELECTRON_IPC.windowEvent, (_event, rawEnvelope) => {
    const envelope = rawEnvelope as { eventName?: unknown };
    if (typeof envelope.eventName !== "string") return;
    notifyWindowEventListeners(envelope.eventName);
});

window.addEventListener("resize", () => {
    notifyWindowEventListeners("resized");
    notifyWindowEventListeners("scaleChanged");
});

window.addEventListener("DOMContentLoaded", () => {
    document.documentElement.setAttribute("data-neverwrite-electron", "ready");
});

installDragDropBridge();

const api: ElectronPreloadApi = {
    invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
        const envelope: IpcInvokeEnvelope = { command, args };
        return ipcRenderer.invoke(ELECTRON_IPC.invoke, envelope) as Promise<T>;
    },
    listen: listenToRuntimeEvent,
    emitTo(targetLabel, eventName, payload) {
        return ipcRenderer.invoke(ELECTRON_IPC.emitTo, {
            targetLabel,
            eventName,
            payload,
        });
    },
    openDialog(options?: OpenDialogOptions) {
        return ipcRenderer.invoke(ELECTRON_IPC.dialogOpen, options);
    },
    confirmDialog(message: string, options?: ConfirmDialogOptions) {
        return ipcRenderer.invoke(ELECTRON_IPC.dialogConfirm, message, options);
    },
    openPath(filePath: string) {
        return ipcRenderer.invoke(ELECTRON_IPC.openerOpenPath, filePath);
    },
    revealItemInDir(filePath: string) {
        return ipcRenderer.invoke(ELECTRON_IPC.openerRevealItem, filePath);
    },
    async openUrl(url: string) {
        await ipcRenderer.invoke(ELECTRON_IPC.openerOpenUrl, url);
    },
    setZoom(factor: number) {
        webFrame.setZoomFactor(factor);
        return Promise.resolve();
    },
    onDragDropEvent(handler) {
        dragDropListeners.add(handler);
        return Promise.resolve(() => {
            dragDropListeners.delete(handler);
        });
    },
    async getCurrentWindowLabel() {
        const label = await ipcRenderer.invoke(ELECTRON_IPC.currentWindowLabel);
        window.neverwriteWindowLabel =
            typeof label === "string" && label ? label : "main";
        return window.neverwriteWindowLabel;
    },
    getAllWindows() {
        return ipcRenderer.invoke(ELECTRON_IPC.allWindows);
    },
    createWindow(input) {
        return ipcRenderer.invoke(ELECTRON_IPC.createWindow, input);
    },
    windowCommand(label, command, args) {
        const envelope: IpcWindowCommandEnvelope = { label, command, args };
        return ipcRenderer.invoke(ELECTRON_IPC.windowCommand, envelope);
    },
    onWindowEvent: listenToWindowEvent,
};

void api.getCurrentWindowLabel();

contextBridge.exposeInMainWorld("neverwriteElectron", api);
