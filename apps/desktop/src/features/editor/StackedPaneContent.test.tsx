import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { useEditorStore } from "../../app/store/editorStore";
import {
    flushPromises,
    renderComponent,
    setEditorTabs,
    setVaultNotes,
} from "../../test/test-utils";
import { AIChatComposer } from "../ai/components/AIChatComposer";
import type { AIComposerPart } from "../ai/types";
import { EditorPaneContent } from "./EditorPaneContent";

function enableStackedOnFocusedPane() {
    const paneId = useEditorStore.getState().focusedPaneId;
    if (!paneId) throw new Error("expected a focused pane");
    act(() => {
        useEditorStore.getState().setPaneTabDisplayMode(paneId, "stacked");
    });
}

function defineElementMetric(
    element: HTMLElement,
    property:
        | "clientWidth"
        | "offsetLeft"
        | "offsetWidth"
        | "scrollLeft"
        | "scrollWidth",
    initialValue: number,
) {
    let value = initialValue;
    Object.defineProperty(element, property, {
        configurable: true,
        get: () => value,
        set: (next: number) => {
            value = next;
        },
    });
}

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

function dispatchPointerEvent(
    target: Window | Document | Node | Element,
    type: "pointerdown" | "pointermove" | "pointerup",
    init: {
        pointerId: number;
        button?: number;
        buttons: number;
        clientX: number;
        clientY: number;
        screenX: number;
        screenY: number;
    },
) {
    const event = new Event(type, {
        bubbles: true,
        cancelable: true,
    });

    Object.defineProperties(event, {
        pointerId: { value: init.pointerId },
        pointerType: { value: "mouse" },
        isPrimary: { value: true },
        button: { value: init.button ?? 0 },
        buttons: { value: init.buttons },
        clientX: { value: init.clientX },
        clientY: { value: init.clientY },
        screenX: { value: init.screenX },
        screenY: { value: init.screenY },
    });

    fireEvent(target, event);
}

async function flushAnimationFrame() {
    for (let i = 0; i < 2; i += 1) {
        await act(async () => {
            vi.runOnlyPendingTimers();
        });
    }
}

function getMountedState(tabId: string) {
    const column = document.querySelector(
        `[data-stacked-column-id="${tabId}"]`,
    );
    expect(column).not.toBeNull();
    return column
        ?.querySelector("[data-stacked-column-mounted]")
        ?.getAttribute("data-stacked-column-mounted");
}

function getEditorViewInColumn(tabId: string) {
    const column = document.querySelector(
        `[data-stacked-column-id="${tabId}"]`,
    );
    expect(column).not.toBeNull();
    const editorElement = column?.querySelector(".cm-editor");
    expect(editorElement).not.toBeNull();
    const view = EditorView.findFromDOM(editorElement as HTMLElement);
    expect(view).not.toBeNull();
    return view!;
}

describe("StackedPaneContent", () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it("renders one column per tab as a horizontal tablist", () => {
        setEditorTabs(
            [
                {
                    id: "n1",
                    kind: "note",
                    noteId: "note-1",
                    title: "Alpha",
                    content: "A",
                },
                {
                    id: "n2",
                    kind: "note",
                    noteId: "note-2",
                    title: "Beta",
                    content: "B",
                },
            ],
            "n1",
        );
        enableStackedOnFocusedPane();

        renderComponent(<EditorPaneContent />);

        const tablist = screen.getByRole("tablist", { name: /stacked tabs/i });
        expect(tablist).toHaveAttribute("aria-orientation", "horizontal");

        expect(
            screen.getByRole("tab", { name: /alpha/i }),
        ).toHaveAttribute("aria-selected", "true");
        expect(
            screen.getByRole("tab", { name: /beta/i }),
        ).toHaveAttribute("aria-selected", "false");
    });

    it("activates a panel when its spine is clicked", () => {
        setEditorTabs(
            [
                {
                    id: "n1",
                    kind: "note",
                    noteId: "note-1",
                    title: "Alpha",
                    content: "A",
                },
                {
                    id: "n2",
                    kind: "note",
                    noteId: "note-2",
                    title: "Beta",
                    content: "B",
                },
            ],
            "n1",
        );
        enableStackedOnFocusedPane();

        renderComponent(<EditorPaneContent />);

        // Both spines are always present; only the active one is selected.
        expect(
            screen.getByRole("tab", { name: /beta/i }),
        ).toHaveAttribute("aria-selected", "false");

        // Clicking Beta's spine activates it (content reveals via scroll).
        act(() => {
            screen.getByRole("tab", { name: /beta/i }).click();
        });
        expect(
            screen.getByRole("tab", { name: /beta/i }),
        ).toHaveAttribute("aria-selected", "true");
        expect(
            screen.getByRole("tab", { name: /alpha/i }),
        ).toHaveAttribute("aria-selected", "false");
    });

    it("does not render the stacked tablist in default mode", () => {
        setEditorTabs(
            [
                {
                    id: "n1",
                    kind: "note",
                    noteId: "note-1",
                    title: "Alpha",
                    content: "A",
                },
            ],
            "n1",
        );

        renderComponent(<EditorPaneContent />);

        expect(
            screen.queryByRole("tablist", { name: /stacked tabs/i }),
        ).not.toBeInTheDocument();
    });

    it("keeps recently hidden stacked columns mounted as a small warm cache", async () => {
        vi.useFakeTimers();
        setEditorTabs(
            [
                {
                    id: "n1",
                    kind: "note",
                    noteId: "note-1",
                    title: "Alpha",
                    content: "A",
                },
                {
                    id: "n2",
                    kind: "note",
                    noteId: "note-2",
                    title: "Beta",
                    content: "B",
                },
                {
                    id: "n3",
                    kind: "note",
                    noteId: "note-3",
                    title: "Gamma",
                    content: "C",
                },
                {
                    id: "n4",
                    kind: "note",
                    noteId: "note-4",
                    title: "Delta",
                    content: "D",
                },
            ],
            "n1",
        );
        enableStackedOnFocusedPane();

        renderComponent(<EditorPaneContent />);

        const tablist = screen.getByRole("tablist", {
            name: /stacked tabs/i,
        });
        defineElementMetric(tablist, "clientWidth", 600);
        defineElementMetric(tablist, "scrollLeft", 0);

        fireEvent.scroll(tablist);
        await flushAnimationFrame();

        expect(getMountedState("n1")).toBe("true");

        tablist.scrollLeft = 568;
        fireEvent.scroll(tablist);
        await flushAnimationFrame();

        expect(getMountedState("n2")).toBe("true");

        tablist.scrollLeft = 1136;
        fireEvent.scroll(tablist);
        await flushAnimationFrame();

        expect(getMountedState("n2")).toBe("true");
        expect(getMountedState("n3")).toBe("true");
    });

    it("restores scroll for a stacked note column that was visible but not selected", async () => {
        vi.useFakeTimers();
        setEditorTabs(
            [
                {
                    id: "n1",
                    kind: "note",
                    noteId: "note-1",
                    title: "Alpha",
                    content: "A",
                },
                {
                    id: "n2",
                    kind: "note",
                    noteId: "note-2",
                    title: "Beta",
                    content: Array.from(
                        { length: 80 },
                        (_, index) => `Line ${index + 1}`,
                    ).join("\n"),
                },
                {
                    id: "n3",
                    kind: "note",
                    noteId: "note-3",
                    title: "Gamma",
                    content: "C",
                },
                {
                    id: "n4",
                    kind: "note",
                    noteId: "note-4",
                    title: "Delta",
                    content: "D",
                },
                {
                    id: "n5",
                    kind: "note",
                    noteId: "note-5",
                    title: "Epsilon",
                    content: "E",
                },
                {
                    id: "n6",
                    kind: "note",
                    noteId: "note-6",
                    title: "Zeta",
                    content: "F",
                },
            ],
            "n1",
        );
        enableStackedOnFocusedPane();

        renderComponent(<EditorPaneContent />);

        const tablist = screen.getByRole("tablist", {
            name: /stacked tabs/i,
        });
        defineElementMetric(tablist, "clientWidth", 600);
        defineElementMetric(tablist, "scrollLeft", 0);

        fireEvent.scroll(tablist);
        await flushAnimationFrame();

        tablist.scrollLeft = 568;
        fireEvent.scroll(tablist);
        await flushAnimationFrame();

        expect(
            screen.getByRole("tab", { name: /alpha/i }),
        ).toHaveAttribute("aria-selected", "true");
        expect(getMountedState("n2")).toBe("true");

        let betaView = getEditorViewInColumn("n2");
        betaView.scrollDOM.scrollTop = 420;
        betaView.scrollDOM.scrollLeft = 12;
        fireEvent.scroll(betaView.scrollDOM);
        await flushAnimationFrame();

        for (const scrollLeft of [1136, 1704, 2272]) {
            tablist.scrollLeft = scrollLeft;
            fireEvent.scroll(tablist);
            await flushAnimationFrame();
        }

        expect(getMountedState("n2")).toBe("false");

        tablist.scrollLeft = 568;
        fireEvent.scroll(tablist);
        await flushAnimationFrame();

        betaView = getEditorViewInColumn("n2");
        expect(betaView.scrollDOM.scrollTop).toBe(420);
        expect(betaView.scrollDOM.scrollLeft).toBe(12);
    });

    it("drops a stacked note tab into the AI composer without moving the tab", async () => {
        setVaultNotes([
            {
                id: "notes/alpha.md",
                title: "Alpha",
                path: "/vault/notes/alpha.md",
                modified_at: 1,
                created_at: 1,
            },
        ]);
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
        enableStackedOnFocusedPane();

        function ComposerHarness() {
            const [parts, setParts] = useState<AIComposerPart[]>([]);

            return (
                <>
                    <EditorPaneContent />
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
                </>
            );
        }

        const { container } = renderComponent(<ComposerHarness />);
        await flushPromises();

        const tablist = screen.getByRole("tablist", {
            name: /stacked tabs/i,
        });
        const sourceColumn = container.querySelector(
            '[data-stacked-column-id="tab-a"]',
        ) as HTMLElement | null;
        const secondColumn = container.querySelector(
            '[data-stacked-column-id="tab-b"]',
        ) as HTMLElement | null;
        const sourceSpine = sourceColumn?.querySelector(
            '[role="tab"][title="Alpha"]',
        ) as HTMLElement | null;
        const composerDropZone = container.querySelector(
            '[data-ai-composer-drop-zone="true"]',
        ) as HTMLElement | null;
        const composerShell = composerDropZone?.querySelector(
            '[data-testid="chat-composer-shell"]',
        ) as HTMLElement | null;

        expect(sourceColumn).not.toBeNull();
        expect(secondColumn).not.toBeNull();
        expect(sourceSpine).not.toBeNull();
        expect(composerDropZone).not.toBeNull();
        expect(composerShell).not.toBeNull();

        vi.spyOn(tablist, "getBoundingClientRect").mockReturnValue(
            rect({ left: 100, top: 10, width: 600, height: 300 }),
        );
        vi.spyOn(sourceColumn!, "getBoundingClientRect").mockReturnValue(
            rect({ left: 100, top: 10, width: 600, height: 300 }),
        );
        vi.spyOn(secondColumn!, "getBoundingClientRect").mockReturnValue(
            rect({ left: 700, top: 10, width: 600, height: 300 }),
        );
        vi.spyOn(sourceSpine!, "getBoundingClientRect").mockReturnValue(
            rect({ left: 100, top: 10, width: 32, height: 300 }),
        );
        vi.spyOn(composerDropZone!, "getBoundingClientRect").mockReturnValue(
            rect({ left: 120, top: 360, width: 520, height: 140 }),
        );

        defineElementMetric(tablist, "scrollLeft", 0);
        defineElementMetric(tablist, "clientWidth", 600);
        defineElementMetric(tablist, "scrollWidth", 1200);
        defineElementMetric(sourceColumn!, "offsetLeft", 0);
        defineElementMetric(sourceColumn!, "offsetWidth", 600);
        defineElementMetric(secondColumn!, "offsetLeft", 600);
        defineElementMetric(secondColumn!, "offsetWidth", 600);

        await act(async () => {
            dispatchPointerEvent(sourceSpine!, "pointerdown", {
                pointerId: 1,
                button: 0,
                buttons: 1,
                clientX: 116,
                clientY: 64,
                screenX: 116,
                screenY: 64,
            });
        });

        await flushPromises();

        await act(async () => {
            dispatchPointerEvent(sourceSpine!, "pointermove", {
                pointerId: 1,
                buttons: 1,
                clientX: 220,
                clientY: 404,
                screenX: 220,
                screenY: 404,
            });
            dispatchPointerEvent(window, "pointermove", {
                pointerId: 1,
                buttons: 1,
                clientX: 220,
                clientY: 404,
                screenX: 220,
                screenY: 404,
            });
        });

        await waitFor(() => {
            expect(sourceColumn).toHaveStyle({ opacity: "0.5" });
        });
        expect(composerShell!.style.boxShadow).toContain("color-mix");

        await act(async () => {
            dispatchPointerEvent(window, "pointerup", {
                pointerId: 1,
                buttons: 0,
                clientX: 220,
                clientY: 404,
                screenX: 220,
                screenY: 404,
            });
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
