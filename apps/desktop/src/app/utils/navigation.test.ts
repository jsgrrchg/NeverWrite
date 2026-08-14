import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultLayoutState, useLayoutStore } from "../store/layoutStore";
import { REVEAL_NOTE_IN_TREE_EVENT, revealNoteInTree } from "./navigation";

describe("revealNoteInTree", () => {
    beforeEach(() => {
        useLayoutStore.setState({
            ...createDefaultLayoutState(),
            rightPanelExpanded: false,
        });
    });

    it("opens Files on its current side before dispatching the reveal", () => {
        const frames: FrameRequestCallback[] = [];
        vi.spyOn(window, "requestAnimationFrame").mockImplementation(
            (callback) => {
                frames.push(callback);
                return frames.length;
            },
        );
        useLayoutStore.getState().moveSidebarView("files", "right");
        useLayoutStore.setState({
            rightPanelCollapsed: true,
            activeSidebarView: { left: "tags", right: "outline" },
        });
        const listener = vi.fn();
        window.addEventListener(REVEAL_NOTE_IN_TREE_EVENT, listener);

        revealNoteInTree("note-1");
        expect(useLayoutStore.getState()).toMatchObject({
            rightPanelCollapsed: false,
            activeSidebarView: { left: "tags", right: "files" },
        });
        expect(listener).not.toHaveBeenCalled();
        frames[0](0);
        expect(listener).toHaveBeenCalledTimes(1);
        expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({
            noteId: "note-1",
        });
        window.removeEventListener(REVEAL_NOTE_IN_TREE_EVENT, listener);
    });
});
