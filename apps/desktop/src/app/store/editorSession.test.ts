import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
    buildPersistedSession,
    getEditorSessionKey,
    restorePersistedSession,
} from "./editorSession";
import { normalizeHistoryTab } from "./editorTabRegistry";
import { safeStorageClear } from "../utils/safeStorage";
import { useVaultStore } from "./vaultStore";

vi.mock("@tauri-apps/api/core", () => ({
    invoke: vi.fn(),
}));

describe("editorSession", () => {
    beforeEach(() => {
        safeStorageClear();
        localStorage.clear();
        useVaultStore.setState({ vaultPath: "/vaults/project-alpha" });
    });

    afterEach(() => {
        vi.restoreAllMocks();
        safeStorageClear();
        localStorage.clear();
    });

    it("serializes persisted session state without review tab payloads", () => {
        const session = buildPersistedSession({
            tabs: [
                {
                    id: "note-1",
                    kind: "note",
                    noteId: "notes/a",
                    title: "Note A",
                    content: "Body A",
                    history: [
                        {
                            kind: "note",
                            noteId: "notes/a",
                            title: "Note A",
                            content: "Body A",
                        },
                    ],
                    historyIndex: 0,
                },
                {
                    id: "pdf-1",
                    kind: "pdf",
                    entryId: "docs/spec",
                    title: "spec.pdf",
                    path: "/vault/docs/spec.pdf",
                    page: 2,
                    zoom: 1.2,
                    viewMode: "single",
                    history: [
                        {
                            kind: "pdf",
                            entryId: "docs/spec",
                            title: "spec.pdf",
                            path: "/vault/docs/spec.pdf",
                            page: 2,
                            zoom: 1.2,
                            viewMode: "single",
                        },
                    ],
                    historyIndex: 0,
                },
                {
                    id: "file-1",
                    kind: "file",
                    relativePath: "src/main.ts",
                    title: "main.ts",
                    path: "/vault/src/main.ts",
                    content: "console.log('ok')",
                    mimeType: "text/typescript",
                    viewer: "text",
                    history: [
                        {
                            kind: "file",
                            relativePath: "src/main.ts",
                            title: "main.ts",
                            path: "/vault/src/main.ts",
                            content: "console.log('ok')",
                            mimeType: "text/typescript",
                            viewer: "text",
                        },
                    ],
                    historyIndex: 0,
                },
                {
                    id: "map-1",
                    kind: "map",
                    relativePath: "Excalidraw/Board.excalidraw",
                    title: "Board",
                    history: [],
                    historyIndex: -1,
                },
                {
                    id: "graph-1",
                    kind: "graph",
                    title: "Graph View",
                },
                {
                    id: "review-1",
                    kind: "ai-review",
                    sessionId: "review-session",
                    title: "Review",
                },
            ],
            activeTabId: "file-1",
        });

        expect(session.noteIds).toEqual([
            {
                noteId: "notes/a",
                title: "Note A",
                history: [{ noteId: "notes/a", title: "Note A" }],
                historyIndex: 0,
            },
        ]);
        expect(session.pdfTabs).toEqual([
            {
                entryId: "docs/spec",
                title: "spec.pdf",
                path: "/vault/docs/spec.pdf",
                page: 2,
                zoom: 1.2,
                viewMode: "single",
                history: [
                    {
                        entryId: "docs/spec",
                        title: "spec.pdf",
                        path: "/vault/docs/spec.pdf",
                        page: 2,
                        zoom: 1.2,
                        viewMode: "single",
                    },
                ],
                historyIndex: 0,
            },
        ]);
        expect(session.fileTabs).toEqual([
            {
                relativePath: "src/main.ts",
                title: "main.ts",
                path: "/vault/src/main.ts",
                mimeType: "text/typescript",
                viewer: "text",
                history: [
                    {
                        relativePath: "src/main.ts",
                        title: "main.ts",
                        path: "/vault/src/main.ts",
                        mimeType: "text/typescript",
                        viewer: "text",
                    },
                ],
                historyIndex: 0,
            },
        ]);
        expect(session.mapTabs).toEqual([
            {
                relativePath: "Excalidraw/Board.excalidraw",
                title: "Board",
            },
        ]);
        expect(session.hasGraphTab).toBe(true);
        expect(session.activeFilePath).toBe("src/main.ts");
        expect(session.activeTabId).toBe("file-1");
    });

    it("normalizes csv file tabs with the csv viewer by default", () => {
        const normalized = normalizeHistoryTab({
            id: "file-csv",
            kind: "file",
            relativePath: "data/report.csv",
            title: "report.csv",
            path: "/vault/data/report.csv",
            content: "name,amount\nAlice,10",
            mimeType: "text/csv",
        });

        expect(normalized).toMatchObject({
            kind: "file",
            relativePath: "data/report.csv",
            viewer: "csv",
            historyIndex: 0,
        });
        expect(normalized?.history).toEqual([
            expect.objectContaining({
                kind: "file",
                viewer: "csv",
            }),
        ]);
    });

    it("serializes csv file tabs preserving the csv viewer metadata", () => {
        const session = buildPersistedSession({
            tabs: [
                {
                    id: "file-csv",
                    kind: "file",
                    relativePath: "data/report.csv",
                    title: "report.csv",
                    path: "/vault/data/report.csv",
                    content: "name,amount\nAlice,10",
                    mimeType: "text/csv",
                    viewer: "csv",
                    sizeBytes: 2048,
                    contentTruncated: true,
                    history: [
                        {
                            kind: "file",
                            relativePath: "data/report.csv",
                            title: "report.csv",
                            path: "/vault/data/report.csv",
                            content: "name,amount\nAlice,10",
                            mimeType: "text/csv",
                            viewer: "csv",
                            sizeBytes: 2048,
                            contentTruncated: true,
                        },
                    ],
                    historyIndex: 0,
                },
            ],
            activeTabId: "file-csv",
        });

        expect(session.fileTabs).toEqual([
            {
                relativePath: "data/report.csv",
                title: "report.csv",
                path: "/vault/data/report.csv",
                mimeType: "text/csv",
                viewer: "csv",
                sizeBytes: 2048,
                contentTruncated: true,
                history: [
                    {
                        relativePath: "data/report.csv",
                        title: "report.csv",
                        path: "/vault/data/report.csv",
                        mimeType: "text/csv",
                        viewer: "csv",
                        sizeBytes: 2048,
                        contentTruncated: true,
                    },
                ],
                historyIndex: 0,
            },
        ]);
        expect(session.activeFilePath).toBe("data/report.csv");
    });

    it("restores legacy persisted sessions through the session module", async () => {
        localStorage.setItem(
            getEditorSessionKey("/vaults/project-alpha"),
            JSON.stringify({
                noteIds: [
                    {
                        noteId: "notes/a",
                        title: "Note A",
                        history: [{ noteId: "notes/a", title: "Note A" }],
                        historyIndex: 0,
                    },
                ],
                pdfTabs: [
                    {
                        entryId: "docs/spec",
                        title: "spec.pdf",
                        path: "/vault/docs/spec.pdf",
                        page: 3,
                        zoom: 1.5,
                        viewMode: "single",
                    },
                ],
                fileTabs: [
                    {
                        relativePath: "src/main.ts",
                        title: "main.ts",
                        path: "/vault/src/main.ts",
                        mimeType: "text/typescript",
                        viewer: "text",
                    },
                ],
                mapTabs: [
                    {
                        relativePath: "",
                        title: "Board",
                        filePath:
                            "/vaults/project-alpha/Excalidraw/Board.excalidraw",
                    },
                ],
                hasGraphTab: true,
                activeMapRelativePath: "Excalidraw/Board.excalidraw",
                activeNoteId: null,
            }),
        );

        vi.mocked(invoke).mockImplementation(async (command, args) => {
            if (command === "read_note") {
                expect(args).toMatchObject({
                    noteId: "notes/a",
                    vaultPath: "/vaults/project-alpha",
                });
                return { content: "Body A" };
            }
            if (command === "read_vault_file") {
                expect(args).toMatchObject({
                    relativePath: "src/main.ts",
                    vaultPath: "/vaults/project-alpha",
                });
                return { content: "console.log('ok')" };
            }
            throw new Error(`Unexpected command: ${command}`);
        });

        const restored = await restorePersistedSession(
            "/vaults/project-alpha",
            {
                includeMaps: true,
            },
        );

        expect(restored).not.toBeNull();
        expect(restored?.tabs.map((tab) => tab.kind ?? "note")).toEqual([
            "note",
            "pdf",
            "file",
            "map",
            "graph",
        ]);
        expect(restored?.tabs[0]).toMatchObject({
            kind: "note",
            noteId: "notes/a",
            content: "Body A",
        });
        expect(restored?.tabs[1]).toMatchObject({
            kind: "pdf",
            entryId: "docs/spec",
            page: 3,
            zoom: 1.5,
            viewMode: "single",
        });
        expect(restored?.tabs[2]).toMatchObject({
            kind: "file",
            relativePath: "src/main.ts",
            content: "console.log('ok')",
        });
        expect(restored?.tabs[3]).toMatchObject({
            kind: "map",
            relativePath: "Excalidraw/Board.excalidraw",
        });
        expect(restored?.tabs[4]).toMatchObject({
            kind: "graph",
            title: "Graph View",
        });
        expect(restored?.activeTabId).toBe(restored?.tabs[3]?.id ?? null);
    });

    it("restores legacy csv file tabs with inferred viewer and file content", async () => {
        localStorage.setItem(
            getEditorSessionKey("/vaults/project-alpha"),
            JSON.stringify({
                noteIds: [],
                fileTabs: [
                    {
                        relativePath: "data/report.csv",
                        title: "report.csv",
                        path: "/vault/data/report.csv",
                        mimeType: "text/csv",
                    },
                ],
                activeNoteId: null,
                activeFilePath: "data/report.csv",
            }),
        );

        vi.mocked(invoke).mockImplementation(async (command, args) => {
            if (command === "read_vault_file") {
                expect(args).toMatchObject({
                    relativePath: "data/report.csv",
                    vaultPath: "/vaults/project-alpha",
                });
                return { content: "name,amount\nAlice,10" };
            }
            throw new Error(`Unexpected command: ${command}`);
        });

        const restored = await restorePersistedSession("/vaults/project-alpha");

        expect(restored).not.toBeNull();
        expect(restored?.tabs).toHaveLength(1);
        expect(restored?.tabs[0]).toMatchObject({
            kind: "file",
            relativePath: "data/report.csv",
            viewer: "csv",
            content: "name,amount\nAlice,10",
        });
        expect(restored?.activeTabId).toBe(restored?.tabs[0]?.id ?? null);
    });

    it("restores legacy csv file tabs preserving explicit viewer metadata", async () => {
        localStorage.setItem(
            getEditorSessionKey("/vaults/project-alpha"),
            JSON.stringify({
                noteIds: [],
                fileTabs: [
                    {
                        relativePath: "data/report.csv",
                        title: "report.csv",
                        path: "/vault/data/report.csv",
                        mimeType: "text/csv",
                        viewer: "csv",
                        sizeBytes: 2048,
                        contentTruncated: true,
                        history: [
                            {
                                relativePath: "data/report.csv",
                                title: "report.csv",
                                path: "/vault/data/report.csv",
                                mimeType: "text/csv",
                                viewer: "csv",
                                sizeBytes: 2048,
                                contentTruncated: true,
                            },
                        ],
                        historyIndex: 0,
                    },
                ],
                activeNoteId: null,
                activeFilePath: "data/report.csv",
            }),
        );

        vi.mocked(invoke).mockImplementation(async (command, args) => {
            if (command === "read_vault_file") {
                expect(args).toMatchObject({
                    relativePath: "data/report.csv",
                    vaultPath: "/vaults/project-alpha",
                });
                return {
                    content: "name,amount\nAlice,10",
                    size_bytes: 2048,
                    content_truncated: true,
                };
            }
            throw new Error(`Unexpected command: ${command}`);
        });

        const restored = await restorePersistedSession("/vaults/project-alpha");

        expect(restored).not.toBeNull();
        expect(restored?.tabs).toHaveLength(1);
        expect(restored?.tabs[0]).toMatchObject({
            kind: "file",
            relativePath: "data/report.csv",
            viewer: "csv",
            content: "name,amount\nAlice,10",
            sizeBytes: 2048,
            contentTruncated: true,
            historyIndex: 0,
        });
        expect(restored?.tabs[0]).toMatchObject({
            history: [
                expect.objectContaining({
                    viewer: "csv",
                    content: "name,amount\nAlice,10",
                    sizeBytes: 2048,
                    contentTruncated: true,
                }),
            ],
        });
        expect(restored?.activeTabId).toBe(restored?.tabs[0]?.id ?? null);
    });
});
