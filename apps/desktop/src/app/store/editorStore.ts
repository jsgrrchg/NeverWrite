import { create } from "zustand";

const SESSION_KEY = "vaultai.session.tabs";

interface PersistedSession {
    noteIds: Array<{ noteId: string; title: string }>;
    activeNoteId: string | null;
}

export function readPersistedSession(): PersistedSession | null {
    try {
        const raw = localStorage.getItem(SESSION_KEY);
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

export type EditorMode = "preview";

export interface PendingReveal {
    noteId: string;
    targets: string[];
    mode: "link" | "mention";
}

interface EditorStore {
    tabs: Tab[];
    activeTabId: string | null;
    editorMode: EditorMode;
    pendingReveal: PendingReveal | null;
    openNote: (noteId: string, title: string, content: string) => void;
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
}

export const useEditorStore = create<EditorStore>((set, get) => ({
    tabs: [],
    activeTabId: null,
    editorMode: "preview",
    pendingReveal: null,

    openNote: (noteId, title, content) => {
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
        set((state) => ({ tabs: [...state.tabs, tab], activeTabId: tab.id }));
    },

    closeTab: (tabId) => {
        set((state) => {
            const idx = state.tabs.findIndex((t) => t.id === tabId);
            const tabs = state.tabs.filter((t) => t.id !== tabId);
            let activeTabId = state.activeTabId;
            if (activeTabId === tabId) {
                activeTabId = tabs[Math.min(idx, tabs.length - 1)]?.id ?? null;
            }
            return { tabs, activeTabId };
        });
    },

    switchTab: (tabId) => set({ activeTabId: tabId }),

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
        set({
            tabs,
            activeTabId:
                activeTabId && tabs.some((tab) => tab.id === activeTabId)
                    ? activeTabId
                    : (tabs[0]?.id ?? null),
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
            return { tabs, activeTabId: tab.id };
        });
    },

    queueReveal: (pendingReveal) => set({ pendingReveal }),

    clearPendingReveal: () => set({ pendingReveal: null }),
}));

useEditorStore.subscribe((state) => {
    if (!sessionReady) return;
    const session: PersistedSession = {
        noteIds: state.tabs.map((t) => ({ noteId: t.noteId, title: t.title })),
        activeNoteId:
            state.tabs.find((t) => t.id === state.activeTabId)?.noteId ?? null,
    };
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
});
