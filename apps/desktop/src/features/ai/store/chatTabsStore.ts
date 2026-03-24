import { create } from "zustand";
import { useVaultStore } from "../../../app/store/vaultStore";

const CHAT_TABS_STORAGE_KEY_PREFIX = "vaultai.chat.tabs:";
const CHAT_TABS_PERSIST_VERSION = 1;

export interface ChatWorkspaceTab {
    id: string;
    sessionId: string;
    historySessionId?: string;
    runtimeId?: string;
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
        options?: {
            activate?: boolean;
            historySessionId?: string | null;
            runtimeId?: string | null;
        },
    ) => void;
    closeTab: (tabId: string) => void;
    setActiveTab: (tabId: string) => void;
    ensureSessionTab: (
        sessionId: string,
        historySessionId?: string | null,
        runtimeId?: string | null,
    ) => string;
    reorderTabs: (fromIndex: number, toIndex: number) => void;
    removeTabsForSession: (sessionId: string) => void;
    pruneInvalidTabs: (validSessionIds: string[]) => void;
    hydrateForVault: (payload: PersistedChatWorkspace | null) => void;
    restoreWorkspace: (
        payload: PersistedChatWorkspace | null,
        validSessions: Array<{
            sessionId: string;
            historySessionId?: string | null;
            runtimeId?: string | null;
        }>,
        fallbackSessionId?: string | null,
    ) => void;
    replaceSessionId: (
        oldSessionId: string,
        newSessionId: string,
        historySessionId?: string | null,
        runtimeId?: string | null,
    ) => void;
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

function normalizeParsedWorkspace(raw: unknown): PersistedChatWorkspace | null {
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
                historySessionId?: unknown;
                runtimeId?: unknown;
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

            const normalizedTab: ChatWorkspaceTab = {
                id: current.id,
                sessionId: current.sessionId,
            };

            if (
                typeof current.historySessionId === "string" &&
                current.historySessionId.length > 0
            ) {
                normalizedTab.historySessionId = current.historySessionId;
            }

            if (
                typeof current.runtimeId === "string" &&
                current.runtimeId.length > 0
            ) {
                normalizedTab.runtimeId = current.runtimeId;
            }

            if (current.pinned === true) {
                normalizedTab.pinned = true;
            }

            return normalizedTab;
        })
        .filter((tab): tab is ChatWorkspaceTab => tab !== null);

    return buildPersistedWorkspace(
        tabs,
        typeof candidate.activeTabId === "string"
            ? candidate.activeTabId
            : null,
    );
}

function createTab(
    sessionId: string,
    historySessionId?: string | null,
    runtimeId?: string | null,
): ChatWorkspaceTab {
    const tab: ChatWorkspaceTab = {
        id: crypto.randomUUID(),
        sessionId,
    };

    if (historySessionId) {
        tab.historySessionId = historySessionId;
    }

    if (runtimeId) {
        tab.runtimeId = runtimeId;
    }

    return tab;
}

function resolveTabHistorySessionId(tab: ChatWorkspaceTab) {
    if (tab.historySessionId) return tab.historySessionId;
    if (tab.sessionId.startsWith("persisted:")) {
        return tab.sessionId.slice("persisted:".length) || null;
    }
    return null;
}

function syncTabMetadata(
    tab: ChatWorkspaceTab,
    historySessionId?: string | null,
    runtimeId?: string | null,
): ChatWorkspaceTab {
    const nextHistorySessionId = historySessionId ?? tab.historySessionId;
    const nextRuntimeId = runtimeId ?? tab.runtimeId;

    if (
        nextHistorySessionId === tab.historySessionId &&
        nextRuntimeId === tab.runtimeId
    ) {
        return tab;
    }

    return {
        ...tab,
        ...(nextHistorySessionId
            ? { historySessionId: nextHistorySessionId }
            : {}),
        ...(nextRuntimeId ? { runtimeId: nextRuntimeId } : {}),
    };
}

function getNextActiveTabIdAfterRemoval(
    tabs: ChatWorkspaceTab[],
    removedTabIndex: number,
    previousActiveTabId: string | null,
): string | null {
    if (!tabs.length) return null;
    if (
        previousActiveTabId &&
        tabs.some((tab) => tab.id === previousActiveTabId)
    ) {
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
let pendingPersistVaultPath: string | null = null;
let pendingPersistJson: string | null = null;

function flushPendingPersistence() {
    if (!pendingPersistVaultPath || pendingPersistJson === null) {
        return;
    }

    lastPersistedJsonByVaultPath.set(
        pendingPersistVaultPath,
        pendingPersistJson,
    );
    localStorage.setItem(
        getChatTabsStorageKey(pendingPersistVaultPath),
        pendingPersistJson,
    );
    pendingPersistVaultPath = null;
    pendingPersistJson = null;
}

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
        const tabId = get().ensureSessionTab(
            sessionId,
            options?.historySessionId ?? null,
            options?.runtimeId ?? null,
        );

        if (activate) {
            get().setActiveTab(tabId);
        }
    },

    closeTab: (tabId) => {
        set((state) => {
            const removedTabIndex = state.tabs.findIndex(
                (tab) => tab.id === tabId,
            );
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

    ensureSessionTab: (
        sessionId,
        historySessionId = null,
        runtimeId = null,
    ) => {
        let ensuredTabId = "";

        set((state) => {
            const existing = state.tabs.find(
                (tab) => tab.sessionId === sessionId,
            );
            if (existing) {
                ensuredTabId = existing.id;
                const nextTabs = state.tabs.map((tab) =>
                    tab.id === existing.id
                        ? syncTabMetadata(tab, historySessionId, runtimeId)
                        : tab,
                );
                const tabsChanged = nextTabs.some(
                    (tab, index) => tab !== state.tabs[index],
                );

                if (!state.activeTabId) {
                    return tabsChanged
                        ? { tabs: nextTabs, activeTabId: existing.id }
                        : { activeTabId: existing.id };
                }

                return tabsChanged ? { tabs: nextTabs } : state;
            }

            const tab = createTab(sessionId, historySessionId, runtimeId);
            ensuredTabId = tab.id;
            const tabs = [...state.tabs, tab];

            return {
                tabs,
                activeTabId: resolveActiveTabId(tabs, state.activeTabId),
            };
        });

        return ensuredTabId;
    },

    reorderTabs: (fromIndex, toIndex) => {
        set((state) => {
            if (state.tabs.length < 2) return state;

            const from = Math.max(
                0,
                Math.min(fromIndex, state.tabs.length - 1),
            );
            const to = Math.max(0, Math.min(toIndex, state.tabs.length - 1));
            if (from === to) return state;

            const tabs = [...state.tabs];
            const [moved] = tabs.splice(from, 1);
            if (!moved) return state;
            tabs.splice(to, 0, moved);

            return {
                tabs,
                activeTabId: resolveActiveTabId(tabs, state.activeTabId),
            };
        });
    },

    removeTabsForSession: (sessionId) => {
        set((state) => {
            const removedTabIndexes = state.tabs.reduce<number[]>(
                (indexes, tab, index) =>
                    tab.sessionId === sessionId ? [...indexes, index] : indexes,
                [],
            );

            if (!removedTabIndexes.length) return state;

            const tabs = state.tabs.filter(
                (tab) => tab.sessionId !== sessionId,
            );
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
                state.tabs.filter((tab) =>
                    validSessionIdSet.has(tab.sessionId),
                ),
                state.activeTabId,
            );
            const activeTabId =
                state.tabs[removedTabIndex]?.id === state.activeTabId
                    ? getNextActiveTabIdAfterRemoval(
                          tabs,
                          removedTabIndex,
                          null,
                      )
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

    restoreWorkspace: (payload, validSessions, fallbackSessionId = null) => {
        const validSessionIdSet = new Set(
            validSessions.map((s) => s.sessionId),
        );
        const sessionIdByHistoryId = new Map<string, string>();
        const historyIdBySessionId = new Map<string, string>();
        const runtimeIdBySessionId = new Map<string, string>();
        const runtimeIdByHistoryId = new Map<string, string>();
        for (const session of validSessions) {
            const historySessionId = session.historySessionId ?? null;
            if (!historySessionId) continue;
            sessionIdByHistoryId.set(historySessionId, session.sessionId);
            historyIdBySessionId.set(session.sessionId, historySessionId);
            if (session.runtimeId) {
                runtimeIdByHistoryId.set(historySessionId, session.runtimeId);
            }
        }
        for (const session of validSessions) {
            if (session.runtimeId) {
                runtimeIdBySessionId.set(session.sessionId, session.runtimeId);
            }
        }
        const workspace = normalizeWorkspace(payload);

        let tabs = normalizeTabs(
            (workspace?.tabs ?? [])
                .map((tab): ChatWorkspaceTab | null => {
                    if (validSessionIdSet.has(tab.sessionId)) {
                        return syncTabMetadata(
                            tab,
                            historyIdBySessionId.get(tab.sessionId) ??
                                resolveTabHistorySessionId(tab),
                            runtimeIdBySessionId.get(tab.sessionId) ??
                                runtimeIdByHistoryId.get(
                                    resolveTabHistorySessionId(tab) ?? "",
                                ) ??
                                tab.runtimeId,
                        );
                    }

                    const historySessionId = resolveTabHistorySessionId(tab);
                    if (!historySessionId) return null;

                    const resolvedSessionId =
                        sessionIdByHistoryId.get(historySessionId);
                    if (!resolvedSessionId) return null;

                    return {
                        ...tab,
                        sessionId: resolvedSessionId,
                        historySessionId,
                        runtimeId:
                            runtimeIdBySessionId.get(resolvedSessionId) ??
                            runtimeIdByHistoryId.get(historySessionId) ??
                            tab.runtimeId,
                    };
                })
                .filter((tab): tab is ChatWorkspaceTab => tab !== null),
            workspace?.activeTabId ?? null,
        );
        let activeTabId = resolveActiveTabId(
            tabs,
            workspace?.activeTabId ?? null,
        );

        if (
            tabs.length === 0 &&
            fallbackSessionId &&
            validSessionIdSet.has(fallbackSessionId)
        ) {
            const fallbackTab = createTab(
                fallbackSessionId,
                historyIdBySessionId.get(fallbackSessionId) ?? null,
                runtimeIdBySessionId.get(fallbackSessionId) ?? null,
            );
            tabs = [fallbackTab];
            activeTabId = fallbackTab.id;
        }

        set({
            tabs,
            activeTabId,
        });
    },

    replaceSessionId: (
        oldSessionId,
        newSessionId,
        historySessionId = null,
        runtimeId = null,
    ) => {
        if (!oldSessionId || !newSessionId || oldSessionId === newSessionId) {
            return;
        }

        set((state) => {
            const activeTabId = state.activeTabId;
            const tabs = normalizeTabs(
                state.tabs.map((tab) =>
                    tab.sessionId === oldSessionId
                        ? {
                              ...tab,
                              sessionId: newSessionId,
                              historySessionId:
                                  historySessionId ??
                                  tab.historySessionId ??
                                  resolveTabHistorySessionId(tab) ??
                                  undefined,
                              runtimeId:
                                  runtimeId ?? tab.runtimeId ?? undefined,
                          }
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

let _lastChatTabsSig = "";

useChatTabsStore.subscribe((state) => {
    if (!state.isReady) return;

    // Cheap fingerprint to skip expensive serialization when nothing relevant changed
    let sig = state.activeTabId ?? "";
    for (const t of state.tabs) {
        sig += `|${t.id}|${t.sessionId ?? ""}|${t.historySessionId ?? ""}|${t.runtimeId ?? ""}|${t.pinned ? "1" : "0"}`;
    }
    if (sig === _lastChatTabsSig) return;
    _lastChatTabsSig = sig;

    const vaultPath = useVaultStore.getState().vaultPath;
    if (!vaultPath) return;

    const workspace = buildPersistedWorkspace(state.tabs, state.activeTabId);
    const json = JSON.stringify(workspace);
    if (lastPersistedJsonByVaultPath.get(vaultPath) === json) return;

    if (persistTimer) {
        clearTimeout(persistTimer);
    }

    pendingPersistVaultPath = vaultPath;
    pendingPersistJson = json;
    persistTimer = setTimeout(() => {
        flushPendingPersistence();
        persistTimer = null;
    }, 500);
});

export function flushChatTabsPersistence() {
    if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = null;
    }
    flushPendingPersistence();
}

export function resetChatTabsStore() {
    flushChatTabsPersistence();

    lastPersistedJsonByVaultPath.clear();

    useChatTabsStore.setState({
        isReady: false,
        tabs: [],
        activeTabId: null,
    });
}
