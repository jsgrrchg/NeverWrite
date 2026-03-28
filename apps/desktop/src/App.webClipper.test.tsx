import { act } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { openVaultWindow } from "./app/detachedWindows";
import { useEditorStore } from "./app/store/editorStore";
import { useVaultStore } from "./app/store/vaultStore";
import { readWindowSessionSnapshot } from "./app/windowSession";
import { useCommandStore } from "./features/command-palette/store/commandStore";
import { useChatTabsStore } from "./features/ai/store/chatTabsStore";
import { useChatStore } from "./features/ai/store/chatStore";
import { flushPromises, renderComponent } from "./test/test-utils";

const MENU_ACTION_EVENT = "menu-action";
const DOCK_OPEN_VAULT_EVENT = "dock-open-vault";
const WEB_CLIPPER_CLIP_SAVED_EVENT = "vaultai:web-clipper/clip-saved";
const WEB_CLIPPER_ROUTE_CLIP_EVENT = "vaultai:web-clipper/route-clip";

vi.mock("./components/layout/AppLayout", () => ({
    AppLayout: ({
        left,
        center,
        right,
        bottom,
    }: {
        left: ReactNode;
        center: ReactNode;
        right: ReactNode;
        bottom?: ReactNode;
    }) => (
        <div data-testid="app-layout">
            <div>{left}</div>
            <div>{center}</div>
            <div>{right}</div>
            <div>{bottom}</div>
        </div>
    ),
}));

vi.mock("./components/layout/ActivityBar", () => ({
    ActivityBar: () => <div data-testid="activity-bar" />,
}));

vi.mock("./features/vault/FileTree", () => ({
    FileTree: () => <div data-testid="file-tree" />,
}));

vi.mock("./features/vault/VaultSwitcher", () => ({
    VaultSwitcher: () => <div data-testid="vault-switcher" />,
}));

vi.mock("./features/tags/TagsPanel", () => ({
    TagsPanel: () => <div data-testid="tags-panel" />,
}));

vi.mock("./features/search/SearchPanel", () => ({
    SearchPanel: () => <div data-testid="search-panel" />,
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

vi.mock("./features/devtools/DeveloperPanel", () => ({
    DEVELOPER_PANEL_NEW_TAB_EVENT: "developer-panel:new-tab",
    DEVELOPER_PANEL_RESTART_EVENT: "developer-panel:restart",
    DeveloperPanel: () => <div data-testid="developer-panel" />,
}));

vi.mock("./features/ai/hooks/useAutoOpenReviewTab", () => ({
    useAutoOpenReviewTab: () => {},
}));

vi.mock("./app/detachedWindows", () => ({
    ATTACH_EXTERNAL_TAB_EVENT: "vaultai:attach-external-tab",
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

    beforeEach(() => {
        window.history.replaceState({}, "", "/?vault=%2Fvaults%2Fa");
        eventHandlers.clear();
        vi.clearAllMocks();

        vi.mocked(listen).mockImplementation(async (eventName, handler) => {
            eventHandlers.set(
                eventName as string,
                handler as (event: { payload: unknown }) => void,
            );
            return vi.fn();
        });
        vi.mocked(getCurrentWindow().listen).mockResolvedValue(vi.fn());

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

        useEditorStore.setState({
            tabs: [],
            activeTabId: null,
            openNote: vi.fn(),
        });

        useChatStore.setState({
            initialize: vi.fn(async () => {}),
            sessionsById: {},
            activeSessionId: null,
        });

        useChatTabsStore.setState({
            restoreWorkspace: vi.fn(),
        });
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
