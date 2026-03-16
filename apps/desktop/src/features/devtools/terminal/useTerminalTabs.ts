import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVaultStore } from "../../../app/store/vaultStore";
import {
    applyTerminalChunk,
    createTerminalBufferState,
    renderTerminalBuffer,
    type TerminalBufferState,
} from "./terminalBuffer";
import {
    DEV_TERMINAL_ERROR_EVENT,
    DEV_TERMINAL_EXITED_EVENT,
    DEV_TERMINAL_OUTPUT_EVENT,
    DEV_TERMINAL_STARTED_EVENT,
    EMPTY_TERMINAL_SNAPSHOT,
    type TerminalErrorEventPayload,
    type TerminalOutputEventPayload,
    type TerminalSessionCreateInput,
    type TerminalSessionSnapshot,
} from "./terminalTypes";

const TERMINAL_TABS_STORAGE_KEY_PREFIX = "vaultai.devtools.terminal.tabs:";
const TERMINAL_TABS_PERSIST_VERSION = 1;

interface PersistedTerminalWorkspaceTab {
    id: string;
    title: string | null;
    cwd: string | null;
}

interface PersistedTerminalWorkspace {
    version: 1;
    tabs: PersistedTerminalWorkspaceTab[];
    activeTabId: string | null;
}

interface OpenTerminalTabOptions {
    activate?: boolean;
    cwd?: string | null;
    title?: string | null;
}

function normalizeTitle(title: string | null | undefined) {
    const trimmed = title?.trim();
    return trimmed ? trimmed : null;
}

function createTabSnapshot(cwd: string | null): TerminalSessionSnapshot {
    return {
        ...EMPTY_TERMINAL_SNAPSHOT,
        cwd: cwd ?? "",
        status: "starting",
        errorMessage: null,
    };
}

function createTabId() {
    return crypto.randomUUID();
}

function createWorkspaceTab(
    options: Pick<PersistedTerminalWorkspaceTab, "id" | "cwd" | "title">,
): TerminalWorkspaceTab {
    return {
        id: options.id,
        sessionId: null,
        customTitle: normalizeTitle(options.title),
        snapshot: createTabSnapshot(options.cwd),
        bufferState: createTerminalBufferState(),
        output: "",
        busy: true,
    };
}

function normalizeTabs(
    tabs: PersistedTerminalWorkspaceTab[],
    fallbackCwd: string | null,
): PersistedTerminalWorkspaceTab[] {
    const deduped: PersistedTerminalWorkspaceTab[] = [];
    const seen = new Set<string>();

    for (const tab of tabs) {
        if (!tab.id || seen.has(tab.id)) continue;
        seen.add(tab.id);
        deduped.push({
            id: tab.id,
            title: normalizeTitle(tab.title),
            cwd: tab.cwd?.trim() ? tab.cwd : fallbackCwd,
        });
    }

    if (deduped.length > 0) {
        return deduped;
    }

    return [
        {
            id: createTabId(),
            title: null,
            cwd: fallbackCwd,
        },
    ];
}

function resolveActiveTabId(
    tabs: PersistedTerminalWorkspaceTab[],
    activeTabId: string | null,
) {
    if (activeTabId && tabs.some((tab) => tab.id === activeTabId)) {
        return activeTabId;
    }

    return tabs[0]?.id ?? null;
}

function buildPersistedWorkspace(
    tabs: TerminalWorkspaceTab[],
    activeTabId: string | null,
): PersistedTerminalWorkspace {
    const persistedTabs = normalizeTabs(
        tabs.map((tab) => ({
            id: tab.id,
            title: tab.customTitle,
            cwd: tab.snapshot.cwd || null,
        })),
        null,
    );

    return {
        version: TERMINAL_TABS_PERSIST_VERSION,
        tabs: persistedTabs,
        activeTabId: resolveActiveTabId(persistedTabs, activeTabId),
    };
}

function normalizeParsedWorkspace(
    raw: unknown,
    fallbackCwd: string | null,
): PersistedTerminalWorkspace | null {
    if (!raw || typeof raw !== "object") return null;

    const candidate = raw as {
        version?: unknown;
        tabs?: unknown;
        activeTabId?: unknown;
    };

    if (candidate.version !== TERMINAL_TABS_PERSIST_VERSION) return null;
    if (!Array.isArray(candidate.tabs)) return null;

    const tabs = normalizeTabs(
        candidate.tabs
            .map((tab): PersistedTerminalWorkspaceTab | null => {
                if (!tab || typeof tab !== "object") return null;
                const current = tab as {
                    id?: unknown;
                    title?: unknown;
                    cwd?: unknown;
                };
                if (typeof current.id !== "string" || current.id.length === 0) {
                    return null;
                }

                return {
                    id: current.id,
                    title:
                        typeof current.title === "string"
                            ? current.title
                            : null,
                    cwd: typeof current.cwd === "string" ? current.cwd : null,
                };
            })
            .filter(
                (tab): tab is PersistedTerminalWorkspaceTab => tab !== null,
            ),
        fallbackCwd,
    );

    return {
        version: TERMINAL_TABS_PERSIST_VERSION,
        tabs,
        activeTabId: resolveActiveTabId(
            tabs,
            typeof candidate.activeTabId === "string"
                ? candidate.activeTabId
                : null,
        ),
    };
}

function getTerminalTabsStorageKey(vaultPath: string) {
    return `${TERMINAL_TABS_STORAGE_KEY_PREFIX}${vaultPath}`;
}

export function readPersistedTerminalWorkspace(
    vaultPath: string | null,
): PersistedTerminalWorkspace | null {
    if (!vaultPath) return null;

    try {
        const raw = localStorage.getItem(getTerminalTabsStorageKey(vaultPath));
        if (!raw) return null;
        return normalizeParsedWorkspace(JSON.parse(raw), vaultPath);
    } catch {
        return null;
    }
}

async function closeSessionIds(sessionIds: string[], reason?: string) {
    console.log(
        "[terminal] closeSessionIds",
        sessionIds,
        "reason:",
        reason ?? "unknown",
        new Error().stack?.split("\n").slice(1, 4).join(" | "),
    );
    await Promise.all(
        sessionIds.map((sessionId) =>
            Promise.resolve(
                invoke("devtools_close_terminal_session", { sessionId }),
            ).catch(() => undefined),
        ),
    );
}

export interface TerminalWorkspaceTab {
    id: string;
    sessionId: string | null;
    customTitle: string | null;
    snapshot: TerminalSessionSnapshot;
    bufferState: TerminalBufferState;
    output: string;
    busy: boolean;
}

export interface UseTerminalTabsResult {
    tabs: TerminalWorkspaceTab[];
    activeTabId: string | null;
    activeTab: TerminalWorkspaceTab | null;
    openTab: (options?: OpenTerminalTabOptions) => Promise<string | null>;
    duplicateTab: (tabId: string) => Promise<string | null>;
    renameTab: (tabId: string, title: string | null) => void;
    resetTabTitle: (tabId: string) => void;
    reorderTabs: (fromIndex: number, toIndex: number) => void;
    selectTab: (tabId: string) => void;
    closeTab: (tabId: string) => Promise<void>;
    closeOtherTabs: (tabId: string) => Promise<void>;
    restartTab: (tabId: string) => Promise<void>;
    restartActiveTab: () => Promise<void>;
    clearTab: (tabId: string) => void;
    clearActiveTab: () => void;
    writeToTab: (tabId: string, input: string) => Promise<void>;
    resizeTab: (tabId: string, cols: number, rows: number) => Promise<void>;
}

export function useTerminalTabs(enabled: boolean): UseTerminalTabsResult {
    const vaultPath = useVaultStore((state) => state.vaultPath);
    const [tabs, setTabs] = useState<TerminalWorkspaceTab[]>([]);
    const [activeTabId, setActiveTabId] = useState<string | null>(null);
    const tabsRef = useRef<TerminalWorkspaceTab[]>([]);
    const activeTabIdRef = useRef<string | null>(null);
    const persistenceReadyRef = useRef(false);
    const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastPersistedJsonRef = useRef<string | null>(null);
    // Buffer output that arrives before attachSessionToTab sets the sessionId
    const pendingOutputRef = useRef<Map<string, string>>(new Map());
    const tabSessionVersionRef = useRef<Map<string, number>>(new Map());
    const retiredSessionIdsRef = useRef<Set<string>>(new Set());

    useEffect(() => {
        tabsRef.current = tabs;
        activeTabIdRef.current = activeTabId;
    }, [tabs, activeTabId]);

    const updateTab = useCallback(
        (
            tabId: string,
            updater: (tab: TerminalWorkspaceTab) => TerminalWorkspaceTab,
        ) => {
            setTabs((current) =>
                current.map((tab) => (tab.id === tabId ? updater(tab) : tab)),
            );
        },
        [],
    );

    const bumpTabSessionVersion = useCallback((tabId: string) => {
        const nextVersion = (tabSessionVersionRef.current.get(tabId) ?? 0) + 1;
        tabSessionVersionRef.current.set(tabId, nextVersion);
        return nextVersion;
    }, []);

    const invalidateTabSessionRequest = useCallback(
        (tabId: string) => {
            bumpTabSessionVersion(tabId);
        },
        [bumpTabSessionVersion],
    );

    const invalidateTabSessionRequests = useCallback(
        (tabIds: string[]) => {
            for (const tabId of tabIds) {
                invalidateTabSessionRequest(tabId);
            }
        },
        [invalidateTabSessionRequest],
    );

    const closeTrackedSessionIds = useCallback(
        async (sessionIds: string[], reason?: string) => {
            const nextSessionIds = [...new Set(sessionIds)].filter(
                (sessionId) => {
                    if (!sessionId) return false;
                    if (retiredSessionIdsRef.current.has(sessionId)) {
                        return false;
                    }
                    retiredSessionIdsRef.current.add(sessionId);
                    pendingOutputRef.current.delete(sessionId);
                    return true;
                },
            );

            if (nextSessionIds.length === 0) {
                return;
            }

            await closeSessionIds(nextSessionIds, reason);
        },
        [],
    );

    const attachSessionToTab = useCallback(
        (tabId: string, nextSnapshot: TerminalSessionSnapshot) => {
            const bufferedRaw =
                pendingOutputRef.current.get(nextSnapshot.sessionId) ?? "";
            pendingOutputRef.current.delete(nextSnapshot.sessionId);
            console.log(
                "[terminal] attachSession",
                tabId,
                "→ sessionId:",
                nextSnapshot.sessionId,
                "| status:",
                nextSnapshot.status,
                "| bufferedRaw.length:",
                bufferedRaw.length,
            );

            let attached = false;
            const nextTabs = tabsRef.current.map((tab) => {
                if (tab.id !== tabId) return tab;
                attached = true;
                const nextBuffer = bufferedRaw
                    ? applyTerminalChunk(tab.bufferState, bufferedRaw)
                    : tab.bufferState;
                return {
                    ...tab,
                    sessionId: nextSnapshot.sessionId,
                    snapshot: nextSnapshot,
                    bufferState: nextBuffer,
                    output: renderTerminalBuffer(nextBuffer),
                    busy: false,
                };
            });

            if (!attached) {
                return false;
            }

            tabsRef.current = nextTabs;
            setTabs(nextTabs);
            return true;
        },
        [],
    );

    const createSessionForTab = useCallback(
        async (tabId: string, input?: TerminalSessionCreateInput) => {
            const requestVersion = bumpTabSessionVersion(tabId);
            try {
                const next = await invoke<TerminalSessionSnapshot>(
                    "devtools_create_terminal_session",
                    {
                        input: {
                            cwd: input?.cwd ?? vaultPath,
                            cols: input?.cols,
                            rows: input?.rows,
                        },
                    },
                );

                if (
                    tabSessionVersionRef.current.get(tabId) !== requestVersion
                ) {
                    await closeTrackedSessionIds(
                        [next.sessionId],
                        "stale-create",
                    );
                    return next;
                }

                if (!attachSessionToTab(tabId, next)) {
                    await closeTrackedSessionIds(
                        [next.sessionId],
                        "attach-failed",
                    );
                }

                return next;
            } catch (error) {
                updateTab(tabId, (tab) => ({
                    ...tab,
                    busy: false,
                    snapshot: {
                        ...tab.snapshot,
                        status: "error",
                        errorMessage:
                            error instanceof Error
                                ? error.message
                                : String(error ?? "Terminal session failed"),
                    },
                }));
                return null;
            }
        },
        [
            attachSessionToTab,
            bumpTabSessionVersion,
            closeTrackedSessionIds,
            updateTab,
            vaultPath,
        ],
    );

    // Stable ref so workspace restoration effect doesn't re-run on HMR
    const createSessionForTabRef = useRef(createSessionForTab);
    useEffect(() => {
        createSessionForTabRef.current = createSessionForTab;
    }, [createSessionForTab]);

    const openTab = useCallback(
        async (options?: OpenTerminalTabOptions) => {
            if (!enabled) return null;

            const tabId = createTabId();
            const nextTab = createWorkspaceTab({
                id: tabId,
                title: options?.title ?? null,
                cwd: options?.cwd ?? vaultPath,
            });

            const nextTabs = [...tabsRef.current, nextTab];
            tabsRef.current = nextTabs;
            setTabs(nextTabs);
            if (options?.activate !== false) {
                activeTabIdRef.current = tabId;
                setActiveTabId(tabId);
            }

            await createSessionForTabRef.current(tabId, {
                cwd: nextTab.snapshot.cwd || vaultPath,
                cols: nextTab.snapshot.cols,
                rows: nextTab.snapshot.rows,
            });

            return tabId;
        },
        [enabled, vaultPath],
    );

    const duplicateTab = useCallback(
        async (tabId: string) => {
            const tab = tabsRef.current.find((entry) => entry.id === tabId);
            if (!tab) return null;

            const title = tab.customTitle ? `${tab.customTitle} copy` : null;

            return openTab({
                activate: true,
                cwd: tab.snapshot.cwd || vaultPath,
                title,
            });
        },
        [openTab, vaultPath],
    );

    const renameTab = useCallback(
        (tabId: string, title: string | null) => {
            const nextTitle = normalizeTitle(title);
            updateTab(tabId, (tab) => ({
                ...tab,
                customTitle: nextTitle,
            }));
        },
        [updateTab],
    );

    const resetTabTitle = useCallback(
        (tabId: string) => {
            renameTab(tabId, null);
        },
        [renameTab],
    );

    const reorderTabs = useCallback((fromIndex: number, toIndex: number) => {
        if (fromIndex === toIndex) return;

        setTabs((current) => {
            if (
                fromIndex < 0 ||
                toIndex < 0 ||
                fromIndex >= current.length ||
                toIndex >= current.length
            ) {
                return current;
            }

            const next = [...current];
            const [moved] = next.splice(fromIndex, 1);
            next.splice(toIndex, 0, moved);
            return next;
        });
    }, []);

    const selectTab = useCallback((tabId: string) => {
        setActiveTabId((current) =>
            tabsRef.current.some((tab) => tab.id === tabId) ? tabId : current,
        );
    }, []);

    const closeTab = useCallback(
        async (tabId: string) => {
            const currentTabs = tabsRef.current;
            const index = currentTabs.findIndex((tab) => tab.id === tabId);
            if (index < 0) return;

            const closingTab = currentTabs[index];
            const nextTabs = currentTabs.filter((tab) => tab.id !== tabId);
            const nextActiveTabId =
                activeTabIdRef.current === tabId
                    ? (nextTabs[index]?.id ??
                      nextTabs[index - 1]?.id ??
                      nextTabs[0]?.id ??
                      null)
                    : activeTabIdRef.current;

            tabsRef.current = nextTabs;
            activeTabIdRef.current = nextActiveTabId;
            invalidateTabSessionRequest(tabId);
            setTabs(nextTabs);
            setActiveTabId(nextActiveTabId);

            if (closingTab.sessionId) {
                await closeTrackedSessionIds(
                    [closingTab.sessionId],
                    "close-tab",
                );
            }

            if (nextTabs.length === 0) {
                await openTab();
            }
        },
        [closeTrackedSessionIds, invalidateTabSessionRequest, openTab],
    );

    const closeOtherTabs = useCallback(
        async (tabId: string) => {
            const currentTabs = tabsRef.current;
            const preservedTab = currentTabs.find((tab) => tab.id === tabId);
            if (!preservedTab) return;

            const closingSessionIds = currentTabs
                .filter((tab) => tab.id !== tabId)
                .map((tab) => tab.sessionId)
                .filter((sessionId): sessionId is string => Boolean(sessionId));

            invalidateTabSessionRequests(
                currentTabs
                    .filter((tab) => tab.id !== tabId)
                    .map((tab) => tab.id),
            );
            tabsRef.current = [preservedTab];
            activeTabIdRef.current = tabId;
            setTabs([preservedTab]);
            setActiveTabId(tabId);

            if (closingSessionIds.length > 0) {
                await closeTrackedSessionIds(
                    closingSessionIds,
                    "close-other-tabs",
                );
            }
        },
        [closeTrackedSessionIds, invalidateTabSessionRequests],
    );

    const restartTab = useCallback(
        async (tabId: string) => {
            const tab = tabsRef.current.find((entry) => entry.id === tabId);
            if (!tab) return;

            updateTab(tabId, (current) => ({
                ...current,
                busy: true,
                bufferState: createTerminalBufferState(),
                output: "",
                snapshot: {
                    ...current.snapshot,
                    status: "starting",
                    errorMessage: null,
                    exitCode: null,
                },
            }));

            if (!tab.sessionId) {
                await createSessionForTabRef.current(tabId, {
                    cwd: tab.snapshot.cwd || vaultPath,
                    cols: tab.snapshot.cols,
                    rows: tab.snapshot.rows,
                });
                return;
            }

            try {
                const next = await invoke<TerminalSessionSnapshot>(
                    "devtools_restart_terminal_session",
                    { sessionId: tab.sessionId },
                );
                updateTab(tabId, (current) => ({
                    ...current,
                    snapshot: next,
                    busy: false,
                }));
            } catch (error) {
                updateTab(tabId, (current) => ({
                    ...current,
                    busy: false,
                    snapshot: {
                        ...current.snapshot,
                        status: "error",
                        errorMessage:
                            error instanceof Error
                                ? error.message
                                : String(error ?? "Terminal restart failed"),
                    },
                }));
            }
        },
        [updateTab, vaultPath],
    );

    const restartActiveTab = useCallback(async () => {
        const tabId = activeTabIdRef.current;
        if (!tabId) return;
        await restartTab(tabId);
    }, [restartTab]);

    const clearTab = useCallback(
        (tabId: string) => {
            updateTab(tabId, (tab) => ({
                ...tab,
                bufferState: createTerminalBufferState(),
                output: "",
            }));
        },
        [updateTab],
    );

    const clearActiveTab = useCallback(() => {
        const tabId = activeTabIdRef.current;
        if (!tabId) return;
        clearTab(tabId);
    }, [clearTab]);

    const writeToTab = useCallback(async (tabId: string, input: string) => {
        if (!input) return;
        const tab = tabsRef.current.find((entry) => entry.id === tabId);
        if (!tab?.sessionId) return;

        await invoke("devtools_write_terminal_session", {
            input: {
                sessionId: tab.sessionId,
                data: input,
            },
        });
    }, []);

    const resizeTab = useCallback(
        async (tabId: string, cols: number, rows: number) => {
            if (cols < 1 || rows < 1) return;
            const tab = tabsRef.current.find((entry) => entry.id === tabId);
            if (!tab?.sessionId) return;
            if (tab.snapshot.cols === cols && tab.snapshot.rows === rows) {
                return;
            }

            const next = await invoke<TerminalSessionSnapshot>(
                "devtools_resize_terminal_session",
                {
                    input: {
                        sessionId: tab.sessionId,
                        cols,
                        rows,
                    },
                },
            );

            updateTab(tabId, (current) => ({
                ...current,
                snapshot: {
                    ...current.snapshot,
                    cols: next.cols,
                    rows: next.rows,
                },
            }));
        },
        [updateTab],
    );

    useEffect(() => {
        if (!enabled) return;

        let cancelled = false;
        const detachPromise = Promise.all([
            listen<TerminalOutputEventPayload>(
                DEV_TERMINAL_OUTPUT_EVENT,
                (event) => {
                    if (cancelled) return;
                    const { sessionId, chunk } = event.payload;
                    if (retiredSessionIdsRef.current.has(sessionId)) return;
                    console.log(
                        "[terminal] output event",
                        sessionId,
                        "| chunk.length:",
                        chunk.length,
                        "| first50:",
                        JSON.stringify(chunk.slice(0, 50)),
                    );
                    setTabs((current) => {
                        const matched = current.some(
                            (tab) => tab.sessionId === sessionId,
                        );
                        if (matched) {
                            return current.map((tab) => {
                                if (tab.sessionId !== sessionId) return tab;
                                const nextBuffer = applyTerminalChunk(
                                    tab.bufferState,
                                    chunk,
                                );
                                return {
                                    ...tab,
                                    bufferState: nextBuffer,
                                    output: renderTerminalBuffer(nextBuffer),
                                };
                            });
                        }
                        // Buffer raw output for sessions not yet attached to a tab
                        const existing =
                            pendingOutputRef.current.get(sessionId) ?? "";
                        pendingOutputRef.current.set(
                            sessionId,
                            existing + chunk,
                        );
                        return current;
                    });
                },
            ),
            listen<TerminalSessionSnapshot>(
                DEV_TERMINAL_STARTED_EVENT,
                (event) => {
                    if (cancelled) return;
                    setTabs((current) =>
                        current.map((tab) =>
                            tab.sessionId === event.payload.sessionId
                                ? {
                                      ...tab,
                                      snapshot: event.payload,
                                      busy: false,
                                  }
                                : tab,
                        ),
                    );
                },
            ),
            listen<TerminalSessionSnapshot>(
                DEV_TERMINAL_EXITED_EVENT,
                (event) => {
                    if (cancelled) return;
                    setTabs((current) =>
                        current.map((tab) =>
                            tab.sessionId === event.payload.sessionId
                                ? {
                                      ...tab,
                                      snapshot: event.payload,
                                      busy: false,
                                  }
                                : tab,
                        ),
                    );
                },
            ),
            listen<TerminalErrorEventPayload>(
                DEV_TERMINAL_ERROR_EVENT,
                (event) => {
                    if (cancelled) return;
                    setTabs((current) =>
                        current.map((tab) =>
                            tab.sessionId === event.payload.sessionId
                                ? {
                                      ...tab,
                                      busy: false,
                                      snapshot: {
                                          ...tab.snapshot,
                                          status: "error",
                                          errorMessage: event.payload.message,
                                      },
                                  }
                                : tab,
                        ),
                    );
                },
            ),
        ]);

        return () => {
            cancelled = true;
            void detachPromise.then((listeners) => {
                for (const unlisten of listeners) {
                    if (typeof unlisten === "function") {
                        unlisten();
                    }
                }
            });
        };
    }, [enabled]);

    useEffect(() => {
        if (!enabled) return;

        let cancelled = false;

        const restoreWorkspace = async () => {
            persistenceReadyRef.current = false;
            if (persistTimerRef.current) {
                clearTimeout(persistTimerRef.current);
                persistTimerRef.current = null;
            }

            const previousSessionIds = tabsRef.current
                .map((tab) => tab.sessionId)
                .filter((sessionId): sessionId is string => Boolean(sessionId));
            invalidateTabSessionRequests(tabsRef.current.map((tab) => tab.id));

            if (previousSessionIds.length > 0) {
                await closeTrackedSessionIds(
                    previousSessionIds,
                    "restore-workspace",
                );
            }

            if (cancelled) return;

            const workspace = readPersistedTerminalWorkspace(vaultPath) ?? {
                version: TERMINAL_TABS_PERSIST_VERSION,
                tabs: normalizeTabs([], vaultPath),
                activeTabId: null,
            };

            const restoredTabs = workspace.tabs.map((tab) =>
                createWorkspaceTab(tab),
            );

            const nextActiveTabId = resolveActiveTabId(
                workspace.tabs,
                workspace.activeTabId,
            );
            tabsRef.current = restoredTabs;
            activeTabIdRef.current = nextActiveTabId;
            setTabs(restoredTabs);
            setActiveTabId(nextActiveTabId);

            for (const restoredTab of restoredTabs) {
                if (cancelled) return;
                await createSessionForTabRef.current(restoredTab.id, {
                    cwd: restoredTab.snapshot.cwd || vaultPath,
                    cols: restoredTab.snapshot.cols,
                    rows: restoredTab.snapshot.rows,
                });
            }

            if (cancelled) return;
            lastPersistedJsonRef.current = JSON.stringify({
                version: TERMINAL_TABS_PERSIST_VERSION,
                tabs: workspace.tabs,
                activeTabId: resolveActiveTabId(
                    workspace.tabs,
                    workspace.activeTabId,
                ),
            });
            persistenceReadyRef.current = true;
        };

        void restoreWorkspace();

        return () => {
            cancelled = true;
        };
    }, [
        closeTrackedSessionIds,
        enabled,
        invalidateTabSessionRequests,
        vaultPath,
    ]);

    useEffect(() => {
        if (!enabled || !vaultPath || !persistenceReadyRef.current) {
            return;
        }

        const workspace = buildPersistedWorkspace(tabs, activeTabId);
        const json = JSON.stringify(workspace);
        if (lastPersistedJsonRef.current === json) {
            return;
        }

        if (persistTimerRef.current) {
            clearTimeout(persistTimerRef.current);
        }

        persistTimerRef.current = setTimeout(() => {
            localStorage.setItem(getTerminalTabsStorageKey(vaultPath), json);
            lastPersistedJsonRef.current = json;
            persistTimerRef.current = null;
        }, 300);

        return () => {
            if (persistTimerRef.current) {
                clearTimeout(persistTimerRef.current);
                persistTimerRef.current = null;
            }
        };
    }, [activeTabId, enabled, tabs, vaultPath]);

    useEffect(
        () => () => {
            if (persistTimerRef.current) {
                clearTimeout(persistTimerRef.current);
                persistTimerRef.current = null;
            }

            const vaultPathAtCleanup = useVaultStore.getState().vaultPath;
            if (vaultPathAtCleanup && persistenceReadyRef.current) {
                const workspace = buildPersistedWorkspace(
                    tabsRef.current,
                    activeTabIdRef.current,
                );
                const json = JSON.stringify(workspace);
                localStorage.setItem(
                    getTerminalTabsStorageKey(vaultPathAtCleanup),
                    json,
                );
                lastPersistedJsonRef.current = json;
            }

            const sessionIds = tabsRef.current
                .map((tab) => tab.sessionId)
                .filter((sessionId): sessionId is string => Boolean(sessionId));
            invalidateTabSessionRequests(tabsRef.current.map((tab) => tab.id));
            if (sessionIds.length > 0) {
                void closeTrackedSessionIds(sessionIds, "unmount-cleanup");
            }
        },
        [closeTrackedSessionIds, invalidateTabSessionRequests],
    );

    const activeTab = useMemo(
        () => tabs.find((tab) => tab.id === activeTabId) ?? null,
        [activeTabId, tabs],
    );

    return {
        tabs,
        activeTabId,
        activeTab,
        openTab,
        duplicateTab,
        renameTab,
        resetTabTitle,
        reorderTabs,
        selectTab,
        closeTab,
        closeOtherTabs,
        restartTab,
        restartActiveTab,
        clearTab,
        clearActiveTab,
        writeToTab,
        resizeTab,
    };
}
