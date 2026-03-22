import { describe, expect, it } from "vitest";
import { buildTabFileDragDetail } from "./tabDragAttachments";
import type { FileTab, NoteTab, PdfTab, ReviewTab } from "../../app/store/editorStore";

describe("buildTabFileDragDetail", () => {
    it("builds a note mention payload for note tabs", () => {
        const tab: NoteTab = {
            id: "note-1",
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
