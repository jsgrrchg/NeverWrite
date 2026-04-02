import { create } from "zustand";
import type { EditorTarget } from "../../features/editor/editorTargetResolver";
import {
    buildTabFromHistory,
    createGraphTab,
    createMapTab,
    ensureFileTabDefaults,
    isFileTab,
    isGraphTab,
    isHistoryTab,
    isMapTab,
    isNavigableHistoryTab,
    isNoteTab,
    isPdfTab,
    isReviewTab,
    type FileViewerMode,
    type HistoryTab,
    type NavigableHistoryTab,
    type PdfViewMode,
    type RecentlyClosedTab,
    type ReviewTab,
    type Tab,
    type TabHistoryEntry,
    type TabInput,
    type TabCloseReason,
} from "./editorTabs";
import {
    createHistorySnapshot,
    getOpenableHistoryTabHandler,
    normalizeHistoryTab,
    type OpenableHistoryPayload,
} from "./editorTabRegistry";
import {
    buildResourceDeleteUpdate,
    buildResourceReloadUpdate,
    getResourceHandler,
    loadResourceHistoryEntryContent,
    type ResourceReloadDetail,
    type ResourceReloadMetadata,
} from "./editorResourceRegistry";
import {
    buildPersistedSession,
    getEditorSessionSignature,
    isSessionReady,
    writePersistedSession,
} from "./editorSession";
import { useSettingsStore } from "./settingsStore";
import { useVaultStore } from "./vaultStore";

export {
    isFileTab,
    isGraphTab,
    isHistoryTab,
    isMapTab,
    isNavigableHistoryTab,
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
    NavigableHistoryTab,
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
export { markSessionReady, readPersistedSession } from "./editorSession";

const MAX_RECENTLY_CLOSED_TABS = 20;

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
        | "tabs"
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
): NavigableHistoryTab | null {
    const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId);
    if (!activeTab || !isNavigableHistoryTab(activeTab)) {
        return null;
    }
    return normalizeHistoryTab(activeTab) as NavigableHistoryTab;
}

function openOrReuseHistoryTab(
    state: Pick<
        EditorStore,
        | "tabs"
        | "activeTabId"
        | "activationHistory"
        | "tabNavigationHistory"
        | "tabNavigationIndex"
    >,
    payload: OpenableHistoryPayload,
) {
    const handler = getOpenableHistoryTabHandler(payload.kind);

    if (getTabOpenBehavior() === "new_tab") {
        const newTab = handler.createInitialTab(payload as never);
        return {
            tabs: [...state.tabs, newTab],
            ...activateTab(state, newTab.id),
        };
    }

    const activeTab = getReusableHistoryTab(state);
    if (!activeTab) {
        const newTab = handler.createInitialTab(payload as never);
        return {
            tabs: [...state.tabs, newTab],
            ...activateTab(state, newTab.id),
        };
    }

    if (activeTab.kind === payload.kind) {
        if (handler.matchesOpenTarget(activeTab as never, payload as never)) {
            if (!handler.replaceCurrentEntry) {
                return state;
            }
            const nextTab = handler.replaceCurrentEntry(
                activeTab as never,
                payload as never,
            );
            return {
                tabs: replaceTab(state.tabs, nextTab.id, nextTab),
            };
        }
    }

    const kept = activeTab.history.slice(0, activeTab.historyIndex);
    kept.push(
        createHistorySnapshot(activeTab),
        handler.createOpenEntry(payload as never),
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

function insertNormalizedTab(
    state: Pick<
        EditorStore,
        | "tabs"
        | "activeTabId"
        | "activationHistory"
        | "tabNavigationHistory"
        | "tabNavigationIndex"
    >,
    incoming: Tab,
    index?: number,
) {
    if (isGraphTab(incoming)) {
        const existing = state.tabs.find((tab) => isGraphTab(tab));
        if (existing) {
            const tabs =
                existing.title === incoming.title
                    ? state.tabs
                    : state.tabs.map((tab) =>
                          tab.id === existing.id
                              ? { ...tab, title: incoming.title }
                              : tab,
                      );
            return {
                tabs,
                ...activateTab(
                    {
                        ...state,
                        tabs,
                    },
                    existing.id,
                ),
            };
        }
    }

    const tabs = state.tabs.filter((existing) => existing.id !== incoming.id);
    const boundedIndex =
        index === undefined
            ? tabs.length
            : Math.max(0, Math.min(index, tabs.length));

    tabs.splice(boundedIndex, 0, incoming);
    return {
        tabs,
        ...activateTab(state, incoming.id),
    };
}

function patchCurrentHistoryEntry(
    tab: HistoryTab,
    patch: (entry: TabHistoryEntry) => TabHistoryEntry,
): HistoryTab {
    const normalized = normalizeHistoryTab(tab);
    if (!normalized) {
        return tab;
    }
    const currentEntry = normalized.history[normalized.historyIndex];

    if (!currentEntry) {
        return normalized;
    }

    const nextEntry = patch(currentEntry);
    if (nextEntry === currentEntry) {
        return normalized;
    }

    const history = [...normalized.history];
    history[normalized.historyIndex] = nextEntry;
    return buildTabFromHistory(normalized.id, history, normalized.historyIndex);
}

function patchHistoryTabById(
    tabs: Tab[],
    tabId: string,
    patch: (tab: HistoryTab) => Tab,
) {
    return tabs.map((tab) => {
        if (tab.id !== tabId || !isHistoryTab(tab)) {
            return tab;
        }
        return patch(tab);
    });
}

function updateTabHistoryTitle(tab: HistoryTab, title: string): Tab {
    if (tab.title === title && !tab.history[tab.historyIndex]) {
        return tab;
    }

    if (!tab.history[tab.historyIndex]) {
        return {
            ...tab,
            title,
        };
    }

    return patchCurrentHistoryEntry(tab, (entry) =>
        entry.title === title
            ? entry
            : {
                  ...entry,
                  title,
              },
    );
}

function loadHistoryEntryContentIfNeeded(
    tabId: string,
    historyIndex: number,
    entry: TabHistoryEntry,
) {
    if (entry.kind === "note" && !entry.content) {
        void loadResourceHistoryEntryContent(
            getResourceHandler("note"),
            tabId,
            historyIndex,
            entry.noteId,
            useEditorStore.setState,
        );
    }

    if (entry.kind === "file" && !entry.content) {
        void loadResourceHistoryEntryContent(
            getResourceHandler("file"),
            tabId,
            historyIndex,
            entry.relativePath,
            useEditorStore.setState,
        );
    }
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
    content: ResourceReloadDetail["content"];
    title: ResourceReloadDetail["title"];
    origin?: ResourceReloadDetail["origin"];
    opId?: ResourceReloadDetail["opId"];
    revision?: ResourceReloadDetail["revision"];
    contentHash?: ResourceReloadDetail["contentHash"];
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
    _noteReloadMetadata: Record<string, ResourceReloadMetadata | undefined>;
    _fileReloadMetadata: Record<string, ResourceReloadMetadata | undefined>;
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
    reloadNoteContent: (noteId: string, detail: ReloadedDetail) => void;
    reloadFileContent: (relativePath: string, detail: ReloadedDetail) => void;
    forceReloadNoteContent: (noteId: string, detail: ReloadedDetail) => void;
    forceReloadFileContent: (
        relativePath: string,
        detail: ReloadedDetail,
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
            const tab = getReusableHistoryTab(get());
            if (!tab) return;
            get().navigateToHistoryIndex(tab.historyIndex - 1);
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
            const tab = getReusableHistoryTab(get());
            if (!tab) return;
            get().navigateToHistoryIndex(tab.historyIndex + 1);
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
        if (!isNavigableHistoryTab(raw)) return;
        const tab = normalizeHistoryTab(raw) as NavigableHistoryTab;
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

        loadHistoryEntryContentIfNeeded(tab.id, targetIndex, entry);
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
            tabs: patchHistoryTabById(state.tabs, tabId, (tab) =>
                patchCurrentHistoryEntry(tab, (entry) =>
                    entry.kind === "note" || entry.kind === "file"
                        ? entry.content === content
                            ? entry
                            : {
                                  ...entry,
                                  content,
                              }
                        : entry,
                ),
            ),
        }));
    },

    updateTabTitle: (tabId, title) => {
        set((state) => ({
            tabs: state.tabs.map((t) => {
                if (t.id !== tabId) return t;
                if (!isHistoryTab(t)) {
                    return t.title === title ? t : { ...t, title };
                }
                return updateTabHistoryTitle(t, title);
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
            tabs: patchHistoryTabById(state.tabs, tabId, (tab) =>
                !isPdfTab(tab)
                    ? tab
                    : patchCurrentHistoryEntry(tab, (entry) =>
                          entry.kind !== "pdf" || entry.page === page
                              ? entry
                              : {
                                    ...entry,
                                    page,
                                },
                      ),
            ),
        }));
    },

    updatePdfZoom: (tabId, zoom) => {
        set((state) => ({
            tabs: patchHistoryTabById(state.tabs, tabId, (tab) =>
                !isPdfTab(tab)
                    ? tab
                    : patchCurrentHistoryEntry(tab, (entry) =>
                          entry.kind !== "pdf" || entry.zoom === zoom
                              ? entry
                              : {
                                    ...entry,
                                    zoom,
                                },
                      ),
            ),
        }));
    },

    updatePdfViewMode: (tabId, viewMode) => {
        set((state) => ({
            tabs: patchHistoryTabById(state.tabs, tabId, (tab) =>
                !isPdfTab(tab)
                    ? tab
                    : patchCurrentHistoryEntry(tab, (entry) =>
                          entry.kind !== "pdf" || entry.viewMode === viewMode
                              ? entry
                              : {
                                    ...entry,
                                    viewMode,
                                },
                      ),
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
        const seenGraph = new Set<string>();
        const hydratedTabs: Tab[] = tabs.flatMap((tab): Tab[] => {
            const normalized = normalizeHydratedTab(tab);
            if (!normalized) {
                return [];
            }
            if (isGraphTab(normalized)) {
                if (seenGraph.size > 0) {
                    return [];
                }
                seenGraph.add(normalized.id);
            }
            return [normalized];
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
            return insertNormalizedTab(state, incoming, index);
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
        set((state) => {
            const next = buildResourceReloadUpdate(
                getResourceHandler("note"),
                {
                    tabs: state.tabs,
                    pendingForceReloads: state._pendingForceReloads,
                    reloadVersions: state._noteReloadVersions,
                    reloadMetadata: state._noteReloadMetadata,
                },
                noteId,
                detail,
                { fallbackOrigin: "unknown" },
            );

            return {
                tabs: next.tabs,
                _noteReloadVersions: next.reloadVersions,
                _noteReloadMetadata: next.reloadMetadata,
            };
        });
    },

    reloadFileContent: (relativePath, detail) => {
        set((state) => {
            const next = buildResourceReloadUpdate(
                getResourceHandler("file"),
                {
                    tabs: state.tabs,
                    pendingForceReloads: state._pendingForceFileReloads,
                    reloadVersions: state._fileReloadVersions,
                    reloadMetadata: state._fileReloadMetadata,
                },
                relativePath,
                detail,
                { fallbackOrigin: "unknown" },
            );

            return {
                tabs: next.tabs,
                _fileReloadVersions: next.reloadVersions,
                _fileReloadMetadata: next.reloadMetadata,
            };
        });
    },

    forceReloadNoteContent: (noteId, detail) => {
        set((state) => {
            const next = buildResourceReloadUpdate(
                getResourceHandler("note"),
                {
                    tabs: state.tabs,
                    pendingForceReloads: state._pendingForceReloads,
                    reloadVersions: state._noteReloadVersions,
                    reloadMetadata: state._noteReloadMetadata,
                },
                noteId,
                detail,
                { force: true, fallbackOrigin: "system" },
            );

            return {
                tabs: next.tabs,
                _pendingForceReloads: next.pendingForceReloads,
                _noteReloadVersions: next.reloadVersions,
                _noteReloadMetadata: next.reloadMetadata,
            };
        });
    },

    forceReloadFileContent: (relativePath, detail) => {
        set((state) => {
            const next = buildResourceReloadUpdate(
                getResourceHandler("file"),
                {
                    tabs: state.tabs,
                    pendingForceReloads: state._pendingForceFileReloads,
                    reloadVersions: state._fileReloadVersions,
                    reloadMetadata: state._fileReloadMetadata,
                },
                relativePath,
                detail,
                { force: true, fallbackOrigin: "system" },
            );

            return {
                tabs: next.tabs,
                _pendingForceFileReloads: next.pendingForceReloads,
                _fileReloadVersions: next.reloadVersions,
                _fileReloadMetadata: next.reloadMetadata,
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
            const next = buildResourceDeleteUpdate(
                getResourceHandler("note"),
                {
                    tabs: state.tabs,
                    activeTabId: state.activeTabId,
                    activationHistory: state.activationHistory,
                    tabNavigationHistory: state.tabNavigationHistory,
                    tabNavigationIndex: state.tabNavigationIndex,
                    pendingForceReloads: state._pendingForceReloads,
                    reloadVersions: state._noteReloadVersions,
                    reloadMetadata: state._noteReloadMetadata,
                    externalConflicts: state.noteExternalConflicts,
                },
                noteId,
            );

            if (!next) {
                return state;
            }

            return {
                tabs: next.tabs,
                activeTabId: next.activeTabId,
                activationHistory: next.activationHistory,
                tabNavigationHistory: next.tabNavigationHistory,
                tabNavigationIndex: next.tabNavigationIndex,
                _pendingForceReloads: next.pendingForceReloads,
                _noteReloadVersions: next.reloadVersions,
                _noteReloadMetadata: next.reloadMetadata,
                noteExternalConflicts: next.externalConflicts,
            };
        });
    },

    handleFileDeleted: (relativePath) => {
        set((state) => {
            const next = buildResourceDeleteUpdate(
                getResourceHandler("file"),
                {
                    tabs: state.tabs,
                    activeTabId: state.activeTabId,
                    activationHistory: state.activationHistory,
                    tabNavigationHistory: state.tabNavigationHistory,
                    tabNavigationIndex: state.tabNavigationIndex,
                    pendingForceReloads: state._pendingForceFileReloads,
                    reloadVersions: state._fileReloadVersions,
                    reloadMetadata: state._fileReloadMetadata,
                    externalConflicts: state.fileExternalConflicts,
                },
                relativePath,
            );

            if (!next) {
                return state;
            }

            return {
                tabs: next.tabs,
                activeTabId: next.activeTabId,
                activationHistory: next.activationHistory,
                tabNavigationHistory: next.tabNavigationHistory,
                tabNavigationIndex: next.tabNavigationIndex,
                _pendingForceFileReloads: next.pendingForceReloads,
                _fileReloadVersions: next.reloadVersions,
                _fileReloadMetadata: next.reloadMetadata,
                fileExternalConflicts: next.externalConflicts,
            };
        });
    },

    handleNoteRenamed: (oldNoteId, newNoteId, newTitle) => {
        set((state) => ({
            tabs: state.tabs.map((t) => {
                if (!isNoteTab(t)) {
                    return t;
                }

                let didChange = false;
                const history = t.history.map((entry) => {
                    if (entry.kind !== "note" || entry.noteId !== oldNoteId) {
                        return entry;
                    }
                    didChange = true;
                    return {
                        ...entry,
                        noteId: newNoteId,
                        title: newTitle,
                    };
                });

                if (!didChange) {
                    return t;
                }

                return buildTabFromHistory(t.id, history, t.historyIndex);
            }),
        }));
    },
}));

// Debounced session persistence — only write when tab list or active tab changes
let _sessionTimer: ReturnType<typeof setTimeout> | null = null;
let _lastSessionJson = "";
let _lastSessionSig = "";

useEditorStore.subscribe((state) => {
    if (!isSessionReady()) return;

    const vaultPath = useVaultStore.getState().vaultPath;
    if (!vaultPath) return;

    const sig = getEditorSessionSignature(state);
    if (sig === _lastSessionSig) return;
    _lastSessionSig = sig;

    const session = buildPersistedSession(state);
    const json = JSON.stringify(session);
    if (json === _lastSessionJson) return;

    if (_sessionTimer) clearTimeout(_sessionTimer);
    _sessionTimer = setTimeout(() => {
        writePersistedSession(vaultPath, session);
        _lastSessionJson = json;
    }, 500);
});
