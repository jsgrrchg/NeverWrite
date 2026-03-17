import { create } from "zustand";
import { vaultInvoke } from "../utils/vaultInvoke";
import { useSettingsStore } from "./settingsStore";
import { useVaultStore } from "./vaultStore";

const SESSION_KEY = "vaultai.session.tabs";
const SESSION_KEY_PREFIX = "vaultai.session.tabs:";

interface PersistedSession {
    tabs?: TabInput[];
    activeTabId?: string | null;
    noteIds: Array<{
        noteId: string;
        title: string;
        history?: Array<{ noteId: string; title: string }>;
        historyIndex?: number;
    }>;
    pdfTabs?: Array<{
        entryId: string;
        title: string;
        path: string;
        page?: number;
        zoom?: number;
        viewMode?: PdfViewMode;
        history?: Array<{
            entryId: string;
            title: string;
            path: string;
            page?: number;
            zoom?: number;
            viewMode?: PdfViewMode;
        }>;
        historyIndex?: number;
    }>;
    fileTabs?: Array<{
        relativePath: string;
        title: string;
        path: string;
        mimeType?: string | null;
        viewer?: FileViewerMode;
        content: string;
        history?: Array<{
            relativePath: string;
            title: string;
            path: string;
            mimeType?: string | null;
            viewer?: FileViewerMode;
        }>;
        historyIndex?: number;
    }>;
    mapTabs?: Array<{
        filePath: string;
        relativePath: string;
        title: string;
    }>;
    hasGraphTab?: boolean;
    activeNoteId: string | null;
    activePdfEntryId?: string | null;
    activeFilePath?: string | null;
    activeMapFilePath?: string | null;
    activeGraphTab?: boolean;
}

function pushTabToActivation(history: string[], tabId: string) {
    return [...history.filter((id) => id !== tabId), tabId];
}

function pushTabToNavigation(
    history: string[],
    index: number,
    tabId: string,
): { history: string[]; index: number } {
    const truncated = history.slice(0, Math.max(0, index + 1));
    if (truncated[truncated.length - 1] === tabId) {
        return {
            history: truncated,
            index: truncated.length - 1,
        };
    }

    const next = [...truncated, tabId];
    return { history: next, index: next.length - 1 };
}

function activateTab(
    state: Pick<
        EditorStore,
        | "activeTabId"
        | "activationHistory"
        | "tabNavigationHistory"
        | "tabNavigationIndex"
    >,
    tabId: string,
    options?: { recordNavigation?: boolean },
) {
    const activationHistory = pushTabToActivation(
        state.activationHistory,
        tabId,
    );
    if (options?.recordNavigation === false) {
        return { activeTabId: tabId, activationHistory };
    }

    const navigation = pushTabToNavigation(
        state.tabNavigationHistory,
        state.tabNavigationIndex,
        tabId,
    );

    return {
        activeTabId: tabId,
        activationHistory,
        tabNavigationHistory: navigation.history,
        tabNavigationIndex: navigation.index,
    };
}

function getSessionKey(vaultPath: string) {
    return `${SESSION_KEY_PREFIX}${vaultPath}`;
}

export function readPersistedSession(
    vaultPath: string | null,
): PersistedSession | null {
    try {
        const raw =
            (vaultPath
                ? localStorage.getItem(getSessionKey(vaultPath))
                : null) ?? localStorage.getItem(SESSION_KEY);
        if (!raw) return null;
        return JSON.parse(raw) as PersistedSession;
    } catch {
        return null;
    }
}

// Only start persisting after the session has been restored,
// to avoid overwriting saved data with the initial empty state.
let sessionReady = false;

export function markSessionReady() {
    sessionReady = true;
}

export interface NoteHistoryEntry {
    kind: "note";
    noteId: string;
    title: string;
    content: string;
}

export interface PdfHistoryEntry {
    kind: "pdf";
    entryId: string;
    title: string;
    path: string;
    page: number;
    zoom: number;
    viewMode: PdfViewMode;
}

export interface FileHistoryEntry {
    kind: "file";
    relativePath: string;
    title: string;
    path: string;
    content: string;
    mimeType: string | null;
    viewer: FileViewerMode;
}

export interface MapHistoryEntry {
    kind: "map";
    filePath: string;
    relativePath: string;
    title: string;
}

export type TabHistoryEntry =
    | NoteHistoryEntry
    | PdfHistoryEntry
    | FileHistoryEntry
    | MapHistoryEntry;

export type NoteHistoryEntryInput = Omit<NoteHistoryEntry, "kind"> & {
    kind?: "note";
};

export type PdfHistoryEntryInput = Omit<PdfHistoryEntry, "kind"> & {
    kind?: "pdf";
};

export type FileHistoryEntryInput = Omit<FileHistoryEntry, "kind"> & {
    kind?: "file";
};

export type MapHistoryEntryInput = Omit<MapHistoryEntry, "kind"> & {
    kind?: "map";
};

export type TabHistoryEntryInput =
    | NoteHistoryEntryInput
    | PdfHistoryEntryInput
    | FileHistoryEntryInput
    | MapHistoryEntryInput;

export interface NoteTab {
    id: string;
    kind?: "note";
    noteId: string;
    title: string;
    content: string;
    history: TabHistoryEntry[];
    historyIndex: number;
}

export interface PdfTab {
    id: string;
    kind: "pdf";
    entryId: string;
    title: string;
    path: string;
    page: number;
    zoom: number;
    viewMode: PdfViewMode;
    history: TabHistoryEntry[];
    historyIndex: number;
}

export interface FileTab {
    id: string;
    kind: "file";
    relativePath: string;
    path: string;
    title: string;
    content: string;
    mimeType: string | null;
    viewer: FileViewerMode;
    history: TabHistoryEntry[];
    historyIndex: number;
}

export interface ReviewTab {
    id: string;
    kind: "ai-review";
    sessionId: string;
    title: string;
}

export interface MapTab {
    id: string;
    kind: "map";
    filePath: string;
    relativePath: string;
    title: string;
    history: TabHistoryEntry[];
    historyIndex: number;
}

export interface GraphTab {
    id: string;
    kind: "graph";
    title: string;
}

export type PdfViewMode = "single" | "continuous";
export type FileViewerMode = "text" | "image";

export type Tab = NoteTab | PdfTab | FileTab | ReviewTab | MapTab | GraphTab;

export function isNoteTab(tab: Tab): tab is NoteTab;
export function isNoteTab(tab: TabInput): tab is NoteTabInput;
export function isNoteTab(tab: Tab | TabInput): tab is NoteTab | NoteTabInput {
    return (
        tab.kind !== "pdf" &&
        tab.kind !== "file" &&
        tab.kind !== "ai-review" &&
        tab.kind !== "map" &&
        tab.kind !== "graph"
    );
}

export function isPdfTab(tab: Tab): tab is PdfTab;
export function isPdfTab(tab: TabInput): tab is PdfTabInput;
export function isPdfTab(tab: Tab | TabInput): tab is PdfTab | PdfTabInput {
    return tab.kind === "pdf";
}

export function isFileTab(tab: Tab): tab is FileTab;
export function isFileTab(tab: TabInput): tab is FileTabInput;
export function isFileTab(tab: Tab | TabInput): tab is FileTab | FileTabInput {
    return tab.kind === "file";
}

export function isReviewTab(tab: Tab): tab is ReviewTab;
export function isReviewTab(tab: TabInput): tab is ReviewTab;
export function isReviewTab(tab: Tab | TabInput): tab is ReviewTab {
    return tab.kind === "ai-review";
}

export function isMapTab(tab: Tab): tab is MapTab;
export function isMapTab(tab: TabInput): tab is MapTabInput;
export function isMapTab(tab: Tab | TabInput): tab is MapTab | MapTabInput {
    return tab.kind === "map";
}

export function isGraphTab(tab: Tab): tab is GraphTab;
export function isGraphTab(tab: TabInput): tab is GraphTab;
export function isGraphTab(tab: Tab | TabInput): tab is GraphTab {
    return tab.kind === "graph";
}

/** Tab without required history fields — used when creating tabs externally. */
export type NoteTabInput = Omit<NoteTab, "history" | "historyIndex"> & {
    history?: TabHistoryEntryInput[];
    historyIndex?: number;
};

export type PdfTabInput = Omit<PdfTab, "history" | "historyIndex"> & {
    history?: TabHistoryEntryInput[];
    historyIndex?: number;
};

export type FileTabInput = Omit<FileTab, "history" | "historyIndex"> & {
    history?: TabHistoryEntryInput[];
    historyIndex?: number;
};

export type MapTabInput = Omit<MapTab, "history" | "historyIndex"> & {
    history?: TabHistoryEntryInput[];
    historyIndex?: number;
};

export type TabInput =
    | NoteTabInput
    | PdfTabInput
    | FileTabInput
    | ReviewTab
    | MapTabInput
    | GraphTab;

function createNoteHistoryEntry(
    noteId: string,
    title: string,
    content: string,
): NoteHistoryEntry {
    return {
        kind: "note",
        noteId,
        title,
        content,
    };
}

function createPdfHistoryEntry(
    entryId: string,
    title: string,
    path: string,
    page: number,
    zoom: number,
    viewMode: PdfViewMode,
): PdfHistoryEntry {
    return {
        kind: "pdf",
        entryId,
        title,
        path,
        page,
        zoom,
        viewMode,
    };
}

function createFileHistoryEntry(
    relativePath: string,
    title: string,
    path: string,
    content: string,
    mimeType: string | null,
    viewer: FileViewerMode,
): FileHistoryEntry {
    return {
        kind: "file",
        relativePath,
        title,
        path,
        content,
        mimeType,
        viewer,
    };
}

function createMapHistoryEntry(
    filePath: string,
    relativePath: string,
    title: string,
): MapHistoryEntry {
    return {
        kind: "map",
        filePath,
        relativePath,
        title,
    };
}

function inferHistoryEntryKind(
    entry: TabHistoryEntryInput,
    fallbackKind: "note" | "pdf" | "file" | "map",
) {
    if (entry.kind) return entry.kind;
    if ("noteId" in entry) return "note";
    if ("entryId" in entry) return "pdf";
    if ("filePath" in entry) return "map";
    if ("relativePath" in entry) return "file";
    return fallbackKind;
}

function normalizeHistoryEntry(
    entry: TabHistoryEntryInput,
    fallbackKind: "note" | "pdf" | "file" | "map",
): TabHistoryEntry {
    const kind = inferHistoryEntryKind(entry, fallbackKind);

    if (kind === "note") {
        return createNoteHistoryEntry(
            "noteId" in entry ? entry.noteId : "",
            entry.title,
            "content" in entry ? entry.content : "",
        );
    }

    if (kind === "pdf") {
        return createPdfHistoryEntry(
            "entryId" in entry ? entry.entryId : "",
            entry.title,
            "path" in entry ? entry.path : "",
            "page" in entry ? (entry.page ?? 1) : 1,
            "zoom" in entry ? (entry.zoom ?? 1) : 1,
            "viewMode" in entry
                ? (entry.viewMode ?? "continuous")
                : "continuous",
        );
    }

    if (kind === "map") {
        return createMapHistoryEntry(
            "filePath" in entry ? entry.filePath : "",
            "relativePath" in entry ? entry.relativePath : "",
            entry.title,
        );
    }

    const path = "path" in entry ? entry.path : "";
    const mimeType = "mimeType" in entry ? (entry.mimeType ?? null) : null;

    return createFileHistoryEntry(
        "relativePath" in entry ? entry.relativePath : "",
        entry.title,
        path,
        "content" in entry ? entry.content : "",
        mimeType,
        "viewer" in entry
            ? (entry.viewer ?? inferFileViewer(path, mimeType))
            : inferFileViewer(path, mimeType),
    );
}

function createHistoryEntryFromTab(
    tab: NoteTab | PdfTab | FileTab | MapTab,
): TabHistoryEntry {
    if (isPdfTab(tab)) {
        return createPdfHistoryEntry(
            tab.entryId,
            tab.title,
            tab.path,
            tab.page,
            tab.zoom,
            tab.viewMode,
        );
    }

    if (isFileTab(tab)) {
        return createFileHistoryEntry(
            tab.relativePath,
            tab.title,
            tab.path,
            tab.content,
            tab.mimeType,
            tab.viewer,
        );
    }

    if (isMapTab(tab)) {
        return createMapHistoryEntry(tab.filePath, tab.relativePath, tab.title);
    }

    return createNoteHistoryEntry(tab.noteId, tab.title, tab.content);
}

function buildTabFromHistory(
    id: string,
    history: TabHistoryEntry[],
    historyIndex: number,
): NoteTab | PdfTab | FileTab | MapTab {
    const safeIndex = Math.max(0, Math.min(historyIndex, history.length - 1));
    const entry = history[safeIndex];

    if (entry.kind === "pdf") {
        return {
            id,
            kind: "pdf",
            entryId: entry.entryId,
            title: entry.title,
            path: entry.path,
            page: entry.page,
            zoom: entry.zoom,
            viewMode: entry.viewMode,
            history,
            historyIndex: safeIndex,
        };
    }

    if (entry.kind === "file") {
        return {
            id,
            kind: "file",
            relativePath: entry.relativePath,
            title: entry.title,
            path: entry.path,
            content: entry.content,
            mimeType: entry.mimeType,
            viewer: entry.viewer,
            history,
            historyIndex: safeIndex,
        };
    }

    if (entry.kind === "map") {
        return {
            id,
            kind: "map",
            filePath: entry.filePath,
            relativePath: entry.relativePath,
            title: entry.title,
            history,
            historyIndex: safeIndex,
        };
    }

    return {
        id,
        kind: "note",
        noteId: entry.noteId,
        title: entry.title,
        content: entry.content,
        history,
        historyIndex: safeIndex,
    };
}

function createNoteTab(
    noteId: string,
    title: string,
    content: string,
): NoteTab {
    return {
        id: crypto.randomUUID(),
        kind: "note",
        noteId,
        title,
        content,
        history: [createNoteHistoryEntry(noteId, title, content)],
        historyIndex: 0,
    };
}

function createPdfTab(entryId: string, title: string, path: string): PdfTab {
    return {
        id: crypto.randomUUID(),
        kind: "pdf",
        entryId,
        title,
        path,
        page: 1,
        zoom: 1,
        viewMode: "continuous",
        history: [
            createPdfHistoryEntry(entryId, title, path, 1, 1, "continuous"),
        ],
        historyIndex: 0,
    };
}

function createFileTab(
    relativePath: string,
    title: string,
    path: string,
    content: string,
    mimeType: string | null,
    viewer: FileViewerMode,
): FileTab {
    return {
        id: crypto.randomUUID(),
        kind: "file",
        relativePath,
        title,
        path,
        content,
        mimeType,
        viewer,
        history: [
            createFileHistoryEntry(
                relativePath,
                title,
                path,
                content,
                mimeType,
                viewer,
            ),
        ],
        historyIndex: 0,
    };
}

function createMapTab(
    filePath: string,
    relativePath: string,
    title: string,
): MapTab {
    return {
        id: crypto.randomUUID(),
        kind: "map",
        filePath,
        relativePath,
        title,
        history: [],
        historyIndex: -1,
    };
}

function createGraphTab(): GraphTab {
    return {
        id: crypto.randomUUID(),
        kind: "graph",
        title: "Graph View",
    };
}

function ensureMapTabDefaults(tab: MapTabInput): MapTab {
    return {
        id: tab.id,
        kind: "map",
        filePath: tab.filePath,
        relativePath: tab.relativePath,
        title: tab.title,
        history:
            tab.history?.map((entry) => normalizeHistoryEntry(entry, "map")) ??
            [],
        historyIndex: tab.historyIndex ?? -1,
    };
}

function ensurePdfTabDefaults(tab: PdfTabInput): PdfTab {
    if (tab.history && tab.history.length > 0) {
        const history = tab.history.map((entry) =>
            normalizeHistoryEntry(entry, "pdf"),
        );
        return buildTabFromHistory(
            tab.id,
            history,
            tab.historyIndex ?? history.length - 1,
        ) as PdfTab;
    }

    const history = [
        createPdfHistoryEntry(
            tab.entryId,
            tab.title,
            tab.path,
            tab.page ?? 1,
            tab.zoom ?? 1,
            tab.viewMode ?? "continuous",
        ),
    ];

    return buildTabFromHistory(tab.id, history, 0) as PdfTab;
}

function getTabOpenBehavior() {
    return useSettingsStore.getState().tabOpenBehavior;
}

function ensureFileTabHistory(tab: FileTabInput): FileTab {
    if (tab.history && tab.history.length > 0) {
        const history = tab.history.map((entry) =>
            normalizeHistoryEntry(entry, "file"),
        );
        return buildTabFromHistory(
            tab.id,
            history,
            tab.historyIndex ?? history.length - 1,
        ) as FileTab;
    }

    const viewer =
        tab.viewer ?? inferFileViewer(tab.path, tab.mimeType ?? null);

    return buildTabFromHistory(
        tab.id,
        [
            createFileHistoryEntry(
                tab.relativePath,
                tab.title,
                tab.path,
                tab.content,
                tab.mimeType ?? null,
                viewer,
            ),
        ],
        0,
    ) as FileTab;
}

function ensureFileTabDefaults(tab: FileTabInput): FileTab {
    return {
        ...ensureFileTabHistory(tab),
        mimeType: tab.mimeType ?? null,
        viewer: tab.viewer ?? inferFileViewer(tab.path, tab.mimeType),
    };
}

function inferFileViewer(
    path: string,
    mimeType: string | null,
): FileViewerMode {
    const extension = path.split(".").pop()?.toLowerCase() ?? "";
    if (mimeType?.startsWith("image/")) return "image";
    if (
        extension === "png" ||
        extension === "jpg" ||
        extension === "jpeg" ||
        extension === "jpe" ||
        extension === "jfif" ||
        extension === "gif" ||
        extension === "webp" ||
        extension === "svg" ||
        extension === "avif" ||
        extension === "bmp" ||
        extension === "ico"
    ) {
        return "image";
    }
    return "text";
}

function ensureNoteTabHistory(tab: NoteTabInput): NoteTab {
    if (tab.history && tab.history.length > 0) {
        const history = tab.history.map((entry) =>
            normalizeHistoryEntry(entry, "note"),
        );
        return buildTabFromHistory(
            tab.id,
            history,
            tab.historyIndex ?? history.length - 1,
        ) as NoteTab;
    }
    return buildTabFromHistory(
        tab.id,
        [createNoteHistoryEntry(tab.noteId, tab.title, tab.content)],
        0,
    ) as NoteTab;
}

export interface PendingReveal {
    noteId: string;
    targets: string[];
    mode: "link" | "mention";
}

export interface PendingSelectionReveal {
    noteId: string;
    anchor: number;
    head: number;
}

export interface EditorSelectionContext {
    noteId: string;
    text: string;
    from: number;
    to: number;
    startLine: number;
    endLine: number;
}

interface ReloadedNoteDetail {
    content: string;
    title: string;
}

interface EditorStore {
    tabs: Tab[];
    activeTabId: string | null;
    activationHistory: string[];
    tabNavigationHistory: string[];
    tabNavigationIndex: number;
    pendingReveal: PendingReveal | null;
    pendingSelectionReveal: PendingSelectionReveal | null;
    currentSelection: EditorSelectionContext | null;
    _pendingForceReloads: Set<string>;
    openNote: (noteId: string, title: string, content: string) => void;
    openPdf: (entryId: string, title: string, path: string) => void;
    openFile: (
        relativePath: string,
        title: string,
        path: string,
        content: string,
        mimeType: string | null,
        viewer: FileViewerMode,
    ) => void;
    openMap: (filePath: string, relativePath: string, title: string) => void;
    openGraph: () => void;
    openReview: (
        sessionId: string,
        options?: { background?: boolean; title?: string },
    ) => void;
    closeReview: (sessionId: string) => void;
    goBack: () => void;
    goForward: () => void;
    navigateToHistoryIndex: (index: number) => void;
    closeTab: (tabId: string) => void;
    switchTab: (tabId: string) => void;
    updateTabContent: (tabId: string, content: string) => void;
    updateTabTitle: (tabId: string, title: string) => void;
    updatePdfPage: (tabId: string, page: number) => void;
    updatePdfZoom: (tabId: string, zoom: number) => void;
    updatePdfViewMode: (tabId: string, viewMode: PdfViewMode) => void;
    reorderTabs: (fromIndex: number, toIndex: number) => void;
    hydrateTabs: (tabs: TabInput[], activeTabId: string | null) => void;
    insertExternalTab: (tab: TabInput, index?: number) => void;
    queueReveal: (reveal: PendingReveal) => void;
    clearPendingReveal: () => void;
    queueSelectionReveal: (reveal: PendingSelectionReveal) => void;
    clearPendingSelectionReveal: () => void;
    setCurrentSelection: (selection: EditorSelectionContext) => void;
    clearCurrentSelection: () => void;
    reloadNoteContent: (noteId: string, detail: ReloadedNoteDetail) => void;
    forceReloadNoteContent: (
        noteId: string,
        detail: ReloadedNoteDetail,
    ) => void;
    clearForceReload: (noteId: string) => void;
    handleNoteDeleted: (noteId: string) => void;
    handleNoteRenamed: (
        oldNoteId: string,
        newNoteId: string,
        newTitle: string,
    ) => void;
}

export const useEditorStore = create<EditorStore>((set, get) => ({
    tabs: [],
    activeTabId: null,
    activationHistory: [],
    tabNavigationHistory: [],
    tabNavigationIndex: -1,
    pendingReveal: null,
    pendingSelectionReveal: null,
    currentSelection: null,
    _pendingForceReloads: new Set<string>(),

    openNote: (noteId, title, content) => {
        set((state) => {
            if (getTabOpenBehavior() === "new_tab") {
                const newTab = createNoteTab(noteId, title, content);
                return {
                    tabs: [...state.tabs, newTab],
                    ...activateTab(state, newTab.id),
                };
            }

            const activeTab = state.tabs.find(
                (t) => t.id === state.activeTabId,
            );
            if (
                activeTab &&
                !isReviewTab(activeTab) &&
                !isMapTab(activeTab) &&
                !isGraphTab(activeTab)
            ) {
                const tab = isNoteTab(activeTab)
                    ? ensureNoteTabHistory(activeTab)
                    : isPdfTab(activeTab)
                      ? ensurePdfTabDefaults(activeTab)
                      : ensureFileTabDefaults(activeTab);
                if (isNoteTab(tab) && tab.noteId === noteId) {
                    return {
                        tabs: state.tabs.map((tabItem) =>
                            tabItem.id === tab.id
                                ? buildTabFromHistory(
                                      tab.id,
                                      tab.history.map((entry, index) =>
                                          index === tab.historyIndex &&
                                          entry.kind === "note"
                                              ? createNoteHistoryEntry(
                                                    noteId,
                                                    title,
                                                    content,
                                                )
                                              : entry,
                                      ),
                                      tab.historyIndex,
                                  )
                                : tabItem,
                        ),
                    };
                }
                const kept = tab.history.slice(0, tab.historyIndex);
                kept.push(
                    createHistoryEntryFromTab(tab),
                    createNoteHistoryEntry(noteId, title, content),
                );
                return {
                    tabs: state.tabs.map((tabItem) =>
                        tabItem.id === tab.id
                            ? buildTabFromHistory(tab.id, kept, kept.length - 1)
                            : tabItem,
                    ),
                };
            }

            const newTab = createNoteTab(noteId, title, content);
            return {
                tabs: [...state.tabs, newTab],
                ...activateTab(state, newTab.id),
            };
        });
    },

    openPdf: (entryId, title, path) => {
        set((state) => {
            if (getTabOpenBehavior() === "new_tab") {
                const newTab = createPdfTab(entryId, title, path);
                return {
                    tabs: [...state.tabs, newTab],
                    ...activateTab(state, newTab.id),
                };
            }

            const activeTab = state.tabs.find(
                (t) => t.id === state.activeTabId,
            );
            if (
                activeTab &&
                !isReviewTab(activeTab) &&
                !isMapTab(activeTab) &&
                !isGraphTab(activeTab)
            ) {
                const tab = isNoteTab(activeTab)
                    ? ensureNoteTabHistory(activeTab)
                    : isPdfTab(activeTab)
                      ? ensurePdfTabDefaults(activeTab)
                      : ensureFileTabDefaults(activeTab);
                if (isPdfTab(tab) && tab.entryId === entryId) {
                    return state;
                }
                const kept = tab.history.slice(0, tab.historyIndex);
                kept.push(
                    createHistoryEntryFromTab(tab),
                    createPdfHistoryEntry(
                        entryId,
                        title,
                        path,
                        1,
                        1,
                        "continuous",
                    ),
                );
                return {
                    tabs: state.tabs.map((tabItem) =>
                        tabItem.id === tab.id
                            ? buildTabFromHistory(tab.id, kept, kept.length - 1)
                            : tabItem,
                    ),
                };
            }

            const newTab = createPdfTab(entryId, title, path);
            return {
                tabs: [...state.tabs, newTab],
                ...activateTab(state, newTab.id),
            };
        });
    },

    openMap: (filePath, relativePath, title) => {
        set((state) => {
            const existing = state.tabs.find(
                (t) => isMapTab(t) && t.filePath === filePath,
            );
            if (existing) {
                return activateTab(state, existing.id);
            }
            const newTab = createMapTab(filePath, relativePath, title);
            return {
                tabs: [...state.tabs, newTab],
                ...activateTab(state, newTab.id),
            };
        });
    },

    openGraph: () => {
        set((state) => {
            const existing = state.tabs.find((t) => isGraphTab(t));
            if (existing) {
                return activateTab(state, existing.id);
            }
            const newTab = createGraphTab();
            return {
                tabs: [...state.tabs, newTab],
                ...activateTab(state, newTab.id),
            };
        });
    },

    openFile: (relativePath, title, path, content, mimeType, viewer) => {
        set((state) => {
            if (getTabOpenBehavior() === "new_tab") {
                const newTab = createFileTab(
                    relativePath,
                    title,
                    path,
                    content,
                    mimeType,
                    viewer,
                );
                return {
                    tabs: [...state.tabs, newTab],
                    ...activateTab(state, newTab.id),
                };
            }

            const activeTab = state.tabs.find(
                (t) => t.id === state.activeTabId,
            );
            if (
                activeTab &&
                !isReviewTab(activeTab) &&
                !isMapTab(activeTab) &&
                !isGraphTab(activeTab)
            ) {
                const tab = isNoteTab(activeTab)
                    ? ensureNoteTabHistory(activeTab)
                    : isPdfTab(activeTab)
                      ? ensurePdfTabDefaults(activeTab)
                      : ensureFileTabDefaults(activeTab);
                if (isFileTab(tab) && tab.relativePath === relativePath) {
                    return {
                        tabs: state.tabs.map((tabItem) =>
                            tabItem.id !== tab.id
                                ? tabItem
                                : buildTabFromHistory(
                                      tab.id,
                                      tab.history.map((entry, index) =>
                                          index === tab.historyIndex &&
                                          entry.kind === "file"
                                              ? createFileHistoryEntry(
                                                    relativePath,
                                                    title,
                                                    path,
                                                    content,
                                                    mimeType,
                                                    viewer,
                                                )
                                              : entry,
                                      ),
                                      tab.historyIndex,
                                  ),
                        ),
                    };
                }
                const kept = tab.history.slice(0, tab.historyIndex);
                kept.push(
                    createHistoryEntryFromTab(tab),
                    createFileHistoryEntry(
                        relativePath,
                        title,
                        path,
                        content,
                        mimeType,
                        viewer,
                    ),
                );
                return {
                    tabs: state.tabs.map((tabItem) =>
                        tabItem.id === tab.id
                            ? buildTabFromHistory(tab.id, kept, kept.length - 1)
                            : tabItem,
                    ),
                };
            }

            const newTab = createFileTab(
                relativePath,
                title,
                path,
                content,
                mimeType,
                viewer,
            );
            return {
                tabs: [...state.tabs, newTab],
                ...activateTab(state, newTab.id),
            };
        });
    },

    openReview: (sessionId, options) => {
        set((state) => {
            const existing = state.tabs.find(
                (tab) => isReviewTab(tab) && tab.sessionId === sessionId,
            );
            if (existing) {
                const nextTitle = options?.title ?? existing.title;
                const nextTabs =
                    nextTitle === existing.title
                        ? state.tabs
                        : state.tabs.map((tab) =>
                              tab.id === existing.id
                                  ? { ...tab, title: nextTitle }
                                  : tab,
                          );
                if (options?.background) {
                    return nextTabs === state.tabs ? state : { tabs: nextTabs };
                }
                return {
                    tabs: nextTabs,
                    ...activateTab(state, existing.id),
                };
            }

            const newTab: ReviewTab = {
                id: crypto.randomUUID(),
                kind: "ai-review",
                sessionId,
                title: options?.title ?? "Review",
            };

            if (options?.background) {
                return { tabs: [...state.tabs, newTab] };
            }

            return {
                tabs: [...state.tabs, newTab],
                ...activateTab(state, newTab.id),
            };
        });
    },

    closeReview: (sessionId) => {
        const tab = get().tabs.find(
            (t) => isReviewTab(t) && t.sessionId === sessionId,
        );
        if (tab) get().closeTab(tab.id);
    },

    goBack: () => {
        if (getTabOpenBehavior() === "history") {
            const tab = get().tabs.find((t) => t.id === get().activeTabId);
            if (!tab) return;
            if (isNoteTab(tab) || isFileTab(tab) || isPdfTab(tab)) {
                get().navigateToHistoryIndex(tab.historyIndex - 1);
            }
            return;
        }

        const { tabs, tabNavigationHistory, tabNavigationIndex } = get();
        for (let idx = tabNavigationIndex - 1; idx >= 0; idx -= 1) {
            const tabId = tabNavigationHistory[idx];
            if (!tabs.some((tab) => tab.id === tabId)) continue;
            set((state) => ({
                ...activateTab(state, tabId, { recordNavigation: false }),
                tabNavigationIndex: idx,
            }));
            return;
        }
    },

    goForward: () => {
        if (getTabOpenBehavior() === "history") {
            const tab = get().tabs.find((t) => t.id === get().activeTabId);
            if (!tab) return;
            if (isNoteTab(tab) || isFileTab(tab) || isPdfTab(tab)) {
                get().navigateToHistoryIndex(tab.historyIndex + 1);
            }
            return;
        }

        const { tabs, tabNavigationHistory, tabNavigationIndex } = get();
        for (
            let idx = tabNavigationIndex + 1;
            idx < tabNavigationHistory.length;
            idx += 1
        ) {
            const tabId = tabNavigationHistory[idx];
            if (!tabs.some((tab) => tab.id === tabId)) continue;
            set((state) => ({
                ...activateTab(state, tabId, { recordNavigation: false }),
                tabNavigationIndex: idx,
            }));
            return;
        }
    },

    navigateToHistoryIndex: (targetIndex) => {
        const state = get();
        const tabIdx = state.tabs.findIndex((t) => t.id === state.activeTabId);
        if (tabIdx === -1) return;
        const raw = state.tabs[tabIdx];
        if (isReviewTab(raw)) return;
        const tab = isNoteTab(raw)
            ? ensureNoteTabHistory(raw)
            : isPdfTab(raw)
              ? ensurePdfTabDefaults(raw)
              : isFileTab(raw)
                ? ensureFileTabDefaults(raw)
                : null;
        if (!tab) return;
        if (targetIndex < 0 || targetIndex >= tab.history.length) return;
        if (targetIndex === tab.historyIndex) return;

        const currentSnapshot = createHistoryEntryFromTab(tab);
        const history = tab.history.map((h, i) =>
            i === tab.historyIndex ? currentSnapshot : h,
        );
        const entry = history[targetIndex];

        const tabs = [...state.tabs];
        tabs[tabIdx] = buildTabFromHistory(tab.id, history, targetIndex);
        set({ tabs });

        if (entry.kind === "note" && !entry.content) {
            void loadNoteHistoryEntryContent(tab.id, targetIndex, entry.noteId);
        }

        if (entry.kind === "file" && !entry.content) {
            void loadFileHistoryEntryContent(
                tab.id,
                targetIndex,
                entry.relativePath,
            );
        }
    },

    closeTab: (tabId) => {
        set((state) => {
            const idx = state.tabs.findIndex((t) => t.id === tabId);
            const tabs = state.tabs.filter((t) => t.id !== tabId);
            let activeTabId = state.activeTabId;
            const activationHistory = state.activationHistory.filter(
                (id) => id !== tabId,
            );
            const tabNavigationHistory = state.tabNavigationHistory.filter(
                (id) => id !== tabId,
            );
            let tabNavigationIndex = Math.min(
                state.tabNavigationIndex,
                tabNavigationHistory.length - 1,
            );
            if (activeTabId === tabId) {
                activeTabId =
                    [...activationHistory]
                        .reverse()
                        .find((id) => tabs.some((tab) => tab.id === id)) ??
                    tabs[Math.min(idx, tabs.length - 1)]?.id ??
                    null;
            }
            if (activeTabId) {
                const lastActiveIndex =
                    tabNavigationHistory.lastIndexOf(activeTabId);
                if (lastActiveIndex === -1) {
                    const navigation = pushTabToNavigation(
                        tabNavigationHistory,
                        tabNavigationIndex,
                        activeTabId,
                    );
                    return {
                        tabs,
                        activeTabId,
                        activationHistory,
                        tabNavigationHistory: navigation.history,
                        tabNavigationIndex: navigation.index,
                    };
                }
                tabNavigationIndex = lastActiveIndex;
            } else {
                tabNavigationIndex = -1;
            }
            return {
                tabs,
                activeTabId,
                activationHistory,
                tabNavigationHistory,
                tabNavigationIndex,
            };
        });
    },

    switchTab: (tabId) => set((state) => activateTab(state, tabId)),

    updateTabContent: (tabId, content) => {
        set((state) => ({
            tabs: state.tabs.map((t) => {
                if (t.id !== tabId) return t;
                if (isNoteTab(t)) {
                    const tab = ensureNoteTabHistory(t);
                    return buildTabFromHistory(
                        tab.id,
                        tab.history.map((entry, index) =>
                            index === tab.historyIndex && entry.kind === "note"
                                ? { ...entry, content }
                                : entry,
                        ),
                        tab.historyIndex,
                    );
                }
                if (isFileTab(t)) {
                    const tab = ensureFileTabDefaults(t);
                    return buildTabFromHistory(
                        tab.id,
                        tab.history.map((entry, index) =>
                            index === tab.historyIndex && entry.kind === "file"
                                ? { ...entry, content }
                                : entry,
                        ),
                        tab.historyIndex,
                    );
                }
                return t;
            }),
        }));
    },

    updateTabTitle: (tabId, title) => {
        set((state) => ({
            tabs: state.tabs.map((t) => {
                if (t.id !== tabId) return t;
                if (isReviewTab(t)) return { ...t, title };
                if (isMapTab(t)) return { ...t, title };
                if (isGraphTab(t)) return { ...t, title };
                const tab = isNoteTab(t)
                    ? ensureNoteTabHistory(t)
                    : isPdfTab(t)
                      ? ensurePdfTabDefaults(t)
                      : ensureFileTabDefaults(t);
                if (!tab.history?.length) return { ...tab, title };
                const history = [...tab.history];
                if (history[tab.historyIndex]) {
                    history[tab.historyIndex] = {
                        ...history[tab.historyIndex],
                        title,
                    };
                }
                return buildTabFromHistory(tab.id, history, tab.historyIndex);
            }),
        }));
    },

    updatePdfPage: (tabId, page) => {
        set((state) => ({
            tabs: state.tabs.map((t) =>
                t.id !== tabId || !isPdfTab(t)
                    ? t
                    : ((tab) =>
                          buildTabFromHistory(
                              tab.id,
                              tab.history.map((entry, index) =>
                                  index === tab.historyIndex &&
                                  entry.kind === "pdf"
                                      ? { ...entry, page }
                                      : entry,
                              ),
                              tab.historyIndex,
                          ))(ensurePdfTabDefaults(t)),
            ),
        }));
    },

    updatePdfZoom: (tabId, zoom) => {
        set((state) => ({
            tabs: state.tabs.map((t) =>
                t.id !== tabId || !isPdfTab(t)
                    ? t
                    : ((tab) =>
                          buildTabFromHistory(
                              tab.id,
                              tab.history.map((entry, index) =>
                                  index === tab.historyIndex &&
                                  entry.kind === "pdf"
                                      ? { ...entry, zoom }
                                      : entry,
                              ),
                              tab.historyIndex,
                          ))(ensurePdfTabDefaults(t)),
            ),
        }));
    },

    updatePdfViewMode: (tabId, viewMode) => {
        set((state) => ({
            tabs: state.tabs.map((t) =>
                t.id !== tabId || !isPdfTab(t)
                    ? t
                    : ((tab) =>
                          buildTabFromHistory(
                              tab.id,
                              tab.history.map((entry, index) =>
                                  index === tab.historyIndex &&
                                  entry.kind === "pdf"
                                      ? { ...entry, viewMode }
                                      : entry,
                              ),
                              tab.historyIndex,
                          ))(ensurePdfTabDefaults(t)),
            ),
        }));
    },

    reorderTabs: (fromIndex, toIndex) => {
        set((state) => {
            const tabs = [...state.tabs];
            const [tab] = tabs.splice(fromIndex, 1);
            tabs.splice(toIndex, 0, tab);
            return { tabs };
        });
    },

    hydrateTabs: (tabs, activeTabId) => {
        const hydratedTabs: Tab[] = tabs
            .filter((tab) => tab.kind !== "ai-review")
            .map((tab) =>
                tab.kind === "pdf"
                    ? ensurePdfTabDefaults(tab)
                    : tab.kind === "file"
                      ? ensureFileTabDefaults(tab)
                      : tab.kind === "map"
                        ? ensureMapTabDefaults(tab)
                        : tab.kind === "graph"
                          ? tab
                          : ensureNoteTabHistory(tab),
            );
        const nextActiveTabId =
            activeTabId && hydratedTabs.some((tab) => tab.id === activeTabId)
                ? activeTabId
                : (hydratedTabs[0]?.id ?? null);
        set({
            tabs: hydratedTabs,
            activeTabId: nextActiveTabId,
            activationHistory: nextActiveTabId ? [nextActiveTabId] : [],
            tabNavigationHistory: nextActiveTabId ? [nextActiveTabId] : [],
            tabNavigationIndex: nextActiveTabId ? 0 : -1,
        });
    },

    insertExternalTab: (tab, index) => {
        set((state) => {
            const incoming: Tab =
                tab.kind === "pdf"
                    ? ensurePdfTabDefaults(tab)
                    : tab.kind === "file"
                      ? ensureFileTabDefaults(tab)
                      : tab.kind === "ai-review"
                        ? tab
                        : tab.kind === "map"
                          ? ensureMapTabDefaults(tab)
                          : tab.kind === "graph"
                            ? tab
                            : ensureNoteTabHistory(tab);
            const tabs = state.tabs.filter(
                (existing) => existing.id !== incoming.id,
            );
            const boundedIndex =
                index === undefined
                    ? tabs.length
                    : Math.max(0, Math.min(index, tabs.length));

            tabs.splice(boundedIndex, 0, incoming);
            return {
                tabs,
                ...activateTab(state, incoming.id),
            };
        });
    },

    queueReveal: (pendingReveal) => set({ pendingReveal }),

    clearPendingReveal: () => set({ pendingReveal: null }),

    queueSelectionReveal: (pendingSelectionReveal) =>
        set({ pendingSelectionReveal }),

    clearPendingSelectionReveal: () => set({ pendingSelectionReveal: null }),

    setCurrentSelection: (currentSelection) => set({ currentSelection }),

    clearCurrentSelection: () => set({ currentSelection: null }),

    reloadNoteContent: (noteId, detail) => {
        set((state) => ({
            tabs: state.tabs.map((t) => {
                if (!isNoteTab(t) || t.noteId !== noteId) return t;
                if (t.content === detail.content && t.title === detail.title) {
                    return t;
                }
                return { ...t, content: detail.content, title: detail.title };
            }),
        }));
    },

    forceReloadNoteContent: (noteId, detail) => {
        set((state) => {
            const next = new Set(state._pendingForceReloads);
            next.add(noteId);
            return {
                _pendingForceReloads: next,
                tabs: state.tabs.map((t) => {
                    if (!isNoteTab(t) || t.noteId !== noteId) return t;
                    if (
                        t.content === detail.content &&
                        t.title === detail.title
                    ) {
                        return t;
                    }
                    return {
                        ...t,
                        content: detail.content,
                        title: detail.title,
                    };
                }),
            };
        });
    },

    clearForceReload: (noteId) => {
        set((state) => {
            if (!state._pendingForceReloads.has(noteId)) return state;
            const next = new Set(state._pendingForceReloads);
            next.delete(noteId);
            return { _pendingForceReloads: next };
        });
    },

    handleNoteDeleted: (noteId) => {
        const tabsToClose = get().tabs.filter(
            (t) => isNoteTab(t) && t.noteId === noteId,
        );
        for (const tab of tabsToClose) {
            get().closeTab(tab.id);
        }
    },

    handleNoteRenamed: (oldNoteId, newNoteId, newTitle) => {
        set((state) => ({
            tabs: state.tabs.map((t) => {
                if (!isNoteTab(t) || t.noteId !== oldNoteId) return t;
                return { ...t, noteId: newNoteId, title: newTitle };
            }),
        }));
    },
}));

// Load content for a history entry that was restored without content (e.g. after session restore)
async function loadNoteHistoryEntryContent(
    tabId: string,
    historyIndex: number,
    noteId: string,
) {
    try {
        const detail = await vaultInvoke<{ content: string }>("read_note", {
            noteId,
        });
        useEditorStore.setState((state) => ({
            tabs: state.tabs.map((t) => {
                if (t.id !== tabId || isReviewTab(t)) return t;
                const tab = isNoteTab(t)
                    ? ensureNoteTabHistory(t)
                    : isPdfTab(t)
                      ? ensurePdfTabDefaults(t)
                      : isFileTab(t)
                        ? ensureFileTabDefaults(t)
                        : null;
                if (!tab) return t;
                const history = [...tab.history];
                if (
                    history[historyIndex]?.kind === "note" &&
                    history[historyIndex].noteId === noteId
                ) {
                    history[historyIndex] = {
                        ...history[historyIndex],
                        content: detail.content,
                    };
                }
                return buildTabFromHistory(tab.id, history, tab.historyIndex);
            }),
        }));
    } catch (e) {
        console.error("Error loading history entry content:", e);
    }
}

async function loadFileHistoryEntryContent(
    tabId: string,
    historyIndex: number,
    relativePath: string,
) {
    try {
        const detail = await vaultInvoke<{ content: string }>(
            "read_vault_file",
            {
                relativePath,
            },
        );
        useEditorStore.setState((state) => ({
            tabs: state.tabs.map((t) => {
                if (t.id !== tabId || isReviewTab(t)) return t;
                const tab = isNoteTab(t)
                    ? ensureNoteTabHistory(t)
                    : isPdfTab(t)
                      ? ensurePdfTabDefaults(t)
                      : isFileTab(t)
                        ? ensureFileTabDefaults(t)
                        : null;
                if (!tab) return t;
                const history = [...tab.history];
                if (
                    history[historyIndex]?.kind === "file" &&
                    history[historyIndex].relativePath === relativePath
                ) {
                    history[historyIndex] = {
                        ...history[historyIndex],
                        content: detail.content,
                    };
                }
                return buildTabFromHistory(tab.id, history, tab.historyIndex);
            }),
        }));
    } catch (e) {
        console.error("Error loading file history entry content:", e);
    }
}

// Debounced session persistence — only write when tab list or active tab changes
let _sessionTimer: ReturnType<typeof setTimeout> | null = null;
let _lastSessionJson = "";
let _lastSessionSig = "";

useEditorStore.subscribe((state) => {
    if (!sessionReady) return;

    const vaultPath = useVaultStore.getState().vaultPath;
    if (!vaultPath) return;

    // Cheap fingerprint: skip expensive serialization on content-only edits
    let sig = state.activeTabId ?? "";
    for (const t of state.tabs) {
        if (isReviewTab(t)) {
            // Review tabs are transient — skip persistence fingerprint
            continue;
        } else if (isNoteTab(t)) {
            sig += `|note|${t.noteId}|${t.title}|${t.historyIndex}|${t.history.length}`;
        } else if (isMapTab(t)) {
            sig += `|map|${t.filePath}|${t.title}`;
        } else if (isGraphTab(t)) {
            sig += `|graph`;
        } else if (isFileTab(t)) {
            sig += `|file|${t.relativePath}|${t.title}|${t.mimeType ?? ""}`;
        } else {
            const pdfTab = ensurePdfTabDefaults(t);
            sig += `|pdf|${pdfTab.entryId}|${pdfTab.title}|${pdfTab.historyIndex}|${pdfTab.history.length}`;
        }
    }
    if (sig === _lastSessionSig) return;
    _lastSessionSig = sig;

    const activeTab = state.tabs.find((t) => t.id === state.activeTabId);
    const persistedTabs = state.tabs
        .filter(
            (tab): tab is NoteTab | PdfTab | FileTab =>
                !isReviewTab(tab) && !isMapTab(tab) && !isGraphTab(tab),
        )
        .map((tab) =>
            isPdfTab(tab)
                ? ensurePdfTabDefaults(tab)
                : isFileTab(tab)
                  ? ensureFileTabDefaults(tab)
                  : ensureNoteTabHistory(tab),
        );
    const noteTabs = persistedTabs.filter((tab): tab is NoteTab =>
        isNoteTab(tab),
    );
    const session: PersistedSession = {
        tabs: persistedTabs.map((tab) =>
            isPdfTab(tab)
                ? {
                      id: tab.id,
                      kind: "pdf",
                      entryId: tab.entryId,
                      title: tab.title,
                      path: tab.path,
                      page: tab.page,
                      zoom: tab.zoom,
                      viewMode: tab.viewMode,
                      history: tab.history,
                      historyIndex: tab.historyIndex,
                  }
                : isFileTab(tab)
                  ? {
                        id: tab.id,
                        kind: "file",
                        relativePath: tab.relativePath,
                        title: tab.title,
                        path: tab.path,
                        mimeType: tab.mimeType,
                        viewer: tab.viewer,
                        content: tab.content,
                        history: tab.history,
                        historyIndex: tab.historyIndex,
                    }
                  : {
                        id: tab.id,
                        kind: "note",
                        noteId: tab.noteId,
                        title: tab.title,
                        content: tab.content,
                        history: tab.history,
                        historyIndex: tab.historyIndex,
                    },
        ),
        activeTabId: activeTab?.id ?? null,
        noteIds: noteTabs
            .filter((t) => t.noteId)
            .map((t) => ({
                noteId: t.noteId,
                title: t.title,
                history: t.history
                    .filter((h): h is NoteHistoryEntry => h.kind === "note")
                    .map((h) => ({
                        noteId: h.noteId,
                        title: h.title,
                    })),
                historyIndex: t.historyIndex,
            })),
        pdfTabs: persistedTabs.flatMap((rawTab) => {
            if (!isPdfTab(rawTab)) return [];
            const t = ensurePdfTabDefaults(rawTab);
            return [
                {
                    entryId: t.entryId,
                    title: t.title,
                    path: t.path,
                    page: t.page,
                    zoom: t.zoom,
                    viewMode: t.viewMode,
                    history: t.history
                        .filter(
                            (entry): entry is PdfHistoryEntry =>
                                entry.kind === "pdf",
                        )
                        .map((entry) => ({
                            entryId: entry.entryId,
                            title: entry.title,
                            path: entry.path,
                            page: entry.page,
                            zoom: entry.zoom,
                            viewMode: entry.viewMode,
                        })),
                    historyIndex: t.historyIndex,
                },
            ];
        }),
        fileTabs: persistedTabs.flatMap((rawTab) => {
            if (!isFileTab(rawTab)) return [];
            const t = ensureFileTabHistory(rawTab);
            return [
                {
                    relativePath: t.relativePath,
                    title: t.title,
                    path: t.path,
                    mimeType: t.mimeType,
                    viewer: t.viewer,
                    content: t.content,
                    history: t.history
                        .filter((h): h is FileHistoryEntry => h.kind === "file")
                        .map((h) => ({
                            relativePath: h.relativePath,
                            title: h.title,
                            path: h.path,
                            mimeType: h.mimeType,
                            viewer: h.viewer,
                        })),
                    historyIndex: t.historyIndex,
                },
            ];
        }),
        mapTabs: state.tabs
            .filter((t): t is MapTab => isMapTab(t))
            .map((t) => ({
                filePath: t.filePath,
                relativePath: t.relativePath,
                title: t.title,
            })),
        hasGraphTab: state.tabs.some((t) => isGraphTab(t)),
        activeNoteId:
            activeTab && isNoteTab(activeTab) ? activeTab.noteId : null,
        activePdfEntryId:
            activeTab && isPdfTab(activeTab) ? activeTab.entryId : null,
        activeFilePath:
            activeTab && isFileTab(activeTab) ? activeTab.relativePath : null,
        activeMapFilePath:
            activeTab && isMapTab(activeTab) ? activeTab.filePath : null,
        activeGraphTab: activeTab ? isGraphTab(activeTab) : false,
    };
    const json = JSON.stringify(session);
    if (json === _lastSessionJson) return;

    if (_sessionTimer) clearTimeout(_sessionTimer);
    _sessionTimer = setTimeout(() => {
        _lastSessionJson = json;
        localStorage.setItem(getSessionKey(vaultPath), json);
    }, 500);
});
