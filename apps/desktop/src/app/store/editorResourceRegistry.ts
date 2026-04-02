import { vaultInvoke } from "../utils/vaultInvoke";
import { normalizeHistoryTab } from "./editorTabRegistry";
import {
    buildTabFromHistory,
    ensureFileTabDefaults,
    isFileTab,
    isHistoryTab,
    isMapTab,
    isNoteTab,
    type FileHistoryEntry,
    type FileTab,
    type NoteHistoryEntry,
    type NoteTab,
    type Tab,
} from "./editorTabs";

export type ResourceKind = "note" | "file";

export interface ResourceReloadDetail {
    content: string;
    title: string;
    origin?: "user" | "agent" | "external" | "system" | "unknown";
    opId?: string | null;
    revision?: number;
    contentHash?: string | null;
}

export interface ResourceReloadMetadata {
    origin: "user" | "agent" | "external" | "system" | "unknown";
    opId: string | null;
    revision: number;
    contentHash: string | null;
}

interface ResourceTabByKindMap {
    note: NoteTab;
    file: FileTab;
}

interface ResourceHistoryEntryByKindMap {
    note: NoteHistoryEntry;
    file: FileHistoryEntry;
}

interface ResourceReloadState<M extends ResourceReloadMetadata> {
    tabs: Tab[];
    pendingForceReloads: Set<string>;
    reloadVersions: Record<string, number>;
    reloadMetadata: Record<string, M | undefined>;
}

interface ResourceDeletionState<
    M extends ResourceReloadMetadata,
> extends ResourceReloadState<M> {
    activeTabId: string | null;
    activationHistory: string[];
    tabNavigationHistory: string[];
    tabNavigationIndex: number;
    externalConflicts: Set<string>;
}

interface ResourceDeleteTabsResult {
    tabs: Tab[];
    idsToClose: Set<string>;
    didChange: boolean;
}

interface ResourceDeleteUpdate<M extends ResourceReloadMetadata> {
    tabs: Tab[];
    activeTabId: string | null;
    activationHistory: string[];
    tabNavigationHistory: string[];
    tabNavigationIndex: number;
    pendingForceReloads: Set<string>;
    reloadVersions: Record<string, number>;
    reloadMetadata: Record<string, M | undefined>;
    externalConflicts: Set<string>;
}

export interface ResourceHandler<K extends ResourceKind> {
    kind: K;
    updateOpenTab: (
        tab: ResourceTabByKindMap[K],
        detail: ResourceReloadDetail,
    ) => ResourceTabByKindMap[K];
    removeFromTabs: (
        tabs: Tab[],
        resourceId: string,
    ) => ResourceDeleteTabsResult;
    matchesHistoryEntry: (
        entry: NoteHistoryEntry | FileHistoryEntry,
        resourceId: string,
    ) => entry is ResourceHistoryEntryByKindMap[K];
    patchHistoryEntryContent: (
        entry: ResourceHistoryEntryByKindMap[K],
        content: string,
    ) => ResourceHistoryEntryByKindMap[K];
    readHistoryEntryContent: (resourceId: string) => Promise<string>;
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

function omitKey<T>(record: Record<string, T>, keyToOmit: string) {
    return Object.fromEntries(
        Object.entries(record).filter(([key]) => key !== keyToOmit),
    ) as Record<string, T>;
}

function createReloadMetadata(
    detail: ResourceReloadDetail,
    fallbackOrigin: ResourceReloadMetadata["origin"],
): ResourceReloadMetadata {
    return {
        origin: detail.origin ?? fallbackOrigin,
        opId: detail.opId ?? null,
        revision: detail.revision ?? 0,
        contentHash: detail.contentHash ?? null,
    };
}

const noteResourceHandler: ResourceHandler<"note"> = {
    kind: "note",
    updateOpenTab: (tab, detail) => {
        if (tab.content === detail.content && tab.title === detail.title) {
            return tab;
        }
        return {
            ...tab,
            content: detail.content,
            title: detail.title,
        };
    },
    removeFromTabs: (tabs, noteId) => {
        const idsToClose = new Set(
            tabs
                .filter((tab) => isNoteTab(tab) && tab.noteId === noteId)
                .map((tab) => tab.id),
        );
        return {
            tabs:
                idsToClose.size > 0
                    ? tabs.filter((tab) => !idsToClose.has(tab.id))
                    : tabs,
            idsToClose,
            didChange: idsToClose.size > 0,
        };
    },
    matchesHistoryEntry: (entry, noteId): entry is NoteHistoryEntry =>
        entry.kind === "note" && entry.noteId === noteId,
    patchHistoryEntryContent: (entry, content) => ({
        ...entry,
        content,
    }),
    readHistoryEntryContent: async (noteId) => {
        const detail = await vaultInvoke<{ content: string }>("read_note", {
            noteId,
        });
        return detail.content;
    },
};

const fileResourceHandler: ResourceHandler<"file"> = {
    kind: "file",
    updateOpenTab: (tab, detail) => {
        if (tab.content === detail.content && tab.title === detail.title) {
            return tab;
        }
        return {
            ...tab,
            content: detail.content,
            title: detail.title,
        };
    },
    removeFromTabs: (tabs, relativePath) => {
        let didChange = false;
        const idsToClose = new Set(
            tabs.flatMap((rawTab) => {
                if (!isFileTab(rawTab)) {
                    return [];
                }

                const tab = ensureFileTabDefaults(rawTab);
                const removedEntries = tab.history.filter(
                    (entry) =>
                        entry.kind === "file" &&
                        entry.relativePath === relativePath,
                ).length;
                if (removedEntries === 0) {
                    return [];
                }

                didChange = true;
                return tab.history.length === removedEntries ? [tab.id] : [];
            }),
        );

        return {
            tabs: tabs.flatMap((rawTab): Tab[] => {
                if (!isFileTab(rawTab)) {
                    return [rawTab];
                }

                const tab = ensureFileTabDefaults(rawTab);
                const removedBeforeOrAtCurrent = tab.history
                    .slice(0, tab.historyIndex + 1)
                    .filter(
                        (entry) =>
                            entry.kind === "file" &&
                            entry.relativePath === relativePath,
                    ).length;
                const history = tab.history.filter(
                    (entry) =>
                        entry.kind !== "file" ||
                        entry.relativePath !== relativePath,
                );

                if (history.length === tab.history.length) {
                    return [rawTab];
                }

                didChange = true;
                if (history.length === 0) {
                    return [];
                }

                const nextHistoryIndex = Math.min(
                    Math.max(0, tab.historyIndex - removedBeforeOrAtCurrent),
                    history.length - 1,
                );
                return [buildTabFromHistory(tab.id, history, nextHistoryIndex)];
            }),
            idsToClose,
            didChange,
        };
    },
    matchesHistoryEntry: (entry, relativePath): entry is FileHistoryEntry =>
        entry.kind === "file" && entry.relativePath === relativePath,
    patchHistoryEntryContent: (entry, content) => ({
        ...entry,
        content,
    }),
    readHistoryEntryContent: async (relativePath) => {
        const detail = await vaultInvoke<{ content: string }>(
            "read_vault_file",
            { relativePath },
        );
        return detail.content;
    },
};

export const resourceHandlers: {
    [K in ResourceKind]: ResourceHandler<K>;
} = {
    note: noteResourceHandler,
    file: fileResourceHandler,
};

export function getResourceHandler<K extends ResourceKind>(kind: K) {
    return resourceHandlers[kind];
}

export function buildResourceReloadUpdate<
    K extends ResourceKind,
    M extends ResourceReloadMetadata,
>(
    handler: ResourceHandler<K>,
    state: ResourceReloadState<M>,
    resourceId: string,
    detail: ResourceReloadDetail,
    options?: { force?: boolean; fallbackOrigin?: M["origin"] },
) {
    const nextPendingForceReloads = options?.force
        ? new Set(state.pendingForceReloads).add(resourceId)
        : state.pendingForceReloads;

    return {
        tabs: state.tabs.map((tab) => {
            if (handler.kind === "note") {
                return isNoteTab(tab) && tab.noteId === resourceId
                    ? handler.updateOpenTab(
                          tab as ResourceTabByKindMap[K],
                          detail,
                      )
                    : tab;
            }
            return isFileTab(tab) && tab.relativePath === resourceId
                ? handler.updateOpenTab(tab as ResourceTabByKindMap[K], detail)
                : tab;
        }),
        pendingForceReloads: nextPendingForceReloads,
        reloadVersions: {
            ...state.reloadVersions,
            [resourceId]: (state.reloadVersions[resourceId] ?? 0) + 1,
        },
        reloadMetadata: {
            ...state.reloadMetadata,
            [resourceId]: createReloadMetadata(
                detail,
                options?.fallbackOrigin ?? "unknown",
            ) as M,
        },
    };
}

export function buildResourceDeleteUpdate<
    K extends ResourceKind,
    M extends ResourceReloadMetadata,
>(
    handler: ResourceHandler<K>,
    state: ResourceDeletionState<M>,
    resourceId: string,
): ResourceDeleteUpdate<M> | null {
    const { tabs, idsToClose, didChange } = handler.removeFromTabs(
        state.tabs,
        resourceId,
    );
    const pendingForceReloads = new Set(state.pendingForceReloads);
    const externalConflicts = new Set(state.externalConflicts);
    const hadPendingForceReload = pendingForceReloads.delete(resourceId);
    const hadExternalConflict = externalConflicts.delete(resourceId);
    const hadReloadVersion = resourceId in state.reloadVersions;
    const hadReloadMetadata = resourceId in state.reloadMetadata;
    const reloadVersions = hadReloadVersion
        ? omitKey(state.reloadVersions, resourceId)
        : state.reloadVersions;
    const reloadMetadata = hadReloadMetadata
        ? omitKey(state.reloadMetadata, resourceId)
        : state.reloadMetadata;

    if (
        !didChange &&
        !hadPendingForceReload &&
        !hadExternalConflict &&
        !hadReloadVersion &&
        !hadReloadMetadata
    ) {
        return null;
    }

    const activationHistory = state.activationHistory.filter(
        (id) => !idsToClose.has(id),
    );
    const tabNavigationHistory = state.tabNavigationHistory.filter(
        (id) => !idsToClose.has(id),
    );

    let activeTabId = state.activeTabId;
    if (activeTabId && idsToClose.has(activeTabId)) {
        const closedIdx = state.tabs.findIndex((tab) => tab.id === activeTabId);
        activeTabId =
            [...activationHistory]
                .reverse()
                .find((id) => tabs.some((tab) => tab.id === id)) ??
            tabs[Math.min(closedIdx, tabs.length - 1)]?.id ??
            null;
    }

    let tabNavigationIndex = Math.min(
        state.tabNavigationIndex,
        tabNavigationHistory.length - 1,
    );
    if (activeTabId) {
        const lastActiveIndex = tabNavigationHistory.lastIndexOf(activeTabId);
        if (lastActiveIndex === -1) {
            const navigation = pushTabToNavigation(
                tabNavigationHistory,
                tabNavigationIndex,
                activeTabId,
            );
            return {
                tabs,
                activeTabId,
                activationHistory,
                tabNavigationHistory: navigation.history,
                tabNavigationIndex: navigation.index,
                pendingForceReloads,
                reloadVersions,
                reloadMetadata,
                externalConflicts,
            };
        }
        tabNavigationIndex = lastActiveIndex;
    } else {
        tabNavigationIndex = -1;
    }

    return {
        tabs,
        activeTabId,
        activationHistory,
        tabNavigationHistory,
        tabNavigationIndex,
        pendingForceReloads,
        reloadVersions,
        reloadMetadata,
        externalConflicts,
    };
}

export async function loadResourceHistoryEntryContent<K extends ResourceKind>(
    handler: ResourceHandler<K>,
    tabId: string,
    historyIndex: number,
    resourceId: string,
    setState: (updater: (state: { tabs: Tab[] }) => { tabs: Tab[] }) => void,
) {
    try {
        const content = await handler.readHistoryEntryContent(resourceId);
        setState((state) => ({
            tabs: state.tabs.map((tab) => {
                if (tab.id !== tabId || !isHistoryTab(tab) || isMapTab(tab)) {
                    return tab;
                }

                const normalized = normalizeHistoryTab(tab);
                if (!normalized) {
                    return tab;
                }

                const history = [...normalized.history];
                const entry = history[historyIndex];
                if (
                    !entry ||
                    (entry.kind !== "note" && entry.kind !== "file") ||
                    !handler.matchesHistoryEntry(entry, resourceId)
                ) {
                    return tab;
                }

                history[historyIndex] = handler.patchHistoryEntryContent(
                    entry,
                    content,
                );
                return buildTabFromHistory(
                    normalized.id,
                    history,
                    normalized.historyIndex,
                );
            }),
        }));
    } catch (error) {
        console.error(
            `Error loading ${handler.kind} history entry content:`,
            error,
        );
    }
}
