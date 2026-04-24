import type {
    ElectronPreloadApi,
    NeverWriteRuntime,
    RuntimeEventHandler,
    RuntimeLogicalPosition,
    RuntimeWebviewWindow,
    UnlistenFn,
} from "./types";
import {
    DESKTOP_WINDOW_CREATED_EVENT,
    DESKTOP_WINDOW_ERROR_EVENT,
} from "./windowLifecycle";

class ElectronLogicalPosition implements RuntimeLogicalPosition {
    x: number;
    y: number;

    constructor(x: number, y: number) {
        this.x = x;
        this.y = y;
    }
}

function getElectronApi(): ElectronPreloadApi {
    const api = window.neverwriteElectron;
    if (!api) {
        throw new Error("NeverWrite Electron preload API is not available.");
    }
    return api;
}

class ElectronWindowHandle {
    label: string;

    constructor(label: string) {
        this.label = label;
    }

    listen<T>(
        eventName: string,
        handler: RuntimeEventHandler<T>,
    ): Promise<UnlistenFn> {
        return getElectronApi().listen(eventName, handler);
    }

    emitTo<T>(
        targetLabel: string,
        eventName: string,
        payload: T,
    ): Promise<void> {
        return getElectronApi().emitTo(targetLabel, eventName, payload);
    }

    close(): Promise<void> {
        return this.windowCommand("close").then(() => undefined);
    }

    minimize(): Promise<void> {
        return this.windowCommand("minimize").then(() => undefined);
    }

    toggleMaximize(): Promise<void> {
        return this.windowCommand("toggleMaximize").then(() => undefined);
    }

    isMaximized(): Promise<boolean> {
        return this.windowCommand("isMaximized").then(Boolean);
    }

    isMinimized(): Promise<boolean> {
        return this.windowCommand("isMinimized").then(Boolean);
    }

    isVisible(): Promise<boolean> {
        return this.windowCommand("isVisible").then(Boolean);
    }

    show(): Promise<void> {
        return this.windowCommand("show").then(() => undefined);
    }

    setFocus(): Promise<void> {
        return this.windowCommand("focus").then(() => undefined);
    }

    setPosition(position: RuntimeLogicalPosition): Promise<void> {
        return this.windowCommand("setPosition", {
            x: position.x,
            y: position.y,
        }).then(() => undefined);
    }

    startDragging(): Promise<void> {
        // Electron uses CSS app-region dragging. Keep the method so renderer
        // code can stay runtime-neutral while the drag region CSS does the work.
        return Promise.resolve();
    }

    onMoved(handler: () => void): Promise<UnlistenFn> {
        return getElectronApi().onWindowEvent("moved", handler);
    }

    onResized(handler: () => void): Promise<UnlistenFn> {
        return getElectronApi().onWindowEvent("resized", handler);
    }

    onScaleChanged(handler: () => void): Promise<UnlistenFn> {
        return getElectronApi().onWindowEvent("scaleChanged", handler);
    }

    innerPosition(): Promise<{ x: number; y: number }> {
        return Promise.resolve({ x: window.screenX, y: window.screenY });
    }

    scaleFactor(): Promise<number> {
        return Promise.resolve(window.devicePixelRatio || 1);
    }

    setTrafficLightsVisible(visible: boolean): Promise<void> {
        return this.windowCommand("setTrafficLightsVisible", { visible }).then(
            () => undefined,
        );
    }

    setTitleBarOverlay(options: {
        color?: string;
        symbolColor?: string;
        height?: number;
    }): Promise<void> {
        return this.windowCommand("setTitleBarOverlay", options).then(
            () => undefined,
        );
    }

    protected windowCommand(
        command: string,
        args?: Record<string, unknown>,
    ): Promise<unknown> {
        return getElectronApi().windowCommand(this.label, command, args);
    }
}

class ElectronWebviewWindowHandle
    extends ElectronWindowHandle
    implements RuntimeWebviewWindow
{
    private listeners = new Map<string, Set<RuntimeEventHandler<unknown>>>();

    constructor(label: string, options?: Record<string, unknown>) {
        super(label);
        void getElectronApi()
            .createWindow({ label, options })
            .then(() => {
                this.emitLocal(DESKTOP_WINDOW_CREATED_EVENT, null);
            })
            .catch((error: unknown) => {
                this.emitLocal(DESKTOP_WINDOW_ERROR_EVENT, String(error));
            });
    }

    once<T>(
        eventName: string,
        handler: RuntimeEventHandler<T>,
    ): Promise<UnlistenFn> {
        const wrapped: RuntimeEventHandler<unknown> = (event) => {
            void unlisten();
            handler(event as Parameters<RuntimeEventHandler<T>>[0]);
        };
        const listeners = this.listeners.get(eventName) ?? new Set();
        listeners.add(wrapped);
        this.listeners.set(eventName, listeners);

        const unlisten = () => {
            listeners.delete(wrapped);
            if (listeners.size === 0) {
                this.listeners.delete(eventName);
            }
        };

        return Promise.resolve(unlisten);
    }

    setIgnoreCursorEvents(ignore: boolean): Promise<void> {
        return this.windowCommand("setIgnoreCursorEvents", { ignore }).then(
            () => undefined,
        );
    }

    destroy(): Promise<void> {
        return this.close();
    }

    private emitLocal(eventName: string, payload: unknown) {
        const listeners = this.listeners.get(eventName);
        if (!listeners) return;
        for (const listener of [...listeners]) {
            listener({
                event: eventName,
                payload,
                windowLabel: this.label,
            });
        }
    }
}

function getCurrentElectronWindow(): ElectronWindowHandle {
    const label =
        typeof window !== "undefined" && window.neverwriteWindowLabel
            ? window.neverwriteWindowLabel
            : "main";
    return new ElectronWindowHandle(label);
}

export const electronRuntime: NeverWriteRuntime = {
    name: "electron",
    invoke(command, args) {
        return getElectronApi().invoke(command, args);
    },
    listen(eventName, handler) {
        return getElectronApi().listen(eventName, handler);
    },
    emitTo(targetLabel, eventName, payload) {
        return getElectronApi().emitTo(targetLabel, eventName, payload);
    },
    open(options) {
        return getElectronApi().openDialog(options);
    },
    confirm(message, options) {
        return getElectronApi().confirmDialog(message, options);
    },
    openPath(path) {
        return getElectronApi().openPath(path);
    },
    revealItemInDir(path) {
        return getElectronApi().revealItemInDir(path);
    },
    openUrl(url) {
        return getElectronApi().openUrl(url);
    },
    getCurrentWindow() {
        return getCurrentElectronWindow();
    },
    getCurrentWebview() {
        return {
            setZoom(factor) {
                return getElectronApi().setZoom(factor);
            },
            onDragDropEvent(handler) {
                return getElectronApi().onDragDropEvent(handler);
            },
        };
    },
    getCurrentWebviewWindow() {
        return getCurrentElectronWindow();
    },
    async getAllWebviewWindows() {
        const windows = await getElectronApi().getAllWindows();
        return windows.map((windowInfo) => new ElectronWindowHandle(windowInfo.label));
    },
    WebviewWindow: ElectronWebviewWindowHandle,
    LogicalPosition: ElectronLogicalPosition,
};
