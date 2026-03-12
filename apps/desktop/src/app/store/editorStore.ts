import { create } from "zustand";
import { vaultInvoke } from "../utils/vaultInvoke";
import { useVaultStore } from "./vaultStore";

const MAX_HISTORY = 30;
const SESSION_KEY = "vaultai.session.tabs";
const SESSION_KEY_PREFIX = "vaultai.session.tabs:";

interface PersistedSession {
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
        viewMode?: PdfViewMode;
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
    activeNoteId: string | null;
    activePdfEntryId?: string | null;
    activeFilePath?: string | null;
}

function pushTabToActivation(history: string[], tabId: string) {
    return [...history.filter((id) => id !== tabId), tabId];
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

export interface HistoryEntry {
    noteId: string;
    title: string;
    content: string;
}

export interface NoteTab {
    id: string;
    kind?: "note";
    noteId: string;
    title: string;
    content: string;
    history: HistoryEntry[];
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
    history: FileHistoryEntry[];
    historyIndex: number;
}

export interface ReviewTab {
    id: string;
    kind: "ai-review";
    sessionId: string;
    title: string;
}

export type PdfViewMode = "single" | "continuous";
export type FileViewerMode = "text" | "image";
export interface FileHistoryEntry {
    relativePath: string;
    title: string;
    path: string;
    content: string;
    mimeType: string | null;
    viewer: FileViewerMode;
}

export type Tab = NoteTab | PdfTab | FileTab | ReviewTab;

export function isNoteTab(tab: Tab | TabInput): tab is NoteTab | NoteTabInput {
    return (
        tab.kind !== "pdf" && tab.kind !== "file" && tab.kind !== "ai-review"
    );
}

export function isPdfTab(tab: Tab | TabInput): tab is PdfTab {
    return tab.kind === "pdf";
}

export function isFileTab(tab: Tab | TabInput): tab is FileTab {
    return tab.kind === "file";
}

export function isReviewTab(tab: Tab | TabInput): tab is ReviewTab {
    return tab.kind === "ai-review";
}

/** Tab without required history fields — used when creating tabs externally. */
export type NoteTabInput = Omit<NoteTab, "history" | "historyIndex"> &
    Partial<Pick<NoteTab, "history" | "historyIndex">>;

export type FileTabInput = Omit<FileTab, "history" | "historyIndex"> &
    Partial<Pick<FileTab, "history" | "historyIndex">>;

export type TabInput = NoteTabInput | PdfTab | FileTabInput | ReviewTab;

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
        history: [{ noteId, title, content }],
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
            {
                relativePath,
                title,
                path,
                content,
                mimeType,
                viewer,
            },
        ],
        historyIndex: 0,
    };
}

function ensurePdfTabDefaults(tab: PdfTab): PdfTab {
    return {
        ...tab,
        viewMode: tab.viewMode ?? "continuous",
    };
}

function ensureFileTabHistory(tab: FileTabInput): FileTab {
    if (tab.history && tab.history.length > 0) {
        return {
            ...tab,
            history: tab.history,
            historyIndex: tab.historyIndex ?? 0,
        };
    }

    const viewer = tab.viewer ?? inferFileViewer(tab.path, tab.mimeType ?? null);

    return {
        ...tab,
        history: [
            {
                relativePath: tab.relativePath,
                title: tab.title,
                path: tab.path,
                content: tab.content,
                mimeType: tab.mimeType ?? null,
                viewer,
            },
        ],
        historyIndex: 0,
    };
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
        return {
            ...tab,
            history: tab.history,
            historyIndex: tab.historyIndex ?? 0,
        };
    }
    return {
        ...tab,
        history: [
            { noteId: tab.noteId, title: tab.title, content: tab.content },
        ],
        historyIndex: 0,
    };
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
    pendingReveal: PendingReveal | null;
    pendingSelectionReveal: PendingSelectionReveal | null;
    currentSelection: EditorSelectionContext | null;
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
}

export const useEditorStore = create<EditorStore>((set, get) => ({
    tabs: [],
    activeTabId: null,
    activationHistory: [],
    pendingReveal: null,
    pendingSelectionReveal: null,
    currentSelection: null,

    openNote: (noteId, title, content) => {
        set((state) => {
            const activeTab = state.tabs.find(
                (t) => t.id === state.activeTabId,
            );

            // If active tab is a note already showing this note, no-op
            if (
                activeTab &&
                isNoteTab(activeTab) &&
                activeTab.noteId === noteId
            ) {
                return state;
            }

            // If there's an active note tab, navigate within it
            if (activeTab && isNoteTab(activeTab)) {
                const tab = ensureNoteTabHistory(activeTab);
                // Single slice: keep entries up to current, snapshot current, push new
                const kept = tab.history.slice(0, tab.historyIndex);
                kept.push(
                    {
                        noteId: tab.noteId,
                        title: tab.title,
                        content: tab.content,
                    },
                    { noteId, title, content },
                );
                // Cap at MAX_HISTORY
                const capped =
                    kept.length > MAX_HISTORY
                        ? kept.slice(kept.length - MAX_HISTORY)
                        : kept;
                const newIndex = capped.length - 1;

                return {
                    tabs: state.tabs.map((t) =>
                        t.id === activeTab.id
                            ? {
                                  ...t,
                                  noteId,
                                  title,
                                  content,
                                  history: capped,
                                  historyIndex: newIndex,
                              }
                            : t,
                    ),
                };
            }

            // Active tab is a PDF or no tabs — create a new note tab
            const newTab = createNoteTab(noteId, title, content);
            return {
                tabs: [...state.tabs, newTab],
                activeTabId: newTab.id,
                activationHistory: pushTabToActivation(
                    state.activationHistory,
                    newTab.id,
                ),
            };
        });
    },

    openPdf: (entryId, title, path) => {
        set((state) => {
            // If there's already a tab for this PDF, switch to it
            const existing = state.tabs.find(
                (t) => isPdfTab(t) && t.entryId === entryId,
            );
            if (existing) {
                return {
                    activeTabId: existing.id,
                    activationHistory: pushTabToActivation(
                        state.activationHistory,
                        existing.id,
                    ),
                };
            }

            const newTab = createPdfTab(entryId, title, path);
            return {
                tabs: [...state.tabs, newTab],
                activeTabId: newTab.id,
                activationHistory: pushTabToActivation(
                    state.activationHistory,
                    newTab.id,
                ),
            };
        });
    },

    openFile: (relativePath, title, path, content, mimeType, viewer) => {
        set((state) => {
            const activeTab = state.tabs.find(
                (t) => t.id === state.activeTabId,
            );

            if (activeTab && isFileTab(activeTab)) {
                if (activeTab.relativePath === relativePath) {
                    return {
                        tabs: state.tabs.map((tab) =>
                            tab.id !== activeTab.id
                                ? tab
                                : {
                                      ...tab,
                                      relativePath,
                                      title,
                                      path,
                                      content,
                                      mimeType,
                                      viewer,
                                  },
                        ),
                    };
                }

                const tab = ensureFileTabHistory(activeTab);
                const kept = tab.history.slice(0, tab.historyIndex);
                kept.push(
                    {
                        relativePath: tab.relativePath,
                        title: tab.title,
                        path: tab.path,
                        content: tab.content,
                        mimeType: tab.mimeType,
                        viewer: tab.viewer,
                    },
                    {
                        relativePath,
                        title,
                        path,
                        content,
                        mimeType,
                        viewer,
                    },
                );
                const capped =
                    kept.length > MAX_HISTORY
                        ? kept.slice(kept.length - MAX_HISTORY)
                        : kept;
                const newIndex = capped.length - 1;

                return {
                    tabs: state.tabs.map((tabItem) =>
                        tabItem.id === activeTab.id
                            ? {
                                  ...tabItem,
                                  relativePath,
                                  title,
                                  path,
                                  content,
                                  mimeType,
                                  viewer,
                                  history: capped,
                                  historyIndex: newIndex,
                              }
                            : tabItem,
                    ),
                };
            }

            const existing = state.tabs.find(
                (tab) => isFileTab(tab) && tab.relativePath === relativePath,
            );
            if (existing) {
                return {
                    tabs: state.tabs.map((tab) =>
                        tab.id !== existing.id
                            ? tab
                            : {
                                  ...tab,
                                  title,
                                  path,
                                  content,
                                  mimeType,
                                  viewer,
                              },
                    ),
                    activeTabId: existing.id,
                    activationHistory: pushTabToActivation(
                        state.activationHistory,
                        existing.id,
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
                activeTabId: newTab.id,
                activationHistory: pushTabToActivation(
                    state.activationHistory,
                    newTab.id,
                ),
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
                    activeTabId: existing.id,
                    activationHistory: pushTabToActivation(
                        state.activationHistory,
                        existing.id,
                    ),
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
                activeTabId: newTab.id,
                activationHistory: pushTabToActivation(
                    state.activationHistory,
                    newTab.id,
                ),
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
        const tab = get().tabs.find((t) => t.id === get().activeTabId);
        if (!tab) return;
        if (isNoteTab(tab) || isFileTab(tab)) {
            get().navigateToHistoryIndex(tab.historyIndex - 1);
        }
    },

    goForward: () => {
        const tab = get().tabs.find((t) => t.id === get().activeTabId);
        if (!tab) return;
        if (isNoteTab(tab) || isFileTab(tab)) {
            get().navigateToHistoryIndex(tab.historyIndex + 1);
        }
    },

    navigateToHistoryIndex: (targetIndex) => {
        const state = get();
        const tabIdx = state.tabs.findIndex((t) => t.id === state.activeTabId);
        if (tabIdx === -1) return;
        const raw = state.tabs[tabIdx];
        if (isNoteTab(raw)) {
            const tab = ensureNoteTabHistory(raw);
            if (targetIndex < 0 || targetIndex >= tab.history.length) return;
            if (targetIndex === tab.historyIndex) return;

            const currentSnapshot: HistoryEntry = {
                noteId: tab.noteId,
                title: tab.title,
                content: tab.content,
            };
            const history = tab.history.map((h, i) =>
                i === tab.historyIndex ? currentSnapshot : h,
            );
            const entry = history[targetIndex];

            const tabs = [...state.tabs];
            tabs[tabIdx] = {
                ...tab,
                noteId: entry.noteId,
                title: entry.title,
                content: entry.content,
                history,
                historyIndex: targetIndex,
            };
            set({ tabs });

            if (!entry.content) {
                void loadNoteHistoryEntryContent(
                    tab.id,
                    targetIndex,
                    entry.noteId,
                );
            }
            return;
        }

        if (!isFileTab(raw)) return;
        const tab = ensureFileTabHistory(raw);
        if (targetIndex < 0 || targetIndex >= tab.history.length) return;
        if (targetIndex === tab.historyIndex) return;

        const currentSnapshot: FileHistoryEntry = {
            relativePath: tab.relativePath,
            title: tab.title,
            path: tab.path,
            content: tab.content,
            mimeType: tab.mimeType,
            viewer: tab.viewer,
        };
        const history = tab.history.map((h, i) =>
            i === tab.historyIndex ? currentSnapshot : h,
        );
        const entry = history[targetIndex];

        const tabs = [...state.tabs];
        tabs[tabIdx] = {
            ...tab,
            relativePath: entry.relativePath,
            title: entry.title,
            path: entry.path,
            content: entry.content,
            mimeType: entry.mimeType,
            viewer: entry.viewer,
            history,
            historyIndex: targetIndex,
        };
        set({ tabs });

        if (!entry.content) {
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
            if (activeTabId === tabId) {
                activeTabId =
                    [...activationHistory]
                        .reverse()
                        .find((id) => tabs.some((tab) => tab.id === id)) ??
                    tabs[Math.min(idx, tabs.length - 1)]?.id ??
                    null;
            }
            return { tabs, activeTabId, activationHistory };
        });
    },

    switchTab: (tabId) =>
        set((state) => ({
            activeTabId: tabId,
            activationHistory: pushTabToActivation(
                state.activationHistory,
                tabId,
            ),
        })),

    updateTabContent: (tabId, content) => {
        set((state) => ({
            tabs: state.tabs.map((t) =>
                t.id !== tabId
                    ? t
                    : isNoteTab(t)
                      ? { ...t, content }
                      : isFileTab(t)
                        ? { ...t, content }
                        : t,
            ),
        }));
    },

    updateTabTitle: (tabId, title) => {
        set((state) => ({
            tabs: state.tabs.map((t) => {
                if (t.id !== tabId) return t;
                if (!isNoteTab(t)) return { ...t, title };
                if (!t.history?.length) return { ...t, title };
                const history = [...t.history];
                if (history[t.historyIndex]) {
                    history[t.historyIndex] = {
                        ...history[t.historyIndex],
                        title,
                    };
                }
                return { ...t, title, history };
            }),
        }));
    },

    updatePdfPage: (tabId, page) => {
        set((state) => ({
            tabs: state.tabs.map((t) =>
                t.id !== tabId || !isPdfTab(t) ? t : { ...t, page },
            ),
        }));
    },

    updatePdfZoom: (tabId, zoom) => {
        set((state) => ({
            tabs: state.tabs.map((t) =>
                t.id !== tabId || !isPdfTab(t) ? t : { ...t, zoom },
            ),
        }));
    },

    updatePdfViewMode: (tabId, viewMode) => {
        set((state) => ({
            tabs: state.tabs.map((t) =>
                t.id !== tabId || !isPdfTab(t) ? t : { ...t, viewMode },
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
                activeTabId: incoming.id,
                activationHistory: pushTabToActivation(
                    state.activationHistory,
                    incoming.id,
                ),
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
                if (t.id !== tabId || !isNoteTab(t)) return t;
                const history = [...t.history];
                if (history[historyIndex]?.noteId === noteId) {
                    history[historyIndex] = {
                        ...history[historyIndex],
                        content: detail.content,
                    };
                }
                // Also update tab content if still viewing this entry
                if (t.historyIndex === historyIndex) {
                    return { ...t, content: detail.content, history };
                }
                return { ...t, history };
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
        const detail = await vaultInvoke<{ content: string }>("read_vault_file", {
            relativePath,
        });
        useEditorStore.setState((state) => ({
            tabs: state.tabs.map((t) => {
                if (t.id !== tabId || !isFileTab(t)) return t;
                const history = [...t.history];
                if (history[historyIndex]?.relativePath === relativePath) {
                    history[historyIndex] = {
                        ...history[historyIndex],
                        content: detail.content,
                    };
                }
                if (t.historyIndex === historyIndex) {
                    return { ...t, content: detail.content, history };
                }
                return { ...t, history };
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
        } else if (isFileTab(t)) {
            sig += `|file|${t.relativePath}|${t.title}|${t.mimeType ?? ""}`;
        } else {
            sig += `|pdf|${t.entryId}|${t.title}|${t.viewMode}`;
        }
    }
    if (sig === _lastSessionSig) return;
    _lastSessionSig = sig;

    const activeTab = state.tabs.find((t) => t.id === state.activeTabId);
    const noteTabs = state.tabs.filter((tab): tab is NoteTab => isNoteTab(tab));
    const session: PersistedSession = {
        noteIds: noteTabs
            .filter((t) => t.noteId)
            .map((t) => ({
                noteId: t.noteId,
                title: t.title,
                history: t.history.map((h) => ({
                    noteId: h.noteId,
                    title: h.title,
                })),
                historyIndex: t.historyIndex,
            })),
        pdfTabs: state.tabs.filter(isPdfTab).map((t) => ({
            entryId: t.entryId,
            title: t.title,
            path: t.path,
            viewMode: t.viewMode,
        })),
        fileTabs: state.tabs.filter(isFileTab).map((rawTab) => {
            const t = ensureFileTabHistory(rawTab);
            return {
                relativePath: t.relativePath,
                title: t.title,
                path: t.path,
                mimeType: t.mimeType,
                viewer: t.viewer,
                content: t.content,
                history: t.history.map((h) => ({
                    relativePath: h.relativePath,
                    title: h.title,
                    path: h.path,
                    mimeType: h.mimeType,
                    viewer: h.viewer,
                })),
                historyIndex: t.historyIndex,
            };
        }),
        activeNoteId:
            activeTab && isNoteTab(activeTab) ? activeTab.noteId : null,
        activePdfEntryId:
            activeTab && isPdfTab(activeTab) ? activeTab.entryId : null,
        activeFilePath:
            activeTab && isFileTab(activeTab) ? activeTab.relativePath : null,
    };
    const json = JSON.stringify(session);
    if (json === _lastSessionJson) return;

    if (_sessionTimer) clearTimeout(_sessionTimer);
    _sessionTimer = setTimeout(() => {
        _lastSessionJson = json;
        localStorage.setItem(getSessionKey(vaultPath), json);
    }, 500);
});
