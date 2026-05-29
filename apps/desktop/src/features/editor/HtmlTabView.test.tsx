import { act, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { FileTab } from "../../app/store/editorStore";
import { useVaultStore } from "../../app/store/vaultStore";
import {
    AGENT_SIDEBAR_DRAG_EVENT,
    type AgentSidebarDragDetail,
} from "../ai/agentSidebarDragEvents";
import {
    FILE_TREE_NOTE_DRAG_EVENT,
    type FileTreeNoteDragDetail,
} from "../ai/dragEvents";
import { renderComponent } from "../../test/test-utils";
import { HtmlTabView } from "./HtmlTabView";

const tab: FileTab = {
    id: "html-tab",
    kind: "file",
    relativePath: "docs/preview.html",
    path: "/vault/docs/preview.html",
    title: "preview.html",
    content: "",
    mimeType: "text/html",
    viewer: "html",
    history: [],
    historyIndex: -1,
};

function getPreviewFrame() {
    return screen.getByTitle(tab.title) as HTMLIFrameElement;
}

function dispatchFileTreeDrag(
    phase: FileTreeNoteDragDetail["phase"],
    origin?: FileTreeNoteDragDetail["origin"],
) {
    act(() => {
        window.dispatchEvent(
            new CustomEvent<FileTreeNoteDragDetail>(
                FILE_TREE_NOTE_DRAG_EVENT,
                {
                    detail: {
                        phase,
                        x: 120,
                        y: 180,
                        notes: [],
                        files: [
                            {
                                filePath: "/vault/docs/source.md",
                                fileName: "source.md",
                                mimeType: "text/markdown",
                            },
                        ],
                        origin,
                    },
                },
            ),
        );
    });
}

function dispatchAgentDrag(phase: AgentSidebarDragDetail["phase"]) {
    act(() => {
        window.dispatchEvent(
            new CustomEvent<AgentSidebarDragDetail>(
                AGENT_SIDEBAR_DRAG_EVENT,
                {
                    detail: {
                        phase,
                        x: 140,
                        y: 200,
                        sessionId: "session-1",
                        title: "Draft agent",
                    },
                },
            ),
        );
    });
}

describe("HtmlTabView", () => {
    beforeEach(() => {
        useVaultStore.setState((state) => ({
            ...state,
            vaultPath: "/vault",
        }));
    });

    it("makes the iframe inert during file tree drags", () => {
        renderComponent(<HtmlTabView tab={tab} />);

        const frame = getPreviewFrame();
        expect(frame.style.pointerEvents).toBe("auto");

        dispatchFileTreeDrag("start");
        expect(frame.style.pointerEvents).toBe("none");

        dispatchFileTreeDrag("move");
        expect(frame.style.pointerEvents).toBe("none");

        dispatchFileTreeDrag("end");
        expect(frame.style.pointerEvents).toBe("auto");
    });

    it("makes the iframe inert during agent sidebar drags", () => {
        renderComponent(<HtmlTabView tab={tab} />);

        const frame = getPreviewFrame();
        expect(frame.style.pointerEvents).toBe("auto");

        dispatchAgentDrag("start");
        expect(frame.style.pointerEvents).toBe("none");

        dispatchAgentDrag("move");
        expect(frame.style.pointerEvents).toBe("none");

        dispatchAgentDrag("cancel");
        expect(frame.style.pointerEvents).toBe("auto");
    });

    it("keeps workspace-tab file drags from changing iframe pointer handling", () => {
        renderComponent(<HtmlTabView tab={tab} />);

        const frame = getPreviewFrame();
        dispatchFileTreeDrag("start", {
            kind: "workspace-tab",
            tabId: "file-tab",
        });

        expect(frame.style.pointerEvents).toBe("auto");
    });

    it("releases the iframe shield on global drag cancellation", () => {
        renderComponent(<HtmlTabView tab={tab} />);

        const frame = getPreviewFrame();
        dispatchAgentDrag("start");
        expect(frame.style.pointerEvents).toBe("none");

        act(() => {
            window.dispatchEvent(new Event("pointercancel"));
        });

        expect(frame.style.pointerEvents).toBe("auto");
    });
});
