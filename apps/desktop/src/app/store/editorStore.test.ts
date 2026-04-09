import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    type FileViewerMode,
    isFileTab,
    isGraphTab,
    isMapTab,
    isNoteTab,
    isPdfTab,
    isReviewTab,
    markSessionReady,
    readPersistedSession,
    useEditorStore,
    type MapTab,
    type MapTabInput,
} from "./editorStore";
import { useSettingsStore } from "./settingsStore";
import { safeStorageClear } from "../utils/safeStorage";
import { useVaultStore } from "./vaultStore";

function makeTab(overrides: {
    id: string;
    noteId: string;
    title: string;
    content: string;
}) {
    return {
        ...overrides,
        kind: "note" as const,
        history: [
            {
                kind: "note" as const,
                noteId: overrides.noteId,
                title: overrides.title,
                content: overrides.content,
            },
        ],
        historyIndex: 0,
    };
}

function makeFileTab(overrides: {
    id: string;
    relativePath: string;
    title: string;
    path: string;
    content: string;
    mimeType: string | null;
    viewer: FileViewerMode;
}) {
    return {
        ...overrides,
        kind: "file" as const,
        history: [
            {
                kind: "file" as const,
                relativePath: overrides.relativePath,
                title: overrides.title,
                path: overrides.path,
                content: overrides.content,
                mimeType: overrides.mimeType,
                viewer: overrides.viewer,
            },
        ],
        historyIndex: 0,
    };
}

function makePdfTab(overrides: {
    id: string;
    entryId: string;
    title: string;
    path: string;
    page?: number;
    zoom?: number;
    viewMode?: "single" | "continuous";
}) {
    const page = overrides.page ?? 1;
    const zoom = overrides.zoom ?? 1;
    const viewMode = overrides.viewMode ?? "continuous";

    return {
        ...overrides,
        kind: "pdf" as const,
        page,
        zoom,
        viewMode,
        history: [
            {
                kind: "pdf" as const,
                entryId: overrides.entryId,
                title: overrides.title,
                path: overrides.path,
                page,
                zoom,
                viewMode,
            },
        ],
        historyIndex: 0,
    };
}

function makeMapTab(overrides: {
    id: string;
    relativePath: string;
    title: string;
}) {
    return {
        ...overrides,
        kind: "map" as const,
        history: [],
        historyIndex: -1,
    };
}

beforeEach(() => {
    safeStorageClear();
    localStorage.clear();
    useEditorStore.setState({
        tabs: [],
        activeTabId: null,
        recentlyClosedTabs: [],
        activationHistory: [],
        tabNavigationHistory: [],
        tabNavigationIndex: -1,
        pendingReveal: null,
        pendingSelectionReveal: null,
        currentSelection: null,
        _pendingForceReloads: new Set(),
        _pendingForceFileReloads: new Set(),
        _noteReloadVersions: {},
        _fileReloadVersions: {},
        _noteReloadMetadata: {},
        _fileReloadMetadata: {},
        dirtyTabIds: new Set(),
        noteExternalConflicts: new Set(),
        fileExternalConflicts: new Set(),
    });
    useSettingsStore.getState().reset();
    useVaultStore.setState({ vaultPath: null });
});

afterEach(() => {
    vi.restoreAllMocks();
    safeStorageClear();
    localStorage.clear();
});

describe("editorStore session persistence", () => {
    it("persists open tabs per vault path", async () => {
        markSessionReady();
        useVaultStore.setState({ vaultPath: "/vaults/geo-2026" });

        useEditorStore.setState({
            tabs: [
                makeTab({
                    id: "tab-1",
                    noteId: "notes/uk",
                    title: "UK",
                    content: "content",
                }),
            ],
            activeTabId: "tab-1",
        });

        // Wait for debounced persistence (500ms)
        await new Promise((r) => setTimeout(r, 600));

        const session = readPersistedSession("/vaults/geo-2026");
        expect(session).not.toBeNull();
        expect(session!.noteIds[0].noteId).toBe("notes/uk");
        expect(session!.activeNoteId).toBe("notes/uk");
    });

    it("persists pdf view mode per vault path", async () => {
        markSessionReady();
        useVaultStore.setState({ vaultPath: "/vaults/pdfs-2026" });

        useEditorStore.setState({
            tabs: [
                makePdfTab({
                    id: "pdf-tab-1",
                    entryId: "reports/q1",
                    title: "Quarterly Report",
                    path: "/vaults/pdfs-2026/reports/q1.pdf",
                    page: 2,
                    viewMode: "continuous",
                }),
            ],
            activeTabId: "pdf-tab-1",
        });

        await new Promise((resolve) => setTimeout(resolve, 600));

        const session = readPersistedSession("/vaults/pdfs-2026");
        expect(session?.pdfTabs?.[0]).toMatchObject({
            entryId: "reports/q1",
            viewMode: "continuous",
        });
        expect(session?.activePdfEntryId).toBe("reports/q1");
    });

    it("persists file viewer mode per vault path", async () => {
        markSessionReady();
        useVaultStore.setState({ vaultPath: "/vaults/assets-2026" });

        useEditorStore.setState({
            tabs: [
                makeFileTab({
                    id: "file-tab-1",
                    relativePath: "assets/cover.avif",
                    title: "cover.avif",
                    path: "/vaults/assets-2026/assets/cover.avif",
                    mimeType: "image/avif",
                    viewer: "image",
                    content: "",
                }),
            ],
            activeTabId: "file-tab-1",
        });

        await new Promise((resolve) => setTimeout(resolve, 600));

        const session = readPersistedSession("/vaults/assets-2026");
        expect(session?.fileTabs?.[0]).toMatchObject({
            relativePath: "assets/cover.avif",
            viewer: "image",
        });
        expect(session?.activeFilePath).toBe("assets/cover.avif");
        expect(session?.tabs).toBeUndefined();
        expect(session?.fileTabs?.[0]).not.toHaveProperty("content");
    });

    it("persists csv file viewer mode per vault path", async () => {
        markSessionReady();
        useVaultStore.setState({ vaultPath: "/vaults/data-2026" });

        useEditorStore.setState({
            tabs: [
                makeFileTab({
                    id: "file-tab-csv",
                    relativePath: "data/report.csv",
                    title: "report.csv",
                    path: "/vaults/data-2026/data/report.csv",
                    mimeType: "text/csv",
                    viewer: "csv",
                    content: "name,amount\nAlice,10",
                }),
            ],
            activeTabId: "file-tab-csv",
        });

        await new Promise((resolve) => setTimeout(resolve, 600));

        const session = readPersistedSession("/vaults/data-2026");
        expect(session?.fileTabs?.[0]).toMatchObject({
            relativePath: "data/report.csv",
            viewer: "csv",
            mimeType: "text/csv",
        });
        expect(session?.activeFilePath).toBe("data/report.csv");
        expect(session?.tabs).toBeUndefined();
        expect(session?.fileTabs?.[0]).not.toHaveProperty("content");
    });

    it("persists map tabs by relative path", async () => {
        markSessionReady();
        useVaultStore.setState({ vaultPath: "/vaults/maps-2026" });

        useEditorStore.setState({
            tabs: [
                makeMapTab({
                    id: "map-tab-1",
                    relativePath: "Excalidraw/Architecture.excalidraw",
                    title: "Architecture",
                }),
            ],
            activeTabId: "map-tab-1",
        });

        await new Promise((resolve) => setTimeout(resolve, 600));

        const session = readPersistedSession("/vaults/maps-2026");
        expect(session?.mapTabs?.[0]).toMatchObject({
            relativePath: "Excalidraw/Architecture.excalidraw",
            title: "Architecture",
        });
        expect(session?.activeMapRelativePath).toBe(
            "Excalidraw/Architecture.excalidraw",
        );
        expect(session?.mapTabs?.[0]).not.toHaveProperty("filePath");
    });

    it("does not persist note contents in the top-level session payload", async () => {
        markSessionReady();
        useVaultStore.setState({ vaultPath: "/vaults/lean-2026" });

        useEditorStore.setState({
            tabs: [
                makeTab({
                    id: "tab-1",
                    noteId: "notes/large",
                    title: "Large",
                    content: "x".repeat(20_000),
                }),
            ],
            activeTabId: "tab-1",
        });

        await new Promise((resolve) => setTimeout(resolve, 600));

        const session = readPersistedSession("/vaults/lean-2026");
        expect(session?.tabs).toBeUndefined();
        expect(session?.noteIds?.[0]).toMatchObject({
            noteId: "notes/large",
            title: "Large",
        });
    });

    it("persists note renames that only affect inactive history entries", async () => {
        markSessionReady();
        useVaultStore.setState({ vaultPath: "/vaults/history-rename-2026" });

        useEditorStore.setState({
            tabs: [
                {
                    id: "note-history-tab",
                    kind: "note",
                    noteId: "notes/current",
                    title: "Current",
                    content: "current body",
                    history: [
                        {
                            kind: "note",
                            noteId: "notes/old",
                            title: "Old title",
                            content: "old body",
                        },
                        {
                            kind: "note",
                            noteId: "notes/current",
                            title: "Current",
                            content: "current body",
                        },
                    ],
                    historyIndex: 1,
                },
            ],
            activeTabId: "note-history-tab",
        });

        await new Promise((resolve) => setTimeout(resolve, 600));

        useEditorStore
            .getState()
            .handleNoteRenamed("notes/old", "notes/renamed", "Renamed");

        await new Promise((resolve) => setTimeout(resolve, 600));

        const session = readPersistedSession("/vaults/history-rename-2026");
        expect(session?.noteIds?.[0]).toEqual({
            noteId: "notes/current",
            title: "Current",
            history: [
                { noteId: "notes/renamed", title: "Renamed" },
                { noteId: "notes/current", title: "Current" },
            ],
            historyIndex: 1,
        });
    });

    it("swallows storage quota errors while persisting", async () => {
        markSessionReady();
        useVaultStore.setState({ vaultPath: "/vaults/quota-2026" });

        const quotaError = new DOMException(
            "Quota exceeded",
            "QuotaExceededError",
        );
        const setItemMock = vi.fn(() => {
            throw quotaError;
        });
        const originalSetItem = window.localStorage.setItem;
        Object.defineProperty(window.localStorage, "setItem", {
            configurable: true,
            value: setItemMock,
        });
        const warnSpy = vi
            .spyOn(console, "warn")
            .mockImplementation(() => undefined);
        try {
            useEditorStore.setState({
                tabs: [
                    makeTab({
                        id: "tab-1",
                        noteId: "notes/quota",
                        title: "Quota",
                        content: "content",
                    }),
                ],
                activeTabId: "tab-1",
            });

            await new Promise((resolve) => setTimeout(resolve, 600));

            expect(setItemMock).toHaveBeenCalled();
            expect(warnSpy).toHaveBeenCalledWith(
                "[safe-storage] Failed to persist safe storage item",
                {
                    key: "neverwrite.session.tabs:/vaults/quota-2026",
                },
            );
        } finally {
            Object.defineProperty(window.localStorage, "setItem", {
                configurable: true,
                value: originalSetItem,
            });
        }
    });

    it("falls back to the legacy global session key when needed", () => {
        localStorage.setItem(
            "neverwrite.session.tabs",
            JSON.stringify({
                noteIds: [{ noteId: "notes/legacy", title: "Legacy" }],
                activeNoteId: "notes/legacy",
            }),
        );

        expect(readPersistedSession("/vaults/migrated")).toEqual({
            noteIds: [{ noteId: "notes/legacy", title: "Legacy" }],
            activeNoteId: "notes/legacy",
        });
    });
});

describe("editorStore map tabs", () => {
    beforeEach(() => {
        useVaultStore.setState({ vaultPath: "/vaults/maps-2026" });
    });

    it("deduplicates map tabs by relative path", () => {
        const store = useEditorStore.getState();

        store.openMap("Excalidraw/Architecture.excalidraw", "Architecture");
        store.openMap("Excalidraw/Architecture.excalidraw", "Architecture");

        const mapTabs = useEditorStore
            .getState()
            .tabs.filter((tab): tab is MapTab => isMapTab(tab));
        expect(mapTabs).toHaveLength(1);
        expect(mapTabs[0]?.relativePath).toBe(
            "Excalidraw/Architecture.excalidraw",
        );
    });

    it("hydrates legacy map tabs from an absolute file path inside the active vault", () => {
        const legacyMapTabs = [
            {
                id: "map-1",
                kind: "map" as const,
                title: "Legacy",
                relativePath: "",
                filePath: "/vaults/maps-2026/Excalidraw/Legacy.excalidraw",
            },
        ] satisfies Array<MapTabInput & { filePath: string }>;

        useEditorStore
            .getState()
            .hydrateTabs(legacyMapTabs as unknown as MapTabInput[], "map-1");

        const activeTab = useEditorStore
            .getState()
            .tabs.find((tab) => tab.id === "map-1");
        expect(activeTab && isMapTab(activeTab)).toBe(true);
        expect(activeTab && isMapTab(activeTab) && activeTab.relativePath).toBe(
            "Excalidraw/Legacy.excalidraw",
        );
    });
});

describe("editorStore hydration and external insertion", () => {
    beforeEach(() => {
        useVaultStore.setState({ vaultPath: "/vaults/project-alpha" });
    });

    it("hydrates mixed persisted tabs, drops review tabs, and keeps the requested active tab", () => {
        useEditorStore.getState().hydrateTabs(
            [
                {
                    id: "note-1",
                    noteId: "notes/alpha",
                    title: "Alpha",
                    content: "Alpha body",
                    history: [{ noteId: "notes/alpha", title: "Alpha" }],
                    historyIndex: 0,
                },
                {
                    id: "pdf-1",
                    kind: "pdf",
                    entryId: "docs/spec",
                    title: "spec.pdf",
                    path: "/vault/docs/spec.pdf",
                    history: [
                        {
                            entryId: "docs/spec",
                            title: "spec.pdf",
                            path: "/vault/docs/spec.pdf",
                        },
                    ],
                    historyIndex: 0,
                },
                {
                    id: "file-1",
                    kind: "file",
                    relativePath: "src/app.ts",
                    title: "app.ts",
                    path: "/vault/src/app.ts",
                    content: "console.log('ok')",
                    mimeType: "text/typescript",
                    viewer: "text",
                    history: [
                        {
                            relativePath: "src/app.ts",
                            title: "app.ts",
                            path: "/vault/src/app.ts",
                            mimeType: "text/typescript",
                            viewer: "text",
                        },
                    ],
                    historyIndex: 0,
                },
                {
                    id: "map-1",
                    kind: "map",
                    title: "Board",
                    relativePath: "",
                    filePath:
                        "/vaults/project-alpha/Excalidraw/Board.excalidraw",
                } as MapTabInput & { filePath: string },
                {
                    id: "review-1",
                    kind: "ai-review",
                    sessionId: "session-1",
                    title: "Review",
                },
                {
                    id: "graph-1",
                    kind: "graph",
                    title: "Graph View",
                },
            ],
            "graph-1",
        );

        const state = useEditorStore.getState();
        expect(state.tabs).toHaveLength(5);
        expect(state.tabs.some((tab) => isReviewTab(tab))).toBe(false);
        expect(state.activeTabId).toBe("graph-1");
        expect(state.tabs.find((tab) => tab.id === "note-1")).toMatchObject({
            kind: "note",
            historyIndex: 0,
        });
        expect(state.tabs.find((tab) => tab.id === "pdf-1")).toMatchObject({
            kind: "pdf",
            page: 1,
            zoom: 1,
            viewMode: "continuous",
        });
        expect(state.tabs.find((tab) => tab.id === "file-1")).toMatchObject({
            kind: "file",
            content: "console.log('ok')",
        });
        expect(state.tabs.find((tab) => tab.id === "map-1")).toMatchObject({
            kind: "map",
            relativePath: "Excalidraw/Board.excalidraw",
        });
        expect(state.tabs.find((tab) => tab.id === "graph-1")).toMatchObject({
            kind: "graph",
            title: "Graph View",
        });
    });

    it("normalizes external tabs by kind and activates the inserted tab", () => {
        useEditorStore.setState({
            tabs: [
                makeTab({
                    id: "note-a",
                    noteId: "notes/a",
                    title: "A",
                    content: "A",
                }),
            ],
            activeTabId: "note-a",
            activationHistory: ["note-a"],
            tabNavigationHistory: ["note-a"],
            tabNavigationIndex: 0,
        });

        useEditorStore.getState().insertExternalTab(
            {
                id: "file-1",
                kind: "file",
                relativePath: "src/server.ts",
                title: "server.ts",
                path: "/vault/src/server.ts",
                content: "export {}",
                mimeType: "text/typescript",
                viewer: "text",
                history: [
                    {
                        relativePath: "src/server.ts",
                        title: "server.ts",
                        path: "/vault/src/server.ts",
                        mimeType: "text/typescript",
                        viewer: "text",
                    },
                ],
                historyIndex: 0,
            },
            0,
        );

        let state = useEditorStore.getState();
        expect(state.tabs.map((tab) => tab.id)).toEqual(["file-1", "note-a"]);
        expect(state.activeTabId).toBe("file-1");
        expect(state.tabs[0]).toMatchObject({
            kind: "file",
            content: "export {}",
        });

        useEditorStore.getState().insertExternalTab({
            id: "review-1",
            kind: "ai-review",
            sessionId: "session-1",
            title: "Review",
        });

        state = useEditorStore.getState();
        expect(state.tabs[state.tabs.length - 1]).toMatchObject({
            id: "review-1",
            kind: "ai-review",
        });
        expect(state.activeTabId).toBe("review-1");

        useEditorStore.getState().insertExternalTab({
            id: "graph-1",
            kind: "graph",
            title: "Graph View",
        });

        state = useEditorStore.getState();
        expect(state.tabs[state.tabs.length - 1]).toMatchObject({
            id: "graph-1",
            kind: "graph",
        });
        expect(state.activeTabId).toBe("graph-1");
    });

    it("preserves graph singleton when inserting an external graph tab", () => {
        useEditorStore.setState({
            tabs: [
                {
                    id: "graph-existing",
                    kind: "graph",
                    title: "Graph View",
                },
            ],
            activeTabId: "graph-existing",
            activationHistory: ["graph-existing"],
            tabNavigationHistory: ["graph-existing"],
            tabNavigationIndex: 0,
        });

        useEditorStore.getState().insertExternalTab({
            id: "graph-new",
            kind: "graph",
            title: "Knowledge Graph",
        });

        const state = useEditorStore.getState();
        const graphTabs = state.tabs.filter((tab) => isGraphTab(tab));
        expect(graphTabs).toHaveLength(1);
        expect(graphTabs[0]).toMatchObject({
            id: "graph-existing",
            title: "Knowledge Graph",
        });
        expect(state.activeTabId).toBe("graph-existing");
    });

    it("skips invalid external map tabs that cannot resolve a relative path", () => {
        useEditorStore.getState().insertExternalTab({
            id: "map-invalid",
            kind: "map",
            title: "Broken map",
            relativePath: "",
        });

        expect(useEditorStore.getState().tabs).toEqual([]);
        expect(useEditorStore.getState().activeTabId).toBeNull();
    });
});

describe("editorStore navigation history", () => {
    beforeEach(() => {
        useSettingsStore.getState().setSetting("tabOpenBehavior", "new_tab");
    });

    it("openNote always creates a new tab", () => {
        useEditorStore.setState({
            tabs: [
                makeTab({
                    id: "tab-a",
                    noteId: "notes/source",
                    title: "Source",
                    content: "source",
                }),
            ],
            activeTabId: "tab-a",
            tabNavigationHistory: ["tab-a"],
            tabNavigationIndex: 0,
        });

        useEditorStore.getState().openNote("notes/linked", "Linked", "linked");

        const { tabs, activeTabId } = useEditorStore.getState();
        const openedTab = tabs[1];
        expect(tabs).toHaveLength(2);
        expect(isNoteTab(openedTab) ? openedTab.noteId : null).toBe(
            "notes/linked",
        );
        expect(isNoteTab(openedTab) ? openedTab.content : null).toBe("linked");
        expect(openedTab?.id).toBe(activeTabId);
    });

    it("openNote records tab navigation history", () => {
        useEditorStore.setState({
            tabs: [
                makeTab({
                    id: "tab-a",
                    noteId: "notes/first",
                    title: "First",
                    content: "first",
                }),
            ],
            activeTabId: "tab-a",
            tabNavigationHistory: ["tab-a"],
            tabNavigationIndex: 0,
        });

        useEditorStore.getState().openNote("notes/second", "Second", "second");

        const { tabs, tabNavigationHistory, tabNavigationIndex } =
            useEditorStore.getState();
        expect(tabs).toHaveLength(2);
        expect(tabNavigationHistory).toEqual(["tab-a", tabs[1].id]);
        expect(tabNavigationIndex).toBe(1);
    });

    it("openNote creates a new tab even when the active tab already shows the note", () => {
        useEditorStore.setState({
            tabs: [
                makeTab({
                    id: "tab-a",
                    noteId: "notes/same",
                    title: "Same",
                    content: "same",
                }),
            ],
            activeTabId: "tab-a",
            tabNavigationHistory: ["tab-a"],
            tabNavigationIndex: 0,
        });

        useEditorStore.getState().openNote("notes/same", "Same", "same");

        const { tabs, activeTabId } = useEditorStore.getState();
        const openedTab = tabs[1];
        expect(tabs).toHaveLength(2);
        expect(isNoteTab(openedTab) ? openedTab.noteId : null).toBe(
            "notes/same",
        );
        expect(activeTabId).toBe(openedTab?.id);
    });

    it("openNote creates a new tab when no tabs exist", () => {
        useEditorStore.getState().openNote("notes/new", "New", "new");

        const { tabs, activeTabId } = useEditorStore.getState();
        const openedTab = tabs[0];
        expect(tabs).toHaveLength(1);
        expect(isNoteTab(openedTab) ? openedTab.noteId : null).toBe(
            "notes/new",
        );
        expect(activeTabId).toBe(openedTab?.id);
    });

    it("goBack restores the previous tab", () => {
        useEditorStore.setState({
            tabs: [
                makeTab({
                    id: "tab-a",
                    noteId: "notes/first",
                    title: "First",
                    content: "first",
                }),
            ],
            activeTabId: "tab-a",
            tabNavigationHistory: ["tab-a"],
            tabNavigationIndex: 0,
        });

        useEditorStore.getState().openNote("notes/second", "Second", "second");
        useEditorStore.getState().goBack();

        const { activeTabId, tabNavigationIndex } = useEditorStore.getState();
        expect(activeTabId).toBe("tab-a");
        expect(tabNavigationIndex).toBe(0);
    });

    it("goForward restores the next tab", () => {
        useEditorStore.setState({
            tabs: [
                makeTab({
                    id: "tab-a",
                    noteId: "notes/first",
                    title: "First",
                    content: "first",
                }),
            ],
            activeTabId: "tab-a",
            tabNavigationHistory: ["tab-a"],
            tabNavigationIndex: 0,
        });

        useEditorStore.getState().openNote("notes/second", "Second", "second");
        const openedTabId = useEditorStore.getState().activeTabId;
        useEditorStore.getState().goBack();
        useEditorStore.getState().goForward();

        const { activeTabId, tabNavigationIndex } = useEditorStore.getState();
        expect(activeTabId).toBe(openedTabId);
        expect(tabNavigationIndex).toBe(1);
    });

    it("goBack is a no-op at the start of history", () => {
        useEditorStore.setState({
            tabs: [
                makeTab({
                    id: "tab-a",
                    noteId: "notes/only",
                    title: "Only",
                    content: "only",
                }),
            ],
            activeTabId: "tab-a",
            tabNavigationHistory: ["tab-a"],
            tabNavigationIndex: 0,
        });

        useEditorStore.getState().goBack();

        expect(useEditorStore.getState().activeTabId).toBe("tab-a");
    });

    it("opening a tab from the middle of navigation history truncates forward entries", () => {
        useEditorStore.setState({
            tabs: [
                makeTab({
                    id: "tab-a",
                    noteId: "notes/a",
                    title: "A",
                    content: "a",
                }),
            ],
            activeTabId: "tab-a",
            tabNavigationHistory: ["tab-a"],
            tabNavigationIndex: 0,
        });

        useEditorStore.getState().openNote("notes/b", "B", "b");
        useEditorStore.getState().openNote("notes/c", "C", "c");
        useEditorStore.getState().goBack(); // at B tab
        useEditorStore.getState().openNote("notes/d", "D", "d");

        const { tabs, tabNavigationHistory, tabNavigationIndex } =
            useEditorStore.getState();
        expect(tabs).toHaveLength(4);
        expect(tabNavigationHistory).toEqual(["tab-a", tabs[1].id, tabs[3].id]);
        expect(tabNavigationIndex).toBe(2);
    });

    it("openNote leaves each tab with a single-entry local history", () => {
        useEditorStore.setState({
            tabs: [
                makeTab({
                    id: "tab-a",
                    noteId: "notes/0",
                    title: "0",
                    content: "0",
                }),
            ],
            activeTabId: "tab-a",
            _noteReloadVersions: {},
            _noteReloadMetadata: {},
        });

        for (let i = 1; i <= 35; i++) {
            useEditorStore.getState().openNote(`notes/${i}`, `${i}`, `${i}`);
        }

        const { tabs, activeTabId } = useEditorStore.getState();
        const activeTab = tabs.find((tab) => tab.id === activeTabId);
        expect(tabs).toHaveLength(36);
        expect(activeTab).toMatchObject({
            noteId: "notes/35",
            historyIndex: 0,
        });
        expect(
            activeTab && "history" in activeTab ? activeTab.history : [],
        ).toHaveLength(1);
    });

    it("preserves edited content on the original tab when opening a new one", () => {
        useEditorStore.setState({
            tabs: [
                makeTab({
                    id: "tab-a",
                    noteId: "notes/first",
                    title: "First",
                    content: "original",
                }),
            ],
            activeTabId: "tab-a",
            tabNavigationHistory: ["tab-a"],
            tabNavigationIndex: 0,
        });

        // Simulate editing content
        useEditorStore.getState().updateTabContent("tab-a", "edited");

        // Navigate to new note
        useEditorStore.getState().openNote("notes/second", "Second", "second");

        // Go back — should return to the edited tab
        useEditorStore.getState().goBack();
        const tab = useEditorStore
            .getState()
            .tabs.find((t) => t.id === "tab-a");
        expect(tab && isNoteTab(tab) ? tab.content : null).toBe("edited");
        expect(useEditorStore.getState().activeTabId).toBe("tab-a");
    });

    it("openFile always creates a new tab", () => {
        useEditorStore.setState({
            tabs: [
                makeFileTab({
                    id: "file-tab-a",
                    relativePath: "src/alpha.ts",
                    title: "alpha.ts",
                    path: "/vault/src/alpha.ts",
                    content: "alpha",
                    mimeType: "text/typescript",
                    viewer: "text",
                }),
            ],
            activeTabId: "file-tab-a",
        });

        useEditorStore
            .getState()
            .openFile(
                "src/beta.ts",
                "beta.ts",
                "/vault/src/beta.ts",
                "beta",
                "text/typescript",
                "text",
            );

        const { tabs, activeTabId } = useEditorStore.getState();
        expect(tabs).toHaveLength(2);
        expect(tabs[1].id).toBe(activeTabId);
        expect(tabs[1]).toMatchObject({
            relativePath: "src/beta.ts",
            content: "beta",
            historyIndex: 0,
        });
    });

    it("goBack restores the previous file tab", () => {
        useEditorStore.setState({
            tabs: [
                makeFileTab({
                    id: "file-tab-a",
                    relativePath: "src/alpha.ts",
                    title: "alpha.ts",
                    path: "/vault/src/alpha.ts",
                    content: "alpha",
                    mimeType: "text/typescript",
                    viewer: "text",
                }),
            ],
            activeTabId: "file-tab-a",
            tabNavigationHistory: ["file-tab-a"],
            tabNavigationIndex: 0,
        });

        useEditorStore
            .getState()
            .openFile(
                "src/beta.ts",
                "beta.ts",
                "/vault/src/beta.ts",
                "beta",
                "text/typescript",
                "text",
            );
        const openedTabId = useEditorStore.getState().activeTabId;
        useEditorStore.getState().goBack();
        useEditorStore.getState().goForward();

        expect(useEditorStore.getState().activeTabId).toBe(openedTabId);
    });
});

describe("editorStore tab history mode", () => {
    it("openNote reuses the active tab and pushes note history by default", () => {
        useEditorStore.setState({
            tabs: [
                makeTab({
                    id: "tab-a",
                    noteId: "notes/source",
                    title: "Source",
                    content: "source",
                }),
            ],
            activeTabId: "tab-a",
        });

        useEditorStore.getState().openNote("notes/linked", "Linked", "linked");

        const { tabs, activeTabId } = useEditorStore.getState();
        expect(tabs).toHaveLength(1);
        expect(activeTabId).toBe("tab-a");
        expect(tabs[0]).toMatchObject({
            noteId: "notes/linked",
            title: "Linked",
            content: "linked",
            historyIndex: 1,
        });
        expect("history" in tabs[0] ? tabs[0].history : []).toEqual([
            {
                kind: "note",
                noteId: "notes/source",
                title: "Source",
                content: "source",
            },
            {
                kind: "note",
                noteId: "notes/linked",
                title: "Linked",
                content: "linked",
            },
        ]);
    });

    it("goBack and goForward navigate local note history in history mode", () => {
        useEditorStore.setState({
            tabs: [
                makeTab({
                    id: "tab-a",
                    noteId: "notes/source",
                    title: "Source",
                    content: "source",
                }),
            ],
            activeTabId: "tab-a",
        });

        useEditorStore.getState().openNote("notes/linked", "Linked", "linked");
        useEditorStore.getState().goBack();

        let tab = useEditorStore.getState().tabs[0];
        expect(tab).toMatchObject({
            noteId: "notes/source",
            historyIndex: 0,
        });

        useEditorStore.getState().goForward();

        tab = useEditorStore.getState().tabs[0];
        expect(tab).toMatchObject({
            noteId: "notes/linked",
            historyIndex: 1,
        });
    });

    it("openFile reuses the active file tab and pushes file history by default", () => {
        useEditorStore.setState({
            tabs: [
                makeFileTab({
                    id: "file-tab-a",
                    relativePath: "src/alpha.ts",
                    title: "alpha.ts",
                    path: "/vault/src/alpha.ts",
                    content: "alpha",
                    mimeType: "text/typescript",
                    viewer: "text",
                }),
            ],
            activeTabId: "file-tab-a",
        });

        useEditorStore
            .getState()
            .openFile(
                "src/beta.ts",
                "beta.ts",
                "/vault/src/beta.ts",
                "beta",
                "text/typescript",
                "text",
            );

        const tab = useEditorStore.getState().tabs[0];
        expect(useEditorStore.getState().tabs).toHaveLength(1);
        expect(tab).toMatchObject({
            relativePath: "src/beta.ts",
            title: "beta.ts",
            content: "beta",
            historyIndex: 1,
        });
        expect("history" in tab ? tab.history : []).toHaveLength(2);

        useEditorStore.getState().goBack();
        expect(useEditorStore.getState().tabs[0]).toMatchObject({
            relativePath: "src/alpha.ts",
            historyIndex: 0,
        });
    });

    it("handleFileDeleted removes deleted file entries from local file history", () => {
        useEditorStore.setState({
            tabs: [
                {
                    id: "file-tab-a",
                    kind: "file",
                    relativePath: "src/beta.ts",
                    title: "beta.ts",
                    path: "/vault/src/beta.ts",
                    content: "beta",
                    mimeType: "text/typescript",
                    viewer: "text",
                    history: [
                        {
                            kind: "file",
                            relativePath: "src/alpha.ts",
                            title: "alpha.ts",
                            path: "/vault/src/alpha.ts",
                            content: "alpha",
                            mimeType: "text/typescript",
                            viewer: "text",
                        },
                        {
                            kind: "file",
                            relativePath: "src/beta.ts",
                            title: "beta.ts",
                            path: "/vault/src/beta.ts",
                            content: "beta",
                            mimeType: "text/typescript",
                            viewer: "text",
                        },
                    ],
                    historyIndex: 1,
                },
            ],
            activeTabId: "file-tab-a",
        });

        useEditorStore.getState().handleFileDeleted("src/alpha.ts");

        const tab = useEditorStore.getState().tabs[0];
        expect(useEditorStore.getState().tabs).toHaveLength(1);
        expect(tab).toMatchObject({
            relativePath: "src/beta.ts",
            title: "beta.ts",
            historyIndex: 0,
        });
        expect("history" in tab ? tab.history : []).toEqual([
            {
                kind: "file",
                relativePath: "src/beta.ts",
                title: "beta.ts",
                path: "/vault/src/beta.ts",
                content: "beta",
                mimeType: "text/typescript",
                viewer: "text",
            },
        ]);

        useEditorStore.getState().goBack();
        expect(useEditorStore.getState().tabs[0]).toMatchObject({
            relativePath: "src/beta.ts",
            historyIndex: 0,
        });
    });

    it("handleNoteDeleted removes reload and conflict state even when the note is not open", () => {
        useEditorStore.setState({
            tabs: [
                makeTab({
                    id: "tab-b",
                    noteId: "notes/b",
                    title: "B",
                    content: "Body B",
                }),
            ],
            activeTabId: "tab-b",
            activationHistory: ["tab-b"],
            tabNavigationHistory: ["tab-b"],
            tabNavigationIndex: 0,
            _pendingForceReloads: new Set(["notes/a", "notes/b"]),
            _noteReloadVersions: {
                "notes/a": 2,
                "notes/b": 1,
            },
            _noteReloadMetadata: {
                "notes/a": {
                    origin: "external",
                    revision: 2,
                    opId: "external-2",
                    contentHash: null,
                },
                "notes/b": {
                    origin: "external",
                    revision: 1,
                    opId: "external-1",
                    contentHash: null,
                },
            },
            noteExternalConflicts: new Set(["notes/a"]),
        });

        useEditorStore.getState().handleNoteDeleted("notes/a");

        const state = useEditorStore.getState();
        expect(state.tabs).toHaveLength(1);
        expect(state.activeTabId).toBe("tab-b");
        expect(state._pendingForceReloads.has("notes/a")).toBe(false);
        expect(state._pendingForceReloads.has("notes/b")).toBe(true);
        expect(state._noteReloadVersions["notes/a"]).toBeUndefined();
        expect(state._noteReloadVersions["notes/b"]).toBe(1);
        expect(state._noteReloadMetadata["notes/a"]).toBeUndefined();
        expect(state._noteReloadMetadata["notes/b"]).toMatchObject({
            origin: "external",
            revision: 1,
            opId: "external-1",
        });
        expect(state.noteExternalConflicts.has("notes/a")).toBe(false);
    });

    it("handleNoteDeleted removes reload state and closes matching note tabs", () => {
        useEditorStore.setState({
            tabs: [
                makeTab({
                    id: "tab-a",
                    noteId: "notes/a",
                    title: "A",
                    content: "Body A",
                }),
                makeTab({
                    id: "tab-b",
                    noteId: "notes/b",
                    title: "B",
                    content: "Body B",
                }),
            ],
            activeTabId: "tab-a",
            activationHistory: ["tab-a", "tab-b"],
            tabNavigationHistory: ["tab-a"],
            tabNavigationIndex: 0,
            _pendingForceReloads: new Set(["notes/a"]),
            _noteReloadVersions: {
                "notes/a": 3,
            },
            _noteReloadMetadata: {
                "notes/a": {
                    origin: "agent",
                    revision: 3,
                    opId: "agent-3",
                    contentHash: null,
                },
            },
            noteExternalConflicts: new Set(["notes/a"]),
        });

        useEditorStore.getState().handleNoteDeleted("notes/a");

        const state = useEditorStore.getState();
        expect(state.tabs).toHaveLength(1);
        expect(state.tabs[0]).toMatchObject({
            id: "tab-b",
            noteId: "notes/b",
        });
        expect(state.activeTabId).toBe("tab-b");
        expect(state._pendingForceReloads.has("notes/a")).toBe(false);
        expect(state._noteReloadVersions["notes/a"]).toBeUndefined();
        expect(state._noteReloadMetadata["notes/a"]).toBeUndefined();
        expect(state.noteExternalConflicts.has("notes/a")).toBe(false);
    });

    it("openPdf reuses the active pdf tab and restores pdf state through history", () => {
        useEditorStore.setState({
            tabs: [
                makePdfTab({
                    id: "pdf-tab-a",
                    entryId: "docs/alpha",
                    title: "alpha.pdf",
                    path: "/vault/docs/alpha.pdf",
                    page: 3,
                    zoom: 1.5,
                    viewMode: "single",
                }),
            ],
            activeTabId: "pdf-tab-a",
        });

        useEditorStore
            .getState()
            .openPdf("docs/beta", "beta.pdf", "/vault/docs/beta.pdf");

        let tab = useEditorStore.getState().tabs[0];
        expect(useEditorStore.getState().tabs).toHaveLength(1);
        expect(tab).toMatchObject({
            entryId: "docs/beta",
            title: "beta.pdf",
            path: "/vault/docs/beta.pdf",
            page: 1,
            zoom: 1,
            viewMode: "continuous",
            historyIndex: 1,
        });

        useEditorStore.getState().goBack();

        tab = useEditorStore.getState().tabs[0];
        expect(tab).toMatchObject({
            entryId: "docs/alpha",
            title: "alpha.pdf",
            path: "/vault/docs/alpha.pdf",
            page: 3,
            zoom: 1.5,
            viewMode: "single",
            historyIndex: 0,
        });
    });

    it("openFile reuses the active note tab and keeps mixed history in one tab", () => {
        useEditorStore.setState({
            tabs: [
                makeTab({
                    id: "tab-a",
                    noteId: "notes/source",
                    title: "Source",
                    content: "source",
                }),
            ],
            activeTabId: "tab-a",
        });

        useEditorStore
            .getState()
            .openFile(
                "config/app.toml",
                "app.toml",
                "/vault/config/app.toml",
                "name = 'NeverWrite'",
                "application/toml",
                "text",
            );

        let tab = useEditorStore.getState().tabs[0];
        expect(useEditorStore.getState().tabs).toHaveLength(1);
        expect(tab).toMatchObject({
            kind: "file",
            relativePath: "config/app.toml",
            historyIndex: 1,
        });
        expect("history" in tab ? tab.history : []).toEqual([
            {
                kind: "note",
                noteId: "notes/source",
                title: "Source",
                content: "source",
            },
            {
                kind: "file",
                relativePath: "config/app.toml",
                title: "app.toml",
                path: "/vault/config/app.toml",
                content: "name = 'NeverWrite'",
                mimeType: "application/toml",
                viewer: "text",
            },
        ]);

        useEditorStore.getState().goBack();
        tab = useEditorStore.getState().tabs[0];
        expect(tab).toMatchObject({
            kind: "note",
            noteId: "notes/source",
            historyIndex: 0,
        });
    });
});

describe("editorStore tab management", () => {
    it("opens graph as a singleton and reactivates the existing tab", () => {
        useEditorStore.getState().openGraph();
        const firstGraphTab = useEditorStore
            .getState()
            .tabs.find((tab) => isGraphTab(tab));

        useEditorStore.getState().openGraph();

        const state = useEditorStore.getState();
        const graphTabs = state.tabs.filter((tab) => isGraphTab(tab));
        expect(graphTabs).toHaveLength(1);
        expect(state.activeTabId).toBe(firstGraphTab?.id ?? null);
    });

    it("updates renamed notes inside inactive history entries", () => {
        useEditorStore.setState({
            tabs: [
                {
                    id: "note-tab",
                    kind: "note",
                    noteId: "notes/current",
                    title: "Current",
                    content: "current body",
                    history: [
                        {
                            kind: "note",
                            noteId: "notes/old",
                            title: "Old title",
                            content: "old body",
                        },
                        {
                            kind: "note",
                            noteId: "notes/current",
                            title: "Current",
                            content: "current body",
                        },
                    ],
                    historyIndex: 1,
                },
            ],
            activeTabId: "note-tab",
        });

        useEditorStore
            .getState()
            .handleNoteRenamed("notes/old", "notes/renamed", "Renamed");

        const noteTab = useEditorStore.getState().tabs[0];
        expect(noteTab).toMatchObject({
            kind: "note",
            noteId: "notes/current",
            title: "Current",
            historyIndex: 1,
        });
        expect(isNoteTab(noteTab) ? noteTab.history : []).toEqual([
            {
                kind: "note",
                noteId: "notes/renamed",
                title: "Renamed",
                content: "old body",
            },
            {
                kind: "note",
                noteId: "notes/current",
                title: "Current",
                content: "current body",
            },
        ]);
    });

    it("opens review tabs in background, updates the existing one, and closes by session id", () => {
        useEditorStore.setState({
            tabs: [
                makeTab({
                    id: "tab-a",
                    noteId: "notes/a",
                    title: "A",
                    content: "a",
                }),
            ],
            activeTabId: "tab-a",
            activationHistory: ["tab-a"],
            tabNavigationHistory: ["tab-a"],
            tabNavigationIndex: 0,
        });

        useEditorStore.getState().openReview("session-1", {
            background: true,
            title: "Initial review",
        });

        let state = useEditorStore.getState();
        const reviewTab = state.tabs.find((tab) => isReviewTab(tab));
        expect(reviewTab).toMatchObject({
            kind: "ai-review",
            sessionId: "session-1",
            title: "Initial review",
        });
        expect(state.activeTabId).toBe("tab-a");

        useEditorStore.getState().openReview("session-1", {
            title: "Updated review",
        });

        state = useEditorStore.getState();
        const updatedReviewTab = state.tabs.find((tab) => isReviewTab(tab));
        expect(state.tabs.filter((tab) => isReviewTab(tab))).toHaveLength(1);
        expect(updatedReviewTab).toMatchObject({
            title: "Updated review",
        });
        expect(state.activeTabId).toBe(updatedReviewTab?.id ?? null);

        useEditorStore.getState().closeReview("session-1");

        state = useEditorStore.getState();
        expect(state.tabs.some((tab) => isReviewTab(tab))).toBe(false);
        expect(state.activeTabId).toBe("tab-a");
    });

    it("tracks dirty tabs and clears them when the tab closes", () => {
        useEditorStore.setState({
            tabs: [
                makeTab({
                    id: "tab-a",
                    noteId: "notes/a",
                    title: "A",
                    content: "a",
                }),
                makeFileTab({
                    id: "tab-b",
                    relativePath: "src/app.ts",
                    title: "app.ts",
                    path: "/vault/src/app.ts",
                    content: "export {};",
                    mimeType: "text/typescript",
                    viewer: "text",
                }),
            ],
            activeTabId: "tab-a",
        });

        useEditorStore.getState().setTabDirty("tab-a", true);
        useEditorStore.getState().setTabDirty("tab-b", true);

        expect(useEditorStore.getState().dirtyTabIds).toEqual(
            new Set(["tab-a", "tab-b"]),
        );

        useEditorStore.getState().closeTab("tab-a");

        expect(useEditorStore.getState().dirtyTabIds).toEqual(
            new Set(["tab-b"]),
        );
    });

    it("returns to the most recently active tab when closing the current one", () => {
        useEditorStore.setState({
            tabs: [
                makeTab({
                    id: "tab-a",
                    noteId: "notes/a",
                    title: "A",
                    content: "a",
                }),
                makeTab({
                    id: "tab-b",
                    noteId: "notes/b",
                    title: "B",
                    content: "b",
                }),
                makeTab({
                    id: "tab-c",
                    noteId: "notes/c",
                    title: "C",
                    content: "c",
                }),
            ],
            activeTabId: "tab-c",
            activationHistory: ["tab-a", "tab-b", "tab-c"],
        });

        useEditorStore.getState().closeTab("tab-c");

        expect(useEditorStore.getState().activeTabId).toBe("tab-b");
        expect(useEditorStore.getState().recentlyClosedTabs).toMatchObject([
            {
                index: 2,
                tab: { id: "tab-c" },
            },
        ]);
    });

    it("tracks switching history when deciding which tab to restore", () => {
        useEditorStore.setState({
            tabs: [
                makeTab({
                    id: "tab-a",
                    noteId: "notes/a",
                    title: "A",
                    content: "a",
                }),
                makeTab({
                    id: "tab-b",
                    noteId: "notes/b",
                    title: "B",
                    content: "b",
                }),
                makeTab({
                    id: "tab-c",
                    noteId: "notes/c",
                    title: "C",
                    content: "c",
                }),
            ],
            activeTabId: "tab-a",
            activationHistory: ["tab-a"],
        });

        useEditorStore.getState().switchTab("tab-c");
        useEditorStore.getState().switchTab("tab-b");
        useEditorStore.getState().closeTab("tab-b");

        expect(useEditorStore.getState().activeTabId).toBe("tab-c");
    });

    it("reopens the most recently closed tab at its previous index", () => {
        useEditorStore.setState({
            tabs: [
                makeTab({
                    id: "tab-a",
                    noteId: "notes/a",
                    title: "A",
                    content: "a",
                }),
                makeFileTab({
                    id: "tab-b",
                    relativePath: "assets/banner.png",
                    title: "banner.png",
                    path: "/vault/assets/banner.png",
                    content: "",
                    mimeType: "image/png",
                    viewer: "image",
                }),
                makeTab({
                    id: "tab-c",
                    noteId: "notes/c",
                    title: "C",
                    content: "c",
                }),
            ],
            activeTabId: "tab-b",
            activationHistory: ["tab-a", "tab-b"],
            tabNavigationHistory: ["tab-a", "tab-b"],
            tabNavigationIndex: 1,
        });

        useEditorStore.getState().closeTab("tab-b");
        useEditorStore.getState().reopenLastClosedTab();

        const { tabs, activeTabId, recentlyClosedTabs } =
            useEditorStore.getState();
        expect(tabs.map((tab) => tab.id)).toEqual(["tab-a", "tab-b", "tab-c"]);
        expect(activeTabId).toBe("tab-b");
        expect(recentlyClosedTabs).toEqual([]);
        expect(isFileTab(tabs[1]) ? tabs[1].viewer : null).toBe("image");
    });

    it("reopens closed tabs in LIFO order", () => {
        useEditorStore.setState({
            tabs: [
                makeTab({
                    id: "tab-a",
                    noteId: "notes/a",
                    title: "A",
                    content: "a",
                }),
                makeTab({
                    id: "tab-b",
                    noteId: "notes/b",
                    title: "B",
                    content: "b",
                }),
                makeTab({
                    id: "tab-c",
                    noteId: "notes/c",
                    title: "C",
                    content: "c",
                }),
            ],
            activeTabId: "tab-c",
            activationHistory: ["tab-a", "tab-b", "tab-c"],
            tabNavigationHistory: ["tab-a", "tab-b", "tab-c"],
            tabNavigationIndex: 2,
        });

        useEditorStore.getState().closeTab("tab-c");
        useEditorStore.getState().closeTab("tab-b");

        useEditorStore.getState().reopenLastClosedTab();
        expect(useEditorStore.getState().tabs.map((tab) => tab.id)).toEqual([
            "tab-a",
            "tab-b",
        ]);

        useEditorStore.getState().reopenLastClosedTab();
        expect(useEditorStore.getState().tabs.map((tab) => tab.id)).toEqual([
            "tab-a",
            "tab-b",
            "tab-c",
        ]);
    });

    it("does not remember tabs closed for delete or cleanup flows", () => {
        useEditorStore.setState({
            tabs: [
                makeTab({
                    id: "tab-a",
                    noteId: "notes/a",
                    title: "A",
                    content: "a",
                }),
                makePdfTab({
                    id: "tab-b",
                    entryId: "docs/spec",
                    title: "spec.pdf",
                    path: "/vault/docs/spec.pdf",
                }),
            ],
            activeTabId: "tab-b",
            activationHistory: ["tab-a", "tab-b"],
            tabNavigationHistory: ["tab-a", "tab-b"],
            tabNavigationIndex: 1,
        });

        useEditorStore.getState().closeTab("tab-b", { reason: "delete" });
        useEditorStore.getState().closeTab("tab-a", { reason: "cleanup" });

        expect(useEditorStore.getState().recentlyClosedTabs).toEqual([]);
        useEditorStore.getState().reopenLastClosedTab();
        expect(useEditorStore.getState().tabs).toEqual([]);
    });

    it("does not rewrite state when switching to the already active tab", () => {
        useEditorStore.setState({
            tabs: [
                makeTab({
                    id: "tab-a",
                    noteId: "notes/a",
                    title: "A",
                    content: "a",
                }),
                makeTab({
                    id: "tab-b",
                    noteId: "notes/b",
                    title: "B",
                    content: "b",
                }),
            ],
            activeTabId: "tab-b",
            activationHistory: ["tab-a", "tab-b"],
            tabNavigationHistory: ["tab-a", "tab-b"],
            tabNavigationIndex: 1,
        });

        const before = useEditorStore.getState();
        useEditorStore.getState().switchTab("tab-b");
        const after = useEditorStore.getState();

        expect(after.activeTabId).toBe("tab-b");
        expect(after.activationHistory).toEqual(["tab-a", "tab-b"]);
        expect(after.tabNavigationHistory).toEqual(["tab-a", "tab-b"]);
        expect(after.tabNavigationIndex).toBe(1);
        expect(after).toBe(before);
    });

    it("updates title and content when clean tabs reload from disk", () => {
        useEditorStore.setState({
            tabs: [
                makeTab({
                    id: "tab-a",
                    noteId: "notes/a",
                    title: "Old title",
                    content: "Old body",
                }),
            ],
            activeTabId: "tab-a",
        });

        useEditorStore.getState().reloadNoteContent("notes/a", {
            title: "New title",
            content: "New body",
        });

        expect(useEditorStore.getState().tabs[0]).toMatchObject({
            title: "New title",
            content: "New body",
        });
    });

    it("tracks logical reloads even when content stays the same", () => {
        useEditorStore.setState({
            tabs: [
                makeTab({
                    id: "tab-a",
                    noteId: "notes/a",
                    title: "Same title",
                    content: "Same body",
                }),
            ],
            activeTabId: "tab-a",
        });
        const initialVersion =
            useEditorStore.getState()._noteReloadVersions["notes/a"] ?? 0;

        useEditorStore.getState().reloadNoteContent("notes/a", {
            title: "Same title",
            content: "Same body",
            origin: "external",
            revision: 2,
            opId: "external-2",
        });

        let state = useEditorStore.getState();
        expect(state.tabs[0]).toMatchObject({
            title: "Same title",
            content: "Same body",
        });
        expect(state._noteReloadVersions["notes/a"]).toBe(initialVersion + 1);
        expect(state._noteReloadMetadata["notes/a"]).toMatchObject({
            origin: "external",
            revision: 2,
            opId: "external-2",
        });

        useEditorStore.getState().reloadNoteContent("notes/a", {
            title: "Same title",
            content: "Same body",
            origin: "external",
            revision: 3,
            opId: "external-3",
        });

        state = useEditorStore.getState();
        expect(state._noteReloadVersions["notes/a"]).toBe(initialVersion + 2);
        expect(state._noteReloadMetadata["notes/a"]).toMatchObject({
            origin: "external",
            revision: 3,
            opId: "external-3",
        });
    });

    it("updates title and content when clean file tabs reload from disk", () => {
        useEditorStore.setState({
            tabs: [
                makeFileTab({
                    id: "file-tab-a",
                    relativePath: "src/a.ts",
                    title: "old.ts",
                    path: "/vault/src/a.ts",
                    content: "old body",
                    mimeType: "text/typescript",
                    viewer: "text",
                }),
            ],
            activeTabId: "file-tab-a",
        });

        useEditorStore.getState().reloadFileContent("src/a.ts", {
            title: "new.ts",
            content: "new body",
        });

        expect(useEditorStore.getState().tabs[0]).toMatchObject({
            title: "new.ts",
            content: "new body",
        });
        expect(useEditorStore.getState()._fileReloadVersions["src/a.ts"]).toBe(
            1,
        );
    });

    it("tracks forced reload state for file tabs through the direct API", () => {
        useEditorStore.setState({
            tabs: [
                makeFileTab({
                    id: "file-tab-a",
                    relativePath: "src/a.ts",
                    title: "a.ts",
                    path: "/vault/src/a.ts",
                    content: "before",
                    mimeType: "text/typescript",
                    viewer: "text",
                }),
            ],
            activeTabId: "file-tab-a",
        });

        useEditorStore.getState().forceReloadFileContent("src/a.ts", {
            title: "a.ts",
            content: "after",
            origin: "external",
            revision: 7,
            opId: "external-7",
        });

        const state = useEditorStore.getState();
        expect(state.tabs[0]).toMatchObject({
            title: "a.ts",
            content: "after",
        });
        expect(state._pendingForceFileReloads.has("src/a.ts")).toBe(true);
        expect(state._fileReloadVersions["src/a.ts"]).toBe(1);
        expect(state._fileReloadMetadata["src/a.ts"]).toMatchObject({
            origin: "external",
            revision: 7,
            opId: "external-7",
        });
    });

    it("force reloads a note target through the shared target API", () => {
        useEditorStore.setState({
            tabs: [
                makeTab({
                    id: "tab-a",
                    noteId: "notes/a",
                    title: "Old title",
                    content: "Old body",
                }),
            ],
            activeTabId: "tab-a",
        });

        const noteTab = useEditorStore.getState().tabs[0];
        useEditorStore.getState().forceReloadEditorTarget(
            {
                kind: "note",
                absolutePath: "/vault/notes/a.md",
                noteId: "notes/a",
                openTab: isNoteTab(noteTab) ? noteTab : null,
            },
            {
                title: "New title",
                content: "New body",
                origin: "agent",
                revision: 4,
                opId: "agent-4",
            },
        );

        const state = useEditorStore.getState();
        expect(state.tabs[0]).toMatchObject({
            title: "New title",
            content: "New body",
        });
        expect(state._pendingForceReloads.has("notes/a")).toBe(true);
        expect(state._noteReloadMetadata["notes/a"]).toMatchObject({
            origin: "agent",
            revision: 4,
            opId: "agent-4",
        });
    });

    it("force reloads a file target through the shared target API", () => {
        useEditorStore.setState({
            tabs: [
                makeFileTab({
                    id: "tab-a",
                    relativePath: "src/watcher.rs",
                    title: "watcher.rs",
                    path: "/vault/src/watcher.rs",
                    content: "old line",
                    mimeType: "text/rust",
                    viewer: "text",
                }),
            ],
            activeTabId: "tab-a",
        });

        const fileTab = useEditorStore.getState().tabs[0];
        useEditorStore.getState().forceReloadEditorTarget(
            {
                kind: "file",
                absolutePath: "/vault/src/watcher.rs",
                relativePath: "src/watcher.rs",
                openTab: isFileTab(fileTab) ? fileTab : null,
            },
            {
                title: "watcher.rs",
                content: "new line",
                origin: "agent",
                revision: 5,
                opId: "agent-5",
            },
        );

        const state = useEditorStore.getState();
        expect(state.tabs[0]).toMatchObject({
            title: "watcher.rs",
            content: "new line",
        });
        expect(state._pendingForceFileReloads.has("src/watcher.rs")).toBe(true);
        expect(state._fileReloadVersions["src/watcher.rs"]).toBe(1);
        expect(state._fileReloadMetadata["src/watcher.rs"]).toMatchObject({
            origin: "agent",
            revision: 5,
            opId: "agent-5",
        });
    });

    it("updates pdf page, zoom, and view mode on the current history entry", () => {
        useEditorStore.setState({
            tabs: [
                makePdfTab({
                    id: "pdf-tab-a",
                    entryId: "docs/guide",
                    title: "guide.pdf",
                    path: "/vault/docs/guide.pdf",
                    page: 1,
                    zoom: 1,
                    viewMode: "continuous",
                }),
            ],
            activeTabId: "pdf-tab-a",
        });

        useEditorStore.getState().updatePdfPage("pdf-tab-a", 4);
        useEditorStore.getState().updatePdfZoom("pdf-tab-a", 1.75);
        useEditorStore.getState().updatePdfViewMode("pdf-tab-a", "single");

        const pdfTab = useEditorStore
            .getState()
            .tabs.find((tab) => tab.id === "pdf-tab-a");
        expect(isPdfTab(pdfTab) ? pdfTab : null).toMatchObject({
            page: 4,
            zoom: 1.75,
            viewMode: "single",
        });
        expect(
            isPdfTab(pdfTab) ? pdfTab.history[pdfTab.historyIndex] : null,
        ).toMatchObject({
            kind: "pdf",
            page: 4,
            zoom: 1.75,
            viewMode: "single",
        });
    });

    it("hydrates pane workspaces while mirroring the focused pane into legacy fields", () => {
        useEditorStore.getState().hydrateWorkspace(
            [
                {
                    id: "pane-1",
                    tabs: [
                        makeTab({
                            id: "tab-a",
                            noteId: "notes/a",
                            title: "A",
                            content: "Alpha",
                        }),
                    ],
                    activeTabId: "tab-a",
                    activationHistory: ["tab-a"],
                    tabNavigationHistory: ["tab-a"],
                    tabNavigationIndex: 0,
                },
                {
                    id: "pane-2",
                    tabs: [
                        makeFileTab({
                            id: "file-b",
                            relativePath: "src/main.ts",
                            title: "main.ts",
                            path: "/vault/src/main.ts",
                            content: "console.log('ok')",
                            mimeType: "text/typescript",
                            viewer: "text",
                        }),
                    ],
                    activeTabId: "file-b",
                    activationHistory: ["file-b"],
                    tabNavigationHistory: ["file-b"],
                    tabNavigationIndex: 0,
                },
            ],
            "pane-2",
        );

        const state = useEditorStore.getState();

        expect(state.focusedPaneId).toBe("pane-2");
        expect(state.panes).toHaveLength(2);
        expect(state.panes[0]?.activeTabId).toBe("tab-a");
        expect(state.panes[1]?.activeTabId).toBe("file-b");
        expect(state.tabs[0]).toMatchObject({
            id: "file-b",
            kind: "file",
            relativePath: "src/main.ts",
        });
        expect(state.activeTabId).toBe("file-b");
    });
});
