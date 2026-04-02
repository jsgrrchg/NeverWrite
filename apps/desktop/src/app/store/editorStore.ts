import { create } from "zustand";
import type { EditorTarget } from "../../features/editor/editorTargetResolver";
import {
    buildTabFromHistory,
    createGraphTab,
    createMapTab,
    ensureFileTabDefaults,
    ensureFileTabHistory,
    ensureNoteTabHistory,
    ensurePdfTabDefaults,
    isFileTab,
    isGraphTab,
    isHistoryTab,
    isMapTab,
    isNoteTab,
    isPdfTab,
    isReviewTab,
    type FileHistoryEntry,
    type FileTab,
    type FileTabInput,
    type FileViewerMode,
    type HistoryTab,
    type GraphTab,
    type MapTab,
    type MapTabInput,
    type NoteHistoryEntry,
    type NoteTab,
    type NoteTabInput,
    type PdfHistoryEntry,
    type PdfTab,
    type PdfTabInput,
    type PdfViewMode,
    type RecentlyClosedTab,
    type ReviewTab,
    type Tab,
    type TabHistoryEntry,
    type TabInput,
    type TabCloseReason,
} from "./editorTabs";
import {
    getHistoryTabHandler,
    getOpenableHistoryTabHandler,
    normalizeHistoryTab,
    type HistoryTabHandler,
    type OpenableHistoryPayload,
    type OpenableHistoryTabKind,
} from "./editorTabRegistry";
import { safeStorageGetItem, safeStorageSetItem } from "../utils/safeStorage";
import { vaultInvoke } from "../utils/vaultInvoke";
import { useSettingsStore } from "./settingsStore";
import { useVaultStore } from "./vaultStore";

export {
    isFileTab,
    isGraphTab,
    isHistoryTab,
    isMapTab,
    isNoteTab,
    isPdfTab,
    isResourceBackedTab,
    isReviewTab,
    isTransientTab,
} from "./editorTabs";
export type {
    FileHistoryEntry,
    FileTab,
    FileTabInput,
    FileViewerMode,
    GraphTab,
    HistoryTab,
    HistoryTabInput,
    MapTab,
    MapTabInput,
    NoteHistoryEntry,
    NoteTab,
    NoteTabInput,
    PdfHistoryEntry,
    PdfTab,
    PdfTabInput,
    PdfViewMode,
    ResourceBackedTab,
    ReviewTab,
    Tab,
    TabCloseReason,
    TabHistoryEntry,
    TabInput,
    TransientTab,
} from "./editorTabs";

const SESSION_KEY = "vaultai.session.tabs";
const SESSION_KEY_PREFIX = "vaultai.session.tabs:";
const MAX_RECENTLY_CLOSED_TABS = 20;

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
        content?: string;
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
        relativePath: string;
        title: string;
        filePath?: string;
    }>;
    hasGraphTab?: boolean;
    activeNoteId: string | null;
    activePdfEntryId?: string | null;
    activeFilePath?: string | null;
    activeMapRelativePath?: string | null;
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

function replaceTab(tabs: Tab[], tabId: string, nextTab: Tab) {
    return tabs.map((tab) => (tab.id === tabId ? nextTab : tab));
}

function getReusableHistoryTab(
    state: Pick<EditorStore, "tabs" | "activeTabId">,
): HistoryTab | null {
    const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId);
    if (!activeTab || !isHistoryTab(activeTab) || isMapTab(activeTab)) {
        return null;
    }
    return normalizeHistoryTab(activeTab);
}

function createHistorySnapshot(tab: HistoryTab): TabHistoryEntry {
    if (isNoteTab(tab)) {
        return getHistoryTabHandler("note").entryFromTab(tab);
    }
    if (isPdfTab(tab)) {
        return getHistoryTabHandler("pdf").entryFromTab(tab);
    }
    if (isFileTab(tab)) {
        return getHistoryTabHandler("file").entryFromTab(tab);
    }
    return getHistoryTabHandler("map").entryFromTab(tab);
}

function openOrReuseHistoryTab<K extends OpenableHistoryTabKind>(
    state: Pick<
        EditorStore,
        | "tabs"
        | "activeTabId"
        | "activationHistory"
        | "tabNavigationHistory"
        | "tabNavigationIndex"
    >,
    payload: Extract<OpenableHistoryPayload, { kind: K }>,
) {
    const handler = getOpenableHistoryTabHandler(
        payload.kind,
    ) as HistoryTabHandler<K>;

    if (getTabOpenBehavior() === "new_tab") {
        const newTab = handler.createInitialTab(payload);
        return {
            tabs: [...state.tabs, newTab],
            ...activateTab(state, newTab.id),
        };
    }

    const activeTab = getReusableHistoryTab(state);
    if (!activeTab) {
        const newTab = handler.createInitialTab(payload);
        return {
            tabs: [...state.tabs, newTab],
            ...activateTab(state, newTab.id),
        };
    }

    if (activeTab.kind === payload.kind) {
        const typedActiveTab = activeTab as Extract<HistoryTab, { kind: K }>;
        if (handler.matchesOpenTarget(typedActiveTab, payload)) {
            if (!handler.replaceCurrentEntry) {
                return state;
            }
            const nextTab = handler.replaceCurrentEntry(
                typedActiveTab,
                payload,
            );
            return {
                tabs: replaceTab(state.tabs, nextTab.id, nextTab),
            };
        }
    }

    const kept = activeTab.history.slice(0, activeTab.historyIndex);
    kept.push(
        createHistorySnapshot(activeTab),
        handler.createOpenEntry(payload),
    );
    const nextTab = handler.buildFromHistory(
        activeTab.id,
        kept,
        kept.length - 1,
    );
    return {
        tabs: replaceTab(state.tabs, activeTab.id, nextTab),
    };
}

function normalizeHydratedTab(tab: TabInput): Tab | null {
    if (isReviewTab(tab)) {
        return null;
    }
    if (isHistoryTab(tab)) {
        return normalizeHistoryTab(tab);
    }
    if (isGraphTab(tab)) {
        return tab;
    }
    return null;
}

function normalizeExternalTab(tab: TabInput): Tab | null {
    if (isHistoryTab(tab)) {
        return normalizeHistoryTab(tab);
    }
    if (isReviewTab(tab) || isGraphTab(tab)) {
        return tab;
    }
    return null;
}

function getSessionKey(vaultPath: string) {
    return `${SESSION_KEY_PREFIX}${vaultPath}`;
}

export function readPersistedSession(
    vaultPath: string | null,
): PersistedSession | null {
    try {
        const raw =
            (vaultPath ? safeStorageGetItem(getSessionKey(vaultPath)) : null) ??
            safeStorageGetItem(SESSION_KEY);
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
function shouldRememberClosedTab(reason: TabCloseReason) {
    return reason === "user" || reason === "bulk-user";
}

function pushRecentlyClosedTab(
    entries: RecentlyClosedTab[],
    tab: Tab,
    index: number,
) {
    const next = entries.filter((entry) => entry.tab.id !== tab.id);
    next.push({
        tab,
        index: Math.max(0, index),
    });
    return next.slice(-MAX_RECENTLY_CLOSED_TABS);
}

function getTabOpenBehavior() {
    return useSettingsStore.getState().tabOpenBehavior;
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
    noteId: string | null;
    path: string | null;
    text: string;
    from: number;
    to: number;
    startLine: number;
    endLine: number;
}

export interface ReloadedDetail {
    content: string;
    title: string;
    origin?: "user" | "agent" | "external" | "system" | "unknown";
    opId?: string | null;
    revision?: number;
    contentHash?: string | null;
}

type ReloadedNoteDetail = ReloadedDetail;
type ReloadedFileDetail = ReloadedDetail;

interface NoteReloadMetadata {
    origin: "user" | "agent" | "external" | "system" | "unknown";
    opId: string | null;
    revision: number;
    contentHash: string | null;
}

interface FileReloadMetadata {
    origin: "user" | "agent" | "external" | "system" | "unknown";
    opId: string | null;
    revision: number;
    contentHash: string | null;
}

interface EditorStore {
    tabs: Tab[];
    activeTabId: string | null;
    recentlyClosedTabs: RecentlyClosedTab[];
    activationHistory: string[];
    tabNavigationHistory: string[];
    tabNavigationIndex: number;
    pendingReveal: PendingReveal | null;
    pendingSelectionReveal: PendingSelectionReveal | null;
    currentSelection: EditorSelectionContext | null;
    _pendingForceReloads: Set<string>;
    _pendingForceFileReloads: Set<string>;
    _noteReloadVersions: Record<string, number>;
    _fileReloadVersions: Record<string, number>;
    _noteReloadMetadata: Record<string, NoteReloadMetadata | undefined>;
    _fileReloadMetadata: Record<string, FileReloadMetadata | undefined>;
    noteExternalConflicts: Set<string>;
    fileExternalConflicts: Set<string>;
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
    openMap: (relativePath: string, title: string) => void;
    openGraph: () => void;
    openReview: (
        sessionId: string,
        options?: { background?: boolean; title?: string },
    ) => void;
    closeReview: (sessionId: string) => void;
    goBack: () => void;
    goForward: () => void;
    navigateToHistoryIndex: (index: number) => void;
    closeTab: (tabId: string, options?: { reason?: TabCloseReason }) => void;
    reopenLastClosedTab: () => void;
    switchTab: (tabId: string) => void;
    updateTabContent: (tabId: string, content: string) => void;
    updateTabTitle: (tabId: string, title: string) => void;
    updateFileHistoryTitle: (
        tabId: string,
        relativePath: string,
        title: string,
    ) => void;
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
    reloadFileContent: (
        relativePath: string,
        detail: ReloadedFileDetail,
    ) => void;
    forceReloadNoteContent: (
        noteId: string,
        detail: ReloadedNoteDetail,
    ) => void;
    forceReloadFileContent: (
        relativePath: string,
        detail: ReloadedFileDetail,
    ) => void;
    forceReloadEditorTarget: (
        target: EditorTarget,
        detail: ReloadedDetail,
    ) => void;
    clearForceReload: (noteId: string) => void;
    clearForceFileReload: (relativePath: string) => void;
    markNoteExternalConflict: (noteId: string) => void;
    clearNoteExternalConflict: (noteId: string) => void;
    markFileExternalConflict: (relativePath: string) => void;
    clearFileExternalConflict: (relativePath: string) => void;
    handleNoteDeleted: (noteId: string) => void;
    handleFileDeleted: (relativePath: string) => void;
    handleNoteRenamed: (
        oldNoteId: string,
        newNoteId: string,
        newTitle: string,
    ) => void;
}

export const useEditorStore = create<EditorStore>((set, get) => ({
    tabs: [],
    activeTabId: null,
    recentlyClosedTabs: [],
    activationHistory: [],
    tabNavigationHistory: [],
    tabNavigationIndex: -1,
    pendingReveal: null,
    pendingSelectionReveal: null,
    currentSelection: null,
    _pendingForceReloads: new Set<string>(),
    _pendingForceFileReloads: new Set<string>(),
    _noteReloadVersions: {},
    _fileReloadVersions: {},
    _noteReloadMetadata: {},
    _fileReloadMetadata: {},
    noteExternalConflicts: new Set<string>(),
    fileExternalConflicts: new Set<string>(),

    openNote: (noteId, title, content) => {
        set((state) =>
            openOrReuseHistoryTab(state, {
                kind: "note",
                noteId,
                title,
                content,
            }),
        );
    },

    openPdf: (entryId, title, path) => {
        set((state) =>
            openOrReuseHistoryTab(state, {
                kind: "pdf",
                entryId,
                title,
                path,
            }),
        );
    },

    openMap: (relativePath, title) => {
        set((state) => {
            const existing = state.tabs.find(
                (t) => isMapTab(t) && t.relativePath === relativePath,
            );
            if (existing) {
                return activateTab(state, existing.id);
            }
            const newTab = createMapTab(relativePath, title);
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
        set((state) =>
            openOrReuseHistoryTab(state, {
                kind: "file",
                relativePath,
                title,
                path,
                content,
                mimeType,
                viewer,
            }),
        );
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
        if (!isHistoryTab(raw) || isMapTab(raw)) return;
        const tab = normalizeHistoryTab(raw);
        if (targetIndex < 0 || targetIndex >= tab.history.length) return;
        if (targetIndex === tab.historyIndex) return;

        const currentSnapshot = createHistorySnapshot(tab);
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

    closeTab: (tabId, options) => {
        set((state) => {
            const idx = state.tabs.findIndex((t) => t.id === tabId);
            if (idx === -1) return state;

            const closedTab = state.tabs[idx];
            const tabs = state.tabs.filter((t) => t.id !== tabId);
            let activeTabId = state.activeTabId;
            const reason = options?.reason ?? "user";
            const recentlyClosedTabs = shouldRememberClosedTab(reason)
                ? pushRecentlyClosedTab(
                      state.recentlyClosedTabs,
                      closedTab,
                      idx,
                  )
                : state.recentlyClosedTabs;
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
                        recentlyClosedTabs,
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
                recentlyClosedTabs,
                activationHistory,
                tabNavigationHistory,
                tabNavigationIndex,
            };
        });
    },

    reopenLastClosedTab: () => {
        set((state) => {
            const closed =
                state.recentlyClosedTabs[state.recentlyClosedTabs.length - 1];
            if (!closed) return state;

            const tabs = state.tabs.filter(
                (existing) => existing.id !== closed.tab.id,
            );
            const insertIndex = Math.max(
                0,
                Math.min(closed.index, tabs.length),
            );
            tabs.splice(insertIndex, 0, closed.tab);

            return {
                tabs,
                recentlyClosedTabs: state.recentlyClosedTabs.slice(0, -1),
                ...activateTab(state, closed.tab.id),
            };
        });
    },

    switchTab: (tabId) =>
        set((state) =>
            state.activeTabId === tabId ? state : activateTab(state, tabId),
        ),

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
                const tab = normalizeHistoryTab(t);
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

    updateFileHistoryTitle: (tabId, relativePath, title) => {
        set((state) => ({
            tabs: state.tabs.map((t) => {
                if (t.id !== tabId || !isFileTab(t)) return t;
                const tab = ensureFileTabDefaults(t);
                let didChange = false;
                const history = tab.history.map((entry) => {
                    if (
                        entry.kind !== "file" ||
                        entry.relativePath !== relativePath ||
                        entry.title === title
                    ) {
                        return entry;
                    }
                    didChange = true;
                    return {
                        ...entry,
                        title,
                    };
                });
                if (!didChange) {
                    return t;
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
        const hydratedTabs: Tab[] = tabs.flatMap((tab): Tab[] => {
            const normalized = normalizeHydratedTab(tab);
            return normalized ? [normalized] : [];
        });
        const nextActiveTabId =
            activeTabId && hydratedTabs.some((tab) => tab.id === activeTabId)
                ? activeTabId
                : (hydratedTabs[0]?.id ?? null);
        set({
            tabs: hydratedTabs,
            activeTabId: nextActiveTabId,
            recentlyClosedTabs: [],
            activationHistory: nextActiveTabId ? [nextActiveTabId] : [],
            tabNavigationHistory: nextActiveTabId ? [nextActiveTabId] : [],
            tabNavigationIndex: nextActiveTabId ? 0 : -1,
        });
    },

    insertExternalTab: (tab, index) => {
        set((state) => {
            const incoming = normalizeExternalTab(tab);
            if (!incoming) {
                return state;
            }
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
            _noteReloadVersions: {
                ...state._noteReloadVersions,
                [noteId]: (state._noteReloadVersions[noteId] ?? 0) + 1,
            },
            _noteReloadMetadata: {
                ...state._noteReloadMetadata,
                [noteId]: {
                    origin: detail.origin ?? "unknown",
                    opId: detail.opId ?? null,
                    revision: detail.revision ?? 0,
                    contentHash: detail.contentHash ?? null,
                },
            },
            tabs: state.tabs.map((t) => {
                if (!isNoteTab(t) || t.noteId !== noteId) return t;
                if (t.content === detail.content && t.title === detail.title) {
                    return t;
                }
                return { ...t, content: detail.content, title: detail.title };
            }),
        }));
    },

    reloadFileContent: (relativePath, detail) => {
        set((state) => ({
            _fileReloadVersions: {
                ...state._fileReloadVersions,
                [relativePath]:
                    (state._fileReloadVersions[relativePath] ?? 0) + 1,
            },
            _fileReloadMetadata: {
                ...state._fileReloadMetadata,
                [relativePath]: {
                    origin: detail.origin ?? "unknown",
                    opId: detail.opId ?? null,
                    revision: detail.revision ?? 0,
                    contentHash: detail.contentHash ?? null,
                },
            },
            tabs: state.tabs.map((t) => {
                if (!isFileTab(t) || t.relativePath !== relativePath) return t;
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
                _noteReloadVersions: {
                    ...state._noteReloadVersions,
                    [noteId]: (state._noteReloadVersions[noteId] ?? 0) + 1,
                },
                _noteReloadMetadata: {
                    ...state._noteReloadMetadata,
                    [noteId]: {
                        origin: detail.origin ?? "system",
                        opId: detail.opId ?? null,
                        revision: detail.revision ?? 0,
                        contentHash: detail.contentHash ?? null,
                    },
                },
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

    forceReloadFileContent: (relativePath, detail) => {
        set((state) => {
            const next = new Set(state._pendingForceFileReloads);
            next.add(relativePath);
            return {
                _pendingForceFileReloads: next,
                _fileReloadVersions: {
                    ...state._fileReloadVersions,
                    [relativePath]:
                        (state._fileReloadVersions[relativePath] ?? 0) + 1,
                },
                _fileReloadMetadata: {
                    ...state._fileReloadMetadata,
                    [relativePath]: {
                        origin: detail.origin ?? "system",
                        opId: detail.opId ?? null,
                        revision: detail.revision ?? 0,
                        contentHash: detail.contentHash ?? null,
                    },
                },
                tabs: state.tabs.map((t) => {
                    if (!isFileTab(t) || t.relativePath !== relativePath) {
                        return t;
                    }
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

    forceReloadEditorTarget: (target, detail) => {
        if (!target.openTab) {
            return;
        }

        if (target.kind === "note") {
            get().forceReloadNoteContent(target.noteId, detail);
            return;
        }

        get().forceReloadFileContent(target.relativePath, {
            content: detail.content,
            title: detail.title,
            origin: detail.origin,
            opId: detail.opId,
            revision: detail.revision,
            contentHash: detail.contentHash,
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

    clearForceFileReload: (relativePath) => {
        set((state) => {
            if (!state._pendingForceFileReloads.has(relativePath)) return state;
            const next = new Set(state._pendingForceFileReloads);
            next.delete(relativePath);
            return { _pendingForceFileReloads: next };
        });
    },

    markNoteExternalConflict: (noteId) => {
        set((state) => {
            if (state.noteExternalConflicts.has(noteId)) return state;
            const next = new Set(state.noteExternalConflicts);
            next.add(noteId);
            return { noteExternalConflicts: next };
        });
    },

    clearNoteExternalConflict: (noteId) => {
        set((state) => {
            if (!state.noteExternalConflicts.has(noteId)) return state;
            const next = new Set(state.noteExternalConflicts);
            next.delete(noteId);
            return { noteExternalConflicts: next };
        });
    },

    markFileExternalConflict: (relativePath) => {
        set((state) => {
            if (state.fileExternalConflicts.has(relativePath)) return state;
            const next = new Set(state.fileExternalConflicts);
            next.add(relativePath);
            return { fileExternalConflicts: next };
        });
    },

    clearFileExternalConflict: (relativePath) => {
        set((state) => {
            if (!state.fileExternalConflicts.has(relativePath)) return state;
            const next = new Set(state.fileExternalConflicts);
            next.delete(relativePath);
            return { fileExternalConflicts: next };
        });
    },

    handleNoteDeleted: (noteId) => {
        set((state) => {
            const idsToClose = new Set(
                state.tabs
                    .filter((t) => isNoteTab(t) && t.noteId === noteId)
                    .map((t) => t.id),
            );
            const nextPendingForceReloads = new Set(state._pendingForceReloads);
            const nextNoteExternalConflicts = new Set(
                state.noteExternalConflicts,
            );
            const hadPendingForceReload =
                nextPendingForceReloads.delete(noteId);
            const hadExternalConflict =
                nextNoteExternalConflicts.delete(noteId);
            const hadReloadVersion = noteId in state._noteReloadVersions;
            const hadReloadMetadata = noteId in state._noteReloadMetadata;
            const nextNoteReloadVersions = hadReloadVersion
                ? Object.fromEntries(
                      Object.entries(state._noteReloadVersions).filter(
                          ([key]) => key !== noteId,
                      ),
                  )
                : state._noteReloadVersions;
            const nextNoteReloadMetadata = hadReloadMetadata
                ? Object.fromEntries(
                      Object.entries(state._noteReloadMetadata).filter(
                          ([key]) => key !== noteId,
                      ),
                  )
                : state._noteReloadMetadata;
            const didChange = idsToClose.size > 0;

            if (
                !didChange &&
                !hadPendingForceReload &&
                !hadExternalConflict &&
                !hadReloadVersion &&
                !hadReloadMetadata
            ) {
                return state;
            }

            const tabs = state.tabs.filter((t) => !idsToClose.has(t.id));
            const activationHistory = state.activationHistory.filter(
                (id) => !idsToClose.has(id),
            );
            const tabNavigationHistory = state.tabNavigationHistory.filter(
                (id) => !idsToClose.has(id),
            );

            let activeTabId = state.activeTabId;
            if (activeTabId && idsToClose.has(activeTabId)) {
                const closedIdx = state.tabs.findIndex(
                    (t) => t.id === activeTabId,
                );
                activeTabId =
                    [...activationHistory]
                        .reverse()
                        .find((id) => tabs.some((tab) => tab.id === id)) ??
                    tabs[Math.min(closedIdx, tabs.length - 1)]?.id ??
                    null;
            }

            let tabNavigationIndex = Math.min(
                state.tabNavigationIndex,
                tabNavigationHistory.length - 1,
            );
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
                        _pendingForceReloads: nextPendingForceReloads,
                        _noteReloadVersions: nextNoteReloadVersions,
                        _noteReloadMetadata: nextNoteReloadMetadata,
                        noteExternalConflicts: nextNoteExternalConflicts,
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
                _pendingForceReloads: nextPendingForceReloads,
                _noteReloadVersions: nextNoteReloadVersions,
                _noteReloadMetadata: nextNoteReloadMetadata,
                noteExternalConflicts: nextNoteExternalConflicts,
            };
        });
    },

    handleFileDeleted: (relativePath) => {
        set((state) => {
            let didChange = false;
            const idsToClose = new Set(
                state.tabs.flatMap((rawTab) => {
                    if (!isFileTab(rawTab)) {
                        return [];
                    }

                    const tab = ensureFileTabDefaults(rawTab);
                    const removedEntries = tab.history.filter(
                        (entry) =>
                            entry.kind === "file" &&
                            entry.relativePath === relativePath,
                    ).length;
                    if (removedEntries === 0) {
                        return [];
                    }

                    didChange = true;
                    return tab.history.length === removedEntries
                        ? [tab.id]
                        : [];
                }),
            );
            const tabs = state.tabs.flatMap((rawTab): Tab[] => {
                if (!isFileTab(rawTab)) {
                    return [rawTab];
                }

                const tab = ensureFileTabDefaults(rawTab);
                const removedBeforeOrAtCurrent = tab.history
                    .slice(0, tab.historyIndex + 1)
                    .filter(
                        (entry) =>
                            entry.kind === "file" &&
                            entry.relativePath === relativePath,
                    ).length;
                const history = tab.history.filter(
                    (entry) =>
                        entry.kind !== "file" ||
                        entry.relativePath !== relativePath,
                );

                if (history.length === tab.history.length) {
                    return [rawTab];
                }
                if (history.length === 0) {
                    return [];
                }

                const nextHistoryIndex = Math.min(
                    Math.max(0, tab.historyIndex - removedBeforeOrAtCurrent),
                    history.length - 1,
                );
                return [buildTabFromHistory(tab.id, history, nextHistoryIndex)];
            });

            const nextPendingForceFileReloads = new Set(
                state._pendingForceFileReloads,
            );
            const nextFileExternalConflicts = new Set(
                state.fileExternalConflicts,
            );
            const hadPendingForceReload =
                nextPendingForceFileReloads.delete(relativePath);
            const hadExternalConflict =
                nextFileExternalConflicts.delete(relativePath);
            const hadReloadVersion = relativePath in state._fileReloadVersions;
            const hadReloadMetadata = relativePath in state._fileReloadMetadata;
            const nextFileReloadVersions = hadReloadVersion
                ? Object.fromEntries(
                      Object.entries(state._fileReloadVersions).filter(
                          ([key]) => key !== relativePath,
                      ),
                  )
                : state._fileReloadVersions;
            const nextFileReloadMetadata = hadReloadMetadata
                ? Object.fromEntries(
                      Object.entries(state._fileReloadMetadata).filter(
                          ([key]) => key !== relativePath,
                      ),
                  )
                : state._fileReloadMetadata;

            if (
                !didChange &&
                !hadPendingForceReload &&
                !hadExternalConflict &&
                !hadReloadVersion &&
                !hadReloadMetadata
            ) {
                return state;
            }

            const activationHistory = state.activationHistory.filter(
                (id) => !idsToClose.has(id),
            );
            const tabNavigationHistory = state.tabNavigationHistory.filter(
                (id) => !idsToClose.has(id),
            );

            let activeTabId = state.activeTabId;
            if (activeTabId && idsToClose.has(activeTabId)) {
                const closedIdx = state.tabs.findIndex(
                    (t) => t.id === activeTabId,
                );
                activeTabId =
                    [...activationHistory]
                        .reverse()
                        .find((id) => tabs.some((tab) => tab.id === id)) ??
                    tabs[Math.min(closedIdx, tabs.length - 1)]?.id ??
                    null;
            }

            let tabNavigationIndex = Math.min(
                state.tabNavigationIndex,
                tabNavigationHistory.length - 1,
            );
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
                        _pendingForceFileReloads: nextPendingForceFileReloads,
                        _fileReloadVersions: nextFileReloadVersions,
                        _fileReloadMetadata: nextFileReloadMetadata,
                        fileExternalConflicts: nextFileExternalConflicts,
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
                _pendingForceFileReloads: nextPendingForceFileReloads,
                _fileReloadVersions: nextFileReloadVersions,
                _fileReloadMetadata: nextFileReloadMetadata,
                fileExternalConflicts: nextFileExternalConflicts,
            };
        });
    },

    handleNoteRenamed: (oldNoteId, newNoteId, newTitle) => {
        set((state) => ({
            tabs: state.tabs.map((t) => {
                if (!isNoteTab(t) || t.noteId !== oldNoteId) return t;
                return {
                    ...t,
                    noteId: newNoteId,
                    title: newTitle,
                    history: t.history?.map((entry) =>
                        entry.kind === "note" && entry.noteId === oldNoteId
                            ? { ...entry, noteId: newNoteId }
                            : entry,
                    ),
                };
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
                if (t.id !== tabId || !isHistoryTab(t) || isMapTab(t)) return t;
                const tab = normalizeHistoryTab(t);
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
                if (t.id !== tabId || !isHistoryTab(t) || isMapTab(t)) return t;
                const tab = normalizeHistoryTab(t);
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
            sig += `|map|${t.relativePath}|${t.title}`;
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
                isHistoryTab(tab) && !isMapTab(tab),
        )
        .map((tab) => normalizeHistoryTab(tab));
    const noteTabs = persistedTabs.filter((tab): tab is NoteTab =>
        isNoteTab(tab),
    );
    const session: PersistedSession = {
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
        activeMapRelativePath:
            activeTab && isMapTab(activeTab) ? activeTab.relativePath : null,
        activeGraphTab: activeTab ? isGraphTab(activeTab) : false,
    };
    const json = JSON.stringify(session);
    if (json === _lastSessionJson) return;

    if (_sessionTimer) clearTimeout(_sessionTimer);
    _sessionTimer = setTimeout(() => {
        try {
            safeStorageSetItem(getSessionKey(vaultPath), json);
            _lastSessionJson = json;
        } catch (error) {
            console.warn("Failed to persist editor session", error);
        }
    }, 500);
});
