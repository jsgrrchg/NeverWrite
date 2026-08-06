import { act, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import {
    renderComponent,
    setEditorTabs,
    flushPromises,
    getMockCurrentWebviewWindow,
    getMockCurrentWindow,
    mockInvoke,
} from "./test/test-utils";
import { useCommandStore } from "./features/command-palette/store/commandStore";
import { isTerminalTab, useEditorStore } from "./app/store/editorStore";
import { useSettingsStore } from "./app/store/settingsStore";
import { useVaultStore } from "./app/store/vaultStore";
import { getDesktopPlatform } from "./app/utils/platform";
import {
    setShortcutOverride,
    SHORTCUT_OVERRIDES_STORAGE_KEY,
} from "./app/shortcuts/preferences";
import {
    resetTerminalRuntimeStoreForTests,
    useTerminalRuntimeStore,
} from "./features/terminal/terminalRuntimeStore";

const detachedWindowMock = vi.hoisted(() => ({
    label: "note-test",
    mode: "note" as "main" | "note",
}));

const originalUserAgent = navigator.userAgent;
const originalPlatform = navigator.platform;

function setNavigatorIdentity(userAgent: string, platform: string) {
    Object.defineProperty(window.navigator, "userAgent", {
        configurable: true,
        value: userAgent,
    });
    Object.defineProperty(window.navigator, "platform", {
        configurable: true,
        value: platform,
    });
}

vi.mock("./features/editor/UnifiedBar", () => ({
    UnifiedBar: ({ windowMode }: { windowMode: string }) => (
        <div data-testid="unified-bar" data-window-mode={windowMode} />
    ),
}));

vi.mock("./features/editor/FileTabView", () => ({
    FileTabView: () => (
        <div data-testid="file-tab-view" className="h-full overflow-auto">
            File tab view
        </div>
    ),
}));

vi.mock("./features/editor/Editor", () => ({
    Editor: () => <div data-testid="editor-view">Editor view</div>,
}));

vi.mock("./features/pdf/PdfTabView", () => ({
    PdfTabView: () => <div data-testid="pdf-tab-view">PDF view</div>,
}));

vi.mock("./features/ai/components/AIReviewView", () => ({
    AIReviewView: () => <div data-testid="review-view">Review view</div>,
}));

vi.mock("./features/search/SearchView", () => ({
    SearchView: () => <div data-testid="search-view">Search view</div>,
}));

vi.mock("./features/command-palette/CommandPalette", () => ({
    CommandPalette: () => <div data-testid="command-palette" />,
}));

vi.mock("./features/quick-switcher/QuickSwitcher", () => ({
    QuickSwitcher: () => <div data-testid="quick-switcher" />,
}));

vi.mock("./features/settings", () => ({
    SettingsPanel: () => <div data-testid="settings-panel" />,
}));

vi.mock("./features/ai/AIChatDetachedWindowHost", () => ({
    AIChatDetachedWindowHost: () => (
        <div data-testid="ai-chat-detached-window-host" />
    ),
}));

vi.mock("./app/detachedWindows", () => ({
    ATTACH_EXTERNAL_TAB_EVENT: "neverwrite:attach-external-tab",
    getCurrentWindowLabel: () => detachedWindowMock.label,
    getWindowMode: () => detachedWindowMock.mode,
    openDetachedNoteWindow: vi.fn(),
    openSettingsWindow: vi.fn(),
    openVaultWindow: vi.fn(),
    publishWindowTabDropZone: vi.fn(),
    readDetachedWindowPayload: vi.fn(() => null),
}));

vi.mock("./app/detachedWindowBootstrap", () => ({
    bootstrapDetachedWindow: vi.fn(async () => {}),
}));

vi.mock("./app/windowSession", () => ({
    buildWindowSessionEntry: vi.fn(() => null),
    refreshWindowSessionSnapshot: vi.fn(async () => {}),
    restoreWindowSession: vi.fn(() => null),
    writeWindowSessionEntry: vi.fn(),
}));

describe("App note window", () => {
    beforeEach(() => {
        setNavigatorIdentity(originalUserAgent, originalPlatform);
        localStorage.clear();
        detachedWindowMock.label = "note-test";
        detachedWindowMock.mode = "note";
        getMockCurrentWindow().label = "note-test";
        getMockCurrentWebviewWindow().label = "note-test";
        window.history.replaceState({}, "", "/?window=note");
        resetTerminalRuntimeStoreForTests();
        useSettingsStore.getState().reset();
        setEditorTabs([
            {
                id: "file-tab-1",
                kind: "file",
                relativePath: "docs/readme.txt",
                title: "readme.txt",
                path: "/vault/docs/readme.txt",
                mimeType: "text/plain",
                viewer: "text",
                content: "hello",
            },
        ]);
        useVaultStore.setState({ vaultPath: "/vault" });
        useCommandStore.setState({
            commands: new Map(),
            activeModal: null,
        });
    });

    it("preserves the min-size constrained layout chain for detached file tabs", async () => {
        renderComponent(<App />);
        await flushPromises();

        expect(
            screen.getByTestId("ai-chat-detached-window-host"),
        ).toBeInTheDocument();
        expect(screen.getByTestId("unified-bar")).toHaveAttribute(
            "data-window-mode",
            "note",
        );

        const fileTabView = screen.getByTestId("file-tab-view");
        const panelWrapper = fileTabView.parentElement;
        const windowContentWrapper = panelWrapper?.parentElement;

        expect(panelWrapper).toHaveClass(
            "relative",
            "flex-1",
            "min-h-0",
            "min-w-0",
            "w-full",
            "overflow-hidden",
        );
        expect(windowContentWrapper).toHaveClass(
            "flex-1",
            "min-h-0",
            "min-w-0",
            "overflow-hidden",
            "flex",
            "flex-col",
        );
    });

    it("registers workspace split and focus commands", async () => {
        renderComponent(<App />);
        await flushPromises();

        await act(async () => {
            useCommandStore.getState().execute("workspace:split-right");
            await Promise.resolve();
        });
        await flushPromises();

        expect(useEditorStore.getState().panes.map((pane) => pane.id)).toEqual([
            "primary",
            "pane-2",
        ]);
        expect(useEditorStore.getState().focusedPaneId).toBe("pane-2");

        await act(async () => {
            useCommandStore.getState().execute("workspace:focus-left");
            await Promise.resolve();
        });
        await flushPromises();

        expect(useEditorStore.getState().focusedPaneId).toBe("primary");
    });

    it("opens workspace terminals from the terminal command", async () => {
        detachedWindowMock.label = "main";
        detachedWindowMock.mode = "main";
        window.history.replaceState({}, "", "/");

        renderComponent(<App />);
        await flushPromises();

        expect(
            useCommandStore
                .getState()
                .search("terminal")
                .some((command) => command.label === "New Terminal"),
        ).toBe(true);

        await act(async () => {
            useCommandStore.getState().execute("workspace:new-terminal-tab");
            await Promise.resolve();
        });
        await flushPromises();

        const activeTab = useEditorStore
            .getState()
            .tabs.find(
                (tab) => tab.id === useEditorStore.getState().activeTabId,
            );
        expect(activeTab && isTerminalTab(activeTab)).toBe(true);
    });

    it("opens workspace terminals from the developer terminal shortcut", async () => {
        detachedWindowMock.label = "main";
        detachedWindowMock.mode = "main";
        window.history.replaceState({}, "", "/");

        renderComponent(<App />);
        await flushPromises();

        const platform = getDesktopPlatform();

        await act(async () => {
            window.dispatchEvent(
                new KeyboardEvent("keydown", {
                    key: "r",
                    metaKey: platform === "macos",
                    ctrlKey: platform !== "macos",
                }),
            );
            await Promise.resolve();
        });
        await flushPromises();

        const activeTab = useEditorStore
            .getState()
            .tabs.find(
                (tab) => tab.id === useEditorStore.getState().activeTabId,
            );
        expect(activeTab && isTerminalTab(activeTab)).toBe(true);
    });

    it("applies changed global bindings immediately across configurable categories", async () => {
        detachedWindowMock.label = "main";
        detachedWindowMock.mode = "main";
        window.history.replaceState({}, "", "/");

        renderComponent(<App />);
        await flushPromises();

        const platform = getDesktopPlatform();
        const primaryModifier = platform === "macos" ? "meta" : "ctrl";
        const cases = [
            {
                action: "quick_switcher" as const,
                commandId: "nav:quick-switcher",
                customKey: "1",
                defaultKey: "o",
                defaultShift: false,
            },
            {
                action: "new_note" as const,
                commandId: "vault:new-note",
                customKey: "2",
                defaultKey: "n",
                defaultShift: false,
            },
            {
                action: "search_in_vault" as const,
                commandId: "vault:search",
                customKey: "7",
                defaultKey: "f",
                defaultShift: true,
            },
            {
                action: "new_agent" as const,
                commandId: "ai:new-agent",
                customKey: "3",
                defaultKey: "n",
                defaultShift: true,
            },
            {
                action: "new_terminal" as const,
                commandId: "workspace:new-terminal-tab",
                customKey: "4",
                defaultKey: "r",
                defaultShift: false,
            },
            {
                action: "close_tab" as const,
                commandId: "editor:close-tab",
                customKey: "5",
                defaultKey: "w",
                defaultShift: false,
            },
            {
                action: "toggle_left_sidebar" as const,
                commandId: "layout:toggle-sidebar",
                customKey: "6",
                defaultKey: "s",
                defaultShift: false,
            },
        ];

        await act(async () => {
            for (const shortcutCase of cases) {
                setShortcutOverride(shortcutCase.action, platform, {
                    key: shortcutCase.customKey,
                    modifiers: [primaryModifier, "alt"],
                });
            }
            await Promise.resolve();
        });
        await flushPromises();

        for (const shortcutCase of cases) {
            expect(
                useCommandStore.getState().commands.get(shortcutCase.commandId)
                    ?.shortcut,
            ).toContain(shortcutCase.customKey);
        }
        if (platform === "macos") {
            expect(mockInvoke()).toHaveBeenCalledWith(
                "sync_native_menu_shortcuts",
                {
                    accelerators: expect.objectContaining({
                        "nav:quick-switcher": "Command+Alt+1",
                        "vault:new-note": "Command+Alt+2",
                        "vault:search": "Command+Alt+7",
                    }),
                },
            );
        }

        const execute = vi.fn();
        useCommandStore.setState({ execute });

        for (const shortcutCase of cases) {
            execute.mockClear();
            window.dispatchEvent(
                new KeyboardEvent("keydown", {
                    key: shortcutCase.customKey,
                    metaKey: platform === "macos",
                    ctrlKey: platform !== "macos",
                    altKey: true,
                }),
            );
            expect(execute).toHaveBeenCalledWith(shortcutCase.commandId);

            execute.mockClear();
            window.dispatchEvent(
                new KeyboardEvent("keydown", {
                    key: shortcutCase.defaultKey,
                    metaKey: platform === "macos",
                    ctrlKey: platform !== "macos",
                    shiftKey: shortcutCase.defaultShift,
                }),
            );
            expect(execute).not.toHaveBeenCalled();
        }
    });

    it("ignores AltGr without suppressing physical Ctrl+Alt shortcuts on Windows", async () => {
        setNavigatorIdentity(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Win32",
        );
        detachedWindowMock.label = "main";
        detachedWindowMock.mode = "main";
        window.history.replaceState({}, "", "/");
        setShortcutOverride("quick_switcher", "windows", {
            key: "@",
            modifiers: ["ctrl", "alt"],
        });

        renderComponent(<App />);
        await flushPromises();

        const execute = vi.fn();
        useCommandStore.setState({ execute });
        const altGraphEvent = new KeyboardEvent("keydown", {
            key: "@",
            code: "KeyQ",
            ctrlKey: true,
            altKey: true,
            cancelable: true,
        });
        Object.defineProperty(altGraphEvent, "getModifierState", {
            configurable: true,
            value: (modifier: string) => modifier === "AltGraph",
        });

        window.dispatchEvent(altGraphEvent);
        expect(execute).not.toHaveBeenCalled();
        expect(altGraphEvent.defaultPrevented).toBe(false);

        window.dispatchEvent(
            new KeyboardEvent("keyup", {
                key: "AltGraph",
                code: "AltRight",
            }),
        );
        window.dispatchEvent(
            new KeyboardEvent("keydown", {
                key: "@",
                code: "KeyQ",
                ctrlKey: true,
                altKey: true,
            }),
        );
        expect(execute).toHaveBeenCalledWith("nav:quick-switcher");
    });

    it("keeps Escape priority and fixed editor shortcuts unchanged", async () => {
        detachedWindowMock.label = "main";
        detachedWindowMock.mode = "main";
        window.history.replaceState({}, "", "/");

        renderComponent(<App />);
        await flushPromises();

        const platform = getDesktopPlatform();
        const execute = vi.fn();
        useCommandStore.setState({ execute });

        window.dispatchEvent(
            new KeyboardEvent("keydown", {
                key: "e",
                metaKey: platform === "macos",
                ctrlKey: platform !== "macos",
            }),
        );
        expect(execute).toHaveBeenCalledWith("editor:toggle-live-preview");

        execute.mockClear();
        act(() => {
            useCommandStore.getState().openCommandPalette();
        });
        await flushPromises();

        act(() => {
            window.dispatchEvent(
                new KeyboardEvent("keydown", { key: "Escape" }),
            );
        });

        expect(useCommandStore.getState().activeModal).toBeNull();
        expect(execute).not.toHaveBeenCalled();
    });

    it("keeps stored configurable overrides from winning capture-phase precedence over fixed editor bindings", async () => {
        setNavigatorIdentity(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Win32",
        );
        detachedWindowMock.label = "main";
        detachedWindowMock.mode = "main";
        window.history.replaceState({}, "", "/");
        localStorage.setItem(
            SHORTCUT_OVERRIDES_STORAGE_KEY,
            JSON.stringify({
                version: 1,
                macos: {},
                windows: {
                    quick_switcher: { key: "e", modifiers: ["ctrl"] },
                    new_note: { key: "f", modifiers: ["ctrl"] },
                    new_agent: {
                        key: "s",
                        modifiers: ["ctrl", "shift"],
                    },
                    new_terminal: { key: "1", modifiers: ["ctrl"] },
                    command_palette: { key: "b", modifiers: ["ctrl"] },
                },
            }),
        );

        renderComponent(<App />);
        await flushPromises();

        const execute = vi.fn();
        useCommandStore.setState({ execute });

        const togglePreview = new KeyboardEvent("keydown", {
            key: "e",
            ctrlKey: true,
            cancelable: true,
        });
        window.dispatchEvent(togglePreview);
        expect(execute).toHaveBeenCalledWith("editor:toggle-live-preview");
        expect(execute).toHaveBeenCalledTimes(1);
        expect(togglePreview.defaultPrevented).toBe(true);

        for (const event of [
            new KeyboardEvent("keydown", {
                key: "f",
                ctrlKey: true,
                cancelable: true,
            }),
            new KeyboardEvent("keydown", {
                key: "s",
                ctrlKey: true,
                shiftKey: true,
                cancelable: true,
            }),
            new KeyboardEvent("keydown", {
                key: "1",
                ctrlKey: true,
                cancelable: true,
            }),
            new KeyboardEvent("keydown", {
                key: "b",
                ctrlKey: true,
                cancelable: true,
            }),
        ]) {
            execute.mockClear();
            window.dispatchEvent(event);
            expect(execute).not.toHaveBeenCalled();
            expect(event.defaultPrevented).toBe(false);
        }
    });

    it("starts workspace terminal runtimes inside detached note windows", async () => {
        mockInvoke().mockResolvedValue({
            sessionId: "devterm-note-1",
            program: "/bin/zsh",
            status: "running",
            displayName: "zsh",
            cwd: "/vault",
            cols: 120,
            rows: 24,
            exitCode: null,
            errorMessage: null,
        });
        setEditorTabs(
            [
                {
                    id: "terminal-tab-1",
                    kind: "terminal",
                    terminalId: "terminal-1",
                    title: "Terminal 1",
                    cwd: "/vault",
                },
            ],
            "terminal-tab-1",
        );

        renderComponent(<App />);
        await flushPromises();

        expect(mockInvoke()).toHaveBeenCalledWith(
            "devtools_create_terminal_session",
            {
                input: {
                    cwd: "/vault",
                    cols: 120,
                    rows: 24,
                    extraEnv: {},
                },
            },
        );
        expect(
            useTerminalRuntimeStore.getState().runtimesById["terminal-1"],
        ).toMatchObject({
            tabId: "terminal-tab-1",
            sessionId: "devterm-note-1",
        });
    });

    it("only restarts the active workspace terminal command for terminal tabs", async () => {
        detachedWindowMock.label = "main";
        detachedWindowMock.mode = "main";
        window.history.replaceState({}, "", "/");
        const restartSpy = vi
            .spyOn(useTerminalRuntimeStore.getState(), "restart")
            .mockResolvedValue(undefined);

        renderComponent(<App />);
        await flushPromises();

        expect(
            useCommandStore
                .getState()
                .search("")
                .some(
                    (command) => command.id === "developer:restart-terminal",
                ),
        ).toBe(false);

        await act(async () => {
            useEditorStore.getState().openTerminal();
            await Promise.resolve();
        });
        await flushPromises();

        const activeTab = useEditorStore
            .getState()
            .tabs.find(
                (tab) => tab.id === useEditorStore.getState().activeTabId,
            );
        expect(activeTab && isTerminalTab(activeTab)).toBe(true);

        expect(
            useCommandStore
                .getState()
                .search("")
                .some((command) => command.id === "developer:restart-terminal"),
        ).toBe(true);

        await act(async () => {
            useCommandStore.getState().execute("developer:restart-terminal");
            await Promise.resolve();
        });

        expect(restartSpy).toHaveBeenCalledWith(
            isTerminalTab(activeTab) ? activeTab.terminalId : "",
        );
    });
});
