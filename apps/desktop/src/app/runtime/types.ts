export type RuntimeName = "tauri" | "electron";

export type UnlistenFn = () => void;

export interface RuntimeEvent<T> {
    event: string;
    payload: T;
    id?: number;
    windowLabel?: string;
}

export type RuntimeEventHandler<T> = (event: RuntimeEvent<T>) => void;

export interface RuntimeDragDropPayload {
    type: "enter" | "over" | "drop" | "leave";
    paths: string[];
    position?: {
        x: number;
        y: number;
    };
}

export interface RuntimeDragDropEvent {
    payload: RuntimeDragDropPayload;
}

export interface RuntimeLogicalPosition {
    x: number;
    y: number;
}

export interface RuntimeLogicalPositionConstructor {
    new (x: number, y: number): RuntimeLogicalPosition;
}

export interface RuntimeWindow {
    label: string;
    listen<T>(
        eventName: string,
        handler: RuntimeEventHandler<T>,
    ): Promise<UnlistenFn>;
    emitTo<T>(
        targetLabel: string,
        eventName: string,
        payload: T,
    ): Promise<void>;
    close(): Promise<void>;
    minimize(): Promise<void>;
    toggleMaximize(): Promise<void>;
    isMaximized(): Promise<boolean>;
    isMinimized(): Promise<boolean>;
    isVisible(): Promise<boolean>;
    show(): Promise<void>;
    setFocus(): Promise<void>;
    setPosition(position: RuntimeLogicalPosition): Promise<void>;
    startDragging(): Promise<void>;
    onMoved(handler: () => void): Promise<UnlistenFn>;
    onResized(handler: () => void): Promise<UnlistenFn>;
    onScaleChanged(handler: () => void): Promise<UnlistenFn>;
    innerPosition?: () => Promise<{
        x: number;
        y: number;
        toLogical?: (scaleFactor: number) => { x: number; y: number };
    }>;
    scaleFactor?: () => Promise<number>;
}

export interface RuntimeWebview {
    setZoom(factor: number): Promise<void>;
    onDragDropEvent(
        handler: (event: RuntimeDragDropEvent) => void,
    ): Promise<UnlistenFn>;
}

export interface RuntimeWebviewWindow extends RuntimeWindow {
    once<T>(eventName: string, handler: RuntimeEventHandler<T>): Promise<UnlistenFn>;
    setIgnoreCursorEvents(ignore: boolean): Promise<void>;
    destroy(): Promise<void>;
}

export interface RuntimeWebviewWindowConstructor {
    new (label: string, options?: Record<string, unknown>): RuntimeWebviewWindow;
}

export interface OpenDialogOptions {
    title?: string;
    directory?: boolean;
    multiple?: boolean;
    defaultPath?: string;
    filters?: { name: string; extensions: string[] }[];
}

export interface ConfirmDialogOptions {
    title?: string;
    kind?: "info" | "warning" | "error";
    okLabel?: string;
    cancelLabel?: string;
}

export interface Update {
    body?: string | null;
    currentVersion: string;
    version: string;
    date?: string | null;
    rawJson?: unknown;
}

export interface NeverWriteRuntime {
    name: RuntimeName;
    invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
    listen<T>(
        eventName: string,
        handler: RuntimeEventHandler<T>,
    ): Promise<UnlistenFn>;
    emitTo<T>(
        targetLabel: string,
        eventName: string,
        payload: T,
    ): Promise<void>;
    open(options?: OpenDialogOptions): Promise<string | string[] | null>;
    confirm(message: string, options?: ConfirmDialogOptions): Promise<boolean>;
    openPath(path: string): Promise<void>;
    revealItemInDir(path: string): Promise<void>;
    openUrl(url: string): Promise<void>;
    getCurrentWindow(): RuntimeWindow;
    getCurrentWebview(): RuntimeWebview;
    getCurrentWebviewWindow(): RuntimeWindow;
    getAllWebviewWindows(): Promise<RuntimeWindow[]>;
    WebviewWindow: RuntimeWebviewWindowConstructor;
    LogicalPosition: RuntimeLogicalPositionConstructor;
}

export interface RuntimeWindowInfo {
    label: string;
}

export interface ElectronWindowCreateOptions {
    label: string;
    options?: Record<string, unknown>;
}

export interface ElectronPreloadApi {
    invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
    listen<T>(
        eventName: string,
        handler: RuntimeEventHandler<T>,
    ): Promise<UnlistenFn>;
    emitTo<T>(
        targetLabel: string,
        eventName: string,
        payload: T,
    ): Promise<void>;
    openDialog(options?: OpenDialogOptions): Promise<string | string[] | null>;
    confirmDialog(
        message: string,
        options?: ConfirmDialogOptions,
    ): Promise<boolean>;
    openPath(path: string): Promise<void>;
    revealItemInDir(path: string): Promise<void>;
    openUrl(url: string): Promise<void>;
    setZoom(factor: number): Promise<void>;
    onDragDropEvent(
        handler: (event: RuntimeDragDropEvent) => void,
    ): Promise<UnlistenFn>;
    getCurrentWindowLabel(): Promise<string>;
    getAllWindows(): Promise<RuntimeWindowInfo[]>;
    createWindow(input: ElectronWindowCreateOptions): Promise<void>;
    windowCommand(
        label: string | null,
        command: string,
        args?: Record<string, unknown>,
    ): Promise<unknown>;
    onWindowEvent(eventName: string, handler: () => void): Promise<UnlistenFn>;
}
