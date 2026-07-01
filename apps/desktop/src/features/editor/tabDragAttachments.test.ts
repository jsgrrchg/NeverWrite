import { describe, expect, it, vi } from "vitest";
import {
    buildTabFileDragDetail,
    createWorkspaceTabExternalDragHandlers,
    resolveComposerDropTarget,
} from "./tabDragAttachments";
import type {
    ChatTab,
    FileTab,
    MapTab,
    NoteTab,
    PdfTab,
    ReviewTab,
} from "../../app/store/editorStore";
import { useVaultStore } from "../../app/store/vaultStore";

describe("buildTabFileDragDetail", () => {
    it("builds a note mention payload for note tabs", () => {
        const tab: NoteTab = {
            id: "note-1",
            kind: "note",
            noteId: "notes/daily.md",
            title: "Daily",
            content: "",
            history: [],
            historyIndex: 0,
        };

        expect(
            buildTabFileDragDetail(tab, "move", { clientX: 24, clientY: 48 }),
        ).toEqual({
            phase: "move",
            x: 24,
            y: 48,
            notes: [
                {
                    id: "notes/daily.md",
                    title: "Daily",
                    path: "notes/daily.md",
                },
            ],
        });
    });

    it("prefers a resolved absolute note path when available", () => {
        const tab: NoteTab = {
            id: "note-1",
            kind: "note",
            noteId: "notes/daily.md",
            title: "Daily",
            content: "",
            history: [],
            historyIndex: 0,
        };

        expect(
            buildTabFileDragDetail(
                tab,
                "move",
                { clientX: 24, clientY: 48 },
                {
                    resolveNotePath: (noteId) =>
                        noteId === "notes/daily.md"
                            ? "/vault/notes/daily.md"
                            : null,
                },
            ),
        ).toEqual({
            phase: "move",
            x: 24,
            y: 48,
            notes: [
                {
                    id: "notes/daily.md",
                    title: "Daily",
                    path: "/vault/notes/daily.md",
                },
            ],
        });
    });

    it("uses the existing absolute path for pdf tabs", () => {
        const tab: PdfTab = {
            id: "pdf-1",
            kind: "pdf",
            entryId: "docs/spec.pdf",
            title: "Spec",
            path: "/vault/docs/spec.pdf",
            page: 1,
            zoom: 1,
            fitWidth: false,
            viewMode: "continuous",
            scrollTop: 0,
            scrollLeft: 0,
            history: [],
            historyIndex: 0,
        };

        expect(
            buildTabFileDragDetail(tab, "attach", { clientX: 10, clientY: 12 }),
        )?.toMatchObject({
            files: [
                {
                    filePath: "/vault/docs/spec.pdf",
                    fileName: "spec.pdf",
                    mimeType: "application/pdf",
                },
            ],
        });
    });

    it("uses the stored mime type for generic file tabs", () => {
        const tab: FileTab = {
            id: "file-1",
            kind: "file",
            relativePath: "data/report.csv",
            title: "Report",
            path: "/vault/data/report.csv",
            content: "",
            mimeType: "text/csv",
            viewer: "text",
            history: [],
            historyIndex: 0,
        };

        expect(
            buildTabFileDragDetail(tab, "start", { clientX: 1, clientY: 2 }),
        )?.toMatchObject({
            files: [
                {
                    filePath: "/vault/data/report.csv",
                    fileName: "report.csv",
                    mimeType: "text/csv",
                },
            ],
        });
    });

    it("resolves a vault-scoped absolute path for map tabs", () => {
        useVaultStore.setState({ vaultPath: "/vault" });
        const tab: MapTab = {
            id: "map-1",
            kind: "map",
            relativePath: "Excalidraw/Architecture.excalidraw",
            title: "Architecture",
            history: [],
            historyIndex: -1,
        };

        expect(
            buildTabFileDragDetail(tab, "move", { clientX: 3, clientY: 4 }),
        )?.toMatchObject({
            files: [
                {
                    filePath: "/vault/Excalidraw/Architecture.excalidraw",
                    fileName: "Architecture.excalidraw",
                    mimeType: "application/json",
                },
            ],
        });
    });

    it("ignores review tabs", () => {
        const tab: ReviewTab = {
            id: "review-1",
            kind: "ai-review",
            sessionId: "session-1",
            title: "Review",
        };

        expect(
            buildTabFileDragDetail(tab, "move", { clientX: 5, clientY: 6 }),
        ).toBeNull();
    });

    it("ignores chat tabs", () => {
        const tab: ChatTab = {
            id: "chat-1",
            kind: "ai-chat",
            sessionId: "session-1",
            title: "Chat",
        };

        expect(
            buildTabFileDragDetail(tab, "move", { clientX: 5, clientY: 6 }),
        ).toBeNull();
    });
});

describe("resolveComposerDropTarget", () => {
    it("returns composer when the pointer is over a composer drop zone", () => {
        document.body.innerHTML =
            '<div data-ai-composer-drop-zone="true"></div>';
        const dropZone = document.querySelector(
            '[data-ai-composer-drop-zone="true"]',
        ) as HTMLElement;

        dropZone.getBoundingClientRect = () =>
            ({
                left: 100,
                top: 200,
                right: 340,
                bottom: 320,
                width: 240,
                height: 120,
                x: 100,
                y: 200,
                toJSON: () => ({}),
            }) as DOMRect;

        expect(resolveComposerDropTarget(180, 240)).toEqual({
            type: "composer",
        });
    });

    it("returns none when the pointer is outside composer drop zones", () => {
        document.body.innerHTML =
            '<div data-ai-composer-drop-zone="true"></div>';
        const dropZone = document.querySelector(
            '[data-ai-composer-drop-zone="true"]',
        ) as HTMLElement;

        dropZone.getBoundingClientRect = () =>
            ({
                left: 100,
                top: 200,
                right: 340,
                bottom: 320,
                width: 240,
                height: 120,
                x: 100,
                y: 200,
                toJSON: () => ({}),
            }) as DOMRect;

        expect(resolveComposerDropTarget(24, 48)).toEqual({
            type: "none",
        });
    });
});

describe("createWorkspaceTabExternalDragHandlers", () => {
    it("resolves composer before delegating to detach targets", () => {
        document.body.innerHTML =
            '<div data-ai-composer-drop-zone="true"></div>';
        const dropZone = document.querySelector(
            '[data-ai-composer-drop-zone="true"]',
        ) as HTMLElement;
        let detachResolverCalled = false;

        dropZone.getBoundingClientRect = () =>
            ({
                left: 100,
                top: 200,
                right: 340,
                bottom: 320,
                width: 240,
                height: 120,
                x: 100,
                y: 200,
                toJSON: () => ({}),
            }) as DOMRect;

        const handlers = createWorkspaceTabExternalDragHandlers({
            getTabById: () => null,
            resolveDetachDropTarget: () => {
                detachResolverCalled = true;
                return { type: "detach-window" };
            },
        });

        expect(
            handlers.resolveExternalDropTarget("note-1", {
                clientX: 180,
                clientY: 240,
            }),
        ).toEqual({ type: "composer" });
        expect(detachResolverCalled).toBe(false);
    });

    it("falls back to detach resolution outside composer zones", () => {
        document.body.innerHTML = "";
        const handlers = createWorkspaceTabExternalDragHandlers({
            getTabById: () => null,
            resolveDetachDropTarget: () => ({ type: "detach-window" }),
        });

        expect(
            handlers.resolveExternalDropTarget("note-1", {
                clientX: -80,
                clientY: 12,
            }),
        ).toEqual({ type: "detach-window" });
    });

    it("builds attachment details from a tab id and resolved vault note path", () => {
        const tab: NoteTab = {
            id: "note-1",
            kind: "note",
            noteId: "notes/daily.md",
            title: "Daily",
            content: "",
            history: [],
            historyIndex: 0,
        };
        useVaultStore.setState({
            notes: [
                {
                    id: "notes/daily.md",
                    title: "Daily",
                    path: "/vault/notes/daily.md",
                    modified_at: 1,
                    created_at: 1,
                },
            ],
        });

        const handlers = createWorkspaceTabExternalDragHandlers({
            getTabById: (tabId) => (tabId === tab.id ? tab : null),
        });

        expect(
            handlers.buildAttachmentDetail("note-1", "end", {
                clientX: 16,
                clientY: 32,
            }),
        ).toEqual({
            phase: "end",
            x: 16,
            y: 32,
            notes: [
                {
                    id: "notes/daily.md",
                    title: "Daily",
                    path: "/vault/notes/daily.md",
                },
            ],
        });
    });

    it("returns null attachment details for missing tabs", () => {
        const handlers = createWorkspaceTabExternalDragHandlers({
            getTabById: () => null,
        });

        expect(
            handlers.buildAttachmentDetail("missing", "end", {
                clientX: 16,
                clientY: 32,
            }),
        ).toBeNull();
    });

    it("commits only detach-window external drops", () => {
        const commitDetachDrop = vi.fn();
        const handlers = createWorkspaceTabExternalDragHandlers({
            getTabById: () => null,
            commitDetachDrop,
        });
        const coords = {
            clientX: -80,
            clientY: 12,
            screenX: 400,
            screenY: 120,
        };

        handlers.onCommitExternalDrop("note-1", { type: "composer" }, coords);
        expect(commitDetachDrop).not.toHaveBeenCalled();

        handlers.onCommitExternalDrop(
            "note-1",
            { type: "detach-window" },
            coords,
        );
        expect(commitDetachDrop).toHaveBeenCalledWith("note-1", coords);
    });
});
