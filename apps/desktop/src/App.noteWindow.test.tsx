import { act, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import {
    renderComponent,
    setEditorTabs,
    flushPromises,
    getMockCurrentWebviewWindow,
    getMockCurrentWindow,
} from "./test/test-utils";
import { useCommandStore } from "./features/command-palette/store/commandStore";
import { isTerminalTab, useEditorStore } from "./app/store/editorStore";
import { useSettingsStore } from "./app/store/settingsStore";
import { useVaultStore } from "./app/store/vaultStore";
import {
    resetTerminalRuntimeStoreForTests,
    useTerminalRuntimeStore,
} from "./features/terminal/terminalRuntimeStore";

const detachedWindowMock = vi.hoisted(() => ({
    label: "note-test",
    mode: "note" as "main" | "note",
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

    it("opens workspace terminals from the developer terminal command", async () => {
        detachedWindowMock.label = "main";
        detachedWindowMock.mode = "main";
        window.history.replaceState({}, "", "/");
        useSettingsStore.setState({
            developerModeEnabled: true,
            developerTerminalEnabled: true,
        });

        renderComponent(<App />);
        await flushPromises();

        expect(
            useCommandStore
                .getState()
                .search("terminal")
                .some((command) => command.label === "New Terminal"),
        ).toBe(true);

        await act(async () => {
            useCommandStore.getState().execute("developer:new-terminal-tab");
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

    it("only restarts the active workspace terminal command for terminal tabs", async () => {
        detachedWindowMock.label = "main";
        detachedWindowMock.mode = "main";
        window.history.replaceState({}, "", "/");
        useSettingsStore.setState({
            developerModeEnabled: true,
            developerTerminalEnabled: true,
        });
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
