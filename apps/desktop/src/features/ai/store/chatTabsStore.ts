import { create } from "zustand";
import { useVaultStore } from "../../../app/store/vaultStore";

const CHAT_TABS_STORAGE_KEY_PREFIX = "vaultai.chat.tabs:";
const CHAT_TABS_PERSIST_VERSION = 1;

export interface ChatWorkspaceTab {
    id: string;
    sessionId: string;
    pinned?: boolean;
}

export interface PersistedChatWorkspace {
    version: 1;
    tabs: ChatWorkspaceTab[];
    activeTabId: string | null;
}

interface ChatTabsStore {
    isReady: boolean;
    tabs: ChatWorkspaceTab[];
    activeTabId: string | null;
    openSessionTab: (
        sessionId: string,
        options?: { activate?: boolean },
    ) => void;
    closeTab: (tabId: string) => void;
    setActiveTab: (tabId: string) => void;
    ensureSessionTab: (sessionId: string) => string;
    removeTabsForSession: (sessionId: string) => void;
    pruneInvalidTabs: (validSessionIds: string[]) => void;
    hydrateForVault: (payload: PersistedChatWorkspace | null) => void;
    restoreWorkspace: (
        payload: PersistedChatWorkspace | null,
        validSessionIds: string[],
        fallbackSessionId?: string | null,
    ) => void;
    replaceSessionId: (oldSessionId: string, newSessionId: string) => void;
    reset: () => void;
}

function getPreferredTab(
    existing: ChatWorkspaceTab,
    incoming: ChatWorkspaceTab,
    preferredTabId: string | null,
) {
    if (incoming.id === preferredTabId && existing.id !== preferredTabId) {
        return incoming;
    }

    return existing;
}

function normalizeTabs(
    tabs: ChatWorkspaceTab[],
    preferredTabId: string | null,
): ChatWorkspaceTab[] {
    const deduped: ChatWorkspaceTab[] = [];
    const indexesByTabId = new Map<string, number>();
    const indexesBySessionId = new Map<string, number>();

    for (const tab of tabs) {
        if (!tab.id || !tab.sessionId) continue;

        const existingIndex =
            indexesByTabId.get(tab.id) ?? indexesBySessionId.get(tab.sessionId);

        if (existingIndex === undefined) {
            const nextIndex = deduped.length;
            deduped.push(tab);
            indexesByTabId.set(tab.id, nextIndex);
            indexesBySessionId.set(tab.sessionId, nextIndex);
            continue;
        }

        const existing = deduped[existingIndex];
        if (!existing) continue;

        const preferred = getPreferredTab(existing, tab, preferredTabId);
        deduped[existingIndex] = preferred;

        if (preferred.id !== existing.id) {
            indexesByTabId.delete(existing.id);
            indexesByTabId.set(preferred.id, existingIndex);
        }

        if (preferred.sessionId !== existing.sessionId) {
            indexesBySessionId.delete(existing.sessionId);
            indexesBySessionId.set(preferred.sessionId, existingIndex);
        }
    }

    return deduped;
}

function resolveActiveTabId(
    tabs: ChatWorkspaceTab[],
    activeTabId: string | null,
): string | null {
    if (activeTabId && tabs.some((tab) => tab.id === activeTabId)) {
        return activeTabId;
    }

    return tabs[0]?.id ?? null;
}

function normalizeWorkspace(
    payload: PersistedChatWorkspace | null,
): PersistedChatWorkspace | null {
    if (!payload || payload.version !== CHAT_TABS_PERSIST_VERSION) {
        return null;
    }

    const tabs = normalizeTabs(payload.tabs ?? [], payload.activeTabId);

    return {
        version: CHAT_TABS_PERSIST_VERSION,
        tabs,
        activeTabId: resolveActiveTabId(tabs, payload.activeTabId),
    };
}

function buildPersistedWorkspace(
    tabs: ChatWorkspaceTab[],
    activeTabId: string | null,
): PersistedChatWorkspace {
    const normalizedTabs = normalizeTabs(tabs, activeTabId);

    return {
        version: CHAT_TABS_PERSIST_VERSION,
        tabs: normalizedTabs,
        activeTabId: resolveActiveTabId(normalizedTabs, activeTabId),
    };
}

function normalizeParsedWorkspace(
    raw: unknown,
): PersistedChatWorkspace | null {
    if (!raw || typeof raw !== "object") return null;

    const candidate = raw as {
        version?: unknown;
        tabs?: unknown;
        activeTabId?: unknown;
    };

    if (candidate.version !== CHAT_TABS_PERSIST_VERSION) return null;
    if (!Array.isArray(candidate.tabs)) return null;

    const tabs = candidate.tabs
        .map((tab): ChatWorkspaceTab | null => {
            if (!tab || typeof tab !== "object") return null;
            const current = tab as {
                id?: unknown;
                sessionId?: unknown;
                pinned?: unknown;
            };

            if (
                typeof current.id !== "string" ||
                current.id.length === 0 ||
                typeof current.sessionId !== "string" ||
                current.sessionId.length === 0
            ) {
                return null;
            }

            return current.pinned === true
                ? {
                      id: current.id,
                      sessionId: current.sessionId,
                      pinned: true,
                  }
                : {
                      id: current.id,
                      sessionId: current.sessionId,
                  };
        })
        .filter((tab): tab is ChatWorkspaceTab => tab !== null);

    return buildPersistedWorkspace(
        tabs,
        typeof candidate.activeTabId === "string"
            ? candidate.activeTabId
            : null,
    );
}

function createTab(sessionId: string): ChatWorkspaceTab {
    return {
        id: crypto.randomUUID(),
        sessionId,
    };
}

function getNextActiveTabIdAfterRemoval(
    tabs: ChatWorkspaceTab[],
    removedTabIndex: number,
    previousActiveTabId: string | null,
): string | null {
    if (!tabs.length) return null;
    if (previousActiveTabId && tabs.some((tab) => tab.id === previousActiveTabId)) {
        return previousActiveTabId;
    }

    return tabs[Math.max(0, removedTabIndex - 1)]?.id ?? tabs[0]?.id ?? null;
}

export function getChatTabsStorageKey(vaultPath: string) {
    return `${CHAT_TABS_STORAGE_KEY_PREFIX}${vaultPath}`;
}

export function readPersistedChatWorkspace(
    vaultPath: string | null,
): PersistedChatWorkspace | null {
    if (!vaultPath) return null;

    try {
        const raw = localStorage.getItem(getChatTabsStorageKey(vaultPath));
        if (!raw) return null;
        return normalizeParsedWorkspace(JSON.parse(raw));
    } catch {
        return null;
    }
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
const lastPersistedJsonByVaultPath = new Map<string, string>();

export function markChatTabsReady() {
    useChatTabsStore.setState({ isReady: true });
}

export const useChatTabsStore = create<ChatTabsStore>((set, get) => ({
    isReady: false,
    tabs: [],
    activeTabId: null,

    openSessionTab: (sessionId, options) => {
        if (!sessionId) return;

        const activate = options?.activate !== false;
        const tabId = get().ensureSessionTab(sessionId);

        if (activate) {
            get().setActiveTab(tabId);
        }
    },

    closeTab: (tabId) => {
        set((state) => {
            const removedTabIndex = state.tabs.findIndex((tab) => tab.id === tabId);
            if (removedTabIndex === -1) return state;

            const tabs = state.tabs.filter((tab) => tab.id !== tabId);
            const activeTabId =
                state.activeTabId === tabId
                    ? getNextActiveTabIdAfterRemoval(
                          tabs,
                          removedTabIndex,
                          null,
                      )
                    : resolveActiveTabId(tabs, state.activeTabId);

            return { tabs, activeTabId };
        });
    },

    setActiveTab: (tabId) =>
        set((state) =>
            state.tabs.some((tab) => tab.id === tabId)
                ? { activeTabId: tabId }
                : state,
        ),

    ensureSessionTab: (sessionId) => {
        let ensuredTabId = "";

        set((state) => {
            const existing = state.tabs.find((tab) => tab.sessionId === sessionId);
            if (existing) {
                ensuredTabId = existing.id;

                if (!state.activeTabId) {
                    return { activeTabId: existing.id };
                }

                return state;
            }

            const tab = createTab(sessionId);
            ensuredTabId = tab.id;
            const tabs = [...state.tabs, tab];

            return {
                tabs,
                activeTabId: resolveActiveTabId(tabs, state.activeTabId),
            };
        });

        return ensuredTabId;
    },

    removeTabsForSession: (sessionId) => {
        set((state) => {
            const removedTabIndexes = state.tabs.reduce<number[]>(
                (indexes, tab, index) =>
                    tab.sessionId === sessionId ? [...indexes, index] : indexes,
                [],
            );

            if (!removedTabIndexes.length) return state;

            const tabs = state.tabs.filter((tab) => tab.sessionId !== sessionId);
            const activeTabId =
                state.tabs[removedTabIndexes[0]]?.id === state.activeTabId
                    ? getNextActiveTabIdAfterRemoval(
                          tabs,
                          removedTabIndexes[0],
                          null,
                      )
                    : resolveActiveTabId(tabs, state.activeTabId);

            return { tabs, activeTabId };
        });
    },

    pruneInvalidTabs: (validSessionIds) => {
        const validSessionIdSet = new Set(validSessionIds);

        set((state) => {
            const removedTabIndex = state.tabs.findIndex(
                (tab) => !validSessionIdSet.has(tab.sessionId),
            );
            if (removedTabIndex === -1) {
                const tabs = normalizeTabs(state.tabs, state.activeTabId);
                const activeTabId = resolveActiveTabId(tabs, state.activeTabId);
                return tabs === state.tabs && activeTabId === state.activeTabId
                    ? state
                    : { tabs, activeTabId };
            }

            const tabs = normalizeTabs(
                state.tabs.filter((tab) => validSessionIdSet.has(tab.sessionId)),
                state.activeTabId,
            );
            const activeTabId =
                state.tabs[removedTabIndex]?.id === state.activeTabId
                    ? getNextActiveTabIdAfterRemoval(tabs, removedTabIndex, null)
                    : resolveActiveTabId(tabs, state.activeTabId);

            return { tabs, activeTabId };
        });
    },

    hydrateForVault: (payload) => {
        const workspace = normalizeWorkspace(payload);
        set({
            tabs: workspace?.tabs ?? [],
            activeTabId: workspace?.activeTabId ?? null,
        });
    },

    restoreWorkspace: (payload, validSessionIds, fallbackSessionId = null) => {
        const validSessionIdSet = new Set(validSessionIds);
        const workspace = normalizeWorkspace(payload);

        let tabs = normalizeTabs(
            (workspace?.tabs ?? []).filter((tab) =>
                validSessionIdSet.has(tab.sessionId),
            ),
            workspace?.activeTabId ?? null,
        );
        let activeTabId = resolveActiveTabId(tabs, workspace?.activeTabId ?? null);

        if (
            tabs.length === 0 &&
            fallbackSessionId &&
            validSessionIdSet.has(fallbackSessionId)
        ) {
            const fallbackTab = createTab(fallbackSessionId);
            tabs = [fallbackTab];
            activeTabId = fallbackTab.id;
        }

        set({
            tabs,
            activeTabId,
        });
    },

    replaceSessionId: (oldSessionId, newSessionId) => {
        if (!oldSessionId || !newSessionId || oldSessionId === newSessionId) {
            return;
        }

        set((state) => {
            const activeTabId = state.activeTabId;
            const tabs = normalizeTabs(
                state.tabs.map((tab) =>
                    tab.sessionId === oldSessionId
                        ? { ...tab, sessionId: newSessionId }
                        : tab,
                ),
                activeTabId,
            );

            return {
                tabs,
                activeTabId: resolveActiveTabId(tabs, activeTabId),
            };
        });
    },

    reset: () => {
        set({
            tabs: [],
            activeTabId: null,
        });
    },
}));

useChatTabsStore.subscribe((state) => {
    if (!state.isReady) return;

    const vaultPath = useVaultStore.getState().vaultPath;
    if (!vaultPath) return;

    const workspace = buildPersistedWorkspace(state.tabs, state.activeTabId);
    const json = JSON.stringify(workspace);
    if (lastPersistedJsonByVaultPath.get(vaultPath) === json) return;

    if (persistTimer) {
        clearTimeout(persistTimer);
    }

    persistTimer = setTimeout(() => {
        lastPersistedJsonByVaultPath.set(vaultPath, json);
        localStorage.setItem(getChatTabsStorageKey(vaultPath), json);
    }, 500);
});

export function resetChatTabsStore() {
    if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = null;
    }

    lastPersistedJsonByVaultPath.clear();

    useChatTabsStore.setState({
        isReady: false,
        tabs: [],
        activeTabId: null,
    });
}
