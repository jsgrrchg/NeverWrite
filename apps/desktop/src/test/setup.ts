import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
    invoke: vi.fn(),
    convertFileSrc: vi.fn((path: string) => `asset://${path}`),
}));

vi.mock("@tauri-apps/api/event", () => ({
    listen: vi.fn().mockResolvedValue(vi.fn()),
}));

vi.mock("@tauri-apps/api/window", () => ({
    getCurrentWindow: () => ({
        listen: vi.fn(),
        once: vi.fn(),
        onCloseRequested: vi.fn(),
        onMoved: vi.fn().mockResolvedValue(vi.fn()),
        onResized: vi.fn().mockResolvedValue(vi.fn()),
        onScaleChanged: vi.fn().mockResolvedValue(vi.fn()),
        setFocus: vi.fn(),
        startDragging: vi.fn(),
        emitTo: vi.fn(),
        close: vi.fn(),
        label: "main",
    }),
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
    WebviewWindow: class MockWebviewWindow {
        label: string;

        constructor(label: string) {
            this.label = label;
        }

        once = vi.fn();
        show = vi.fn();
        setFocus = vi.fn();
        destroy = vi.fn();
        setIgnoreCursorEvents = vi.fn();
        setPosition = vi.fn();
        outerPosition = vi.fn().mockResolvedValue({ x: 0, y: 0 });
        outerSize = vi.fn().mockResolvedValue({ width: 1200, height: 800 });
        isMinimized = vi.fn().mockResolvedValue(false);
        isVisible = vi.fn().mockResolvedValue(true);
    },
    getAllWebviewWindows: vi.fn().mockResolvedValue([]),
    getCurrentWebviewWindow: vi.fn(() => ({ label: "main" })),
}));

vi.mock("@tauri-apps/api/dpi", () => ({
    LogicalPosition: class LogicalPosition {
        x: number;
        y: number;

        constructor(x: number, y: number) {
            this.x = x;
            this.y = y;
        }
    },
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
    open: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
    openUrl: vi.fn(),
    openPath: vi.fn(),
    revealItemInDir: vi.fn(),
}));

function createStorageMock(): Storage {
    const store = new Map<string, string>();

    return {
        get length() {
            return store.size;
        },
        clear() {
            store.clear();
        },
        getItem(key: string) {
            return store.get(key) ?? null;
        },
        key(index: number) {
            return Array.from(store.keys())[index] ?? null;
        },
        removeItem(key: string) {
            store.delete(key);
        },
        setItem(key: string, value: string) {
            store.set(key, value);
        },
    };
}

const localStorageMock = createStorageMock();
const sessionStorageMock = createStorageMock();

Object.defineProperty(globalThis, "localStorage", {
    value: localStorageMock,
    configurable: true,
});

Object.defineProperty(globalThis, "sessionStorage", {
    value: sessionStorageMock,
    configurable: true,
});

Object.defineProperty(window, "localStorage", {
    value: localStorageMock,
    configurable: true,
});

Object.defineProperty(window, "sessionStorage", {
    value: sessionStorageMock,
    configurable: true,
});

Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
    })),
});

Object.defineProperty(window, "BroadcastChannel", {
    writable: true,
    value: class MockBroadcastChannel {
        name: string;

        constructor(name: string) {
            this.name = name;
        }

        addEventListener() {}

        removeEventListener() {}

        postMessage() {}

        close() {}
    },
});

Object.defineProperty(globalThis, "requestAnimationFrame", {
    writable: true,
    value: (cb: FrameRequestCallback) =>
        window.setTimeout(() => cb(performance.now()), 0),
});

Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    value: vi.fn(),
    configurable: true,
});

const emptyDomRect = {
    x: 0,
    y: 0,
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    width: 0,
    height: 0,
    toJSON: () => ({}),
};

Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    value: vi.fn(() => emptyDomRect),
    configurable: true,
});

Object.defineProperty(Range.prototype, "getClientRects", {
    value: vi.fn(() => []),
    configurable: true,
});

let useEditorStore: typeof import("../app/store/editorStore").useEditorStore;
let useThemeStore: typeof import("../app/store/themeStore").useThemeStore;
let useVaultStore: typeof import("../app/store/vaultStore").useVaultStore;
let useCommandStore: typeof import("../features/command-palette/store/commandStore").useCommandStore;

Object.defineProperty(globalThis, "__clipboardMock", {
    value: {
        writeText: vi.fn().mockResolvedValue(undefined),
        readText: vi.fn().mockResolvedValue(""),
    },
    writable: true,
    configurable: true,
});

beforeEach(async () => {
    localStorage.clear();
    sessionStorage.clear();
    vi.clearAllMocks();
    vi.useRealTimers();

    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
    }));

    const clipboardMock = {
        writeText: vi.fn().mockResolvedValue(undefined),
        readText: vi.fn().mockResolvedValue(""),
    };
    (
        globalThis as typeof globalThis & {
            __clipboardMock: typeof clipboardMock;
        }
    ).__clipboardMock = clipboardMock;

    Object.defineProperty(navigator, "clipboard", {
        value: clipboardMock,
        configurable: true,
    });

    ({ useEditorStore } = await import("../app/store/editorStore"));
    ({ useThemeStore } = await import("../app/store/themeStore"));
    ({ useVaultStore } = await import("../app/store/vaultStore"));
    ({ useCommandStore } =
        await import("../features/command-palette/store/commandStore"));

    useEditorStore.setState({
        tabs: [],
        activeTabId: null,
        activationHistory: [],
        pendingReveal: null,
        pendingSelectionReveal: null,
    });

    useThemeStore.setState({
        mode: "system",
        themeName: "default",
        isDark: false,
    });

    useVaultStore.setState({
        vaultPath: null,
        notes: [],
        vaultRevision: 0,
        contentRevision: 0,
        structureRevision: 0,
        resolverRevision: 0,
        tagsRevision: 0,
        isLoading: false,
        vaultOpenState: {
            path: null,
            stage: "idle",
            message: "",
            processed: 0,
            total: 0,
            note_count: 0,
            snapshot_used: false,
            cancelled: false,
            started_at_ms: null,
            finished_at_ms: null,
            metrics: {
                scan_ms: 0,
                snapshot_load_ms: 0,
                parse_ms: 0,
                index_ms: 0,
                snapshot_save_ms: 0,
            },
            error: null,
        },
        error: null,
    });

    useCommandStore.setState({
        commands: new Map(),
        activeModal: null,
    });
});

afterEach(() => {
    cleanup();
});
