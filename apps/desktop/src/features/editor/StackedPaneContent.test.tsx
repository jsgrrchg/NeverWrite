import { act, fireEvent, screen } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useEditorStore } from "../../app/store/editorStore";
import { renderComponent, setEditorTabs } from "../../test/test-utils";
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
    property: "clientWidth" | "scrollLeft",
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
});
