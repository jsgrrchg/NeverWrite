import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";

type XtermMockInstance = {
    write: (text: string) => void;
    reset: () => void;
    clear: () => void;
    focus: () => void;
    selectAll: () => void;
    getSelection: () => string;
    emitData: (data: string) => void;
};

const xtermMockInstances: XtermMockInstance[] = [];

Object.defineProperty(globalThis, "__xtermMockInstances", {
    value: xtermMockInstances,
    writable: true,
    configurable: true,
});

vi.mock("@tauri-apps/api/core", () => ({
    invoke: vi.fn(),
    convertFileSrc: vi.fn((path: string) => `asset://${path}`),
}));

vi.mock("@tauri-apps/api/event", () => ({
    listen: vi.fn().mockResolvedValue(vi.fn()),
    emitTo: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@xterm/xterm", () => ({
    Terminal: class MockTerminal {
        cols = 80;
        rows = 24;
        element: HTMLDivElement | null = null;
        screen: HTMLDivElement | null = null;
        textarea: HTMLTextAreaElement | undefined;
        options: Record<string, unknown>;
        private selection = "";
        private readonly dataListeners = new Set<(data: string) => void>();
        private readonly selectionListeners = new Set<() => void>();

        constructor(options: Record<string, unknown> = {}) {
            this.options = { ...options };
            xtermMockInstances.push(this);
        }

        loadAddon(addon: { activate?: (terminal: unknown) => void }) {
            addon.activate?.(this);
        }

        open(container: HTMLElement) {
            const node = document.createElement("div");
            node.className = "xterm";
            const screen = document.createElement("div");
            screen.className = "xterm-screen";
            const textarea = document.createElement("textarea");
            textarea.setAttribute("aria-label", "Terminal input");
            node.appendChild(screen);
            node.appendChild(textarea);
            container.appendChild(node);
            this.element = node;
            this.screen = screen;
            this.textarea = textarea;
        }

        write(text: string) {
            if (!this.screen) return;
            this.screen.textContent = (this.screen.textContent ?? "") + text;
        }

        reset() {
            if (this.screen) {
                this.screen.textContent = "";
            }
            this.selection = "";
        }

        clear() {
            this.reset();
        }

        focus() {
            this.textarea?.dispatchEvent(new FocusEvent("focus"));
        }

        selectAll() {
            this.selection = this.screen?.textContent ?? "";
            this.selectionListeners.forEach((listener) => listener());
        }

        getSelection() {
            return this.selection;
        }

        onData(listener: (data: string) => void) {
            this.dataListeners.add(listener);
            return {
                dispose: () => {
                    this.dataListeners.delete(listener);
                },
            };
        }

        onSelectionChange(listener: () => void) {
            this.selectionListeners.add(listener);
            return {
                dispose: () => {
                    this.selectionListeners.delete(listener);
                },
            };
        }

        attachCustomKeyEventHandler(_: (event: KeyboardEvent) => boolean) {
            // No-op in tests; keyboard interception is exercised through UI state.
        }

        emitData(data: string) {
            this.dataListeners.forEach((listener) => listener(data));
        }

        dispose() {
            this.element?.remove();
            this.element = null;
            this.screen = null;
            this.textarea = undefined;
            this.dataListeners.clear();
            this.selectionListeners.clear();
            this.selection = "";
            const index = xtermMockInstances.indexOf(this);
            if (index >= 0) {
                xtermMockInstances.splice(index, 1);
            }
        }
    },
}));

vi.mock("@xterm/addon-fit", () => ({
    FitAddon: class MockFitAddon {
        private terminal: {
            cols: number;
            rows: number;
        } | null = null;

        activate(terminal: { cols: number; rows: number }) {
            this.terminal = terminal;
        }

        fit() {
            if (!this.terminal) return;
            this.terminal.cols = 80;
            this.terminal.rows = 24;
        }

        proposeDimensions() {
            return { cols: 80, rows: 24 };
        }

        dispose() {}
    },
}));

vi.mock("@xterm/addon-search", () => ({
    SearchAddon: class MockSearchAddon {
        private readonly listeners = new Set<
            (event: { resultIndex: number; resultCount: number }) => void
        >();

        activate() {}

        findNext(term: string) {
            const resultCount = term ? 1 : 0;
            this.listeners.forEach((listener) =>
                listener({
                    resultIndex: resultCount > 0 ? 0 : -1,
                    resultCount,
                }),
            );
            return resultCount > 0;
        }

        findPrevious(term: string) {
            return this.findNext(term);
        }

        clearDecorations() {
            this.listeners.forEach((listener) =>
                listener({ resultIndex: -1, resultCount: 0 }),
            );
        }

        clearActiveDecoration() {}

        onDidChangeResults(
            listener: (event: {
                resultIndex: number;
                resultCount: number;
            }) => void,
        ) {
            this.listeners.add(listener);
            return {
                dispose: () => {
                    this.listeners.delete(listener);
                },
            };
        }

        dispose() {
            this.listeners.clear();
        }
    },
}));

vi.mock("@xterm/addon-web-links", () => ({
    WebLinksAddon: class MockWebLinksAddon {
        activate() {}
        dispose() {}
    },
}));

vi.mock("react-datasheet-grid", async () => {
    const React = await import("react");

    return {
        createTextColumn: (column: unknown) => column,
        keyColumn: (key: string, column: Record<string, unknown>) => ({
            ...column,
            dataKey: key,
        }),
        DataSheetGrid: ({
            value = [],
            onChange,
            columns = [],
            stickyRightColumn,
            className,
        }: {
            value?: Array<Record<string, string>>;
            onChange?: (rows: Array<Record<string, string>>) => void;
            columns?: Array<Record<string, unknown>>;
            stickyRightColumn?: Record<string, unknown>;
            className?: string;
        }) =>
            React.createElement(
                "div",
                { className },
                React.createElement(
                    "div",
                    { className: "dsg-container" },
                    React.createElement(
                        "div",
                        { className: "dsg-row dsg-row-header" },
                        columns.map((column, index) =>
                            React.createElement(
                                "div",
                                {
                                    key: `header-${String(column.dataKey ?? index)}`,
                                    className: "dsg-cell-header-container",
                                },
                                column.title as React.ReactNode,
                            ),
                        ),
                        stickyRightColumn
                            ? React.createElement(
                                  "div",
                                  {
                                      key: "sticky-header",
                                      className: "dsg-cell-header-container",
                                  },
                                  stickyRightColumn.title as React.ReactNode,
                              )
                            : null,
                    ),
                    value.map((row, rowIndex) =>
                        React.createElement(
                            "div",
                            {
                                key:
                                    row.__csv_row_id ??
                                    `row-${rowIndex.toString()}`,
                                className: "dsg-row",
                            },
                            columns.map((column, columnIndex) => {
                                const dataKey = String(
                                    column.dataKey ?? columnIndex,
                                );
                                return React.createElement("input", {
                                    key: `cell-${rowIndex.toString()}-${dataKey}`,
                                    className: "dsg-input",
                                    value: row[dataKey] ?? "",
                                    onChange: (
                                        event: React.ChangeEvent<HTMLInputElement>,
                                    ) => {
                                        onChange?.(
                                            value.map((candidate, index) =>
                                                index === rowIndex
                                                    ? {
                                                          ...candidate,
                                                          [dataKey]:
                                                              event.target
                                                                  .value,
                                                      }
                                                    : candidate,
                                            ),
                                        );
                                    },
                                });
                            }),
                            stickyRightColumn?.component
                                ? React.createElement(
                                      stickyRightColumn.component as React.ComponentType<{
                                          rowData: Record<string, string>;
                                          rowIndex: number;
                                          deleteRow: () => void;
                                      }>,
                                      {
                                          key: `sticky-cell-${rowIndex.toString()}`,
                                          rowData: row,
                                          rowIndex,
                                          deleteRow: () => {
                                              onChange?.(
                                                  value.filter(
                                                      (_, index) =>
                                                          index !== rowIndex,
                                                  ),
                                              );
                                          },
                                      },
                                  )
                                : null,
                        ),
                    ),
                ),
            ),
    };
});

vi.mock("react-resize-detector", () => ({
    useResizeDetector: () => ({
        width: 960,
        height: 420,
    }),
}));

const mockCurrentWindow = {
    listen: vi.fn(),
    once: vi.fn(),
    onCloseRequested: vi.fn(),
    onMoved: vi.fn().mockResolvedValue(vi.fn()),
    onResized: vi.fn().mockResolvedValue(vi.fn()),
    onScaleChanged: vi.fn().mockResolvedValue(vi.fn()),
    setFocus: vi.fn(),
    startDragging: vi.fn(),
    minimize: vi.fn().mockResolvedValue(undefined),
    maximize: vi.fn().mockResolvedValue(undefined),
    unmaximize: vi.fn().mockResolvedValue(undefined),
    toggleMaximize: vi.fn().mockResolvedValue(undefined),
    isMaximized: vi.fn().mockResolvedValue(false),
    emitTo: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    label: "main",
};

const mockCurrentWebviewWindow = {
    listen: vi.fn(),
    once: vi.fn(),
    onCloseRequested: vi.fn(),
    onMoved: vi.fn().mockResolvedValue(vi.fn()),
    onResized: vi.fn().mockResolvedValue(vi.fn()),
    onScaleChanged: vi.fn().mockResolvedValue(vi.fn()),
    setFocus: vi.fn(),
    startDragging: vi.fn(),
    minimize: vi.fn().mockResolvedValue(undefined),
    maximize: vi.fn().mockResolvedValue(undefined),
    unmaximize: vi.fn().mockResolvedValue(undefined),
    toggleMaximize: vi.fn().mockResolvedValue(undefined),
    isMaximized: vi.fn().mockResolvedValue(false),
    emitTo: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    label: "main",
};

Object.defineProperty(globalThis, "__mockCurrentWindow", {
    value: mockCurrentWindow,
    writable: true,
    configurable: true,
});

Object.defineProperty(globalThis, "__mockCurrentWebviewWindow", {
    value: mockCurrentWebviewWindow,
    writable: true,
    configurable: true,
});

vi.mock("@tauri-apps/api/window", () => ({
    getCurrentWindow: () => mockCurrentWindow,
}));

vi.mock("@tauri-apps/api/webview", () => ({
    getCurrentWebview: () => ({
        onDragDropEvent: vi.fn().mockResolvedValue(vi.fn()),
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
    getCurrentWebviewWindow: vi.fn(() => mockCurrentWebviewWindow),
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
    confirm: vi.fn().mockResolvedValue(true),
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

Object.defineProperty(globalThis, "ResizeObserver", {
    writable: true,
    configurable: true,
    value: class MockResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
    },
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

Object.defineProperty(globalThis, "ResizeObserver", {
    writable: true,
    value: class MockResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
    },
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
let useSettingsStore: typeof import("../app/store/settingsStore").useSettingsStore;
let useThemeStore: typeof import("../app/store/themeStore").useThemeStore;
let useVaultStore: typeof import("../app/store/vaultStore").useVaultStore;
let useCommandStore: typeof import("../features/command-palette/store/commandStore").useCommandStore;
let resetChatStore: typeof import("../features/ai/store/chatStore").resetChatStore;
let resetChatTabsStore: typeof import("../features/ai/store/chatTabsStore").resetChatTabsStore;

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
    xtermMockInstances.length = 0;
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
    ({ useSettingsStore } = await import("../app/store/settingsStore"));
    ({ useThemeStore } = await import("../app/store/themeStore"));
    ({ useVaultStore } = await import("../app/store/vaultStore"));
    ({ useCommandStore } =
        await import("../features/command-palette/store/commandStore"));
    ({ resetChatStore } = await import("../features/ai/store/chatStore"));
    ({ resetChatTabsStore } =
        await import("../features/ai/store/chatTabsStore"));

    useEditorStore.setState({
        tabs: [],
        activeTabId: null,
        recentlyClosedTabs: [],
        activationHistory: [],
        tabNavigationHistory: [],
        tabNavigationIndex: -1,
        pendingReveal: null,
        pendingSelectionReveal: null,
    });

    useThemeStore.setState({
        mode: "system",
        themeName: "default",
        isDark: false,
    });

    useSettingsStore.getState().reset();

    useVaultStore.setState({
        vaultPath: null,
        notes: [],
        entries: [],
        vaultRevision: 0,
        contentRevision: 0,
        structureRevision: 0,
        resolverRevision: 0,
        graphRevision: 0,
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

    resetChatStore();
    resetChatTabsStore();
});

afterEach(() => {
    cleanup();
});
