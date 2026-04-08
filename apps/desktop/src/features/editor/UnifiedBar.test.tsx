import { act, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, beforeEach, vi } from "vitest";
import { useState } from "react";
import {
    renderComponent,
    flushPromises,
    setEditorTabs,
    setVaultEntries,
    setVaultNotes,
} from "../../test/test-utils";
import { useEditorStore } from "../../app/store/editorStore";
import { useSettingsStore } from "../../app/store/settingsStore";
import { FILE_TREE_NOTE_DRAG_EVENT } from "../ai/dragEvents";
import type { AIComposerPart } from "../ai/types";

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
    ATTACH_EXTERNAL_TAB_EVENT: "neverwrite:attach-external-tab",
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

function defineElementMetric<T extends keyof HTMLElement>(
    element: HTMLElement,
    property: T,
    value: HTMLElement[T],
) {
    Object.defineProperty(element, property, {
        configurable: true,
        value,
    });
}

function resizeObserverEntry(
    target: Element,
    contentRect: DOMRectReadOnly,
): ResizeObserverEntry {
    return {
        target,
        contentRect,
        borderBoxSize: [],
        contentBoxSize: [],
        devicePixelContentBoxSize: [],
    } as ResizeObserverEntry;
}

describe("UnifiedBar tab strip drop", () => {
    beforeEach(() => {
        if (typeof window.PointerEvent === "undefined") {
            class MockPointerEvent extends MouseEvent {
                pointerId: number;
                pointerType: string;
                isPrimary: boolean;

                constructor(
                    type: string,
                    init: MouseEventInit & {
                        pointerId?: number;
                        pointerType?: string;
                        isPrimary?: boolean;
                    } = {},
                ) {
                    super(type, init);
                    this.pointerId = init.pointerId ?? 1;
                    this.pointerType = init.pointerType ?? "mouse";
                    this.isPrimary = init.isPrimary ?? true;
                }
            }

            Object.defineProperty(window, "PointerEvent", {
                configurable: true,
                value: MockPointerEvent,
            });
            Object.defineProperty(globalThis, "PointerEvent", {
                configurable: true,
                value: MockPointerEvent,
            });
        }

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

    it("shrinks editor tabs continuously and expands them again when space returns", async () => {
        const resizeCallbacks: ResizeObserverCallback[] = [];
        const originalResizeObserver = globalThis.ResizeObserver;

        class MockResizeObserver {
            constructor(callback: ResizeObserverCallback) {
                resizeCallbacks.push(callback);
            }

            observe() {}

            disconnect() {}
        }

        Object.defineProperty(globalThis, "ResizeObserver", {
            configurable: true,
            writable: true,
            value: MockResizeObserver,
        });

        try {
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
                {
                    id: "tab-c",
                    kind: "note",
                    noteId: "notes/gamma.md",
                    title: "Gamma",
                    content: "gamma",
                },
            ]);

            const { UnifiedBar } = await import("./UnifiedBar");
            const { container } = renderComponent(
                <UnifiedBar windowMode="main" />,
            );
            await flushPromises();

            const strip = container.querySelector(
                '[data-tab-strip="true"]',
            ) as HTMLElement | null;
            const firstTab = container.querySelector(
                '[data-tab-id="tab-a"]',
            ) as HTMLElement | null;

            expect(strip).not.toBeNull();
            expect(firstTab).not.toBeNull();

            defineElementMetric(strip!, "clientWidth", 420);
            defineElementMetric(strip!, "scrollWidth", 420);
            defineElementMetric(strip!, "scrollLeft", 0);

            await act(async () => {
                for (const resizeCallback of resizeCallbacks) {
                    resizeCallback(
                        [
                            resizeObserverEntry(
                                strip!,
                                rect({
                                    left: 0,
                                    top: 0,
                                    width: 420,
                                    height: 30,
                                }),
                            ),
                        ],
                        {} as ResizeObserver,
                    );
                }
                await Promise.resolve();
            });

            expect(strip).toHaveAttribute("data-tab-density", "compact");
            expect(strip).not.toHaveAttribute("data-tab-overflowing");
            expect(parseFloat(firstTab!.style.width)).toBeGreaterThan(128);
            expect(parseFloat(firstTab!.style.width)).toBeLessThan(160);

            defineElementMetric(strip!, "clientWidth", 560);
            defineElementMetric(strip!, "scrollWidth", 560);

            await act(async () => {
                for (const resizeCallback of resizeCallbacks) {
                    resizeCallback(
                        [
                            resizeObserverEntry(
                                strip!,
                                rect({
                                    left: 0,
                                    top: 0,
                                    width: 560,
                                    height: 30,
                                }),
                            ),
                        ],
                        {} as ResizeObserver,
                    );
                }
                await Promise.resolve();
            });

            expect(strip).toHaveAttribute("data-tab-density", "comfortable");
            expect(parseFloat(firstTab!.style.width)).toBe(160);
        } finally {
            Object.defineProperty(globalThis, "ResizeObserver", {
                configurable: true,
                writable: true,
                value: originalResizeObserver,
            });
        }
    });

    it("keeps the strip scrollable once tabs hit the overflow density", async () => {
        const resizeCallbacks: ResizeObserverCallback[] = [];
        const originalResizeObserver = globalThis.ResizeObserver;

        class MockResizeObserver {
            constructor(callback: ResizeObserverCallback) {
                resizeCallbacks.push(callback);
            }

            observe() {}

            disconnect() {}
        }

        Object.defineProperty(globalThis, "ResizeObserver", {
            configurable: true,
            writable: true,
            value: MockResizeObserver,
        });

        try {
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
                {
                    id: "tab-c",
                    kind: "note",
                    noteId: "notes/gamma.md",
                    title: "Gamma",
                    content: "gamma",
                },
                {
                    id: "tab-d",
                    kind: "note",
                    noteId: "notes/delta.md",
                    title: "Delta",
                    content: "delta",
                },
                {
                    id: "tab-e",
                    kind: "note",
                    noteId: "notes/epsilon.md",
                    title: "Epsilon",
                    content: "epsilon",
                },
            ]);

            const { UnifiedBar } = await import("./UnifiedBar");
            const { container } = renderComponent(
                <UnifiedBar windowMode="main" />,
            );
            await flushPromises();

            const strip = container.querySelector(
                '[data-tab-strip="true"]',
            ) as HTMLElement | null;
            const firstTab = container.querySelector(
                '[data-tab-id="tab-a"]',
            ) as HTMLElement | null;

            expect(strip).not.toBeNull();
            expect(firstTab).not.toBeNull();

            defineElementMetric(strip!, "clientWidth", 360);
            defineElementMetric(strip!, "scrollWidth", 520);
            defineElementMetric(strip!, "scrollLeft", 0);

            await act(async () => {
                for (const resizeCallback of resizeCallbacks) {
                    resizeCallback(
                        [
                            resizeObserverEntry(
                                strip!,
                                rect({
                                    left: 0,
                                    top: 0,
                                    width: 360,
                                    height: 30,
                                }),
                            ),
                        ],
                        {} as ResizeObserver,
                    );
                }
                await Promise.resolve();
            });

            expect(strip).toHaveAttribute("data-tab-density", "overflow");
            expect(strip).toHaveAttribute("data-tab-overflowing", "true");
            expect(parseFloat(firstTab!.style.width)).toBe(96);
            expect(
                container.querySelector('[data-tab-strip-fade="trailing"]'),
            ).not.toBeNull();
        } finally {
            Object.defineProperty(globalThis, "ResizeObserver", {
                configurable: true,
                writable: true,
                value: originalResizeObserver,
            });
        }
    });

    it("keeps the trailing drag spacer compact on macOS note windows", async () => {
        Object.defineProperty(window.navigator, "userAgent", {
            configurable: true,
            value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/605.1.15",
        });
        Object.defineProperty(window.navigator, "platform", {
            configurable: true,
            value: "MacIntel",
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
            container.querySelector(
                '[data-window-drag-trailing-spacer="true"]',
            ),
        ).toHaveStyle({
            width: "8px",
        });
    });

    it("keeps a visible drag placeholder while dropping a tab into the AI composer", async () => {
        setVaultNotes([
            {
                id: "notes/alpha.md",
                title: "Alpha",
                path: "/vault/notes/alpha.md",
                modified_at: 1,
                created_at: 1,
            },
        ]);
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
        const { AIChatComposer } =
            await import("../ai/components/AIChatComposer");

        function ComposerHarness() {
            const [parts, setParts] = useState<AIComposerPart[]>([]);

            return (
                <>
                    <UnifiedBar windowMode="main" />
                    <div style={{ paddingTop: 96 }}>
                        <AIChatComposer
                            parts={parts}
                            notes={[
                                {
                                    id: "notes/alpha.md",
                                    title: "Alpha",
                                    path: "/vault/notes/alpha.md",
                                },
                            ]}
                            status="idle"
                            runtimeName="Assistant"
                            onChange={setParts}
                            onMentionAttach={vi.fn()}
                            onFolderAttach={vi.fn()}
                            onSubmit={vi.fn()}
                            onStop={vi.fn()}
                        />
                    </div>
                </>
            );
        }

        const { container } = renderComponent(<ComposerHarness />);
        await flushPromises();

        const strip = container.querySelector(
            '[data-tab-strip="true"]',
        ) as HTMLElement | null;
        const sourceTab = container.querySelector(
            '[data-tab-id="tab-a"]',
        ) as HTMLElement | null;
        const secondTab = container.querySelector(
            '[data-tab-id="tab-b"]',
        ) as HTMLElement | null;
        const composerDropZone = container.querySelector(
            '[data-ai-composer-drop-zone="true"]',
        ) as HTMLElement | null;

        expect(strip).not.toBeNull();
        expect(sourceTab).not.toBeNull();
        expect(secondTab).not.toBeNull();
        expect(composerDropZone).not.toBeNull();

        vi.spyOn(strip!, "getBoundingClientRect").mockReturnValue(
            rect({ left: 100, top: 10, width: 360, height: 30 }),
        );
        vi.spyOn(sourceTab!, "getBoundingClientRect").mockReturnValue(
            rect({ left: 100, top: 10, width: 160, height: 30 }),
        );
        vi.spyOn(secondTab!, "getBoundingClientRect").mockReturnValue(
            rect({ left: 264, top: 10, width: 160, height: 30 }),
        );
        vi.spyOn(composerDropZone!, "getBoundingClientRect").mockReturnValue(
            rect({ left: 120, top: 120, width: 520, height: 140 }),
        );

        defineElementMetric(strip!, "scrollLeft", 0);
        defineElementMetric(strip!, "clientWidth", 360);
        defineElementMetric(strip!, "scrollWidth", 360);
        defineElementMetric(sourceTab!, "offsetLeft", 0);
        defineElementMetric(sourceTab!, "offsetWidth", 160);
        defineElementMetric(secondTab!, "offsetLeft", 164);
        defineElementMetric(secondTab!, "offsetWidth", 160);

        fireEvent.pointerDown(sourceTab!, {
            pointerId: 1,
            button: 0,
            buttons: 1,
            clientX: 148,
            clientY: 24,
            screenX: 148,
            screenY: 24,
        });

        fireEvent.pointerMove(sourceTab!, {
            pointerId: 1,
            buttons: 1,
            clientX: 220,
            clientY: 164,
            screenX: 220,
            screenY: 164,
        });

        await waitFor(() => {
            expect(
                container.querySelector('[data-tab-id="tab-a"]'),
            ).toHaveAttribute("data-dragging", "true");
        });
        expect(container.querySelector('[data-tab-id="tab-a"]')).toHaveStyle({
            opacity: "0.18",
        });

        fireEvent.pointerUp(sourceTab!, {
            pointerId: 1,
            buttons: 0,
            clientX: 220,
            clientY: 164,
            screenX: 220,
            screenY: 164,
        });

        await flushPromises();

        expect(useEditorStore.getState().tabs.map((tab) => tab.id)).toEqual([
            "tab-a",
            "tab-b",
        ]);
        expect(
            composerDropZone!.querySelector(
                '[data-kind="mention"][data-note-id="notes/alpha.md"]',
            ),
        ).not.toBeNull();
    });
});
