import { create } from "zustand";
import {
    safeStorageGetItem,
    safeStorageSetItem,
} from "../../../app/utils/safeStorage";
import { logWarn } from "../../../app/utils/runtimeLog";
import {
    reorderAgentScope,
    reorderVisiblePinnedAgents,
} from "../agentSidebarOrder";

export interface ChatFolder {
    id: string;
    name: string;
    createdAt: number;
}

export interface AgentSidebarSessionMetadata {
    pinnedAt: number | null;
    completedAt: number | null;
    snoozedAt: number | null;
    snoozedUntil: number | null;
    folderId: string | null;
    lastVisitedAt: number | null;
}

export interface PersistedAgentSidebarStateV1 {
    version: 1;
    folders: Record<string, ChatFolder>;
    folderOrder: string[];
    collapsedFolderIds: string[];
    collapsedParentSessionIds: string[];
    pinnedOrder: string[];
    activeOrder: string[];
    snoozedShelfExpanded: boolean;
    completedShelfExpanded: boolean;
    sessionMetadata: Record<string, AgentSidebarSessionMetadata>;
}

interface AgentSidebarStore extends PersistedAgentSidebarStateV1 {
    vaultPath: string | null;
    legacyMigrationPending: boolean;
    setVaultPath: (vaultPath: string | null) => void;
    migrateLegacyMetadata: (rootSessionIds: Iterable<string>) => void;
    createFolder: (name: string) => string | null;
    renameFolder: (folderId: string, name: string) => void;
    deleteFolder: (folderId: string) => void;
    reorderFolder: (folderId: string, destinationIndex: number) => void;
    moveSessionToFolder: (sessionId: string, folderId: string | null) => void;
    toggleFolderCollapsed: (folderId: string) => void;
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
    reorderActiveSession: (
        sessionId: string,
        destinationIndex: number,
        scopeSessionIds?: readonly string[],
    ) => void;
    resetPinnedOrder: () => void;
    resetActiveOrder: () => void;
    replaceSessionId: (fromSessionId: string, toSessionId: string) => void;
    markSessionVisited: (sessionId: string, visitedAt?: number) => void;
    reconcile: (rootSessionIds: Iterable<string>) => void;
}

const STORAGE_PREFIX = "neverwrite.agents.sidebar.v1";
const LEGACY_FOLDERS_PREFIX = "neverwrite.chats.folders";
const LEGACY_PINNED_KEY = "neverwrite.chats.pinnedIds";
const LEGACY_COLLAPSED_PARENTS_KEY =
    "neverwrite.ai.agentsSidebar.collapsedParents";

export const EMPTY_AGENT_SIDEBAR_STATE: PersistedAgentSidebarStateV1 = {
    version: 1,
    folders: {},
    folderOrder: [],
    collapsedFolderIds: [],
    collapsedParentSessionIds: [],
    pinnedOrder: [],
    activeOrder: [],
    snoozedShelfExpanded: false,
    completedShelfExpanded: false,
    sessionMetadata: {},
};

const EMPTY_SESSION_METADATA: AgentSidebarSessionMetadata = {
    pinnedAt: null,
    completedAt: null,
    snoozedAt: null,
    snoozedUntil: null,
    folderId: null,
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

function normalizeFolderName(name: string) {
    return name.trim().replace(/\s+/g, " ").slice(0, 80);
}

function orderedFolderIds(
    folders: Record<string, ChatFolder>,
    requestedOrder: unknown,
) {
    const known = new Set(Object.keys(folders));
    const requested = uniqueStrings(requestedOrder, known);
    const fallback = Object.values(folders)
        .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
        .map((folder) => folder.id);
    return [...requested, ...fallback.filter((id) => !requested.includes(id))];
}

function normalizePersistedState(value: unknown): PersistedAgentSidebarStateV1 {
    if (!value || typeof value !== "object") return EMPTY_AGENT_SIDEBAR_STATE;
    const candidate = value as Partial<PersistedAgentSidebarStateV1>;
    const folders: Record<string, ChatFolder> = {};
    for (const [id, folder] of Object.entries(candidate.folders ?? {})) {
        const name = normalizeFolderName(folder?.name ?? "");
        if (!id || !name) continue;
        folders[id] = {
            id,
            name,
            createdAt: finiteTimestamp(folder?.createdAt) ?? 0,
        };
    }
    const folderIds = new Set(Object.keys(folders));
    const sessionMetadata: Record<string, AgentSidebarSessionMetadata> = {};
    for (const [sessionId, metadata] of Object.entries(
        candidate.sessionMetadata ?? {},
    )) {
        if (!sessionId || !metadata || typeof metadata !== "object") continue;
        const folderId =
            typeof metadata.folderId === "string" && folderIds.has(metadata.folderId)
                ? metadata.folderId
                : null;
        sessionMetadata[sessionId] = {
            pinnedAt: finiteTimestamp(metadata.pinnedAt),
            completedAt: finiteTimestamp(metadata.completedAt),
            snoozedAt: finiteTimestamp(metadata.snoozedAt),
            snoozedUntil: finiteTimestamp(metadata.snoozedUntil),
            folderId,
            lastVisitedAt: finiteTimestamp(metadata.lastVisitedAt),
        };
    }
    return {
        version: 1,
        folders,
        folderOrder: orderedFolderIds(folders, candidate.folderOrder),
        collapsedFolderIds: uniqueStrings(candidate.collapsedFolderIds, folderIds),
        collapsedParentSessionIds: uniqueStrings(
            candidate.collapsedParentSessionIds,
        ),
        pinnedOrder: uniqueStrings(candidate.pinnedOrder),
        activeOrder: uniqueStrings(candidate.activeOrder),
        snoozedShelfExpanded: candidate.snoozedShelfExpanded === true,
        completedShelfExpanded: candidate.completedShelfExpanded === true,
        sessionMetadata,
    };
}

function readState(vaultPath: string | null) {
    if (!vaultPath) return { state: EMPTY_AGENT_SIDEBAR_STATE, exists: false };
    const raw = safeStorageGetItem(getAgentSidebarStorageKey(vaultPath));
    if (!raw) return { state: readLegacyFolders(vaultPath), exists: false };
    try {
        return { state: normalizePersistedState(JSON.parse(raw)), exists: true };
    } catch (error) {
        logWarn("agent-sidebar", "Failed to hydrate agent sidebar metadata", error, {
            onceKey: `hydrate:${normalizeVaultPath(vaultPath)}`,
        });
        return { state: EMPTY_AGENT_SIDEBAR_STATE, exists: true };
    }
}

function readLegacyFolders(vaultPath: string): PersistedAgentSidebarStateV1 {
    const raw =
        safeStorageGetItem(
            `${LEGACY_FOLDERS_PREFIX}:${encodeURIComponent(vaultPath)}`,
        ) ?? safeStorageGetItem(LEGACY_FOLDERS_PREFIX);
    if (!raw) return EMPTY_AGENT_SIDEBAR_STATE;
    try {
        const legacy = JSON.parse(raw) as {
            folders?: Record<string, ChatFolder>;
            folderOrder?: string[];
            sessionFolderIds?: Record<string, string>;
            collapsedFolderIds?: string[];
        };
        const base = normalizePersistedState({
            version: 1,
            folders: legacy.folders,
            folderOrder: legacy.folderOrder,
            collapsedFolderIds: legacy.collapsedFolderIds,
        });
        const metadata = { ...base.sessionMetadata };
        for (const [sessionId, folderId] of Object.entries(
            legacy.sessionFolderIds ?? {},
        )) {
            if (base.folders[folderId]) {
                metadata[sessionId] = { ...EMPTY_SESSION_METADATA, folderId };
            }
        }
        return { ...base, sessionMetadata: metadata };
    } catch {
        return EMPTY_AGENT_SIDEBAR_STATE;
    }
}

function persistedSnapshot(state: AgentSidebarStore): PersistedAgentSidebarStateV1 {
    return {
        version: 1,
        folders: state.folders,
        folderOrder: state.folderOrder,
        collapsedFolderIds: state.collapsedFolderIds,
        collapsedParentSessionIds: state.collapsedParentSessionIds,
        pinnedOrder: state.pinnedOrder,
        activeOrder: state.activeOrder,
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
    createFolder: (rawName) => {
        const name = normalizeFolderName(rawName);
        if (!name) return null;
        const id = crypto.randomUUID();
        set((state) =>
            mutate(state, {
                folders: {
                    ...state.folders,
                    [id]: { id, name, createdAt: Date.now() },
                },
                folderOrder: [...orderedFolderIds(state.folders, state.folderOrder), id],
            }),
        );
        return id;
    },
    renameFolder: (folderId, rawName) =>
        set((state) => {
            const folder = state.folders[folderId];
            const name = normalizeFolderName(rawName);
            if (!folder || !name || folder.name === name) return state;
            return mutate(state, {
                folders: { ...state.folders, [folderId]: { ...folder, name } },
            });
        }),
    deleteFolder: (folderId) =>
        set((state) => {
            if (!state.folders[folderId]) return state;
            const folders = { ...state.folders };
            delete folders[folderId];
            const sessionMetadata = Object.fromEntries(
                Object.entries(state.sessionMetadata).map(([id, metadata]) => [
                    id,
                    metadata.folderId === folderId
                        ? { ...metadata, folderId: null }
                        : metadata,
                ]),
            );
            return mutate(state, {
                folders,
                folderOrder: state.folderOrder.filter((id) => id !== folderId),
                collapsedFolderIds: state.collapsedFolderIds.filter(
                    (id) => id !== folderId,
                ),
                sessionMetadata,
            });
        }),
    reorderFolder: (folderId, destinationIndex) =>
        set((state) => {
            if (!state.folders[folderId]) return state;
            const folderOrder = moveInOrder(
                orderedFolderIds(state.folders, state.folderOrder),
                folderId,
                destinationIndex,
            );
            return mutate(state, { folderOrder });
        }),
    moveSessionToFolder: (sessionId, folderId) =>
        set((state) => {
            if (folderId && !state.folders[folderId]) return state;
            const current = metadataFor(state, sessionId);
            if (current.folderId === folderId) return state;
            return mutate(state, {
                sessionMetadata: {
                    ...state.sessionMetadata,
                    [sessionId]: { ...current, folderId },
                },
                activeOrder: state.activeOrder.filter((id) => id !== sessionId),
            });
        }),
    toggleFolderCollapsed: (folderId) =>
        set((state) => {
            if (!state.folders[folderId]) return state;
            const collapsed = new Set(state.collapsedFolderIds);
            if (collapsed.has(folderId)) collapsed.delete(folderId);
            else collapsed.add(folderId);
            return mutate(state, { collapsedFolderIds: [...collapsed] });
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
                    sessionId,
                    ...state.pinnedOrder.filter((id) => id !== sessionId),
                ],
                activeOrder: state.activeOrder.filter((id) => id !== sessionId),
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
                        pinnedAt: null,
                        completedAt: at,
                        snoozedAt: null,
                        snoozedUntil: null,
                    },
                },
                pinnedOrder: state.pinnedOrder.filter((id) => id !== sessionId),
                activeOrder: state.activeOrder.filter((id) => id !== sessionId),
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
                activeOrder:
                    current.pinnedAt === null
                        ? state.activeOrder.filter((id) => id !== sessionId)
                        : state.activeOrder,
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
    reorderActiveSession: (sessionId, destinationIndex, scopeSessionIds) =>
        set((state) =>
            mutate(state, {
                activeOrder: scopeSessionIds
                    ? reorderAgentScope(
                          state.activeOrder,
                          scopeSessionIds,
                          sessionId,
                          destinationIndex,
                      )
                    : moveInOrder(
                          state.activeOrder,
                          sessionId,
                          destinationIndex,
                      ),
            }),
        ),
    resetPinnedOrder: () => set((state) => mutate(state, { pinnedOrder: [] })),
    resetActiveOrder: () => set((state) => mutate(state, { activeOrder: [] })),
    replaceSessionId: (fromSessionId, toSessionId) =>
        set((state) => {
            if (!fromSessionId || !toSessionId || fromSessionId === toSessionId) {
                return state;
            }
            const source = state.sessionMetadata[fromSessionId];
            const collapsed = state.collapsedParentSessionIds.includes(fromSessionId);
            if (!source && !collapsed && !state.pinnedOrder.includes(fromSessionId) && !state.activeOrder.includes(fromSessionId)) {
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
                activeOrder: replaceInOrder(state.activeOrder, fromSessionId, toSessionId),
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
            const activeOrder = state.activeOrder.filter((id) => roots.has(id));
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
                sameOrder(activeOrder, state.activeOrder) &&
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
                activeOrder,
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
