import { describe, expect, it } from "vitest";
import { buildTabFileDragDetail } from "./tabDragAttachments";
import type {
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
            viewMode: "continuous",
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
});
