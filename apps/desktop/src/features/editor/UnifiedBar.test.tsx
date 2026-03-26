import { act, fireEvent } from "@testing-library/react";
import { describe, expect, it, beforeEach, vi } from "vitest";
import {
    renderComponent,
    flushPromises,
    setEditorTabs,
    setVaultEntries,
} from "../../test/test-utils";
import { useEditorStore } from "../../app/store/editorStore";
import { useSettingsStore } from "../../app/store/settingsStore";
import { FILE_TREE_NOTE_DRAG_EVENT } from "../ai/dragEvents";

const innerPositionMock = vi.fn();
const scaleFactorMock = vi.fn();
const onDragDropEventMock = vi.fn();
const minimizeMock = vi.fn().mockResolvedValue(undefined);
const toggleMaximizeMock = vi.fn().mockResolvedValue(undefined);
const isMaximizedMock = vi.fn().mockResolvedValue(false);
const closeMock = vi.fn().mockResolvedValue(undefined);

const mockCurrentWindow = {
    listen: vi.fn(),
    once: vi.fn(),
    onCloseRequested: vi.fn(),
    onMoved: vi.fn().mockResolvedValue(vi.fn()),
    onResized: vi.fn().mockResolvedValue(vi.fn()),
    onScaleChanged: vi.fn().mockResolvedValue(vi.fn()),
    innerPosition: innerPositionMock,
    scaleFactor: scaleFactorMock,
    setFocus: vi.fn(),
    startDragging: vi.fn(),
    minimize: minimizeMock,
    toggleMaximize: toggleMaximizeMock,
    isMaximized: isMaximizedMock,
    emitTo: vi.fn(),
    close: closeMock,
    label: "main",
};

vi.mock("@tauri-apps/api/window", () => ({
    getCurrentWindow: () => mockCurrentWindow,
}));

vi.mock("@tauri-apps/api/webview", () => ({
    getCurrentWebview: () => ({
        onDragDropEvent: onDragDropEventMock,
    }),
}));

vi.mock("../../app/detachedWindows", () => ({
    ATTACH_EXTERNAL_TAB_EVENT: "vaultai:attach-external-tab",
    createDetachedWindowPayload: vi.fn(),
    createGhostWindow: vi.fn(),
    destroyGhostWindow: vi.fn(),
    findWindowTabDropTarget: vi.fn(),
    getCurrentWindowLabel: vi.fn(() => "main"),
    getDetachedWindowPosition: vi.fn(),
    isPointerOutsideCurrentWindow: vi.fn(() => false),
    moveGhostWindow: vi.fn(),
    openDetachedNoteWindow: vi.fn(),
    publishWindowTabDropZone: vi.fn(),
}));

function rect({
    left,
    top,
    width,
    height,
}: {
    left: number;
    top: number;
    width: number;
    height: number;
}) {
    return {
        x: left,
        y: top,
        left,
        top,
        right: left + width,
        bottom: top + height,
        width,
        height,
        toJSON: () => ({}),
    } as DOMRect;
}

describe("UnifiedBar tab strip drop", () => {
    beforeEach(() => {
        onDragDropEventMock.mockReset();
        onDragDropEventMock.mockResolvedValue(vi.fn());
        minimizeMock.mockClear();
        toggleMaximizeMock.mockClear();
        isMaximizedMock.mockReset();
        isMaximizedMock.mockResolvedValue(false);
        closeMock.mockClear();

        scaleFactorMock.mockResolvedValue(1);
        innerPositionMock.mockResolvedValue({
            x: 0,
            y: 0,
            toLogical: () => ({ x: 0, y: 0 }),
        });

        Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
            value: vi.fn(),
            configurable: true,
        });
        Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", {
            value: vi.fn(),
            configurable: true,
        });
        Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", {
            value: vi.fn(() => false),
            configurable: true,
        });

        useSettingsStore.setState({ fileTreeShowExtensions: false });
    });

    it("switches tabs when clicking another tab", async () => {
        setEditorTabs(
            [
                {
                    id: "tab-a",
                    kind: "note",
                    noteId: "notes/alpha.md",
                    title: "Alpha",
                    content: "alpha",
                },
                {
                    id: "tab-b",
                    kind: "note",
                    noteId: "notes/beta.md",
                    title: "Beta",
                    content: "beta",
                },
            ],
            "tab-a",
        );

        const { UnifiedBar } = await import("./UnifiedBar");
        renderComponent(<UnifiedBar windowMode="main" />);
        await flushPromises();

        const targetTab = document.querySelector(
            '[data-tab-id="tab-b"]',
        ) as HTMLElement | null;
        expect(targetTab).not.toBeNull();

        fireEvent.click(targetTab!);
        expect(useEditorStore.getState().activeTabId).toBe("tab-b");
    });

    it("opens a file tree drag drop in the strip at the requested position", async () => {
        setEditorTabs([
            {
                id: "tab-a",
                kind: "note",
                noteId: "notes/alpha.md",
                title: "Alpha",
                content: "alpha",
            },
            {
                id: "tab-b",
                kind: "note",
                noteId: "notes/beta.md",
                title: "Beta",
                content: "beta",
            },
        ]);

        setVaultEntries([
            {
                id: "docs/reference.pdf",
                path: "/vault/docs/reference.pdf",
                relative_path: "docs/reference.pdf",
                title: "Reference",
                file_name: "reference.pdf",
                extension: "pdf",
                kind: "pdf",
                modified_at: 1,
                created_at: 1,
                size: 128,
                mime_type: "application/pdf",
            },
        ]);

        const { UnifiedBar } = await import("./UnifiedBar");
        renderComponent(<UnifiedBar windowMode="main" />);
        await flushPromises();

        const strip = document.querySelector(
            '[data-tab-strip="true"]',
        ) as HTMLElement | null;
        expect(strip).not.toBeNull();

        const tabNodes = Array.from(
            strip!.querySelectorAll<HTMLElement>("[data-tab-id]"),
        );
        expect(tabNodes).toHaveLength(2);

        vi.spyOn(strip!, "getBoundingClientRect").mockReturnValue(
            rect({ left: 100, top: 10, width: 360, height: 30 }),
        );
        vi.spyOn(tabNodes[0], "getBoundingClientRect").mockReturnValue(
            rect({ left: 100, top: 10, width: 160, height: 30 }),
        );
        vi.spyOn(tabNodes[1], "getBoundingClientRect").mockReturnValue(
            rect({ left: 264, top: 10, width: 160, height: 30 }),
        );

        await act(async () => {
            window.dispatchEvent(
                new CustomEvent(FILE_TREE_NOTE_DRAG_EVENT, {
                    detail: {
                        phase: "end",
                        x: 280,
                        y: 20,
                        notes: [],
                        files: [
                            {
                                filePath: "/vault/docs/reference.pdf",
                                fileName: "reference.pdf",
                                mimeType: "application/pdf",
                            },
                        ],
                    },
                }),
            );
            await Promise.resolve();
        });
        await flushPromises();

        expect(useEditorStore.getState().tabs.map((tab) => tab.title)).toEqual([
            "Alpha",
            "Reference",
            "Beta",
        ]);
        expect(
            useEditorStore
                .getState()
                .tabs.find(
                    (tab) => tab.id === useEditorStore.getState().activeTabId,
                )?.title,
        ).toBe("Reference");
    });

    it("ignores drag-drop events emitted by the tab strip itself", async () => {
        setEditorTabs([
            {
                id: "tab-a",
                kind: "note",
                noteId: "notes/alpha.md",
                title: "Alpha",
                content: "alpha",
            },
            {
                id: "tab-b",
                kind: "note",
                noteId: "notes/beta.md",
                title: "Beta",
                content: "beta",
            },
        ]);

        const { UnifiedBar } = await import("./UnifiedBar");
        renderComponent(<UnifiedBar windowMode="main" />);
        await flushPromises();

        await act(async () => {
            window.dispatchEvent(
                new CustomEvent(FILE_TREE_NOTE_DRAG_EVENT, {
                    detail: {
                        phase: "end",
                        x: 240,
                        y: 20,
                        notes: [
                            {
                                id: "notes/alpha.md",
                                title: "Alpha",
                                path: "notes/alpha.md",
                            },
                        ],
                        origin: {
                            kind: "unified-bar-tab",
                            tabId: "tab-a",
                        },
                    },
                }),
            );
            await Promise.resolve();
        });
        await flushPromises();

        expect(useEditorStore.getState().tabs.map((tab) => tab.id)).toEqual([
            "tab-a",
            "tab-b",
        ]);
    });

    it("renders native window controls on Windows and dispatches commands", async () => {
        Object.defineProperty(window.navigator, "userAgent", {
            configurable: true,
            value: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        });
        Object.defineProperty(window.navigator, "platform", {
            configurable: true,
            value: "Win32",
        });

        setEditorTabs([
            {
                id: "tab-a",
                kind: "note",
                noteId: "notes/alpha.md",
                title: "Alpha",
                content: "alpha",
            },
        ]);

        const { UnifiedBar } = await import("./UnifiedBar");
        const { container } = renderComponent(<UnifiedBar windowMode="note" />);
        await flushPromises();

        expect(
            container.querySelector('[data-window-controls="windows"]'),
        ).not.toBeNull();

        fireEvent.click(
            container.querySelector(
                '[data-window-control="minimize"]',
            ) as HTMLElement,
        );
        fireEvent.click(
            container.querySelector(
                '[data-window-control="maximize"]',
            ) as HTMLElement,
        );
        fireEvent.click(
            container.querySelector(
                '[data-window-control="close"]',
            ) as HTMLElement,
        );

        expect(minimizeMock).toHaveBeenCalledTimes(1);
        expect(toggleMaximizeMock).toHaveBeenCalledTimes(1);
        expect(closeMock).toHaveBeenCalledTimes(1);
    });

    it("renders New Tab without a fake .md suffix and closes it from the tab strip", async () => {
        useSettingsStore.setState({ fileTreeShowExtensions: true });
        setEditorTabs([
            {
                id: "tab-new",
                kind: "note",
                noteId: "",
                title: "New Tab",
                content: "",
            },
        ]);

        const { UnifiedBar } = await import("./UnifiedBar");
        const { container } = renderComponent(<UnifiedBar windowMode="main" />);
        await flushPromises();

        expect(container).toHaveTextContent("New Tab");
        expect(container).not.toHaveTextContent(".md");

        const closeButton = container.querySelector(
            '[data-tab-id="tab-new"] button',
        ) as HTMLElement | null;
        expect(closeButton).not.toBeNull();

        fireEvent.click(closeButton!);

        expect(useEditorStore.getState().tabs).toHaveLength(0);
        expect(useEditorStore.getState().activeTabId).toBeNull();
    });
});
