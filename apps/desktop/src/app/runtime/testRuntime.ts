import type {
    NeverWriteRuntime,
    RuntimeEventHandler,
    RuntimeLogicalPosition,
    RuntimeWebviewWindow,
    UnlistenFn,
} from "./types";

class TestLogicalPosition implements RuntimeLogicalPosition {
    x: number;
    y: number;

    constructor(x: number, y: number) {
        this.x = x;
        this.y = y;
    }
}

class TestWindow implements RuntimeWebviewWindow {
    label: string;

    constructor(label = "main") {
        this.label = label;
    }

    listen<T>(
        _eventName: string,
        _handler: RuntimeEventHandler<T>,
    ): Promise<UnlistenFn> {
        return Promise.resolve(() => {});
    }

    once<T>(
        _eventName: string,
        _handler: RuntimeEventHandler<T>,
    ): Promise<UnlistenFn> {
        return Promise.resolve(() => {});
    }

    emitTo<T>(
        _targetLabel: string,
        _eventName: string,
        _payload: T,
    ): Promise<void> {
        return Promise.resolve();
    }

    close(): Promise<void> {
        return Promise.resolve();
    }

    minimize(): Promise<void> {
        return Promise.resolve();
    }

    toggleMaximize(): Promise<void> {
        return Promise.resolve();
    }

    isMaximized(): Promise<boolean> {
        return Promise.resolve(false);
    }

    isMinimized(): Promise<boolean> {
        return Promise.resolve(false);
    }

    isVisible(): Promise<boolean> {
        return Promise.resolve(true);
    }

    show(): Promise<void> {
        return Promise.resolve();
    }

    setFocus(): Promise<void> {
        return Promise.resolve();
    }

    setPosition(_position: RuntimeLogicalPosition): Promise<void> {
        return Promise.resolve();
    }

    startDragging(): Promise<void> {
        return Promise.resolve();
    }

    onMoved(_handler: () => void): Promise<UnlistenFn> {
        return Promise.resolve(() => {});
    }

    onResized(_handler: () => void): Promise<UnlistenFn> {
        return Promise.resolve(() => {});
    }

    onScaleChanged(_handler: () => void): Promise<UnlistenFn> {
        return Promise.resolve(() => {});
    }

    setIgnoreCursorEvents(_ignore: boolean): Promise<void> {
        return Promise.resolve();
    }

    destroy(): Promise<void> {
        return Promise.resolve();
    }
}

export function createTestRuntime(
    invokeHandler: NeverWriteRuntime["invoke"] = async () => undefined as never,
): NeverWriteRuntime {
    const currentWindow = new TestWindow("main");
    return {
        name: "tauri",
        invoke: invokeHandler,
        listen: async () => () => {},
        emitTo: async () => {},
        open: async () => null,
        confirm: async () => false,
        openPath: async () => {},
        revealItemInDir: async () => {},
        openUrl: async () => {},
        getCurrentWindow: () => currentWindow,
        getCurrentWebview: () => ({
            setZoom: async () => {},
            onDragDropEvent: async () => () => {},
        }),
        getCurrentWebviewWindow: () => currentWindow,
        getAllWebviewWindows: async () => [currentWindow],
        WebviewWindow: TestWindow,
        LogicalPosition: TestLogicalPosition,
    };
}
