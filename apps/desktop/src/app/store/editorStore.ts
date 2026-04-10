import { create } from "zustand";
import type { EditorTarget } from "../../features/editor/editorTargetResolver";
import {
    buildTabFromHistory,
    createChatTab,
    createGraphTab,
    createMapTab,
    ensureFileTabDefaults,
    isChatTab,
    isFileTab,
    isGraphTab,
    isHistoryTab,
    isMapTab,
    isNavigableHistoryTab,
    isNoteTab,
    isPdfTab,
    isReviewTab,
    type ChatTab,
    type FileViewerMode,
    type HistoryTab,
    type NavigableHistoryTab,
    type PdfViewMode,
    type RecentlyClosedTab,
    type ReviewTab,
    type Tab,
    type TabHistoryEntry,
    type TabInput,
    type TabCloseReason,
} from "./editorTabs";
import {
    createHistorySnapshot,
    getOpenableHistoryTabHandler,
    normalizeHistoryTab,
    type OpenableHistoryPayload,
} from "./editorTabRegistry";
import {
    buildResourceDeleteUpdate,
    buildResourceReloadUpdate,
    getResourceHandler,
    loadResourceHistoryEntryContent,
    type ResourceReloadDetail,
    type ResourceReloadMetadata,
} from "./editorResourceRegistry";
import {
    buildPersistedSession,
    getEditorSessionSignature,
    isSessionReady,
    writePersistedSession,
} from "./editorSession";
import { useSettingsStore } from "./settingsStore";
import { useVaultStore } from "./vaultStore";
import {
    balanceSplit,
    DEFAULT_EDITOR_PANE_ID as INITIAL_EDITOR_PANE_ID,
    closePaneAndCollapse,
    createInitialLayout,
    getNextGeneratedPaneId,
    getLayoutPaneIds,
    movePane,
    normalizeLayoutTree,
    resizeSplit,
    splitPane,
    type WorkspaceLayoutNode,
    type WorkspaceMovePosition,
    type WorkspaceSplitDirection,
} from "./workspaceLayoutTree";
import { findAdjacentPane } from "./workspaceLayoutNavigation";

export {
    fileViewerNeedsTextContent,
    isChatTab,
    isFileTab,
    isGraphTab,
    isHistoryTab,
    isMapTab,
    isNavigableHistoryTab,
    isNoteTab,
    isPdfTab,
    isResourceBackedTab,
    isReviewTab,
    isTransientTab,
} from "./editorTabs";
export type {
    ChatTab,
    FileHistoryEntry,
    FileTab,
    FileTabInput,
    FileViewerMode,
    GraphTab,
    HistoryTab,
    HistoryTabInput,
    MapTab,
    MapTabInput,
    NavigableHistoryTab,
    NoteHistoryEntry,
    NoteTab,
    NoteTabInput,
    PdfHistoryEntry,
    PdfTab,
    PdfTabInput,
    PdfViewMode,
    ResourceBackedTab,
    ReviewTab,
    Tab,
    TabCloseReason,
    TabHistoryEntry,
    TabInput,
    TransientTab,
} from "./editorTabs";
export { markSessionReady, readPersistedSession } from "./editorSession";

const MAX_RECENTLY_CLOSED_TABS = 20;

interface LegacyWorkspaceState {
    tabs: Tab[];
    activeTabId: string | null;
    activationHistory: string[];
    tabNavigationHistory: string[];
    tabNavigationIndex: number;
}

export interface EditorPaneState extends LegacyWorkspaceState {
    id: string;
}

export interface EditorPaneInput {
    id?: string;
    tabs: TabInput[];
    activeTabId: string | null;
    activationHistory?: string[];
    tabNavigationHistory?: string[];
    tabNavigationIndex?: number;
}

export type WorkspacePaneNeighborDirection = "left" | "right" | "up" | "down";

function normalizeLegacyWorkspaceState(
    workspace: Partial<LegacyWorkspaceState>,
): LegacyWorkspaceState {
    const tabs = workspace.tabs ?? [];
    const tabIds = new Set(tabs.map((tab) => tab.id));
    const activeTabId =
        workspace.activeTabId && tabIds.has(workspace.activeTabId)
            ? workspace.activeTabId
            : (tabs[0]?.id ?? null);

    const activationHistory = (workspace.activationHistory ?? []).filter((id) =>
        tabIds.has(id),
    );
    if (activeTabId && !activationHistory.includes(activeTabId)) {
        activationHistory.push(activeTabId);
    }

    const tabNavigationHistory = (workspace.tabNavigationHistory ?? []).filter(
        (id) => tabIds.has(id),
    );

    if (activeTabId && !tabNavigationHistory.includes(activeTabId)) {
        tabNavigationHistory.push(activeTabId);
    }

    const tabNavigationIndex = activeTabId
        ? Math.max(
              0,
              Math.min(
                  workspace.tabNavigationIndex ??
                      tabNavigationHistory.lastIndexOf(activeTabId),
                  tabNavigationHistory.length - 1,
              ),
          )
        : -1;

    return {
        tabs,
        activeTabId,
        activationHistory,
        tabNavigationHistory,
        tabNavigationIndex,
    };
}

function createEditorPaneState(
    id: string,
    workspace: Partial<LegacyWorkspaceState> = {},
): EditorPaneState {
    return {
        id,
        ...normalizeLegacyWorkspaceState(workspace),
    };
}

function stringArraysEqual(left: readonly string[], right: readonly string[]) {
    return (
        left.length === right.length &&
        left.every((value, index) => value === right[index])
    );
}

function tabsShallowEqual(left: readonly Tab[], right: readonly Tab[]) {
    return (
        left.length === right.length &&
        left.every((value, index) => value === right[index])
    );
}

function getResolvedFocusedPaneId(
    panes: readonly EditorPaneState[],
    focusedPaneId: string | null | undefined,
) {
    if (focusedPaneId && panes.some((pane) => pane.id === focusedPaneId)) {
        return focusedPaneId;
    }
    return panes[0]?.id ?? INITIAL_EDITOR_PANE_ID;
}

function getNextEditorPaneId(panes: readonly EditorPaneState[]) {
    return getNextGeneratedPaneId(panes.map((pane) => pane.id));
}

function buildLinearLayoutTree(paneIds: readonly string[]) {
    if (paneIds.length === 0) {
        return createInitialLayout(INITIAL_EDITOR_PANE_ID);
    }

    let tree = createInitialLayout(paneIds[0] ?? INITIAL_EDITOR_PANE_ID);
    for (let index = 1; index < paneIds.length; index += 1) {
        const paneId = paneIds[index];
        const anchorPaneId = paneIds[index - 1];
        if (!paneId || !anchorPaneId) {
            continue;
        }
        tree = splitPane(tree, anchorPaneId, "row", paneId);
    }

    return tree;
}

function buildPaneCacheMap(panes: readonly EditorPaneState[]) {
    return new Map(
        panes.map((pane) => [pane.id, createEditorPaneState(pane.id, pane)]),
    );
}

function resolveLayoutTreeFromState<
    TState extends Pick<EditorStore, "panes" | "focusedPaneId"> &
        Partial<LegacyWorkspaceState> &
        Partial<Pick<EditorStore, "layoutTree">>,
>(state: TState, paneIds?: readonly string[]) {
    const resolvedPaneIds =
        paneIds ??
        (state.panes.length > 0
            ? state.panes.map((pane) => pane.id)
            : [INITIAL_EDITOR_PANE_ID]);

    if (state.layoutTree) {
        const normalizedTree = normalizeLayoutTree(state.layoutTree);
        const treePaneIds = getLayoutPaneIds(normalizedTree);
        if (stringArraysEqual(treePaneIds, resolvedPaneIds)) {
            return normalizedTree;
        }
    }

    return buildLinearLayoutTree(resolvedPaneIds);
}

function getEffectivePaneWorkspace<
    TState extends Pick<EditorStore, "panes" | "focusedPaneId"> &
        Partial<LegacyWorkspaceState> &
        Partial<Pick<EditorStore, "layoutTree">>,
>(state: TState) {
    const panes = state.panes.length > 0 ? state.panes : [];
    const hasLegacyWorkspace =
        Array.isArray(state.tabs) &&
        (state.tabs.length > 0 ||
            state.activeTabId !== null ||
            (state.activationHistory?.length ?? 0) > 0 ||
            (state.tabNavigationHistory?.length ?? 0) > 0 ||
            (state.tabNavigationIndex ?? -1) >= 0);

    if (panes.length > 1 || !hasLegacyWorkspace) {
        const effectivePanes =
            panes.length > 0
                ? panes
                : [createEditorPaneState(INITIAL_EDITOR_PANE_ID)];
        const layoutTree = resolveLayoutTreeFromState(
            state,
            effectivePanes.map((pane) => pane.id),
        );
        const paneCache = new Map(
            effectivePanes.map((pane) => [pane.id, pane] as const),
        );
        const orderedPanes = getLayoutPaneIds(layoutTree).map(
            (paneId) => paneCache.get(paneId) ?? createEditorPaneState(paneId),
        );
        return {
            layoutTree,
            panes: orderedPanes,
            focusedPaneId: getResolvedFocusedPaneId(
                orderedPanes,
                state.focusedPaneId,
            ),
        };
    }

    const singlePane =
        panes[0] ?? createEditorPaneState(INITIAL_EDITOR_PANE_ID);
    const isPlaceholderInitialPane =
        singlePane.id === INITIAL_EDITOR_PANE_ID &&
        singlePane.tabs.length === 0 &&
        singlePane.activeTabId === null &&
        singlePane.activationHistory.length === 0 &&
        singlePane.tabNavigationHistory.length === 0 &&
        singlePane.tabNavigationIndex === -1;

    if (!isPlaceholderInitialPane) {
        const layoutTree = resolveLayoutTreeFromState(
            state,
            panes.map((pane) => pane.id),
        );
        return {
            layoutTree,
            panes,
            focusedPaneId: getResolvedFocusedPaneId(panes, state.focusedPaneId),
        };
    }

    const legacyPane = createEditorPaneState(INITIAL_EDITOR_PANE_ID, {
        tabs: state.tabs ?? [],
        activeTabId: state.activeTabId ?? null,
        activationHistory: state.activationHistory ?? [],
        tabNavigationHistory: state.tabNavigationHistory ?? [],
        tabNavigationIndex: state.tabNavigationIndex ?? -1,
    });
    const layoutTree = resolveLayoutTreeFromState(state, [legacyPane.id]);

    return {
        layoutTree,
        panes: [legacyPane],
        focusedPaneId: getResolvedFocusedPaneId(
            [legacyPane],
            state.focusedPaneId,
        ),
    };
}

export function selectEditorPaneState<
    TState extends Pick<EditorStore, "panes" | "focusedPaneId"> &
        Partial<LegacyWorkspaceState> &
        Partial<Pick<EditorStore, "layoutTree">>,
>(state: TState, paneId?: string | null) {
    return selectPaneState(state, paneId);
}

export function selectLeafPaneIds<
    TState extends Pick<EditorStore, "panes" | "focusedPaneId"> &
        Partial<LegacyWorkspaceState> &
        Partial<Pick<EditorStore, "layoutTree">>,
>(state: TState) {
    return getLayoutPaneIds(getEffectivePaneWorkspace(state).layoutTree);
}

export function selectFocusedPaneId<
    TState extends Pick<EditorStore, "panes" | "focusedPaneId"> &
        Partial<LegacyWorkspaceState> &
        Partial<Pick<EditorStore, "layoutTree">>,
>(state: TState) {
    return getEffectivePaneWorkspace(state).focusedPaneId;
}

export function selectPaneCount<
    TState extends Pick<EditorStore, "panes" | "focusedPaneId"> &
        Partial<LegacyWorkspaceState> &
        Partial<Pick<EditorStore, "layoutTree">>,
>(state: TState) {
    return selectLeafPaneIds(state).length;
}

export function selectPaneState<
    TState extends Pick<EditorStore, "panes" | "focusedPaneId"> &
        Partial<LegacyWorkspaceState> &
        Partial<Pick<EditorStore, "layoutTree">>,
>(state: TState, paneId?: string | null) {
    const { panes, focusedPaneId } = getEffectivePaneWorkspace(state);
    const resolvedPaneId = paneId
        ? getResolvedFocusedPaneId(panes, paneId)
        : getResolvedFocusedPaneId(panes, focusedPaneId);

    return (
        panes.find((pane) => pane.id === resolvedPaneId) ??
        panes[0] ??
        createEditorPaneState(INITIAL_EDITOR_PANE_ID)
    );
}

export function selectPaneNeighbor<
    TState extends Pick<EditorStore, "panes" | "focusedPaneId"> &
        Partial<LegacyWorkspaceState> &
        Partial<Pick<EditorStore, "layoutTree">>,
>(state: TState, paneId: string, direction: WorkspacePaneNeighborDirection) {
    const workspace = getEffectivePaneWorkspace(state);
    const geometricNeighbor = findAdjacentPane(
        workspace.layoutTree,
        paneId,
        direction,
    );
    if (geometricNeighbor) {
        return geometricNeighbor;
    }

    const paneIds = getLayoutPaneIds(workspace.layoutTree);
    const paneIndex = paneIds.indexOf(paneId);
    if (paneIndex === -1) {
        return null;
    }

    if (direction === "left" || direction === "up") {
        if (direction === "up") {
            return null;
        }
        return paneIds[paneIndex - 1] ?? null;
    }

    if (direction === "down") {
        return null;
    }

    return paneIds[paneIndex + 1] ?? null;
}

export function selectEditorPaneTabs<
    TState extends Pick<EditorStore, "panes" | "focusedPaneId"> &
        Partial<LegacyWorkspaceState> &
        Partial<Pick<EditorStore, "layoutTree">>,
>(state: TState, paneId?: string | null) {
    return selectPaneState(state, paneId).tabs;
}

export function selectEditorPaneActiveTab<
    TState extends Pick<EditorStore, "panes" | "focusedPaneId"> &
        Partial<LegacyWorkspaceState> &
        Partial<Pick<EditorStore, "layoutTree">>,
>(state: TState, paneId?: string | null) {
    const pane = selectPaneState(state, paneId);
    return pane.tabs.find((tab) => tab.id === pane.activeTabId) ?? null;
}

export function selectFocusedEditorTab<
    TState extends Pick<EditorStore, "panes" | "focusedPaneId"> &
        Partial<LegacyWorkspaceState> &
        Partial<Pick<EditorStore, "layoutTree">>,
>(state: TState) {
    return selectEditorPaneActiveTab(state);
}

export function selectEditorWorkspaceTabs<
    TState extends Pick<EditorStore, "panes" | "focusedPaneId"> &
        Partial<LegacyWorkspaceState> &
        Partial<Pick<EditorStore, "layoutTree">>,
>(state: TState) {
    return getEffectivePaneWorkspace(state).panes.flatMap((pane) => pane.tabs);
}

function buildFocusedPaneProjection(args: {
    panes: EditorPaneState[];
    focusedPaneId?: string | null;
    layoutTree?: WorkspaceLayoutNode;
}) {
    const paneStates =
        args.panes.length > 0
            ? args.panes.map((pane) => createEditorPaneState(pane.id, pane))
            : [createEditorPaneState(INITIAL_EDITOR_PANE_ID)];
    const paneIds = paneStates.map((pane) => pane.id);
    const layoutTree =
        args.layoutTree &&
        stringArraysEqual(
            getLayoutPaneIds(normalizeLayoutTree(args.layoutTree)),
            paneIds,
        )
            ? normalizeLayoutTree(args.layoutTree)
            : buildLinearLayoutTree(paneIds);
    const paneCache = buildPaneCacheMap(paneStates);
    const panes = getLayoutPaneIds(layoutTree).map(
        (paneId) => paneCache.get(paneId) ?? createEditorPaneState(paneId),
    );
    const focusedPaneId = getResolvedFocusedPaneId(panes, args.focusedPaneId);
    const focusedPane =
        panes.find((pane) => pane.id === focusedPaneId) ?? panes[0];

    return {
        layoutTree,
        panes,
        focusedPaneId,
        tabs: focusedPane.tabs,
        activeTabId: focusedPane.activeTabId,
        activationHistory: focusedPane.activationHistory,
        tabNavigationHistory: focusedPane.tabNavigationHistory,
        tabNavigationIndex: focusedPane.tabNavigationIndex,
    };
}

function pushTabToActivation(history: string[], tabId: string) {
    return [...history.filter((id) => id !== tabId), tabId];
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

function activateTab(
    state: Pick<
        EditorStore,
        | "tabs"
        | "activeTabId"
        | "activationHistory"
        | "tabNavigationHistory"
        | "tabNavigationIndex"
    >,
    tabId: string,
    options?: { recordNavigation?: boolean },
) {
    const activationHistory = pushTabToActivation(
        state.activationHistory,
        tabId,
    );
    if (options?.recordNavigation === false) {
        return { activeTabId: tabId, activationHistory };
    }

    const navigation = pushTabToNavigation(
        state.tabNavigationHistory,
        state.tabNavigationIndex,
        tabId,
    );

    return {
        activeTabId: tabId,
        activationHistory,
        tabNavigationHistory: navigation.history,
        tabNavigationIndex: navigation.index,
    };
}

function replaceTab(tabs: Tab[], tabId: string, nextTab: Tab) {
    return tabs.map((tab) => (tab.id === tabId ? nextTab : tab));
}

function getReusableHistoryTab(
    state: Pick<EditorStore, "tabs" | "activeTabId">,
): NavigableHistoryTab | null {
    const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId);
    if (!activeTab || !isNavigableHistoryTab(activeTab)) {
        return null;
    }
    return normalizeHistoryTab(activeTab) as NavigableHistoryTab;
}

function openOrReuseHistoryTab(
    state: Pick<
        EditorStore,
        | "tabs"
        | "activeTabId"
        | "activationHistory"
        | "tabNavigationHistory"
        | "tabNavigationIndex"
    >,
    payload: OpenableHistoryPayload,
) {
    const handler = getOpenableHistoryTabHandler(payload.kind);

    if (getTabOpenBehavior() === "new_tab") {
        const newTab = handler.createInitialTab(payload as never);
        return {
            tabs: [...state.tabs, newTab],
            ...activateTab(state, newTab.id),
        };
    }

    const activeTab = getReusableHistoryTab(state);
    if (!activeTab) {
        const newTab = handler.createInitialTab(payload as never);
        return {
            tabs: [...state.tabs, newTab],
            ...activateTab(state, newTab.id),
        };
    }

    if (activeTab.kind === payload.kind) {
        if (handler.matchesOpenTarget(activeTab as never, payload as never)) {
            if (!handler.replaceCurrentEntry) {
                return state;
            }
            const nextTab = handler.replaceCurrentEntry(
                activeTab as never,
                payload as never,
            );
            return {
                tabs: replaceTab(state.tabs, nextTab.id, nextTab),
            };
        }
    }

    const kept = activeTab.history.slice(0, activeTab.historyIndex);
    kept.push(
        createHistorySnapshot(activeTab),
        handler.createOpenEntry(payload as never),
    );
    const nextTab = handler.buildFromHistory(
        activeTab.id,
        kept,
        kept.length - 1,
    );
    return {
        tabs: replaceTab(state.tabs, activeTab.id, nextTab),
    };
}

function normalizeHydratedTab(tab: TabInput): Tab | null {
    if (isReviewTab(tab)) {
        return null;
    }
    if (isHistoryTab(tab)) {
        return normalizeHistoryTab(tab);
    }
    if (isGraphTab(tab)) {
        return tab;
    }
    return null;
}

function normalizeExternalTab(tab: TabInput): Tab | null {
    if (isHistoryTab(tab)) {
        return normalizeHistoryTab(tab);
    }
    if (isReviewTab(tab) || isChatTab(tab) || isGraphTab(tab)) {
        return tab;
    }
    return null;
}

function insertNormalizedTab(
    state: Pick<
        EditorStore,
        | "tabs"
        | "activeTabId"
        | "activationHistory"
        | "tabNavigationHistory"
        | "tabNavigationIndex"
    >,
    incoming: Tab,
    index?: number,
) {
    if (isGraphTab(incoming)) {
        const existing = state.tabs.find((tab) => isGraphTab(tab));
        if (existing) {
            const tabs =
                existing.title === incoming.title
                    ? state.tabs
                    : state.tabs.map((tab) =>
                          tab.id === existing.id
                              ? { ...tab, title: incoming.title }
                              : tab,
                      );
            return {
                tabs,
                ...activateTab(
                    {
                        ...state,
                        tabs,
                    },
                    existing.id,
                ),
            };
        }
    }

    const tabs = state.tabs.filter((existing) => existing.id !== incoming.id);
    const boundedIndex =
        index === undefined
            ? tabs.length
            : Math.max(0, Math.min(index, tabs.length));

    tabs.splice(boundedIndex, 0, incoming);
    return {
        tabs,
        ...activateTab(state, incoming.id),
    };
}

function removeTabFromWorkspaceState(
    state: Pick<
        EditorStore,
        | "tabs"
        | "activeTabId"
        | "activationHistory"
        | "tabNavigationHistory"
        | "tabNavigationIndex"
    >,
    tabId: string,
) {
    const idx = state.tabs.findIndex((tab) => tab.id === tabId);
    if (idx === -1) {
        return state;
    }

    const tabs = state.tabs.filter((tab) => tab.id !== tabId);
    let activeTabId = state.activeTabId;
    const activationHistory = state.activationHistory.filter(
        (id) => id !== tabId,
    );
    const tabNavigationHistory = state.tabNavigationHistory.filter(
        (id) => id !== tabId,
    );
    let tabNavigationIndex = Math.min(
        state.tabNavigationIndex,
        tabNavigationHistory.length - 1,
    );

    if (activeTabId === tabId) {
        activeTabId =
            [...activationHistory]
                .reverse()
                .find((id) => tabs.some((tab) => tab.id === id)) ??
            tabs[Math.min(idx, tabs.length - 1)]?.id ??
            null;
    }

    if (activeTabId) {
        const navigationIndex = tabNavigationHistory.lastIndexOf(activeTabId);
        if (navigationIndex === -1) {
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
            };
        }
        tabNavigationIndex = navigationIndex;
    } else {
        tabNavigationIndex = -1;
    }

    return {
        tabs,
        activeTabId,
        activationHistory,
        tabNavigationHistory,
        tabNavigationIndex,
    };
}

function mergePaneStates(
    targetPane: EditorPaneState,
    sourcePane: EditorPaneState,
) {
    const tabs = [...targetPane.tabs, ...sourcePane.tabs];
    const activeTabId = targetPane.activeTabId ?? sourcePane.activeTabId;
    const activationHistory = [
        ...targetPane.activationHistory,
        ...sourcePane.activationHistory,
    ].filter((tabId, index, items) => items.indexOf(tabId) === index);
    const tabNavigationHistory = [
        ...targetPane.tabNavigationHistory,
        ...sourcePane.tabNavigationHistory,
    ].filter((tabId, index, items) => items.indexOf(tabId) === index);
    const tabNavigationIndex = activeTabId
        ? Math.max(0, tabNavigationHistory.lastIndexOf(activeTabId))
        : -1;

    return createEditorPaneState(targetPane.id, {
        tabs,
        activeTabId,
        activationHistory,
        tabNavigationHistory,
        tabNavigationIndex,
    });
}

function getPaneRecipientIdForRemoval(
    panes: readonly EditorPaneState[],
    paneId: string,
) {
    const paneIndex = panes.findIndex((pane) => pane.id === paneId);
    if (paneIndex === -1) {
        return null;
    }

    return panes[paneIndex - 1]?.id ?? panes[paneIndex + 1]?.id ?? null;
}

function getPaneRecipientIdForWorkspace<
    TState extends Pick<EditorStore, "panes" | "focusedPaneId"> &
        Partial<LegacyWorkspaceState> &
        Partial<Pick<EditorStore, "layoutTree">>,
>(state: TState, paneId: string) {
    return (
        selectPaneNeighbor(state, paneId, "left") ??
        selectPaneNeighbor(state, paneId, "right") ??
        selectPaneNeighbor(state, paneId, "up") ??
        selectPaneNeighbor(state, paneId, "down") ??
        getPaneRecipientIdForRemoval(
            getEffectivePaneWorkspace(state).panes,
            paneId,
        )
    );
}

function getSplitAnchorPaneId(
    workspace: Pick<EditorStore, "panes" | "focusedPaneId">,
    paneId?: string | null,
) {
    return getResolvedFocusedPaneId(
        workspace.panes,
        paneId ?? workspace.focusedPaneId,
    );
}

function buildSplitPaneProjection(
    workspace: Pick<EditorStore, "panes" | "focusedPaneId" | "layoutTree">,
    anchorPaneId: string,
    direction: WorkspaceSplitDirection,
    nextPane: EditorPaneState,
) {
    return buildFocusedPaneProjection({
        panes: [...workspace.panes, nextPane],
        focusedPaneId: nextPane.id,
        layoutTree: splitPane(
            workspace.layoutTree,
            anchorPaneId,
            direction,
            nextPane.id,
        ),
    });
}

function removeEmptyPanesFromWorkspace(
    workspace: Pick<EditorStore, "panes" | "focusedPaneId" | "layoutTree">,
    options?: {
        preferredFocusedPaneId?: string | null;
    },
) {
    let nextPanes = workspace.panes;
    let nextLayoutTree = workspace.layoutTree;
    let nextFocusedPaneId = workspace.focusedPaneId;

    for (const pane of [...nextPanes]) {
        if (pane.tabs.length > 0) {
            continue;
        }

        if (nextPanes.length === 1) {
            nextPanes = [];
            nextLayoutTree = createInitialLayout(INITIAL_EDITOR_PANE_ID);
            nextFocusedPaneId = INITIAL_EDITOR_PANE_ID;
            break;
        }

        const workspaceBeforeRemoval = {
            panes: nextPanes,
            focusedPaneId: nextFocusedPaneId,
            layoutTree: nextLayoutTree,
        };

        if (nextFocusedPaneId === pane.id) {
            nextFocusedPaneId =
                getPaneRecipientIdForWorkspace(
                    workspaceBeforeRemoval,
                    pane.id,
                ) ??
                nextPanes.find((candidate) => candidate.id !== pane.id)?.id ??
                INITIAL_EDITOR_PANE_ID;
        }

        nextPanes = nextPanes.filter((candidate) => candidate.id !== pane.id);
        nextLayoutTree = closePaneAndCollapse(nextLayoutTree, pane.id);
    }

    const preferredFocusedPaneId = options?.preferredFocusedPaneId;
    if (
        preferredFocusedPaneId &&
        nextPanes.some((pane) => pane.id === preferredFocusedPaneId)
    ) {
        nextFocusedPaneId = preferredFocusedPaneId;
    }

    return {
        panes: nextPanes,
        focusedPaneId: nextFocusedPaneId,
        layoutTree: nextLayoutTree,
    };
}

function findPaneContainingTab(
    panes: readonly EditorPaneState[],
    tabId: string,
): EditorPaneState | null {
    return (
        panes.find((pane) => pane.tabs.some((tab) => tab.id === tabId)) ?? null
    );
}

function activatePaneTab(
    state: Pick<EditorStore, "panes" | "focusedPaneId" | "layoutTree">,
    paneId: string,
    tabId: string,
    options?: { recordNavigation?: boolean },
) {
    const targetPane = state.panes.find((pane) => pane.id === paneId);
    if (!targetPane) {
        return null;
    }

    return buildFocusedPaneProjection({
        panes: state.panes.map((pane) =>
            pane.id === paneId
                ? createEditorPaneState(pane.id, {
                      ...pane,
                      ...activateTab(pane, tabId, options),
                  })
                : pane,
        ),
        focusedPaneId: paneId,
        layoutTree: state.layoutTree,
    });
}

function patchCurrentHistoryEntry(
    tab: HistoryTab,
    patch: (entry: TabHistoryEntry) => TabHistoryEntry,
): HistoryTab {
    const normalized = normalizeHistoryTab(tab);
    if (!normalized) {
        return tab;
    }
    const currentEntry = normalized.history[normalized.historyIndex];

    if (!currentEntry) {
        return normalized;
    }

    const nextEntry = patch(currentEntry);
    if (nextEntry === currentEntry) {
        return normalized;
    }

    const history = [...normalized.history];
    history[normalized.historyIndex] = nextEntry;
    return buildTabFromHistory(normalized.id, history, normalized.historyIndex);
}

function patchHistoryTabById(
    tabs: Tab[],
    tabId: string,
    patch: (tab: HistoryTab) => Tab,
) {
    return tabs.map((tab) => {
        if (tab.id !== tabId || !isHistoryTab(tab)) {
            return tab;
        }
        return patch(tab);
    });
}

function updateTabHistoryTitle(tab: HistoryTab, title: string): Tab {
    if (tab.title === title && !tab.history[tab.historyIndex]) {
        return tab;
    }

    if (!tab.history[tab.historyIndex]) {
        return {
            ...tab,
            title,
        };
    }

    return patchCurrentHistoryEntry(tab, (entry) =>
        entry.title === title
            ? entry
            : {
                  ...entry,
                  title,
              },
    );
}

function loadHistoryEntryContentIfNeeded(
    tabId: string,
    historyIndex: number,
    entry: TabHistoryEntry,
) {
    if (entry.kind === "note" && !entry.content) {
        void loadResourceHistoryEntryContent(
            getResourceHandler("note"),
            tabId,
            historyIndex,
            entry.noteId,
            useEditorStore.setState,
        );
    }

    if (entry.kind === "file" && !entry.content) {
        void loadResourceHistoryEntryContent(
            getResourceHandler("file"),
            tabId,
            historyIndex,
            entry.relativePath,
            useEditorStore.setState,
        );
    }
}
function shouldRememberClosedTab(reason: TabCloseReason) {
    return reason === "user" || reason === "bulk-user";
}

function pushRecentlyClosedTab(
    entries: RecentlyClosedTab[],
    tab: Tab,
    index: number,
) {
    const next = entries.filter((entry) => entry.tab.id !== tab.id);
    next.push({
        tab,
        index: Math.max(0, index),
    });
    return next.slice(-MAX_RECENTLY_CLOSED_TABS);
}

function getTabOpenBehavior() {
    return useSettingsStore.getState().tabOpenBehavior;
}

function updatePaneWithTabs(pane: EditorPaneState, tabs: readonly Tab[]) {
    if (tabsShallowEqual(pane.tabs, tabs)) {
        return pane;
    }

    return createEditorPaneState(pane.id, {
        ...pane,
        tabs: [...tabs],
    });
}

function updateTabTitleInTabs(
    tabs: readonly Tab[],
    tabId: string,
    title: string,
) {
    let didChange = false;
    const nextTabs = tabs.map((tab) => {
        if (tab.id !== tabId) {
            return tab;
        }

        const nextTab = !isHistoryTab(tab)
            ? tab.title === title
                ? tab
                : { ...tab, title }
            : updateTabHistoryTitle(tab, title);

        didChange ||= nextTab !== tab;
        return nextTab;
    });

    return didChange ? nextTabs : tabs;
}

function applyResourceReloadToWorkspacePanes<K extends "note" | "file">(
    workspace: ReturnType<typeof getEffectivePaneWorkspace>,
    kind: K,
    resourceId: string,
    detail: ReloadedDetail,
    options?: {
        force?: boolean;
        fallbackOrigin?: "unknown" | "system" | "external" | "agent";
    },
) {
    const handler = getResourceHandler(kind);
    return workspace.panes.map((pane) => {
        const next = buildResourceReloadUpdate(
            handler,
            {
                tabs: pane.tabs,
                pendingForceReloads: new Set<string>(),
                reloadVersions: {},
                reloadMetadata: {},
            },
            resourceId,
            detail,
            options,
        );

        return updatePaneWithTabs(pane, next.tabs);
    });
}

function applyResourceReloadAcrossWorkspace<
    TState extends Pick<
        EditorStore,
        | "panes"
        | "focusedPaneId"
        | "layoutTree"
        | "tabs"
        | "_pendingForceReloads"
        | "_pendingForceFileReloads"
        | "_noteReloadVersions"
        | "_noteReloadMetadata"
        | "_fileReloadVersions"
        | "_fileReloadMetadata"
    >,
>(
    state: TState,
    kind: "note" | "file",
    resourceId: string,
    detail: ReloadedDetail,
    options?: {
        force?: boolean;
        fallbackOrigin?: "unknown" | "system" | "external" | "agent";
    },
) {
    const workspace = getEffectivePaneWorkspace(state);
    const nextPanes =
        kind === "note"
            ? applyResourceReloadToWorkspacePanes(
                  workspace,
                  "note",
                  resourceId,
                  detail,
                  options,
              )
            : applyResourceReloadToWorkspacePanes(
                  workspace,
                  "file",
                  resourceId,
                  detail,
                  options,
              );
    const projection = buildFocusedPaneProjection({
        panes: nextPanes,
        focusedPaneId: workspace.focusedPaneId,
        layoutTree: workspace.layoutTree,
    });
    const didChange =
        nextPanes.length !== workspace.panes.length ||
        nextPanes.some((pane, index) => pane !== workspace.panes[index]);

    if (kind === "note") {
        const nextMetadata = buildResourceReloadUpdate(
            getResourceHandler("note"),
            {
                tabs: state.tabs,
                pendingForceReloads: state._pendingForceReloads,
                reloadVersions: state._noteReloadVersions,
                reloadMetadata: state._noteReloadMetadata,
            },
            resourceId,
            detail,
            options,
        );

        return {
            projection,
            didChange,
            pendingForceReloads: nextMetadata.pendingForceReloads,
            reloadVersions: nextMetadata.reloadVersions,
            reloadMetadata: nextMetadata.reloadMetadata,
        };
    }

    const nextMetadata = buildResourceReloadUpdate(
        getResourceHandler("file"),
        {
            tabs: state.tabs,
            pendingForceReloads: state._pendingForceFileReloads,
            reloadVersions: state._fileReloadVersions,
            reloadMetadata: state._fileReloadMetadata,
        },
        resourceId,
        detail,
        options,
    );

    return {
        projection,
        didChange,
        pendingForceReloads: nextMetadata.pendingForceReloads,
        reloadVersions: nextMetadata.reloadVersions,
        reloadMetadata: nextMetadata.reloadMetadata,
    };
}

function applyResourceDeleteAcrossWorkspace<
    TState extends Pick<EditorStore, "panes" | "focusedPaneId" | "layoutTree">,
>(state: TState, kind: "note" | "file", resourceId: string) {
    const workspace = getEffectivePaneWorkspace(state);
    const nextPanes = workspace.panes.map((pane) => {
        const next =
            kind === "note"
                ? buildResourceDeleteUpdate(
                      getResourceHandler("note"),
                      {
                          tabs: pane.tabs,
                          activeTabId: pane.activeTabId,
                          activationHistory: pane.activationHistory,
                          tabNavigationHistory: pane.tabNavigationHistory,
                          tabNavigationIndex: pane.tabNavigationIndex,
                          pendingForceReloads: new Set<string>(),
                          reloadVersions: {},
                          reloadMetadata: {},
                          externalConflicts: new Set<string>(),
                      },
                      resourceId,
                  )
                : buildResourceDeleteUpdate(
                      getResourceHandler("file"),
                      {
                          tabs: pane.tabs,
                          activeTabId: pane.activeTabId,
                          activationHistory: pane.activationHistory,
                          tabNavigationHistory: pane.tabNavigationHistory,
                          tabNavigationIndex: pane.tabNavigationIndex,
                          pendingForceReloads: new Set<string>(),
                          reloadVersions: {},
                          reloadMetadata: {},
                          externalConflicts: new Set<string>(),
                      },
                      resourceId,
                  );

        return next
            ? createEditorPaneState(pane.id, {
                  tabs: next.tabs,
                  activeTabId: next.activeTabId,
                  activationHistory: next.activationHistory,
                  tabNavigationHistory: next.tabNavigationHistory,
                  tabNavigationIndex: next.tabNavigationIndex,
              })
            : pane;
    });

    const compactedWorkspace = removeEmptyPanesFromWorkspace({
        panes: nextPanes,
        focusedPaneId: workspace.focusedPaneId,
        layoutTree: workspace.layoutTree,
    });

    const didChange =
        compactedWorkspace.layoutTree !== workspace.layoutTree ||
        compactedWorkspace.focusedPaneId !== workspace.focusedPaneId ||
        compactedWorkspace.panes.length !== workspace.panes.length ||
        compactedWorkspace.panes.some(
            (pane, index) => pane !== workspace.panes[index],
        );

    return {
        projection: buildFocusedPaneProjection(compactedWorkspace),
        didChange,
    };
}

function renameNoteAcrossWorkspace<
    TState extends Pick<EditorStore, "panes" | "focusedPaneId" | "layoutTree">,
>(state: TState, oldNoteId: string, newNoteId: string, newTitle: string) {
    const workspace = getEffectivePaneWorkspace(state);
    const nextPanes = workspace.panes.map((pane) => {
        let didChange = false;
        const tabs = pane.tabs.map((tab) => {
            if (!isNoteTab(tab)) {
                return tab;
            }

            const history = tab.history.map((entry) => {
                if (entry.kind !== "note" || entry.noteId !== oldNoteId) {
                    return entry;
                }
                didChange = true;
                return {
                    ...entry,
                    noteId: newNoteId,
                    title: newTitle,
                };
            });

            return didChange
                ? buildTabFromHistory(tab.id, history, tab.historyIndex)
                : tab;
        });

        return didChange ? updatePaneWithTabs(pane, tabs) : pane;
    });

    return {
        projection: buildFocusedPaneProjection({
            panes: nextPanes,
            focusedPaneId: workspace.focusedPaneId,
            layoutTree: workspace.layoutTree,
        }),
        didChange:
            nextPanes.length !== workspace.panes.length ||
            nextPanes.some((pane, index) => pane !== workspace.panes[index]),
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
    noteId: string | null;
    path: string | null;
    text: string;
    from: number;
    to: number;
    startLine: number;
    endLine: number;
}

export interface ReloadedDetail {
    content: ResourceReloadDetail["content"];
    title: ResourceReloadDetail["title"];
    sizeBytes?: ResourceReloadDetail["sizeBytes"];
    contentTruncated?: ResourceReloadDetail["contentTruncated"];
    origin?: ResourceReloadDetail["origin"];
    opId?: ResourceReloadDetail["opId"];
    revision?: ResourceReloadDetail["revision"];
    contentHash?: ResourceReloadDetail["contentHash"];
}

interface EditorStore {
    layoutTree: WorkspaceLayoutNode;
    panes: EditorPaneState[];
    focusedPaneId: string | null;
    tabs: Tab[];
    activeTabId: string | null;
    recentlyClosedTabs: RecentlyClosedTab[];
    activationHistory: string[];
    tabNavigationHistory: string[];
    tabNavigationIndex: number;
    pendingReveal: PendingReveal | null;
    pendingSelectionReveal: PendingSelectionReveal | null;
    currentSelection: EditorSelectionContext | null;
    _pendingForceReloads: Set<string>;
    _pendingForceFileReloads: Set<string>;
    _noteReloadVersions: Record<string, number>;
    _fileReloadVersions: Record<string, number>;
    _noteReloadMetadata: Record<string, ResourceReloadMetadata | undefined>;
    _fileReloadMetadata: Record<string, ResourceReloadMetadata | undefined>;
    dirtyTabIds: Set<string>;
    noteExternalConflicts: Set<string>;
    fileExternalConflicts: Set<string>;
    openNote: (noteId: string, title: string, content: string) => void;
    openPdf: (entryId: string, title: string, path: string) => void;
    openFile: (
        relativePath: string,
        title: string,
        path: string,
        content: string,
        mimeType: string | null,
        viewer: FileViewerMode,
        options?: {
            sizeBytes?: number | null;
            contentTruncated?: boolean;
        },
    ) => void;
    openMap: (relativePath: string, title: string) => void;
    openGraph: () => void;
    openReview: (
        sessionId: string,
        options?: { background?: boolean; title?: string },
    ) => void;
    closeReview: (sessionId: string) => void;
    openChat: (
        sessionId: string,
        options?: { background?: boolean; title?: string; paneId?: string },
    ) => void;
    closeChat: (sessionId: string) => void;
    goBack: () => void;
    goForward: () => void;
    navigateToHistoryIndex: (index: number) => void;
    closeTab: (tabId: string, options?: { reason?: TabCloseReason }) => void;
    reopenLastClosedTab: () => void;
    switchTab: (tabId: string) => void;
    focusPane: (paneId: string) => void;
    focusPaneNeighbor: (
        direction: WorkspacePaneNeighborDirection,
        paneId?: string,
    ) => void;
    resizePaneSplit: (splitId: string, sizes: readonly number[]) => void;
    splitEditorPane: (
        direction: WorkspaceSplitDirection,
        paneId?: string,
    ) => string | null;
    balancePaneLayout: (splitId?: string) => void;
    createEmptyPane: () => string | null;
    insertExternalTabInPane: (
        tab: TabInput,
        paneId: string,
        index?: number,
    ) => void;
    insertExternalTabInNewSplit: (
        tab: TabInput,
        direction: WorkspaceSplitDirection,
        paneId?: string,
    ) => string | null;
    insertExternalTabInNewPane: (tab: TabInput) => string | null;
    moveTabToNewSplit: (
        tabId: string,
        direction: WorkspaceSplitDirection,
    ) => string | null;
    moveTabToPaneDropTarget: (
        tabId: string,
        targetPaneId: string,
        position: WorkspaceMovePosition | "center",
        index?: number,
    ) => string | null;
    moveTabToPane: (tabId: string, paneId: string, index?: number) => void;
    reorderPaneTabs: (
        paneId: string,
        fromIndex: number,
        toIndex: number,
    ) => void;
    closePane: (paneId: string) => void;
    setTabDirty: (tabId: string, dirty: boolean) => void;
    updateTabContent: (tabId: string, content: string) => void;
    updateTabTitle: (tabId: string, title: string) => void;
    updateFileHistoryTitle: (
        tabId: string,
        relativePath: string,
        title: string,
    ) => void;
    updatePdfPage: (tabId: string, page: number) => void;
    updatePdfZoom: (tabId: string, zoom: number) => void;
    updatePdfViewMode: (tabId: string, viewMode: PdfViewMode) => void;
    reorderTabs: (fromIndex: number, toIndex: number) => void;
    hydrateWorkspace: (
        panes: EditorPaneInput[],
        focusedPaneId?: string | null,
        layoutTree?: WorkspaceLayoutNode,
    ) => void;
    hydrateTabs: (tabs: TabInput[], activeTabId: string | null) => void;
    insertExternalTab: (tab: TabInput, index?: number) => void;
    queueReveal: (reveal: PendingReveal) => void;
    clearPendingReveal: () => void;
    queueSelectionReveal: (reveal: PendingSelectionReveal) => void;
    clearPendingSelectionReveal: () => void;
    setCurrentSelection: (selection: EditorSelectionContext) => void;
    clearCurrentSelection: () => void;
    reloadNoteContent: (noteId: string, detail: ReloadedDetail) => void;
    reloadFileContent: (relativePath: string, detail: ReloadedDetail) => void;
    forceReloadNoteContent: (noteId: string, detail: ReloadedDetail) => void;
    forceReloadFileContent: (
        relativePath: string,
        detail: ReloadedDetail,
    ) => void;
    forceReloadEditorTarget: (
        target: EditorTarget,
        detail: ReloadedDetail,
    ) => void;
    clearForceReload: (noteId: string) => void;
    clearForceFileReload: (relativePath: string) => void;
    markNoteExternalConflict: (noteId: string) => void;
    clearNoteExternalConflict: (noteId: string) => void;
    markFileExternalConflict: (relativePath: string) => void;
    clearFileExternalConflict: (relativePath: string) => void;
    handleNoteDeleted: (noteId: string) => void;
    handleFileDeleted: (relativePath: string) => void;
    handleNoteRenamed: (
        oldNoteId: string,
        newNoteId: string,
        newTitle: string,
    ) => void;
}

export const useEditorStore = create<EditorStore>((set, get) => ({
    layoutTree: createInitialLayout(INITIAL_EDITOR_PANE_ID),
    panes: [createEditorPaneState(INITIAL_EDITOR_PANE_ID)],
    focusedPaneId: INITIAL_EDITOR_PANE_ID,
    tabs: [],
    activeTabId: null,
    recentlyClosedTabs: [],
    activationHistory: [],
    tabNavigationHistory: [],
    tabNavigationIndex: -1,
    pendingReveal: null,
    pendingSelectionReveal: null,
    currentSelection: null,
    _pendingForceReloads: new Set<string>(),
    _pendingForceFileReloads: new Set<string>(),
    _noteReloadVersions: {},
    _fileReloadVersions: {},
    _noteReloadMetadata: {},
    _fileReloadMetadata: {},
    dirtyTabIds: new Set<string>(),
    noteExternalConflicts: new Set<string>(),
    fileExternalConflicts: new Set<string>(),

    openNote: (noteId, title, content) => {
        set((state) =>
            openOrReuseHistoryTab(state, {
                kind: "note",
                noteId,
                title,
                content,
            }),
        );
    },

    openPdf: (entryId, title, path) => {
        set((state) =>
            openOrReuseHistoryTab(state, {
                kind: "pdf",
                entryId,
                title,
                path,
            }),
        );
    },

    openMap: (relativePath, title) => {
        set((state) => {
            const existing = state.tabs.find(
                (t) => isMapTab(t) && t.relativePath === relativePath,
            );
            if (existing) {
                return activateTab(state, existing.id);
            }
            const newTab = createMapTab(relativePath, title);
            return {
                tabs: [...state.tabs, newTab],
                ...activateTab(state, newTab.id),
            };
        });
    },

    openGraph: () => {
        set((state) => {
            const existing = state.tabs.find((t) => isGraphTab(t));
            if (existing) {
                return activateTab(state, existing.id);
            }
            const newTab = createGraphTab();
            return {
                tabs: [...state.tabs, newTab],
                ...activateTab(state, newTab.id),
            };
        });
    },

    openFile: (
        relativePath,
        title,
        path,
        content,
        mimeType,
        viewer,
        options,
    ) => {
        set((state) =>
            openOrReuseHistoryTab(state, {
                kind: "file",
                relativePath,
                title,
                path,
                content,
                mimeType,
                viewer,
                sizeBytes: options?.sizeBytes ?? null,
                contentTruncated: options?.contentTruncated ?? false,
            }),
        );
    },

    openReview: (sessionId, options) => {
        set((state) => {
            const workspace = getEffectivePaneWorkspace(state);
            const existingPane = workspace.panes.find((pane) =>
                pane.tabs.some(
                    (tab) => isReviewTab(tab) && tab.sessionId === sessionId,
                ),
            );
            const existing =
                existingPane?.tabs.find(
                    (tab): tab is ReviewTab =>
                        isReviewTab(tab) && tab.sessionId === sessionId,
                ) ?? null;
            if (existingPane && existing) {
                const nextTitle = options?.title ?? existing.title;
                const nextPane =
                    nextTitle === existing.title
                        ? existingPane
                        : createEditorPaneState(existingPane.id, {
                              ...existingPane,
                              tabs: existingPane.tabs.map((tab) =>
                                  tab.id === existing.id
                                      ? { ...tab, title: nextTitle }
                                      : tab,
                              ),
                          });
                if (options?.background) {
                    if (nextPane === existingPane) {
                        return state;
                    }
                    return buildFocusedPaneProjection({
                        panes: workspace.panes.map((pane) =>
                            pane.id === existingPane.id ? nextPane : pane,
                        ),
                        focusedPaneId: workspace.focusedPaneId,
                        layoutTree: workspace.layoutTree,
                    });
                }
                const projection = activatePaneTab(
                    {
                        layoutTree: workspace.layoutTree,
                        panes: workspace.panes.map((pane) =>
                            pane.id === existingPane.id ? nextPane : pane,
                        ),
                        focusedPaneId: existingPane.id,
                    },
                    existingPane.id,
                    existing.id,
                );
                return (
                    projection ??
                    buildFocusedPaneProjection({
                        panes: workspace.panes.map((pane) =>
                            pane.id === existingPane.id ? nextPane : pane,
                        ),
                        focusedPaneId: existingPane.id,
                        layoutTree: workspace.layoutTree,
                    })
                );
            }

            const newTab: ReviewTab = {
                id: crypto.randomUUID(),
                kind: "ai-review",
                sessionId,
                title: options?.title ?? "Review",
            };

            const focusedPane = selectEditorPaneState(workspace);
            const nextPane = options?.background
                ? createEditorPaneState(focusedPane.id, {
                      ...focusedPane,
                      tabs: [...focusedPane.tabs, newTab],
                  })
                : createEditorPaneState(
                      focusedPane.id,
                      insertNormalizedTab(focusedPane, newTab),
                  );

            if (options?.background) {
                return buildFocusedPaneProjection({
                    panes: workspace.panes.map((pane) =>
                        pane.id === focusedPane.id ? nextPane : pane,
                    ),
                    focusedPaneId: workspace.focusedPaneId,
                    layoutTree: workspace.layoutTree,
                });
            }

            return buildFocusedPaneProjection({
                panes: workspace.panes.map((pane) =>
                    pane.id === focusedPane.id ? nextPane : pane,
                ),
                focusedPaneId: focusedPane.id,
                layoutTree: workspace.layoutTree,
            });
        });
    },

    closeReview: (sessionId) => {
        const tab = selectEditorWorkspaceTabs(get()).find(
            (t) => isReviewTab(t) && t.sessionId === sessionId,
        );
        if (tab) get().closeTab(tab.id);
    },

    openChat: (sessionId, options) => {
        set((state) => {
            const workspace = getEffectivePaneWorkspace(state);

            // Reuse existing ChatTab for this session if already open
            const existingPane = workspace.panes.find((pane) =>
                pane.tabs.some(
                    (tab) => isChatTab(tab) && tab.sessionId === sessionId,
                ),
            );
            const existing =
                existingPane?.tabs.find(
                    (tab): tab is ChatTab =>
                        isChatTab(tab) && tab.sessionId === sessionId,
                ) ?? null;
            if (existingPane && existing) {
                const nextTitle = options?.title ?? existing.title;
                const nextPane =
                    nextTitle === existing.title
                        ? existingPane
                        : createEditorPaneState(existingPane.id, {
                              ...existingPane,
                              tabs: existingPane.tabs.map((tab) =>
                                  tab.id === existing.id
                                      ? { ...tab, title: nextTitle }
                                      : tab,
                              ),
                          });
                if (options?.background) {
                    if (nextPane === existingPane) {
                        return state;
                    }
                    return buildFocusedPaneProjection({
                        panes: workspace.panes.map((pane) =>
                            pane.id === existingPane.id ? nextPane : pane,
                        ),
                        focusedPaneId: workspace.focusedPaneId,
                        layoutTree: workspace.layoutTree,
                    });
                }
                const projection = activatePaneTab(
                    {
                        layoutTree: workspace.layoutTree,
                        panes: workspace.panes.map((pane) =>
                            pane.id === existingPane.id ? nextPane : pane,
                        ),
                        focusedPaneId: existingPane.id,
                    },
                    existingPane.id,
                    existing.id,
                );
                return (
                    projection ??
                    buildFocusedPaneProjection({
                        panes: workspace.panes.map((pane) =>
                            pane.id === existingPane.id ? nextPane : pane,
                        ),
                        focusedPaneId: existingPane.id,
                        layoutTree: workspace.layoutTree,
                    })
                );
            }

            const newTab: ChatTab = createChatTab(
                sessionId,
                options?.title ?? "Chat",
            );

            // Insert into specified pane or focused pane
            const targetPaneId =
                options?.paneId ?? workspace.focusedPaneId ?? null;
            const targetPane = targetPaneId
                ? (workspace.panes.find((p) => p.id === targetPaneId) ?? null)
                : null;
            const focusedPane = targetPane ?? selectEditorPaneState(workspace);

            const nextPane = options?.background
                ? createEditorPaneState(focusedPane.id, {
                      ...focusedPane,
                      tabs: [...focusedPane.tabs, newTab],
                  })
                : createEditorPaneState(
                      focusedPane.id,
                      insertNormalizedTab(focusedPane, newTab),
                  );

            if (options?.background) {
                return buildFocusedPaneProjection({
                    panes: workspace.panes.map((pane) =>
                        pane.id === focusedPane.id ? nextPane : pane,
                    ),
                    focusedPaneId: workspace.focusedPaneId,
                    layoutTree: workspace.layoutTree,
                });
            }

            return buildFocusedPaneProjection({
                panes: workspace.panes.map((pane) =>
                    pane.id === focusedPane.id ? nextPane : pane,
                ),
                focusedPaneId: focusedPane.id,
                layoutTree: workspace.layoutTree,
            });
        });
    },

    closeChat: (sessionId) => {
        const tab = selectEditorWorkspaceTabs(get()).find(
            (t) => isChatTab(t) && t.sessionId === sessionId,
        );
        if (tab) get().closeTab(tab.id);
    },

    goBack: () => {
        if (getTabOpenBehavior() === "history") {
            const tab = getReusableHistoryTab(get());
            if (!tab) return;
            get().navigateToHistoryIndex(tab.historyIndex - 1);
            return;
        }

        const { tabs, tabNavigationHistory, tabNavigationIndex } = get();
        for (let idx = tabNavigationIndex - 1; idx >= 0; idx -= 1) {
            const tabId = tabNavigationHistory[idx];
            if (!tabs.some((tab) => tab.id === tabId)) continue;
            set((state) => ({
                ...activateTab(state, tabId, { recordNavigation: false }),
                tabNavigationIndex: idx,
            }));
            return;
        }
    },

    goForward: () => {
        if (getTabOpenBehavior() === "history") {
            const tab = getReusableHistoryTab(get());
            if (!tab) return;
            get().navigateToHistoryIndex(tab.historyIndex + 1);
            return;
        }

        const { tabs, tabNavigationHistory, tabNavigationIndex } = get();
        for (
            let idx = tabNavigationIndex + 1;
            idx < tabNavigationHistory.length;
            idx += 1
        ) {
            const tabId = tabNavigationHistory[idx];
            if (!tabs.some((tab) => tab.id === tabId)) continue;
            set((state) => ({
                ...activateTab(state, tabId, { recordNavigation: false }),
                tabNavigationIndex: idx,
            }));
            return;
        }
    },

    navigateToHistoryIndex: (targetIndex) => {
        const state = get();
        const tabIdx = state.tabs.findIndex((t) => t.id === state.activeTabId);
        if (tabIdx === -1) return;
        const raw = state.tabs[tabIdx];
        if (!isNavigableHistoryTab(raw)) return;
        const tab = normalizeHistoryTab(raw) as NavigableHistoryTab;
        if (targetIndex < 0 || targetIndex >= tab.history.length) return;
        if (targetIndex === tab.historyIndex) return;

        const currentSnapshot = createHistorySnapshot(tab);
        const history = tab.history.map((h, i) =>
            i === tab.historyIndex ? currentSnapshot : h,
        );
        const entry = history[targetIndex];

        const tabs = [...state.tabs];
        tabs[tabIdx] = buildTabFromHistory(tab.id, history, targetIndex);
        set({ tabs });

        loadHistoryEntryContentIfNeeded(tab.id, targetIndex, entry);
    },

    closeTab: (tabId, options) => {
        set((state) => {
            const workspace = getEffectivePaneWorkspace(state);
            const targetPane =
                findPaneContainingTab(workspace.panes, tabId) ??
                selectEditorPaneState(workspace);
            const idx = targetPane.tabs.findIndex((t) => t.id === tabId);
            if (idx === -1) return state;

            const closedTab = targetPane.tabs[idx];
            const reason = options?.reason ?? "user";
            const recentlyClosedTabs = shouldRememberClosedTab(reason)
                ? pushRecentlyClosedTab(
                      state.recentlyClosedTabs,
                      closedTab,
                      idx,
                  )
                : state.recentlyClosedTabs;
            const nextTargetPane = createEditorPaneState(
                targetPane.id,
                removeTabFromWorkspaceState(targetPane, tabId),
            );
            const projection = buildFocusedPaneProjection(
                removeEmptyPanesFromWorkspace({
                    panes: workspace.panes.map((pane) =>
                        pane.id === targetPane.id ? nextTargetPane : pane,
                    ),
                    focusedPaneId: workspace.focusedPaneId,
                    layoutTree: workspace.layoutTree,
                }),
            );

            return {
                ...projection,
                recentlyClosedTabs,
                dirtyTabIds: new Set(
                    [...state.dirtyTabIds].filter((id) => id !== tabId),
                ),
            };
        });
    },

    reopenLastClosedTab: () => {
        set((state) => {
            const closed =
                state.recentlyClosedTabs[state.recentlyClosedTabs.length - 1];
            if (!closed) return state;

            const tabs = state.tabs.filter(
                (existing) => existing.id !== closed.tab.id,
            );
            const insertIndex = Math.max(
                0,
                Math.min(closed.index, tabs.length),
            );
            tabs.splice(insertIndex, 0, closed.tab);

            return {
                tabs,
                recentlyClosedTabs: state.recentlyClosedTabs.slice(0, -1),
                ...activateTab(state, closed.tab.id),
            };
        });
    },

    switchTab: (tabId) =>
        set((state) => {
            if (state.activeTabId === tabId) {
                return state;
            }

            const workspace = getEffectivePaneWorkspace(state);
            const targetPane = findPaneContainingTab(workspace.panes, tabId);
            if (!targetPane) {
                return activateTab(state, tabId);
            }

            const projection = activatePaneTab(workspace, targetPane.id, tabId);
            return projection ?? state;
        }),

    focusPane: (paneId) =>
        set((state) => {
            const workspace = getEffectivePaneWorkspace(state);
            const nextFocusedPaneId = getResolvedFocusedPaneId(
                workspace.panes,
                paneId,
            );

            if (workspace.focusedPaneId === nextFocusedPaneId) {
                return state;
            }

            return buildFocusedPaneProjection({
                panes: workspace.panes,
                focusedPaneId: nextFocusedPaneId,
                layoutTree: workspace.layoutTree,
            });
        }),

    focusPaneNeighbor: (direction, paneId) =>
        set((state) => {
            const workspace = getEffectivePaneWorkspace(state);
            const sourcePaneId = getSplitAnchorPaneId(workspace, paneId);
            const targetPaneId = selectPaneNeighbor(
                workspace,
                sourcePaneId,
                direction,
            );

            if (!targetPaneId || targetPaneId === workspace.focusedPaneId) {
                return state;
            }

            return buildFocusedPaneProjection({
                panes: workspace.panes,
                focusedPaneId: targetPaneId,
                layoutTree: workspace.layoutTree,
            });
        }),

    resizePaneSplit: (splitId, sizes) =>
        set((state) => ({
            layoutTree: resizeSplit(state.layoutTree, splitId, sizes),
        })),

    splitEditorPane: (direction, paneId) => {
        const workspace = getEffectivePaneWorkspace(get());
        const nextPaneId = getNextEditorPaneId(workspace.panes);
        if (!nextPaneId) {
            return null;
        }

        const anchorPaneId = getSplitAnchorPaneId(workspace, paneId);
        set((state) =>
            buildSplitPaneProjection(
                getEffectivePaneWorkspace(state),
                anchorPaneId,
                direction,
                createEditorPaneState(nextPaneId),
            ),
        );

        return nextPaneId;
    },

    balancePaneLayout: (splitId) =>
        set((state) => {
            const workspace = getEffectivePaneWorkspace(state);
            return buildFocusedPaneProjection({
                panes: workspace.panes,
                focusedPaneId: workspace.focusedPaneId,
                layoutTree: balanceSplit(workspace.layoutTree, splitId),
            });
        }),

    createEmptyPane: () => {
        return get().splitEditorPane("row");
    },

    insertExternalTabInPane: (tab, paneId, index) => {
        set((state) => {
            const incoming = normalizeExternalTab(tab);
            if (!incoming) {
                return state;
            }

            const workspace = getEffectivePaneWorkspace(state);
            const existingPane = workspace.panes.find(
                (pane) => pane.id === paneId,
            );
            if (!existingPane) {
                return state;
            }

            return buildFocusedPaneProjection({
                panes: workspace.panes.map((pane) =>
                    pane.id === paneId
                        ? createEditorPaneState(
                              pane.id,
                              insertNormalizedTab(pane, incoming, index),
                          )
                        : pane,
                ),
                focusedPaneId: paneId,
                layoutTree: workspace.layoutTree,
            });
        });
    },

    insertExternalTabInNewSplit: (tab, direction, paneId) => {
        const incoming = normalizeExternalTab(tab);
        if (!incoming) {
            return null;
        }

        const workspace = getEffectivePaneWorkspace(get());
        const nextPaneId = getNextEditorPaneId(workspace.panes);
        if (!nextPaneId) {
            return null;
        }

        const anchorPaneId = getSplitAnchorPaneId(workspace, paneId);

        set((state) =>
            buildSplitPaneProjection(
                getEffectivePaneWorkspace(state),
                anchorPaneId,
                direction,
                createEditorPaneState(
                    nextPaneId,
                    insertNormalizedTab(
                        createEditorPaneState(nextPaneId),
                        incoming,
                    ),
                ),
            ),
        );

        return nextPaneId;
    },

    insertExternalTabInNewPane: (tab) => {
        return get().insertExternalTabInNewSplit(tab, "row");
    },

    moveTabToNewSplit: (tabId, direction) => {
        const workspace = getEffectivePaneWorkspace(get());
        const sourcePane = findPaneContainingTab(workspace.panes, tabId);
        const nextPaneId = getNextEditorPaneId(workspace.panes);
        if (!sourcePane || !nextPaneId) {
            return null;
        }

        set((state) => {
            const currentWorkspace = getEffectivePaneWorkspace(state);
            const currentSourcePane = findPaneContainingTab(
                currentWorkspace.panes,
                tabId,
            );
            const movingTab =
                currentSourcePane?.tabs.find((tab) => tab.id === tabId) ?? null;

            if (!currentSourcePane || !movingTab) {
                return state;
            }

            const nextSourcePane = createEditorPaneState(
                currentSourcePane.id,
                removeTabFromWorkspaceState(currentSourcePane, tabId),
            );
            const nextWorkspace = removeEmptyPanesFromWorkspace(
                {
                    panes: currentWorkspace.panes
                        .map((pane) =>
                            pane.id === currentSourcePane.id
                                ? nextSourcePane
                                : pane,
                        )
                        .concat(
                            createEditorPaneState(
                                nextPaneId,
                                insertNormalizedTab(
                                    createEditorPaneState(nextPaneId),
                                    movingTab,
                                ),
                            ),
                        ),
                    focusedPaneId: nextPaneId,
                    layoutTree: splitPane(
                        currentWorkspace.layoutTree,
                        currentSourcePane.id,
                        direction,
                        nextPaneId,
                    ),
                },
                {
                    preferredFocusedPaneId: nextPaneId,
                },
            );

            return buildFocusedPaneProjection(nextWorkspace);
        });

        return nextPaneId;
    },

    moveTabToPaneDropTarget: (tabId, targetPaneId, position, index) => {
        if (position === "center") {
            get().moveTabToPane(tabId, targetPaneId, index);
            return null;
        }

        const workspace = getEffectivePaneWorkspace(get());
        const sourcePane = findPaneContainingTab(workspace.panes, tabId);
        const targetPane = workspace.panes.find(
            (pane) => pane.id === targetPaneId,
        );
        const nextPaneId = getNextEditorPaneId(workspace.panes);
        if (!sourcePane || !targetPane || !nextPaneId) {
            return null;
        }

        set((state) => {
            const currentWorkspace = getEffectivePaneWorkspace(state);
            const currentSourcePane = findPaneContainingTab(
                currentWorkspace.panes,
                tabId,
            );
            const currentTargetPane = currentWorkspace.panes.find(
                (pane) => pane.id === targetPaneId,
            );
            const movingTab =
                currentSourcePane?.tabs.find((tab) => tab.id === tabId) ?? null;

            if (!currentSourcePane || !currentTargetPane || !movingTab) {
                return state;
            }

            const nextSourcePane = createEditorPaneState(
                currentSourcePane.id,
                removeTabFromWorkspaceState(currentSourcePane, tabId),
            );
            const splitDirection =
                position === "left" || position === "right" ? "row" : "column";
            const splitLayoutTree = splitPane(
                currentWorkspace.layoutTree,
                currentTargetPane.id,
                splitDirection,
                nextPaneId,
            );
            const nextLayoutTree =
                position === "right" || position === "down"
                    ? splitLayoutTree
                    : movePane(
                          splitLayoutTree,
                          nextPaneId,
                          currentTargetPane.id,
                          position,
                      );
            const nextPaneEntries: Array<[string, EditorPaneState]> =
                currentWorkspace.panes.map((pane) => [
                    pane.id,
                    pane.id === currentSourcePane.id ? nextSourcePane : pane,
                ]);
            nextPaneEntries.push([
                nextPaneId,
                createEditorPaneState(
                    nextPaneId,
                    insertNormalizedTab(
                        createEditorPaneState(nextPaneId),
                        movingTab,
                    ),
                ),
            ]);
            const nextPaneMap = new Map<string, EditorPaneState>(
                nextPaneEntries,
            );

            return buildFocusedPaneProjection(
                removeEmptyPanesFromWorkspace(
                    {
                        panes: getLayoutPaneIds(nextLayoutTree).map(
                            (paneId) =>
                                nextPaneMap.get(paneId) ??
                                createEditorPaneState(paneId),
                        ),
                        focusedPaneId: nextPaneId,
                        layoutTree: nextLayoutTree,
                    },
                    {
                        preferredFocusedPaneId: nextPaneId,
                    },
                ),
            );
        });

        return nextPaneId;
    },

    moveTabToPane: (tabId, paneId, index) => {
        set((state) => {
            const workspace = getEffectivePaneWorkspace(state);
            const sourcePane = workspace.panes.find((pane) =>
                pane.tabs.some((tab) => tab.id === tabId),
            );
            const targetPane = workspace.panes.find(
                (pane) => pane.id === paneId,
            );
            if (!sourcePane || !targetPane || sourcePane.id === targetPane.id) {
                return state;
            }

            const movingTab =
                sourcePane.tabs.find((tab) => tab.id === tabId) ?? null;
            if (!movingTab) {
                return state;
            }

            const nextSourcePane = createEditorPaneState(
                sourcePane.id,
                removeTabFromWorkspaceState(sourcePane, tabId),
            );
            const nextTargetPane = createEditorPaneState(
                targetPane.id,
                insertNormalizedTab(targetPane, movingTab, index),
            );

            return buildFocusedPaneProjection(
                removeEmptyPanesFromWorkspace(
                    {
                        panes: workspace.panes.map((pane) => {
                            if (pane.id === sourcePane.id)
                                return nextSourcePane;
                            if (pane.id === targetPane.id)
                                return nextTargetPane;
                            return pane;
                        }),
                        focusedPaneId: targetPane.id,
                        layoutTree: workspace.layoutTree,
                    },
                    {
                        preferredFocusedPaneId: targetPane.id,
                    },
                ),
            );
        });
    },

    reorderPaneTabs: (paneId, fromIndex, toIndex) => {
        set((state) => {
            const workspace = getEffectivePaneWorkspace(state);
            const pane = workspace.panes.find(
                (candidate) => candidate.id === paneId,
            );
            if (!pane) {
                return state;
            }

            if (
                fromIndex === toIndex ||
                fromIndex < 0 ||
                toIndex < 0 ||
                fromIndex >= pane.tabs.length ||
                toIndex >= pane.tabs.length
            ) {
                return state;
            }

            const tabs = [...pane.tabs];
            const [tab] = tabs.splice(fromIndex, 1);
            tabs.splice(toIndex, 0, tab);

            return buildFocusedPaneProjection({
                panes: workspace.panes.map((candidate) =>
                    candidate.id === paneId
                        ? createEditorPaneState(candidate.id, {
                              ...candidate,
                              tabs,
                          })
                        : candidate,
                ),
                focusedPaneId: workspace.focusedPaneId,
                layoutTree: workspace.layoutTree,
            });
        });
    },

    closePane: (paneId) => {
        set((state) => {
            const workspace = getEffectivePaneWorkspace(state);
            if (workspace.panes.length <= 1) {
                return state;
            }

            const paneIndex = workspace.panes.findIndex(
                (pane) => pane.id === paneId,
            );
            if (paneIndex === -1) {
                return state;
            }

            const closingPane = workspace.panes[paneIndex];
            const recipientPaneId = getPaneRecipientIdForWorkspace(
                workspace,
                paneId,
            );

            if (!recipientPaneId) {
                return state;
            }

            const nextPanes = workspace.panes
                .filter((pane) => pane.id !== paneId)
                .map((pane) =>
                    pane.id === recipientPaneId
                        ? mergePaneStates(pane, closingPane)
                        : pane,
                );

            return buildFocusedPaneProjection({
                panes: nextPanes,
                focusedPaneId:
                    workspace.focusedPaneId === paneId
                        ? recipientPaneId
                        : getResolvedFocusedPaneId(
                              nextPanes,
                              workspace.focusedPaneId,
                          ),
                layoutTree: closePaneAndCollapse(workspace.layoutTree, paneId),
            });
        });
    },

    setTabDirty: (tabId, dirty) => {
        set((state) => {
            const alreadyDirty = state.dirtyTabIds.has(tabId);
            if (alreadyDirty === dirty) {
                return state;
            }

            const dirtyTabIds = new Set(state.dirtyTabIds);
            if (dirty) {
                dirtyTabIds.add(tabId);
            } else {
                dirtyTabIds.delete(tabId);
            }

            return { dirtyTabIds };
        });
    },

    updateTabContent: (tabId, content) => {
        set((state) => ({
            tabs: patchHistoryTabById(state.tabs, tabId, (tab) =>
                patchCurrentHistoryEntry(tab, (entry) =>
                    entry.kind === "note" || entry.kind === "file"
                        ? entry.content === content
                            ? entry
                            : {
                                  ...entry,
                                  content,
                              }
                        : entry,
                ),
            ),
        }));
    },

    updateTabTitle: (tabId, title) => {
        set((state) => {
            const workspace = getEffectivePaneWorkspace(state);
            let didChange = false;
            const nextPanes = workspace.panes.map((pane) => {
                const nextTabs = updateTabTitleInTabs(pane.tabs, tabId, title);
                didChange ||= nextTabs !== pane.tabs;
                return nextTabs === pane.tabs
                    ? pane
                    : createEditorPaneState(pane.id, {
                          ...pane,
                          tabs: [...nextTabs],
                      });
            });

            if (!didChange) {
                return state;
            }

            return buildFocusedPaneProjection({
                panes: nextPanes,
                focusedPaneId: workspace.focusedPaneId,
                layoutTree: workspace.layoutTree,
            });
        });
    },

    updateFileHistoryTitle: (tabId, relativePath, title) => {
        set((state) => ({
            tabs: state.tabs.map((t) => {
                if (t.id !== tabId || !isFileTab(t)) return t;
                const tab = ensureFileTabDefaults(t);
                let didChange = false;
                const history = tab.history.map((entry) => {
                    if (
                        entry.kind !== "file" ||
                        entry.relativePath !== relativePath ||
                        entry.title === title
                    ) {
                        return entry;
                    }
                    didChange = true;
                    return {
                        ...entry,
                        title,
                    };
                });
                if (!didChange) {
                    return t;
                }
                return buildTabFromHistory(tab.id, history, tab.historyIndex);
            }),
        }));
    },

    updatePdfPage: (tabId, page) => {
        set((state) => ({
            tabs: patchHistoryTabById(state.tabs, tabId, (tab) =>
                !isPdfTab(tab)
                    ? tab
                    : patchCurrentHistoryEntry(tab, (entry) =>
                          entry.kind !== "pdf" || entry.page === page
                              ? entry
                              : {
                                    ...entry,
                                    page,
                                },
                      ),
            ),
        }));
    },

    updatePdfZoom: (tabId, zoom) => {
        set((state) => ({
            tabs: patchHistoryTabById(state.tabs, tabId, (tab) =>
                !isPdfTab(tab)
                    ? tab
                    : patchCurrentHistoryEntry(tab, (entry) =>
                          entry.kind !== "pdf" || entry.zoom === zoom
                              ? entry
                              : {
                                    ...entry,
                                    zoom,
                                },
                      ),
            ),
        }));
    },

    updatePdfViewMode: (tabId, viewMode) => {
        set((state) => ({
            tabs: patchHistoryTabById(state.tabs, tabId, (tab) =>
                !isPdfTab(tab)
                    ? tab
                    : patchCurrentHistoryEntry(tab, (entry) =>
                          entry.kind !== "pdf" || entry.viewMode === viewMode
                              ? entry
                              : {
                                    ...entry,
                                    viewMode,
                                },
                      ),
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

    hydrateWorkspace: (panes, focusedPaneId, layoutTree) => {
        const seenGraph = new Set<string>();
        const hydratedPanes = panes.flatMap((pane, index) => {
            const hydratedTabs: Tab[] = pane.tabs.flatMap((tab): Tab[] => {
                const normalized = normalizeHydratedTab(tab);
                if (!normalized) {
                    return [];
                }
                if (isGraphTab(normalized)) {
                    if (seenGraph.size > 0) {
                        return [];
                    }
                    seenGraph.add(normalized.id);
                }
                return [normalized];
            });

            return [
                createEditorPaneState(pane.id?.trim() || `pane-${index + 1}`, {
                    tabs: hydratedTabs,
                    activeTabId: pane.activeTabId,
                    activationHistory: pane.activationHistory,
                    tabNavigationHistory: pane.tabNavigationHistory,
                    tabNavigationIndex: pane.tabNavigationIndex,
                }),
            ];
        });

        set({
            ...buildFocusedPaneProjection({
                panes:
                    hydratedPanes.length > 0
                        ? hydratedPanes
                        : [createEditorPaneState(INITIAL_EDITOR_PANE_ID)],
                focusedPaneId,
                layoutTree: normalizeLayoutTree(
                    layoutTree ??
                        buildLinearLayoutTree(
                            (hydratedPanes.length > 0
                                ? hydratedPanes
                                : [
                                      createEditorPaneState(
                                          INITIAL_EDITOR_PANE_ID,
                                      ),
                                  ]
                            ).map((pane) => pane.id),
                        ),
                ),
            }),
            recentlyClosedTabs: [],
            dirtyTabIds: new Set<string>(),
        });
    },

    hydrateTabs: (tabs, activeTabId) => {
        const seenGraph = new Set<string>();
        const hydratedTabs: Tab[] = tabs.flatMap((tab): Tab[] => {
            const normalized = normalizeHydratedTab(tab);
            if (!normalized) {
                return [];
            }
            if (isGraphTab(normalized)) {
                if (seenGraph.size > 0) {
                    return [];
                }
                seenGraph.add(normalized.id);
            }
            return [normalized];
        });
        const nextActiveTabId =
            activeTabId && hydratedTabs.some((tab) => tab.id === activeTabId)
                ? activeTabId
                : (hydratedTabs[0]?.id ?? null);
        set({
            layoutTree: createInitialLayout(INITIAL_EDITOR_PANE_ID),
            panes: [
                createEditorPaneState(INITIAL_EDITOR_PANE_ID, {
                    tabs: hydratedTabs,
                    activeTabId: nextActiveTabId,
                    activationHistory: nextActiveTabId ? [nextActiveTabId] : [],
                    tabNavigationHistory: nextActiveTabId
                        ? [nextActiveTabId]
                        : [],
                    tabNavigationIndex: nextActiveTabId ? 0 : -1,
                }),
            ],
            focusedPaneId: INITIAL_EDITOR_PANE_ID,
            tabs: hydratedTabs,
            activeTabId: nextActiveTabId,
            recentlyClosedTabs: [],
            activationHistory: nextActiveTabId ? [nextActiveTabId] : [],
            tabNavigationHistory: nextActiveTabId ? [nextActiveTabId] : [],
            tabNavigationIndex: nextActiveTabId ? 0 : -1,
            dirtyTabIds: new Set<string>(),
        });
    },

    insertExternalTab: (tab, index) => {
        set((state) => {
            const incoming = normalizeExternalTab(tab);
            if (!incoming) {
                return state;
            }
            return insertNormalizedTab(state, incoming, index);
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
        set((state) => {
            const next = applyResourceReloadAcrossWorkspace(
                state,
                "note",
                noteId,
                detail,
                { fallbackOrigin: "unknown" },
            );

            return next.didChange
                ? {
                      ...next.projection,
                      _noteReloadVersions: next.reloadVersions,
                      _noteReloadMetadata: next.reloadMetadata,
                  }
                : {
                      _noteReloadVersions: next.reloadVersions,
                      _noteReloadMetadata: next.reloadMetadata,
                  };
        });
    },

    reloadFileContent: (relativePath, detail) => {
        set((state) => {
            const next = applyResourceReloadAcrossWorkspace(
                state,
                "file",
                relativePath,
                detail,
                { fallbackOrigin: "unknown" },
            );

            return next.didChange
                ? {
                      ...next.projection,
                      _fileReloadVersions: next.reloadVersions,
                      _fileReloadMetadata: next.reloadMetadata,
                  }
                : {
                      _fileReloadVersions: next.reloadVersions,
                      _fileReloadMetadata: next.reloadMetadata,
                  };
        });
    },

    forceReloadNoteContent: (noteId, detail) => {
        set((state) => {
            const next = applyResourceReloadAcrossWorkspace(
                state,
                "note",
                noteId,
                detail,
                { force: true, fallbackOrigin: "system" },
            );

            return next.didChange
                ? {
                      ...next.projection,
                      _pendingForceReloads: next.pendingForceReloads,
                      _noteReloadVersions: next.reloadVersions,
                      _noteReloadMetadata: next.reloadMetadata,
                  }
                : {
                      _pendingForceReloads: next.pendingForceReloads,
                      _noteReloadVersions: next.reloadVersions,
                      _noteReloadMetadata: next.reloadMetadata,
                  };
        });
    },

    forceReloadFileContent: (relativePath, detail) => {
        set((state) => {
            const next = applyResourceReloadAcrossWorkspace(
                state,
                "file",
                relativePath,
                detail,
                { force: true, fallbackOrigin: "system" },
            );

            return next.didChange
                ? {
                      ...next.projection,
                      _pendingForceFileReloads: next.pendingForceReloads,
                      _fileReloadVersions: next.reloadVersions,
                      _fileReloadMetadata: next.reloadMetadata,
                  }
                : {
                      _pendingForceFileReloads: next.pendingForceReloads,
                      _fileReloadVersions: next.reloadVersions,
                      _fileReloadMetadata: next.reloadMetadata,
                  };
        });
    },

    forceReloadEditorTarget: (target, detail) => {
        if (!target.openTab) {
            return;
        }

        if (target.kind === "note") {
            get().forceReloadNoteContent(target.noteId, detail);
            return;
        }

        get().forceReloadFileContent(target.relativePath, {
            content: detail.content,
            title: detail.title,
            origin: detail.origin,
            opId: detail.opId,
            revision: detail.revision,
            contentHash: detail.contentHash,
        });
    },

    clearForceReload: (noteId) => {
        set((state) => {
            if (!state._pendingForceReloads.has(noteId)) return state;
            const next = new Set(state._pendingForceReloads);
            next.delete(noteId);
            return { _pendingForceReloads: next };
        });
    },

    clearForceFileReload: (relativePath) => {
        set((state) => {
            if (!state._pendingForceFileReloads.has(relativePath)) return state;
            const next = new Set(state._pendingForceFileReloads);
            next.delete(relativePath);
            return { _pendingForceFileReloads: next };
        });
    },

    markNoteExternalConflict: (noteId) => {
        set((state) => {
            if (state.noteExternalConflicts.has(noteId)) return state;
            const next = new Set(state.noteExternalConflicts);
            next.add(noteId);
            return { noteExternalConflicts: next };
        });
    },

    clearNoteExternalConflict: (noteId) => {
        set((state) => {
            if (!state.noteExternalConflicts.has(noteId)) return state;
            const next = new Set(state.noteExternalConflicts);
            next.delete(noteId);
            return { noteExternalConflicts: next };
        });
    },

    markFileExternalConflict: (relativePath) => {
        set((state) => {
            if (state.fileExternalConflicts.has(relativePath)) return state;
            const next = new Set(state.fileExternalConflicts);
            next.add(relativePath);
            return { fileExternalConflicts: next };
        });
    },

    clearFileExternalConflict: (relativePath) => {
        set((state) => {
            if (!state.fileExternalConflicts.has(relativePath)) return state;
            const next = new Set(state.fileExternalConflicts);
            next.delete(relativePath);
            return { fileExternalConflicts: next };
        });
    },

    handleNoteDeleted: (noteId) => {
        set((state) => {
            const next = applyResourceDeleteAcrossWorkspace(
                state,
                "note",
                noteId,
            );
            const pendingForceReloads = new Set(state._pendingForceReloads);
            const noteExternalConflicts = new Set(state.noteExternalConflicts);
            const hadPendingForceReload = pendingForceReloads.delete(noteId);
            const hadExternalConflict = noteExternalConflicts.delete(noteId);
            const hadReloadVersion = noteId in state._noteReloadVersions;
            const hadReloadMetadata = noteId in state._noteReloadMetadata;

            if (
                !next.didChange &&
                !hadPendingForceReload &&
                !hadExternalConflict &&
                !hadReloadVersion &&
                !hadReloadMetadata
            ) {
                return state;
            }

            return {
                ...next.projection,
                _pendingForceReloads: pendingForceReloads,
                _noteReloadVersions: Object.fromEntries(
                    Object.entries(state._noteReloadVersions).filter(
                        ([key]) => key !== noteId,
                    ),
                ),
                _noteReloadMetadata: Object.fromEntries(
                    Object.entries(state._noteReloadMetadata).filter(
                        ([key]) => key !== noteId,
                    ),
                ),
                noteExternalConflicts,
            };
        });
    },

    handleFileDeleted: (relativePath) => {
        set((state) => {
            const next = applyResourceDeleteAcrossWorkspace(
                state,
                "file",
                relativePath,
            );
            const pendingForceReloads = new Set(state._pendingForceFileReloads);
            const fileExternalConflicts = new Set(state.fileExternalConflicts);
            const hadPendingForceReload =
                pendingForceReloads.delete(relativePath);
            const hadExternalConflict =
                fileExternalConflicts.delete(relativePath);
            const hadReloadVersion = relativePath in state._fileReloadVersions;
            const hadReloadMetadata = relativePath in state._fileReloadMetadata;

            if (
                !next.didChange &&
                !hadPendingForceReload &&
                !hadExternalConflict &&
                !hadReloadVersion &&
                !hadReloadMetadata
            ) {
                return state;
            }

            return {
                ...next.projection,
                _pendingForceFileReloads: pendingForceReloads,
                _fileReloadVersions: Object.fromEntries(
                    Object.entries(state._fileReloadVersions).filter(
                        ([key]) => key !== relativePath,
                    ),
                ),
                _fileReloadMetadata: Object.fromEntries(
                    Object.entries(state._fileReloadMetadata).filter(
                        ([key]) => key !== relativePath,
                    ),
                ),
                fileExternalConflicts,
            };
        });
    },

    handleNoteRenamed: (oldNoteId, newNoteId, newTitle) => {
        set((state) => {
            const next = renameNoteAcrossWorkspace(
                state,
                oldNoteId,
                newNoteId,
                newTitle,
            );
            return next.didChange ? next.projection : state;
        });
    },
}));

let _syncingPaneMirror = false;

useEditorStore.subscribe((state) => {
    if (_syncingPaneMirror) {
        return;
    }

    const projection = buildFocusedPaneProjection({
        panes:
            state.panes.length > 0
                ? state.panes.map((pane) =>
                      pane.id ===
                      getResolvedFocusedPaneId(state.panes, state.focusedPaneId)
                          ? createEditorPaneState(pane.id, {
                                tabs: state.tabs,
                                activeTabId: state.activeTabId,
                                activationHistory: state.activationHistory,
                                tabNavigationHistory:
                                    state.tabNavigationHistory,
                                tabNavigationIndex: state.tabNavigationIndex,
                            })
                          : pane,
                  )
                : [
                      createEditorPaneState(INITIAL_EDITOR_PANE_ID, {
                          tabs: state.tabs,
                          activeTabId: state.activeTabId,
                          activationHistory: state.activationHistory,
                          tabNavigationHistory: state.tabNavigationHistory,
                          tabNavigationIndex: state.tabNavigationIndex,
                      }),
                  ],
        focusedPaneId: state.focusedPaneId,
        layoutTree: state.layoutTree,
    });

    const focusedPane = projection.panes.find(
        (pane) => pane.id === projection.focusedPaneId,
    );
    const currentFocusedPane = state.panes.find(
        (pane) => pane.id === projection.focusedPaneId,
    );

    const panesChanged =
        state.panes.length !== projection.panes.length ||
        projection.panes.some((pane, index) => {
            const current = state.panes[index];
            return (
                !current ||
                current.id !== pane.id ||
                current.activeTabId !== pane.activeTabId ||
                current.tabNavigationIndex !== pane.tabNavigationIndex ||
                current.tabs !== pane.tabs ||
                !stringArraysEqual(
                    current.activationHistory,
                    pane.activationHistory,
                ) ||
                !stringArraysEqual(
                    current.tabNavigationHistory,
                    pane.tabNavigationHistory,
                )
            );
        });
    const legacyChanged =
        state.focusedPaneId !== projection.focusedPaneId ||
        state.tabs !== focusedPane?.tabs ||
        state.activeTabId !== focusedPane?.activeTabId ||
        !stringArraysEqual(
            state.activationHistory,
            focusedPane?.activationHistory ?? [],
        ) ||
        !stringArraysEqual(
            state.tabNavigationHistory,
            focusedPane?.tabNavigationHistory ?? [],
        ) ||
        state.tabNavigationIndex !== focusedPane?.tabNavigationIndex ||
        !currentFocusedPane;

    if (!panesChanged && !legacyChanged) {
        return;
    }

    _syncingPaneMirror = true;
    useEditorStore.setState({
        panes: projection.panes,
        focusedPaneId: projection.focusedPaneId,
        tabs: projection.tabs,
        activeTabId: projection.activeTabId,
        activationHistory: projection.activationHistory,
        tabNavigationHistory: projection.tabNavigationHistory,
        tabNavigationIndex: projection.tabNavigationIndex,
    });
    _syncingPaneMirror = false;
});

// Debounced session persistence — only write when tab list or active tab changes
let _sessionTimer: ReturnType<typeof setTimeout> | null = null;
let _lastSessionJson = "";
let _lastSessionSig = "";

useEditorStore.subscribe((state) => {
    if (!isSessionReady()) return;

    const vaultPath = useVaultStore.getState().vaultPath;
    if (!vaultPath) return;

    const sig = getEditorSessionSignature(state);
    if (sig === _lastSessionSig) return;
    _lastSessionSig = sig;

    const session = buildPersistedSession(state);
    const json = JSON.stringify(session);
    if (json === _lastSessionJson) return;

    if (_sessionTimer) clearTimeout(_sessionTimer);
    _sessionTimer = setTimeout(() => {
        writePersistedSession(vaultPath, session);
        _lastSessionJson = json;
    }, 500);
});
