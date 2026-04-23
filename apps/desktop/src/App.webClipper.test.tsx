import { act, screen } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { openVaultWindow } from "./app/detachedWindows";
import { useEditorStore } from "./app/store/editorStore";
import { getEditorSessionKey } from "./app/store/editorSession";
import { useLayoutStore } from "./app/store/layoutStore";
import { useVaultStore } from "./app/store/vaultStore";
import { readWindowSessionSnapshot } from "./app/windowSession";
import { useCommandStore } from "./features/command-palette/store/commandStore";
import {
    getChatTabsStorageKey,
    useChatTabsStore,
} from "./features/ai/store/chatTabsStore";
import { useChatStore } from "./features/ai/store/chatStore";
import { flushPromises, renderComponent } from "./test/test-utils";

const MENU_ACTION_EVENT = "menu-action";
const DOCK_OPEN_VAULT_EVENT = "dock-open-vault";
const WEB_CLIPPER_CLIP_SAVED_EVENT = "neverwrite:web-clipper/clip-saved";
const WEB_CLIPPER_ROUTE_CLIP_EVENT = "neverwrite:web-clipper/route-clip";

vi.mock("./components/layout/AppLayout", () => ({
    AppLayout: ({
        left,
        center,
        right,
    }: {
        left: ReactNode;
        center: ReactNode;
        right: ReactNode;
    }) => (
        <div data-testid="app-layout">
            <div>{left}</div>
            <div>{center}</div>
            <div>{right}</div>
        </div>
    ),
}));

vi.mock("./components/layout/SidebarShell", () => ({
    SidebarShell: () => <div data-testid="sidebar-shell" />,
}));

vi.mock("./features/notes/LinksPanel", () => ({
    LinksPanel: () => <div data-testid="links-panel" />,
}));

vi.mock("./features/notes/OutlinePanel", () => ({
    OutlinePanel: () => <div data-testid="outline-panel" />,
}));

vi.mock("./features/ai/AIChatPanel", () => ({
    AIChatPanel: () => <div data-testid="ai-chat-panel" />,
}));

vi.mock("./features/editor/UnifiedBar", () => ({
    UnifiedBar: ({ windowMode }: { windowMode: string }) => (
        <div data-testid="unified-bar" data-window-mode={windowMode} />
    ),
}));

vi.mock("./features/editor/EditorChromeBar", () => ({
    EditorChromeBar: () => <div data-testid="editor-chrome-bar" />,
}));

vi.mock("./features/editor/MultiPaneWorkspace", () => ({
    MultiPaneWorkspace: () => <div data-testid="multi-pane-workspace" />,
}));

vi.mock("./features/editor/EditorPaneContent", () => ({
    EditorPaneContent: () => <div data-testid="editor-pane-content" />,
}));

vi.mock("./features/editor/Editor", () => ({
    Editor: () => <div data-testid="editor-view">Editor view</div>,
    REQUEST_CLOSE_ACTIVE_TAB_EVENT: "editor:request-close-active-tab",
}));

vi.mock("./features/editor/FileTabView", () => ({
    FileTabView: () => <div data-testid="file-tab-view">File view</div>,
}));

vi.mock("./features/ai/components/AIReviewView", () => ({
    AIReviewView: () => <div data-testid="review-view">Review view</div>,
}));

vi.mock("./features/editor/NewTabView", () => ({
    NewTabView: () => <div data-testid="new-tab-view">New tab</div>,
}));

vi.mock("./features/search/SearchView", () => ({
    SearchView: () => <div data-testid="search-view">Search view</div>,
}));

vi.mock("./features/pdf/PdfTabView", () => ({
    PdfTabView: () => <div data-testid="pdf-tab-view">PDF view</div>,
}));

vi.mock("./features/maps/MapsPanel", () => ({
    MapsPanel: () => <div data-testid="maps-panel" />,
}));

vi.mock("./features/bookmarks/BookmarksPanel", () => ({
    BookmarksPanel: () => <div data-testid="bookmarks-panel" />,
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

vi.mock("./app/detachedWindows", () => ({
    ATTACH_EXTERNAL_TAB_EVENT: "neverwrite:attach-external-tab",
    getCurrentWindowLabel: () => "main",
    getWindowMode: () => "main",
    openDetachedNoteWindow: vi.fn(),
    openSettingsWindow: vi.fn(),
    openVaultWindow: vi.fn(async () => {}),
    readDetachedWindowPayload: vi.fn(() => null),
}));

vi.mock("./app/detachedWindowBootstrap", () => ({
    bootstrapDetachedWindow: vi.fn(async () => {}),
}));

vi.mock("./app/windowSession", () => ({
    buildWindowSessionEntry: vi.fn(() => ({
        label: "main",
        kind: "vault",
        vaultPath: "/vaults/a",
    })),
    readWindowSessionSnapshot: vi.fn(() => []),
    refreshWindowSessionSnapshot: vi.fn(async () => {}),
    restoreWindowSession: vi.fn(async () => false),
    writeWindowSessionEntry: vi.fn(),
}));

describe("App web clipper routing", () => {
    const eventHandlers = new Map<
        string,
        (event: { payload: unknown }) => void
    >();
    const windowEventHandlers = new Map<
        string,
        (event: { payload: unknown }) => void
    >();

    beforeEach(() => {
        window.history.replaceState({}, "", "/?vault=%2Fvaults%2Fa");
        eventHandlers.clear();
        windowEventHandlers.clear();
        localStorage.clear();
        vi.clearAllMocks();

        vi.mocked(listen).mockImplementation(async (eventName, handler) => {
            eventHandlers.set(
                eventName as string,
                handler as (event: { payload: unknown }) => void,
            );
            const unlisten: UnlistenFn = () => {};
            return unlisten;
        });
        vi.mocked(getCurrentWindow().listen).mockImplementation(
            async (eventName, handler) => {
                windowEventHandlers.set(
                    eventName as string,
                    handler as (event: { payload: unknown }) => void,
                );
                const unlisten: UnlistenFn = () => {};
                return unlisten;
            },
        );

        vi.mocked(readWindowSessionSnapshot).mockReturnValue([]);
        vi.mocked(getAllWebviewWindows).mockResolvedValue([
            { label: "main", setFocus: vi.fn() },
        ] as unknown as Awaited<ReturnType<typeof getAllWebviewWindows>>);

        useVaultStore.setState({
            vaultPath: "/vaults/a",
            openVault: vi.fn(async () => {}),
            restoreVault: vi.fn(async () => {}),
            isLoading: false,
            error: null,
        });
        useLayoutStore.setState({
            editorPaneSizes: [1],
        });

        useEditorStore.setState({
            tabs: [],
            activeTabId: null,
            openNote: vi.fn(),
        });

        useChatStore.setState({
            initialize: vi.fn(async () => ({ sessionInventoryLoaded: true })),
            sessionsById: {},
            activeSessionId: null,
            reconcileRestoredWorkspaceTabs: vi.fn(async () => {}),
        });

        useChatTabsStore.setState({
            restoreWorkspace: vi.fn(),
            hydrateForVault: vi.fn(),
            isReady: false,
            tabs: [],
            activeTabId: null,
        });
    });

    it("keeps the persisted chat workspace when chat initialization fails during cold start", async () => {
        const persistedWorkspace = {
            version: 1 as const,
            tabs: [
                {
                    id: "chat-tab-1",
                    sessionId: "persisted:history-1",
                    historySessionId: "history-1",
                    runtimeId: "codex-acp",
                },
            ],
            activeTabId: "chat-tab-1",
        };
        localStorage.setItem(
            getChatTabsStorageKey("/vaults/a"),
            JSON.stringify(persistedWorkspace),
        );

        const initialize = vi.fn(async () => ({
            sessionInventoryLoaded: false,
        }));
        const reconcileRestoredWorkspaceTabs = vi.fn(async () => {});
        const restoreWorkspace = vi.fn();
        const hydrateForVault = vi.fn();

        useChatStore.setState({
            initialize,
            sessionsById: {},
            activeSessionId: null,
            reconcileRestoredWorkspaceTabs,
        });
        useChatTabsStore.setState({
            restoreWorkspace,
            hydrateForVault,
            isReady: false,
            tabs: [],
            activeTabId: null,
        });

        renderComponent(<App />);
        await flushPromises();

        expect(initialize).toHaveBeenCalled();
        expect(restoreWorkspace).not.toHaveBeenCalled();
        expect(reconcileRestoredWorkspaceTabs).not.toHaveBeenCalled();
        expect(hydrateForVault).toHaveBeenCalledWith(persistedWorkspace);
        expect(useChatTabsStore.getState().isReady).toBe(true);
    });

    it("registers and unregisters the current main window route", async () => {
        const view = renderComponent(<App />);
        await flushPromises();

        expect(invoke).toHaveBeenCalledWith("register_window_vault_route", {
            label: "main",
            windowMode: "main",
            vaultPath: "/vaults/a",
        });

        view.unmount();
        await flushPromises();

        expect(invoke).toHaveBeenCalledWith("unregister_window_vault_route", {
            label: "main",
        });
    });

    it("re-attaches an external tab into the focused pane when split view is active", async () => {
        useEditorStore.getState().hydrateWorkspace(
            [
                {
                    id: "primary",
                    tabs: [
                        {
                            id: "tab-a",
                            kind: "note",
                            noteId: "notes/a",
                            title: "Alpha",
                            content: "Alpha",
                        },
                    ],
                    activeTabId: "tab-a",
                },
                {
                    id: "secondary",
                    tabs: [
                        {
                            id: "tab-b",
                            kind: "note",
                            noteId: "notes/b",
                            title: "Beta",
                            content: "Beta",
                        },
                    ],
                    activeTabId: "tab-b",
                },
            ],
            "secondary",
        );

        renderComponent(<App />);
        await flushPromises();

        const handler = windowEventHandlers.get(
            "neverwrite:attach-external-tab",
        );
        expect(handler).toBeDefined();

        await act(async () => {
            handler?.({
                payload: {
                    tab: {
                        id: "tab-c",
                        kind: "note",
                        noteId: "notes/c",
                        title: "Gamma",
                        content: "Gamma",
                    },
                },
            });
            await Promise.resolve();
        });

        const state = useEditorStore.getState();
        expect(state.focusedPaneId).toBe("secondary");
        expect(state.panes[0]?.tabs.map((tab) => tab.id)).toEqual(["tab-a"]);
        expect(state.panes[1]?.tabs.map((tab) => tab.id)).toEqual([
            "tab-b",
            "tab-c",
        ]);
        expect(state.panes[1]?.activeTabId).toBe("tab-c");
    });

    it("restores a persisted multipane workspace and reapplies pane sizes", async () => {
        localStorage.setItem(
            getEditorSessionKey("/vaults/a"),
            JSON.stringify({
                panes: [
                    {
                        id: "primary",
                        tabs: [
                            {
                                id: "tab-a",
                                kind: "note",
                                noteId: "notes/a",
                                title: "A",
                                content: "Alpha",
                                history: [],
                                historyIndex: 0,
                            },
                        ],
                        activeTabId: "tab-a",
                    },
                    {
                        id: "secondary",
                        tabs: [
                            {
                                id: "tab-b",
                                kind: "note",
                                noteId: "notes/b",
                                title: "B",
                                content: "Beta",
                                history: [],
                                historyIndex: 0,
                            },
                        ],
                        activeTabId: "tab-b",
                    },
                ],
                focusedPaneId: "secondary",
                paneSizes: [0.4, 0.6],
                noteIds: [],
                activeNoteId: null,
            }),
        );

        renderComponent(<App />);
        await flushPromises();

        expect(useEditorStore.getState().panes).toHaveLength(2);
        expect(useEditorStore.getState().focusedPaneId).toBe("secondary");
        expect(screen.getByTestId("editor-chrome-bar")).toBeInTheDocument();
        expect(screen.getByTestId("multi-pane-workspace")).toBeInTheDocument();
        expect(useLayoutStore.getState().editorPaneSizes).toEqual([0.4, 0.6]);
    });

    it("dispatches native menu actions into the command store", async () => {
        renderComponent(<App />);
        await flushPromises();

        await act(async () => {
            eventHandlers.get(MENU_ACTION_EVENT)?.({
                payload: "nav:command-palette",
            });
            await Promise.resolve();
        });

        expect(useCommandStore.getState().activeModal).toBe("command-palette");
    });

    it("opens a new vault window when the dock menu requests it", async () => {
        renderComponent(<App />);
        await flushPromises();
        vi.mocked(openVaultWindow).mockClear();
        vi.mocked(useVaultStore.getState().openVault).mockClear();

        await act(async () => {
            eventHandlers.get(DOCK_OPEN_VAULT_EVENT)?.({
                payload: "/vaults/dock",
            });
            await Promise.resolve();
        });

        expect(openVaultWindow).toHaveBeenCalledWith("/vaults/dock");
        expect(useVaultStore.getState().openVault).not.toHaveBeenCalled();
    });

    it("opens clip-saved payloads without switching the current vault", async () => {
        const openVault = vi.fn(async () => {});
        const openNote = vi.fn();

        useVaultStore.setState({ openVault });
        useEditorStore.setState({ openNote });

        renderComponent(<App />);
        await flushPromises();
        openVault.mockClear();

        const payload = {
            requestId: "req-1",
            vaultPath: "/vaults/a",
            targetWindowLabel: "main",
            noteId: "notes/test",
            title: "Test clip",
            relativePath: "Clips/Test clip.md",
            content: "# Test clip",
        };

        await act(async () => {
            eventHandlers.get(WEB_CLIPPER_CLIP_SAVED_EVENT)?.({ payload });
            await Promise.resolve();
        });

        expect(openVault).not.toHaveBeenCalled();
        expect(openNote).toHaveBeenCalledWith(
            payload.noteId,
            payload.title,
            payload.content,
        );
    });

    it("ignores clip-saved payloads targeted to another window or vault", async () => {
        const openNote = vi.fn();

        useEditorStore.setState({ openNote });

        renderComponent(<App />);
        await flushPromises();

        await act(async () => {
            eventHandlers.get(WEB_CLIPPER_CLIP_SAVED_EVENT)?.({
                payload: {
                    requestId: "req-ignore-window",
                    vaultPath: "/vaults/a",
                    targetWindowLabel: "vault-b",
                    noteId: "notes/other-window",
                    title: "Other window",
                    relativePath: "Clips/Other window.md",
                    content: "# Other window",
                },
            });
            await Promise.resolve();
        });

        await act(async () => {
            eventHandlers.get(WEB_CLIPPER_CLIP_SAVED_EVENT)?.({
                payload: {
                    requestId: "req-ignore-vault",
                    vaultPath: "/vaults/b",
                    targetWindowLabel: "main",
                    noteId: "notes/other-vault",
                    title: "Other vault",
                    relativePath: "Clips/Other vault.md",
                    content: "# Other vault",
                },
            });
            await Promise.resolve();
        });

        expect(openNote).not.toHaveBeenCalled();
    });

    it("does not read text files from disk when no matching text tab is open", async () => {
        vi.useFakeTimers();

        renderComponent(<App />);
        await flushPromises();
        vi.mocked(invoke).mockClear();

        await act(async () => {
            eventHandlers.get("vault://note-changed")?.({
                payload: {
                    vault_path: "/vaults/a",
                    kind: "upsert",
                    entry: {
                        kind: "file",
                        mime_type: "text/plain",
                    },
                    relative_path: "src/ghost.ts",
                    origin: "external",
                    op_id: null,
                    revision: 1,
                    content_hash: null,
                },
            });
            vi.advanceTimersByTime(250);
            await Promise.resolve();
        });

        const readCalls = vi
            .mocked(invoke)
            .mock.calls.filter(([command]) => command === "read_vault_file");
        expect(readCalls).toHaveLength(0);
        vi.useRealTimers();
    });

    it("routes fallback clips through a new vault window and emits to that label", async () => {
        const targetWindowFocus = vi.fn();
        let snapshotReads = 0;
        vi.mocked(readWindowSessionSnapshot).mockImplementation(() => {
            snapshotReads += 1;
            if (snapshotReads < 2) {
                return [];
            }
            return [
                {
                    label: "vault-b",
                    kind: "vault",
                    vaultPath: "/vaults/b",
                },
            ];
        });
        vi.mocked(getAllWebviewWindows)
            .mockResolvedValueOnce([
                { label: "main", setFocus: vi.fn() },
            ] as unknown as Awaited<ReturnType<typeof getAllWebviewWindows>>)
            .mockResolvedValueOnce([
                { label: "main", setFocus: vi.fn() },
                { label: "vault-b", setFocus: targetWindowFocus },
            ] as unknown as Awaited<ReturnType<typeof getAllWebviewWindows>>);

        renderComponent(<App />);
        await flushPromises();
        expect(eventHandlers.has(WEB_CLIPPER_ROUTE_CLIP_EVENT)).toBe(true);

        const payload = {
            requestId: "req-2",
            vaultPath: "/vaults/b",
            targetWindowLabel: null,
            noteId: "notes/clip",
            title: "Clip B",
            relativePath: "Clips/Clip B.md",
            content: "# Clip B",
        };

        await act(async () => {
            eventHandlers.get(WEB_CLIPPER_ROUTE_CLIP_EVENT)?.({ payload });
            await Promise.resolve();
            await Promise.resolve();
        });
        await flushPromises();

        expect(openVaultWindow).toHaveBeenCalledWith("/vaults/b");
        expect(getCurrentWindow().emitTo).toHaveBeenCalledWith(
            "vault-b",
            WEB_CLIPPER_CLIP_SAVED_EVENT,
            {
                ...payload,
                targetWindowLabel: "vault-b",
            },
        );
    });
});
