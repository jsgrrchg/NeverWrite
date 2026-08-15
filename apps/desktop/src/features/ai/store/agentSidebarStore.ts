import { create } from "zustand";
import {
    safeStorageGetItem,
    safeStorageSetItem,
} from "../../../app/utils/safeStorage";
import { logWarn } from "../../../app/utils/runtimeLog";
import { reorderVisiblePinnedAgents } from "../agentSidebarOrder";

export interface AgentSidebarSessionMetadata {
    pinnedAt: number | null;
    completedAt: number | null;
    snoozedAt: number | null;
    snoozedUntil: number | null;
    lastVisitedAt: number | null;
}

export interface PersistedAgentSidebarStateV1 {
    version: 1;
    collapsedParentSessionIds: string[];
    pinnedOrder: string[];
    snoozedShelfExpanded: boolean;
    completedShelfExpanded: boolean;
    sessionMetadata: Record<string, AgentSidebarSessionMetadata>;
}

interface AgentSidebarStore extends PersistedAgentSidebarStateV1 {
    vaultPath: string | null;
    legacyMigrationPending: boolean;
    setVaultPath: (vaultPath: string | null) => void;
    migrateLegacyMetadata: (rootSessionIds: Iterable<string>) => void;
    toggleParentCollapsed: (sessionId: string) => void;
    setSnoozedShelfExpanded: (expanded: boolean) => void;
    setCompletedShelfExpanded: (expanded: boolean) => void;
    togglePin: (sessionId: string, at?: number) => void;
    pinSession: (sessionId: string, at?: number) => void;
    unpinSession: (sessionId: string) => void;
    completeSession: (sessionId: string, at?: number) => void;
    reopenSession: (sessionId: string) => void;
    snoozeSession: (sessionId: string, snoozedUntil: number, at?: number) => void;
    wakeSession: (sessionId: string) => void;
    reorderPinnedSession: (
        sessionId: string,
        destinationIndex: number,
        visibleSessionIds?: readonly string[],
    ) => void;
    resetPinnedOrder: () => void;
    restorePinnedOrder: (sessionIds: readonly string[]) => void;
    replaceSessionId: (fromSessionId: string, toSessionId: string) => void;
    markSessionVisited: (sessionId: string, visitedAt?: number) => void;
    reconcile: (rootSessionIds: Iterable<string>) => void;
}

const STORAGE_PREFIX = "neverwrite.agents.sidebar.v1";
const LEGACY_PINNED_KEY = "neverwrite.chats.pinnedIds";
const LEGACY_COLLAPSED_PARENTS_KEY =
    "neverwrite.ai.agentsSidebar.collapsedParents";

export const EMPTY_AGENT_SIDEBAR_STATE: PersistedAgentSidebarStateV1 = {
    version: 1,
    collapsedParentSessionIds: [],
    pinnedOrder: [],
    snoozedShelfExpanded: false,
    completedShelfExpanded: false,
    sessionMetadata: {},
};

const EMPTY_SESSION_METADATA: AgentSidebarSessionMetadata = {
    pinnedAt: null,
    completedAt: null,
    snoozedAt: null,
    snoozedUntil: null,
    lastVisitedAt: null,
};

function normalizeVaultPath(vaultPath: string) {
    const normalized = vaultPath.trim().replace(/\\/g, "/").replace(/\/+$/, "");
    return normalized || "/";
}

export function getAgentSidebarStorageKey(vaultPath: string) {
    return `${STORAGE_PREFIX}:${encodeURIComponent(normalizeVaultPath(vaultPath))}`;
}

function finiteTimestamp(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) && value >= 0
        ? value
        : null;
}

function uniqueStrings(value: unknown, allowed?: ReadonlySet<string>) {
    if (!Array.isArray(value)) return [];
    const result: string[] = [];
    const seen = new Set<string>();
    for (const candidate of value) {
        if (typeof candidate !== "string" || !candidate || seen.has(candidate)) {
            continue;
        }
        if (allowed && !allowed.has(candidate)) continue;
        seen.add(candidate);
        result.push(candidate);
    }
    return result;
}

function normalizePersistedState(value: unknown): PersistedAgentSidebarStateV1 {
    if (!value || typeof value !== "object") return EMPTY_AGENT_SIDEBAR_STATE;
    const candidate = value as Partial<PersistedAgentSidebarStateV1>;
    const sessionMetadata: Record<string, AgentSidebarSessionMetadata> = {};
    for (const [sessionId, metadata] of Object.entries(
        candidate.sessionMetadata ?? {},
    )) {
        if (!sessionId || !metadata || typeof metadata !== "object") continue;
        sessionMetadata[sessionId] = {
            pinnedAt: finiteTimestamp(metadata.pinnedAt),
            completedAt: finiteTimestamp(metadata.completedAt),
            snoozedAt: finiteTimestamp(metadata.snoozedAt),
            snoozedUntil: finiteTimestamp(metadata.snoozedUntil),
            lastVisitedAt: finiteTimestamp(metadata.lastVisitedAt),
        };
    }
    return {
        version: 1,
        collapsedParentSessionIds: uniqueStrings(
            candidate.collapsedParentSessionIds,
        ),
        pinnedOrder: uniqueStrings(candidate.pinnedOrder),
        snoozedShelfExpanded: candidate.snoozedShelfExpanded === true,
        completedShelfExpanded: candidate.completedShelfExpanded === true,
        sessionMetadata,
    };
}

function readState(vaultPath: string | null) {
    if (!vaultPath) return { state: EMPTY_AGENT_SIDEBAR_STATE, exists: false };
    const raw = safeStorageGetItem(getAgentSidebarStorageKey(vaultPath));
    if (!raw) return { state: EMPTY_AGENT_SIDEBAR_STATE, exists: false };
    try {
        return { state: normalizePersistedState(JSON.parse(raw)), exists: true };
    } catch (error) {
        logWarn("agent-sidebar", "Failed to hydrate agent sidebar metadata", error, {
            onceKey: `hydrate:${normalizeVaultPath(vaultPath)}`,
        });
        return { state: EMPTY_AGENT_SIDEBAR_STATE, exists: true };
    }
}

function persistedSnapshot(state: AgentSidebarStore): PersistedAgentSidebarStateV1 {
    return {
        version: 1,
        collapsedParentSessionIds: state.collapsedParentSessionIds,
        pinnedOrder: state.pinnedOrder,
        snoozedShelfExpanded: state.snoozedShelfExpanded,
        completedShelfExpanded: state.completedShelfExpanded,
        sessionMetadata: state.sessionMetadata,
    };
}

function persist(vaultPath: string | null, state: PersistedAgentSidebarStateV1) {
    if (!vaultPath) return;
    safeStorageSetItem(getAgentSidebarStorageKey(vaultPath), JSON.stringify(state));
}

function metadataFor(
    state: Pick<AgentSidebarStore, "sessionMetadata">,
    sessionId: string,
) {
    return state.sessionMetadata[sessionId] ?? EMPTY_SESSION_METADATA;
}

function replaceInOrder(order: readonly string[], from: string, to: string) {
    return uniqueStrings(order.map((id) => (id === from ? to : id)));
}

function moveInOrder(
    order: readonly string[],
    sessionId: string,
    destinationIndex: number,
) {
    const next = uniqueStrings(order).filter((id) => id !== sessionId);
    next.splice(Math.max(0, Math.min(destinationIndex, next.length)), 0, sessionId);
    return next;
}

function mutate(
    state: AgentSidebarStore,
    update: Partial<PersistedAgentSidebarStateV1>,
) {
    const next = { ...persistedSnapshot(state), ...update };
    persist(state.vaultPath, next);
    return next;
}

export const useAgentSidebarStore = create<AgentSidebarStore>((set) => ({
    ...EMPTY_AGENT_SIDEBAR_STATE,
    vaultPath: null,
    legacyMigrationPending: false,
    setVaultPath: (vaultPath) =>
        set((state) => {
            const normalized = vaultPath ? normalizeVaultPath(vaultPath) : null;
            if (state.vaultPath === normalized) return state;
            const hydrated = readState(normalized);
            return {
                vaultPath: normalized,
                legacyMigrationPending: Boolean(normalized && !hydrated.exists),
                ...hydrated.state,
            };
        }),
    migrateLegacyMetadata: (rootSessionIds) =>
        set((state) => {
            if (!state.vaultPath || !state.legacyMigrationPending) return state;
            const roots = new Set(rootSessionIds);
            const sessionMetadata = { ...state.sessionMetadata };
            const pinnedOrder: string[] = [];
            try {
                const raw = safeStorageGetItem(LEGACY_PINNED_KEY);
                const parsed = raw ? (JSON.parse(raw) as unknown) : null;
                if (parsed && typeof parsed === "object") {
                    for (const [sessionId, value] of Object.entries(parsed)) {
                        if (!roots.has(sessionId)) continue;
                        const pinnedAt =
                            finiteTimestamp(
                                value && typeof value === "object"
                                    ? (value as { pinnedAt?: unknown }).pinnedAt
                                    : value,
                            ) ?? 0;
                        sessionMetadata[sessionId] = {
                            ...metadataFor({ sessionMetadata }, sessionId),
                            pinnedAt,
                        };
                        pinnedOrder.push(sessionId);
                    }
                }
                const collapsedRaw = safeStorageGetItem(
                    LEGACY_COLLAPSED_PARENTS_KEY,
                );
                const collapsed = collapsedRaw
                    ? uniqueStrings(JSON.parse(collapsedRaw), roots)
                    : [];
                const next = mutate(state, {
                    sessionMetadata,
                    pinnedOrder: pinnedOrder.sort(
                        (left, right) =>
                            (sessionMetadata[right]?.pinnedAt ?? 0) -
                            (sessionMetadata[left]?.pinnedAt ?? 0),
                    ),
                    collapsedParentSessionIds: collapsed,
                });
                return { ...next, legacyMigrationPending: false };
            } catch (error) {
                logWarn("agent-sidebar", "Failed to migrate legacy metadata", error);
                const next = mutate(state, { sessionMetadata });
                return { ...next, legacyMigrationPending: false };
            }
        }),
    toggleParentCollapsed: (sessionId) =>
        set((state) => {
            const collapsed = new Set(state.collapsedParentSessionIds);
            if (collapsed.has(sessionId)) collapsed.delete(sessionId);
            else collapsed.add(sessionId);
            return mutate(state, { collapsedParentSessionIds: [...collapsed] });
        }),
    setSnoozedShelfExpanded: (expanded) =>
        set((state) => mutate(state, { snoozedShelfExpanded: expanded })),
    setCompletedShelfExpanded: (expanded) =>
        set((state) => mutate(state, { completedShelfExpanded: expanded })),
    togglePin: (sessionId, at = Date.now()) => {
        const state = useAgentSidebarStore.getState();
        if (metadataFor(state, sessionId).pinnedAt !== null) {
            state.unpinSession(sessionId);
        } else {
            state.pinSession(sessionId, at);
        }
    },
    pinSession: (sessionId, at = Date.now()) =>
        set((state) => {
            const current = metadataFor(state, sessionId);
            return mutate(state, {
                sessionMetadata: {
                    ...state.sessionMetadata,
                    [sessionId]: { ...current, pinnedAt: at, completedAt: null },
                },
                pinnedOrder: [
                    ...state.pinnedOrder.filter((id) => id !== sessionId),
                    sessionId,
                ],
            });
        }),
    unpinSession: (sessionId) =>
        set((state) => {
            const current = metadataFor(state, sessionId);
            if (current.pinnedAt === null) return state;
            return mutate(state, {
                sessionMetadata: {
                    ...state.sessionMetadata,
                    [sessionId]: { ...current, pinnedAt: null },
                },
                pinnedOrder: state.pinnedOrder.filter((id) => id !== sessionId),
            });
        }),
    completeSession: (sessionId, at = Date.now()) =>
        set((state) => {
            const current = metadataFor(state, sessionId);
            return mutate(state, {
                sessionMetadata: {
                    ...state.sessionMetadata,
                    [sessionId]: {
                        ...current,
                        completedAt: at,
                        snoozedAt: null,
                        snoozedUntil: null,
                    },
                },
            });
        }),
    reopenSession: (sessionId) =>
        set((state) => {
            const current = metadataFor(state, sessionId);
            return mutate(state, {
                sessionMetadata: {
                    ...state.sessionMetadata,
                    [sessionId]: {
                        ...current,
                        completedAt: null,
                        snoozedAt: null,
                        snoozedUntil: null,
                    },
                },
            });
        }),
    snoozeSession: (sessionId, snoozedUntil, at = Date.now()) =>
        set((state) => {
            const current = metadataFor(state, sessionId);
            return mutate(state, {
                sessionMetadata: {
                    ...state.sessionMetadata,
                    [sessionId]: {
                        ...current,
                        completedAt: null,
                        snoozedAt: at,
                        snoozedUntil,
                    },
                },
            });
        }),
    wakeSession: (sessionId) =>
        set((state) => {
            const current = metadataFor(state, sessionId);
            return mutate(state, {
                sessionMetadata: {
                    ...state.sessionMetadata,
                    [sessionId]: {
                        ...current,
                        snoozedAt: null,
                        snoozedUntil: null,
                    },
                },
            });
        }),
    reorderPinnedSession: (sessionId, destinationIndex, visibleSessionIds) =>
        set((state) =>
            mutate(state, {
                pinnedOrder: visibleSessionIds
                    ? reorderVisiblePinnedAgents(
                          state.pinnedOrder,
                          visibleSessionIds,
                          sessionId,
                          destinationIndex,
                      )
                    : moveInOrder(
                          state.pinnedOrder,
                          sessionId,
                          destinationIndex,
                      ),
            }),
        ),
    resetPinnedOrder: () => set((state) => mutate(state, { pinnedOrder: [] })),
    restorePinnedOrder: (sessionIds) =>
        set((state) =>
            mutate(state, { pinnedOrder: uniqueStrings(sessionIds) }),
        ),
    replaceSessionId: (fromSessionId, toSessionId) =>
        set((state) => {
            if (!fromSessionId || !toSessionId || fromSessionId === toSessionId) {
                return state;
            }
            const source = state.sessionMetadata[fromSessionId];
            const collapsed = state.collapsedParentSessionIds.includes(fromSessionId);
            if (!source && !collapsed && !state.pinnedOrder.includes(fromSessionId)) {
                return state;
            }
            const sessionMetadata = { ...state.sessionMetadata };
            if (source) {
                delete sessionMetadata[fromSessionId];
                sessionMetadata[toSessionId] = source;
            }
            return mutate(state, {
                sessionMetadata,
                pinnedOrder: replaceInOrder(state.pinnedOrder, fromSessionId, toSessionId),
                collapsedParentSessionIds: replaceInOrder(
                    state.collapsedParentSessionIds,
                    fromSessionId,
                    toSessionId,
                ),
            });
        }),
    markSessionVisited: (sessionId, visitedAt = Date.now()) =>
        set((state) => {
            const current = metadataFor(state, sessionId);
            if ((current.lastVisitedAt ?? 0) >= visitedAt) return state;
            return mutate(state, {
                sessionMetadata: {
                    ...state.sessionMetadata,
                    [sessionId]: { ...current, lastVisitedAt: visitedAt },
                },
            });
        }),
    reconcile: (rootSessionIds) =>
        set((state) => {
            const roots = new Set(rootSessionIds);
            const sessionMetadata: Record<string, AgentSidebarSessionMetadata> = {};
            for (const [sessionId, metadata] of Object.entries(
                state.sessionMetadata,
            )) {
                if (roots.has(sessionId)) {
                    sessionMetadata[sessionId] = metadata;
                    continue;
                }
                const persistedId = `persisted:${sessionId}`;
                if (roots.has(persistedId)) {
                    sessionMetadata[persistedId] = metadata;
                }
            }
            const pinnedOrder = state.pinnedOrder.filter((id) => roots.has(id));
            const collapsedParentSessionIds =
                state.collapsedParentSessionIds.filter((id) => roots.has(id));
            const metadataEntries = Object.entries(sessionMetadata);
            const metadataUnchanged =
                metadataEntries.length ===
                    Object.keys(state.sessionMetadata).length &&
                metadataEntries.every(
                    ([sessionId, metadata]) =>
                        state.sessionMetadata[sessionId] === metadata,
                );
            const sameOrder = (left: readonly string[], right: readonly string[]) =>
                left.length === right.length &&
                left.every((id, index) => id === right[index]);
            if (
                metadataUnchanged &&
                sameOrder(pinnedOrder, state.pinnedOrder) &&
                sameOrder(
                    collapsedParentSessionIds,
                    state.collapsedParentSessionIds,
                )
            ) {
                return state;
            }
            return mutate(state, {
                sessionMetadata,
                pinnedOrder,
                collapsedParentSessionIds,
            });
        }),
}));

export function resetAgentSidebarStore() {
    useAgentSidebarStore.setState({
        ...EMPTY_AGENT_SIDEBAR_STATE,
        vaultPath: null,
        legacyMigrationPending: false,
    });
}

export function syncAgentSidebarStorageEvent(
    event: Pick<StorageEvent, "key" | "newValue">,
) {
    const state = useAgentSidebarStore.getState();
    if (
        !state.vaultPath ||
        event.key !== getAgentSidebarStorageKey(state.vaultPath) ||
        event.newValue === null
    ) {
        return;
    }
    try {
        useAgentSidebarStore.setState({
            ...normalizePersistedState(JSON.parse(event.newValue)),
            legacyMigrationPending: false,
        });
    } catch (error) {
        logWarn(
            "agent-sidebar",
            "Failed to synchronize agent sidebar metadata",
            error,
            { onceKey: `storage-sync:${state.vaultPath}` },
        );
    }
}

if (typeof window !== "undefined") {
    window.addEventListener("storage", syncAgentSidebarStorageEvent);
}
