import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
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
    activeNoteId: string | null;
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

export interface Tab {
    id: string;
    noteId: string;
    title: string;
    content: string;
    history: HistoryEntry[];
    historyIndex: number;
}

/** Tab without required history fields — used when creating tabs externally. */
export type TabInput = Omit<Tab, "history" | "historyIndex"> &
    Partial<Pick<Tab, "history" | "historyIndex">>;

function createTab(noteId: string, title: string, content: string): Tab {
    return {
        id: crypto.randomUUID(),
        noteId,
        title,
        content,
        history: [{ noteId, title, content }],
        historyIndex: 0,
    };
}

function ensureTabHistory(tab: Tab): Tab {
    if (tab.history && tab.history.length > 0) return tab;
    return {
        ...tab,
        history: [{ noteId: tab.noteId, title: tab.title, content: tab.content }],
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
    goBack: () => void;
    goForward: () => void;
    navigateToHistoryIndex: (index: number) => void;
    closeTab: (tabId: string) => void;
    switchTab: (tabId: string) => void;
    updateTabContent: (tabId: string, content: string) => void;
    updateTabTitle: (tabId: string, title: string) => void;
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

            // If active tab already shows this note, no-op
            if (activeTab && activeTab.noteId === noteId) {
                return state;
            }

            // If there's an active tab, navigate within it
            if (activeTab) {
                const tab = ensureTabHistory(activeTab);
                // Save current content to current history entry
                const history = [...tab.history];
                history[tab.historyIndex] = {
                    noteId: tab.noteId,
                    title: tab.title,
                    content: tab.content,
                };
                // Truncate forward entries
                const trimmed = history.slice(0, tab.historyIndex + 1);
                // Push new entry
                const newEntry: HistoryEntry = { noteId, title, content };
                trimmed.push(newEntry);
                // Cap at MAX_HISTORY
                const capped =
                    trimmed.length > MAX_HISTORY
                        ? trimmed.slice(trimmed.length - MAX_HISTORY)
                        : trimmed;
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

            // No tabs — create a new one
            const newTab = createTab(noteId, title, content);
            return {
                tabs: [newTab],
                activeTabId: newTab.id,
                activationHistory: pushTabToActivation(
                    state.activationHistory,
                    newTab.id,
                ),
            };
        });
    },

    goBack: () => get().navigateToHistoryIndex(
        (get().tabs.find((t) => t.id === get().activeTabId)?.historyIndex ?? 1) - 1,
    ),

    goForward: () => get().navigateToHistoryIndex(
        (get().tabs.find((t) => t.id === get().activeTabId)?.historyIndex ?? -1) + 1,
    ),

    navigateToHistoryIndex: (targetIndex) => {
        const state = get();
        const tabIdx = state.tabs.findIndex(
            (t) => t.id === state.activeTabId,
        );
        if (tabIdx === -1) return;
        const tab = ensureTabHistory(state.tabs[tabIdx]);
        if (targetIndex < 0 || targetIndex >= tab.history.length) return;
        if (targetIndex === tab.historyIndex) return;

        // Snapshot current content into history, then jump
        const history = [...tab.history];
        history[tab.historyIndex] = {
            noteId: tab.noteId,
            title: tab.title,
            content: tab.content,
        };
        const entry = history[targetIndex];

        // Splice updated tab directly — avoids iterating every tab
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
            void loadHistoryEntryContent(tab.id, targetIndex, entry.noteId);
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
            tabs: state.tabs.map((t) => {
                if (t.id !== tabId) return t;
                // Also update current history entry
                if (!t.history?.length) return { ...t, content };
                const history = [...t.history];
                if (history[t.historyIndex]) {
                    history[t.historyIndex] = {
                        ...history[t.historyIndex],
                        content,
                    };
                }
                return { ...t, content, history };
            }),
        }));
    },

    updateTabTitle: (tabId, title) => {
        set((state) => ({
            tabs: state.tabs.map((t) => {
                if (t.id !== tabId) return t;
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

    reorderTabs: (fromIndex, toIndex) => {
        set((state) => {
            const tabs = [...state.tabs];
            const [tab] = tabs.splice(fromIndex, 1);
            tabs.splice(toIndex, 0, tab);
            return { tabs };
        });
    },

    hydrateTabs: (tabs, activeTabId) => {
        const hydratedTabs = tabs.map(ensureTabHistory);
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
            const incoming = ensureTabHistory(tab);
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
                if (t.noteId !== noteId) return t;
                if (t.content === detail.content && t.title === detail.title) {
                    return t;
                }
                return { ...t, content: detail.content, title: detail.title };
            }),
        }));
    },
}));

// Load content for a history entry that was restored without content (e.g. after session restore)
async function loadHistoryEntryContent(
    tabId: string,
    historyIndex: number,
    noteId: string,
) {
    try {
        const detail = await invoke<{ content: string }>("read_note", {
            noteId,
        });
        useEditorStore.setState((state) => ({
            tabs: state.tabs.map((t) => {
                if (t.id !== tabId) return t;
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

// Debounced session persistence — only write when tab list or active tab changes
let _sessionTimer: ReturnType<typeof setTimeout> | null = null;
let _lastSessionJson = "";

useEditorStore.subscribe((state) => {
    if (!sessionReady) return;

    const vaultPath = useVaultStore.getState().vaultPath;
    if (!vaultPath) return;

    const session: PersistedSession = {
        noteIds: state.tabs.map((t) => ({
            noteId: t.noteId,
            title: t.title,
            history: t.history.map((h) => ({
                noteId: h.noteId,
                title: h.title,
            })),
            historyIndex: t.historyIndex,
        })),
        activeNoteId:
            state.tabs.find((t) => t.id === state.activeTabId)?.noteId ?? null,
    };
    const json = JSON.stringify(session);
    if (json === _lastSessionJson) return;

    if (_sessionTimer) clearTimeout(_sessionTimer);
    _sessionTimer = setTimeout(() => {
        _lastSessionJson = json;
        localStorage.setItem(getSessionKey(vaultPath), json);
    }, 500);
});
