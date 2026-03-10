import { create } from "zustand";
import { useVaultStore } from "./vaultStore";

const SESSION_KEY = "vaultai.session.tabs";
const SESSION_KEY_PREFIX = "vaultai.session.tabs:";

interface PersistedSession {
    noteIds: Array<{ noteId: string; title: string }>;
    activeNoteId: string | null;
}

function pushTabToHistory(history: string[], tabId: string) {
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

export interface Tab {
    id: string;
    noteId: string;
    title: string;
    content: string;
    isDirty: boolean;
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

export interface OpenNoteOptions {
    placement?: "end" | "afterActive";
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
    openNote: (
        noteId: string,
        title: string,
        content: string,
        options?: OpenNoteOptions,
    ) => void;
    closeTab: (tabId: string) => void;
    switchTab: (tabId: string) => void;
    updateTabContent: (tabId: string, content: string) => void;
    markTabDirty: (tabId: string) => void;
    updateTabTitle: (tabId: string, title: string) => void;
    markTabClean: (tabId: string) => void;
    reorderTabs: (fromIndex: number, toIndex: number) => void;
    hydrateTabs: (tabs: Tab[], activeTabId: string | null) => void;
    insertExternalTab: (tab: Tab, index?: number) => void;
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

    openNote: (noteId, title, content, options) => {
        const existing = get().tabs.find((t) => t.noteId === noteId);
        if (existing) {
            set({ activeTabId: existing.id });
            return;
        }
        const tab: Tab = {
            id: crypto.randomUUID(),
            noteId,
            title,
            content,
            isDirty: false,
        };
        set((state) => {
            if (options?.placement !== "afterActive") {
                return {
                    tabs: [...state.tabs, tab],
                    activeTabId: tab.id,
                    activationHistory: pushTabToHistory(
                        state.activationHistory,
                        tab.id,
                    ),
                };
            }

            const activeIndex = state.tabs.findIndex(
                (item) => item.id === state.activeTabId,
            );
            if (activeIndex === -1) {
                return {
                    tabs: [...state.tabs, tab],
                    activeTabId: tab.id,
                    activationHistory: pushTabToHistory(
                        state.activationHistory,
                        tab.id,
                    ),
                };
            }

            const tabs = [...state.tabs];
            tabs.splice(activeIndex + 1, 0, tab);
            return {
                tabs,
                activeTabId: tab.id,
                activationHistory: pushTabToHistory(
                    state.activationHistory,
                    tab.id,
                ),
            };
        });
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
            activationHistory: pushTabToHistory(state.activationHistory, tabId),
        })),

    updateTabContent: (tabId, content) => {
        set((state) => ({
            tabs: state.tabs.map((t) =>
                t.id === tabId ? { ...t, content, isDirty: true } : t,
            ),
        }));
    },

    markTabDirty: (tabId) => {
        const tab = get().tabs.find((t) => t.id === tabId);
        if (tab && !tab.isDirty) {
            set((state) => ({
                tabs: state.tabs.map((t) =>
                    t.id === tabId ? { ...t, isDirty: true } : t,
                ),
            }));
        }
    },

    updateTabTitle: (tabId, title) => {
        set((state) => ({
            tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, title } : t)),
        }));
    },

    markTabClean: (tabId) => {
        set((state) => ({
            tabs: state.tabs.map((t) =>
                t.id === tabId ? { ...t, isDirty: false } : t,
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
        const nextActiveTabId =
            activeTabId && tabs.some((tab) => tab.id === activeTabId)
                ? activeTabId
                : (tabs[0]?.id ?? null);
        set({
            tabs,
            activeTabId: nextActiveTabId,
            activationHistory: nextActiveTabId ? [nextActiveTabId] : [],
        });
    },

    insertExternalTab: (tab, index) => {
        set((state) => {
            const tabs = state.tabs.filter(
                (existing) => existing.id !== tab.id,
            );
            const boundedIndex =
                index === undefined
                    ? tabs.length
                    : Math.max(0, Math.min(index, tabs.length));

            tabs.splice(boundedIndex, 0, tab);
            return {
                tabs,
                activeTabId: tab.id,
                activationHistory: pushTabToHistory(
                    state.activationHistory,
                    tab.id,
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
                // Don't overwrite unsaved user edits
                if (t.isDirty) return t;
                if (t.content === detail.content && t.title === detail.title) {
                    return t;
                }
                return { ...t, content: detail.content, title: detail.title };
            }),
        }));
    },
}));

useEditorStore.subscribe((state) => {
    if (!sessionReady) return;

    const vaultPath = useVaultStore.getState().vaultPath;
    if (!vaultPath) return;

    const session: PersistedSession = {
        noteIds: state.tabs.map((t) => ({ noteId: t.noteId, title: t.title })),
        activeNoteId:
            state.tabs.find((t) => t.id === state.activeTabId)?.noteId ?? null,
    };
    localStorage.setItem(getSessionKey(vaultPath), JSON.stringify(session));
});
