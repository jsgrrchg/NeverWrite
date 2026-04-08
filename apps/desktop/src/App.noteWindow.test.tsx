import { act, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import {
    renderComponent,
    setEditorTabs,
    flushPromises,
} from "./test/test-utils";
import { useCommandStore } from "./features/command-palette/store/commandStore";
import { useEditorStore } from "./app/store/editorStore";

vi.mock("@tauri-apps/api/event", () => ({
    listen: vi.fn().mockResolvedValue(vi.fn()),
}));

vi.mock("@tauri-apps/api/window", () => ({
    getCurrentWindow: () => ({
        listen: vi.fn().mockResolvedValue(vi.fn()),
        once: vi.fn(),
        onCloseRequested: vi.fn(),
        onMoved: vi.fn().mockResolvedValue(vi.fn()),
        onResized: vi.fn().mockResolvedValue(vi.fn()),
        onScaleChanged: vi.fn().mockResolvedValue(vi.fn()),
        setFocus: vi.fn(),
        startDragging: vi.fn(),
        emitTo: vi.fn(),
        close: vi.fn(),
        label: "note-test",
    }),
}));

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

vi.mock("./features/editor/NewTabView", () => ({
    NewTabView: () => <div data-testid="new-tab-view">New tab</div>,
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

vi.mock("./features/ai/hooks/useAutoOpenReviewTab", () => ({
    useAutoOpenReviewTab: () => {},
}));

vi.mock("./features/devtools/DeveloperPanel", () => ({
    DEVELOPER_PANEL_NEW_TAB_EVENT: "developer-panel:new-tab",
    DEVELOPER_PANEL_RESTART_EVENT: "developer-panel:restart",
    DeveloperPanel: () => <div data-testid="developer-panel" />,
}));

vi.mock("./app/detachedWindows", () => ({
    ATTACH_EXTERNAL_TAB_EVENT: "neverwrite:attach-external-tab",
    getCurrentWindowLabel: () => "note-test",
    getWindowMode: () => "note",
    openDetachedNoteWindow: vi.fn(),
    openSettingsWindow: vi.fn(),
    openVaultWindow: vi.fn(),
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
        window.history.replaceState({}, "", "/?window=note");
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
    });

    it("preserves the min-size constrained layout chain for detached file tabs", async () => {
        renderComponent(<App />);
        await flushPromises();

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

    it("closes an active New Tab through the global close-tab command", async () => {
        setEditorTabs([
            {
                id: "new-tab-1",
                kind: "note",
                noteId: "",
                title: "New Tab",
                content: "",
            },
        ]);

        renderComponent(<App />);
        await flushPromises();

        await act(async () => {
            useCommandStore.getState().execute("editor:close-tab");
            await Promise.resolve();
        });
        await flushPromises();

        expect(useEditorStore.getState().tabs).toHaveLength(0);
        expect(useEditorStore.getState().activeTabId).toBeNull();
    });
});
