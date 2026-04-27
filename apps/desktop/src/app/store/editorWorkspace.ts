import type { StoreApi } from "zustand";
import type { EditorTarget } from "../../features/editor/editorTargetResolver";
import {
    buildTabFromHistory,
    createChatHistoryTab,
    createChatTab,
    createFileHistoryEntry,
    createGraphTab,
    createMapTab,
    createTerminalTab,
    ensureFileTabDefaults,
    ensureTerminalTabDefaults,
    isChatTab,
    isChatHistoryTab,
    isFileTab,
    isGraphTab,
    isHistoryTab,
    isMapTab,
    isNavigableHistoryTab,
    isNoteTab,
    isPdfTab,
    isReviewTab,
    isTerminalTab,
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

/**
 * Pane-centric workspace ownership boundary.
 *
 * The store still projects the focused pane into top-level compatibility
 * fields, but workspace structure and tab ownership live here now.
 */
const MAX_RECENTLY_CLOSED_TABS = 20;

type WorkspaceSetState<TState> = (
    partial:
        | TState
        | Partial<TState>
        | ((state: TState) => TState | Partial<TState>),
) => void;

type WorkspaceGetState<TState> = () => TState;

export interface PaneWorkspaceState {
    tabs: Tab[];
    pinnedTabIds: string[];
    activeTabId: string | null;
    activationHistory: string[];
    tabNavigationHistory: string[];
    tabNavigationIndex: number;
}

export interface EditorPaneState extends PaneWorkspaceState {
    id: string;
    tabIds: string[];
}

export interface EditorPaneInput {
    id?: string;
    tabs: TabInput[];
    pinnedTabIds?: string[];
    activeTabId: string | null;
    activationHistory?: string[];
    tabNavigationHistory?: string[];
    tabNavigationIndex?: number;
}

export type WorkspacePaneNeighborDirection = "left" | "right" | "up" | "down";

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

export interface EditorWorkspaceState extends PaneWorkspaceState {
    layoutTree: WorkspaceLayoutNode;
    panes: EditorPaneState[];
    focusedPaneId: string | null;
    tabsById: Record<string, Tab>;
    recentlyClosedTabs: RecentlyClosedTab[];
    _pendingForceReloads: Set<string>;
    _pendingForceFileReloads: Set<string>;
    _noteReloadVersions: Record<string, number>;
    _fileReloadVersions: Record<string, number>;
    _noteReloadMetadata: Record<string, ResourceReloadMetadata | undefined>;
    _fileReloadMetadata: Record<string, ResourceReloadMetadata | undefined>;
    dirtyTabIds: Set<string>;
    noteExternalConflicts: Set<string>;
    fileExternalConflicts: Set<string>;
}

export interface EditorWorkspaceActions {
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
    openChatHistory: () => void;
    openReview: (
        sessionId: string,
        options?: { background?: boolean; title?: string },
    ) => void;
    closeReview: (sessionId: string) => void;
    openChat: (
        sessionId: string,
        options?: {
            background?: boolean;
            title?: string;
            paneId?: string;
            historySessionId?: string | null;
        },
    ) => void;
    closeChat: (sessionId: string) => void;
    openTerminal: (options?: {
        cwd?: string | null;
        paneId?: string;
        title?: string | null;
    }) => string | null;
    replaceAiSessionId: (
        fromSessionId: string,
        toSessionId: string,
        historySessionId?: string | null,
    ) => void;
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
    unifyAllPanesInto: (paneId?: string) => void;
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
    pinPaneTab: (paneId: string, tabId: string) => void;
    unpinPaneTab: (paneId: string, tabId: string) => void;
    togglePaneTabPinned: (paneId: string, tabId: string) => void;
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
    updatePdfScrollTop: (tabId: string, scrollTop: number) => void;
    updatePdfScrollPosition: (
        tabId: string,
        scrollTop: number,
        scrollLeft: number,
    ) => void;
    hydrateWorkspace: (
        panes: EditorPaneInput[],
        focusedPaneId?: string | null,
        layoutTree?: WorkspaceLayoutNode,
    ) => void;
    hydrateTabs: (tabs: TabInput[], activeTabId: string | null) => void;
    insertExternalTab: (tab: TabInput, index?: number) => void;
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
    handleMapDeleted: (relativePath: string) => void;
    handleMapRenamed: (
        oldRelativePath: string,
        newRelativePath: string,
        newTitle: string,
    ) => void;
    handleNoteRenamed: (
        oldNoteId: string,
        newNoteId: string,
        newTitle: string,
    ) => void;
    handleNoteConvertedToFile: (
        oldNoteId: string,
        newRelativePath: string,
        newTitle: string,
        newPath: string,
        mimeType: string | null,
        viewer: FileViewerMode,
    ) => void;
}

export type EditorWorkspaceStore = EditorWorkspaceState &
    EditorWorkspaceActions;

type EditorWorkspaceReadableState = Pick<
    EditorWorkspaceState,
    "panes" | "focusedPaneId" | "layoutTree"
> & {
    tabsById?: Record<string, Tab>;
} & Partial<PaneWorkspaceState>;

type EditorPaneWorkspaceInput = Partial<PaneWorkspaceState> & {
    tabIds?: readonly string[];
    tabsById?: Record<string, Tab>;
};

function normalizePaneWorkspaceState(
    workspace: EditorPaneWorkspaceInput,
): PaneWorkspaceState & { tabIds: string[] } {
    const resolvedTabsById = { ...(workspace.tabsById ?? {}) };
    for (const tab of workspace.tabs ?? []) {
        resolvedTabsById[tab.id] = tab;
    }

    const orderedTabIds: string[] = [];
    const seenTabIds = new Set<string>();
    const registerTabId = (tabId: string) => {
        if (seenTabIds.has(tabId) || !resolvedTabsById[tabId]) {
            return;
        }
        seenTabIds.add(tabId);
        orderedTabIds.push(tabId);
    };

    for (const tab of workspace.tabs ?? []) {
        registerTabId(tab.id);
    }

    if (workspace.tabIds?.length) {
        workspace.tabIds.forEach(registerTabId);
    }

    const tabs = orderedTabIds
        .map((tabId) => resolvedTabsById[tabId] ?? null)
        .filter((tab): tab is Tab => tab !== null);
    const availableTabIds = new Set(tabs.map((tab) => tab.id));
    const pinnedInputIds = new Set(workspace.pinnedTabIds ?? []);
    const pinnedTabIds = orderedTabIds.filter(
        (tabId) => availableTabIds.has(tabId) && pinnedInputIds.has(tabId),
    );
    const pinnedIdSet = new Set(pinnedTabIds);
    const visualTabIds = [
        ...pinnedTabIds,
        ...orderedTabIds.filter(
            (tabId) => availableTabIds.has(tabId) && !pinnedIdSet.has(tabId),
        ),
    ];
    const visualTabsById = new Map(tabs.map((tab) => [tab.id, tab]));
    const visualTabs = visualTabIds
        .map((tabId) => visualTabsById.get(tabId) ?? null)
        .filter((tab): tab is Tab => tab !== null);
    const tabIds = new Set(visualTabIds);
    const activeTabId =
        workspace.activeTabId && tabIds.has(workspace.activeTabId)
            ? workspace.activeTabId
            : (visualTabs[0]?.id ?? null);

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
        tabs: visualTabs,
        pinnedTabIds,
        tabIds: visualTabIds,
        activeTabId,
        activationHistory,
        tabNavigationHistory,
        tabNavigationIndex,
    };
}

export function createEditorPaneState(
    id: string,
    workspace: EditorPaneWorkspaceInput = {},
): EditorPaneState {
    return {
        id,
        ...normalizePaneWorkspaceState(workspace),
    };
}

function stringArraysEqual(left: readonly string[], right: readonly string[]) {
    return (
        left.length === right.length &&
        left.every((value, index) => value === right[index])
    );
}

function paneIdCollectionsEqual(
    left: readonly string[],
    right: readonly string[],
) {
    if (left.length !== right.length) {
        return false;
    }

    const leftIds = new Set(left);
    const rightIds = new Set(right);
    if (leftIds.size !== left.length || rightIds.size !== right.length) {
        return false;
    }

    return left.every((paneId) => rightIds.has(paneId));
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

function paneStateHasNormalizedTabs(
    pane: EditorPaneState,
    tabsById: Record<string, Tab> | undefined,
) {
    const normalized = createEditorPaneState(pane.id, {
        ...pane,
        tabsById,
    });

    return (
        Array.isArray(pane.tabIds) &&
        Array.isArray(pane.pinnedTabIds) &&
        stringArraysEqual(
            pane.tabIds,
            normalized.tabIds,
        ) &&
        stringArraysEqual(
            pane.pinnedTabIds,
            normalized.pinnedTabIds,
        ) &&
        pane.tabIds.every((tabId, index) =>
            tabsById ? tabsById[tabId] === pane.tabs[index] : true,
        )
    );
}

function buildWorkspaceTabsById(
    panes: readonly EditorPaneState[],
    seed: Record<string, Tab> = {},
) {
    const nextTabsById = { ...seed };
    for (const pane of panes) {
        for (const tab of pane.tabs) {
            nextTabsById[tab.id] = tab;
        }
    }

    const referencedTabIds = new Set<string>();
    for (const pane of panes) {
        for (const tabId of pane.tabIds) {
            referencedTabIds.add(tabId);
        }
    }

    return Object.fromEntries(
        Object.entries(nextTabsById).filter(([tabId]) =>
            referencedTabIds.has(tabId),
        ),
    );
}

function buildWorkspaceSnapshot(args: {
    panes: EditorPaneState[];
    focusedPaneId?: string | null;
    layoutTree?: WorkspaceLayoutNode;
    tabsById?: Record<string, Tab>;
}) {
    const paneStates =
        args.panes.length > 0
            ? args.panes.map((pane) =>
                  createEditorPaneState(pane.id, {
                      ...pane,
                      tabsById: args.tabsById,
                  }),
              )
            : [createEditorPaneState(INITIAL_EDITOR_PANE_ID)];
    const paneIds = paneStates.map((pane) => pane.id);
    const layoutTree =
        args.layoutTree &&
        paneIdCollectionsEqual(
            getLayoutPaneIds(normalizeLayoutTree(args.layoutTree)),
            paneIds,
        )
            ? normalizeLayoutTree(args.layoutTree)
            : buildLinearLayoutTree(paneIds);
    const paneCache = buildPaneCacheMap(paneStates);
    const orderedPanes = getLayoutPaneIds(layoutTree).map(
        (paneId) =>
            paneCache.get(paneId) ??
            createEditorPaneState(paneId, {
                tabsById: args.tabsById,
            }),
    );
    const tabsById = buildWorkspaceTabsById(orderedPanes, args.tabsById);
    const panes = orderedPanes.map((pane) =>
        createEditorPaneState(pane.id, {
            ...pane,
            tabsById,
        }),
    );
    const focusedPaneId = getResolvedFocusedPaneId(panes, args.focusedPaneId);
    const focusedPane =
        panes.find((pane) => pane.id === focusedPaneId) ?? panes[0] ?? null;

    return {
        layoutTree,
        panes,
        focusedPaneId,
        tabsById,
        tabs: focusedPane?.tabs ?? [],
        activeTabId: focusedPane?.activeTabId ?? null,
        activationHistory: focusedPane?.activationHistory ?? [],
        tabNavigationHistory: focusedPane?.tabNavigationHistory ?? [],
        tabNavigationIndex: focusedPane?.tabNavigationIndex ?? -1,
    };
}

function resolveLayoutTreeFromState<
    TState extends EditorWorkspaceReadableState,
>(state: TState, paneIds?: readonly string[]) {
    const resolvedPaneIds =
        paneIds ??
        (state.panes.length > 0
            ? state.panes.map((pane) => pane.id)
            : [INITIAL_EDITOR_PANE_ID]);

    if (state.layoutTree) {
        const normalizedTree = normalizeLayoutTree(state.layoutTree);
        const treePaneIds = getLayoutPaneIds(normalizedTree);
        if (paneIdCollectionsEqual(treePaneIds, resolvedPaneIds)) {
            return normalizedTree;
        }
    }

    return buildLinearLayoutTree(resolvedPaneIds);
}

export function getEffectivePaneWorkspace<
    TState extends EditorWorkspaceReadableState,
>(state: TState) {
    const panes = state.panes.length > 0 ? state.panes : [];
    const hasFocusedPaneFallbackState =
        Array.isArray(state.tabs) &&
        (state.tabs.length > 0 ||
            state.activeTabId !== null ||
            (state.activationHistory?.length ?? 0) > 0 ||
            (state.tabNavigationHistory?.length ?? 0) > 0 ||
            (state.tabNavigationIndex ?? -1) >= 0);

    if (panes.length > 1 || !hasFocusedPaneFallbackState) {
        const effectivePanes =
            panes.length > 0
                ? panes
                : [createEditorPaneState(INITIAL_EDITOR_PANE_ID)];
        const layoutTree = resolveLayoutTreeFromState(
            state,
            effectivePanes.map((pane) => pane.id),
        );
        const orderedPaneIds = getLayoutPaneIds(layoutTree);
        const panesAlreadyStable =
            stringArraysEqual(
                effectivePanes.map((pane) => pane.id),
                orderedPaneIds,
            ) &&
            effectivePanes.every((pane) =>
                paneStateHasNormalizedTabs(pane, state.tabsById),
            );

        if (panesAlreadyStable) {
            return {
                layoutTree,
                panes: effectivePanes,
                focusedPaneId: getResolvedFocusedPaneId(
                    effectivePanes,
                    state.focusedPaneId,
                ),
            };
        }

        const snapshot = buildWorkspaceSnapshot({
            panes: effectivePanes.map((pane) =>
                createEditorPaneState(pane.id, {
                    ...pane,
                    tabsById: state.tabsById,
                }),
            ),
            focusedPaneId: state.focusedPaneId,
            layoutTree,
            tabsById: state.tabsById,
        });
        return {
            layoutTree: snapshot.layoutTree,
            panes: snapshot.panes,
            focusedPaneId: snapshot.focusedPaneId,
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
        if (
            stringArraysEqual(
                panes.map((pane) => pane.id),
                getLayoutPaneIds(layoutTree),
            ) &&
            panes.every((pane) =>
                paneStateHasNormalizedTabs(pane, state.tabsById),
            )
        ) {
            return {
                layoutTree,
                panes,
                focusedPaneId: getResolvedFocusedPaneId(
                    panes,
                    state.focusedPaneId,
                ),
            };
        }

        const snapshot = buildWorkspaceSnapshot({
            panes: panes.map((pane) =>
                createEditorPaneState(pane.id, {
                    ...pane,
                    tabsById: state.tabsById,
                }),
            ),
            focusedPaneId: state.focusedPaneId,
            layoutTree,
            tabsById: state.tabsById,
        });
        return {
            layoutTree: snapshot.layoutTree,
            panes: snapshot.panes,
            focusedPaneId: snapshot.focusedPaneId,
        };
    }

    const fallbackPane = createEditorPaneState(INITIAL_EDITOR_PANE_ID, {
        tabs: state.tabs ?? [],
        activeTabId: state.activeTabId ?? null,
        activationHistory: state.activationHistory ?? [],
        tabNavigationHistory: state.tabNavigationHistory ?? [],
        tabNavigationIndex: state.tabNavigationIndex ?? -1,
    });
    const snapshot = buildWorkspaceSnapshot({
        panes: [fallbackPane],
        focusedPaneId: state.focusedPaneId,
        layoutTree: resolveLayoutTreeFromState(state, [fallbackPane.id]),
        tabsById: state.tabsById,
    });

    return {
        layoutTree: snapshot.layoutTree,
        panes: snapshot.panes,
        focusedPaneId: snapshot.focusedPaneId,
    };
}

export function selectEditorPaneState<
    TState extends EditorWorkspaceReadableState,
>(state: TState, paneId?: string | null) {
    return selectPaneState(state, paneId);
}

export function selectLeafPaneIds<TState extends EditorWorkspaceReadableState>(
    state: TState,
) {
    return getLayoutPaneIds(getEffectivePaneWorkspace(state).layoutTree);
}

export function selectFocusedPaneId<
    TState extends EditorWorkspaceReadableState,
>(state: TState) {
    return getEffectivePaneWorkspace(state).focusedPaneId;
}

export function selectPaneCount<TState extends EditorWorkspaceReadableState>(
    state: TState,
) {
    return selectLeafPaneIds(state).length;
}

export function selectPaneState<TState extends EditorWorkspaceReadableState>(
    state: TState,
    paneId?: string | null,
) {
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

export function selectPaneNeighbor<TState extends EditorWorkspaceReadableState>(
    state: TState,
    paneId: string,
    direction: WorkspacePaneNeighborDirection,
) {
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
    TState extends EditorWorkspaceReadableState,
>(state: TState, paneId?: string | null) {
    return selectPaneState(state, paneId).tabs;
}

export function selectEditorPaneActiveTab<
    TState extends EditorWorkspaceReadableState,
>(state: TState, paneId?: string | null) {
    const pane = selectPaneState(state, paneId);
    return pane.tabs.find((tab) => tab.id === pane.activeTabId) ?? null;
}

export function selectFocusedEditorTab<
    TState extends EditorWorkspaceReadableState,
>(state: TState) {
    return selectEditorPaneActiveTab(state);
}

function replaceAiSessionTabReference(
    tab: Tab,
    fromSessionId: string,
    toSessionId: string,
    historySessionId?: string | null,
) {
    if (isReviewTab(tab) && tab.sessionId === fromSessionId) {
        if (toSessionId === fromSessionId) {
            return tab;
        }

        return {
            ...tab,
            sessionId: toSessionId,
        };
    }

    if (isChatTab(tab) && tab.sessionId === fromSessionId) {
        const nextHistorySessionId = historySessionId ?? tab.historySessionId;
        if (
            toSessionId === fromSessionId &&
            nextHistorySessionId === tab.historySessionId
        ) {
            return tab;
        }

        return {
            ...tab,
            sessionId: toSessionId,
            ...(nextHistorySessionId
                ? { historySessionId: nextHistorySessionId }
                : {}),
        };
    }

    return tab;
}

export function selectEditorWorkspaceTabs<
    TState extends EditorWorkspaceReadableState,
>(state: TState) {
    return getEffectivePaneWorkspace(state).panes.flatMap((pane) => pane.tabs);
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
        EditorWorkspaceState,
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
    state: Pick<EditorWorkspaceState, "tabs" | "activeTabId">,
): NavigableHistoryTab | null {
    const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId);
    if (!activeTab || !isNavigableHistoryTab(activeTab)) {
        return null;
    }
    return normalizeHistoryTab(activeTab) as NavigableHistoryTab;
}

function openOrReuseHistoryTab(
    state: Pick<
        EditorWorkspaceState,
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
    if (isChatTab(tab) || isChatHistoryTab(tab)) {
        return tab;
    }
    if (isGraphTab(tab)) {
        return tab;
    }
    if (isTerminalTab(tab)) {
        return ensureTerminalTabDefaults(tab);
    }
    return null;
}

function normalizeExternalTab(tab: TabInput): Tab | null {
    if (isHistoryTab(tab)) {
        return normalizeHistoryTab(tab);
    }
    if (
        isReviewTab(tab) ||
        isChatTab(tab) ||
        isChatHistoryTab(tab) ||
        isGraphTab(tab)
    ) {
        return tab;
    }
    if (isTerminalTab(tab)) {
        return ensureTerminalTabDefaults(tab);
    }
    return null;
}

function getSingletonWorkspaceTabKind(
    tab: Tab | TabInput | null | undefined,
): "graph" | "ai-chat-history" | null {
    if (isGraphTab(tab)) {
        return "graph";
    }
    if (isChatHistoryTab(tab)) {
        return "ai-chat-history";
    }
    return null;
}

function insertNormalizedTab(
    state: Pick<
        EditorWorkspaceState,
        | "tabs"
        | "pinnedTabIds"
        | "activeTabId"
        | "activationHistory"
        | "tabNavigationHistory"
        | "tabNavigationIndex"
    >,
    incoming: Tab,
    index?: number,
) {
    const singletonKind = getSingletonWorkspaceTabKind(incoming);
    if (singletonKind) {
        const existing = state.tabs.find(
            (tab) => getSingletonWorkspaceTabKind(tab) === singletonKind,
        );
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
                pinnedTabIds: state.pinnedTabIds.filter(
                    (tabId) => tabId !== incoming.id,
                ),
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
        pinnedTabIds: state.pinnedTabIds.filter(
            (tabId) => tabId !== incoming.id,
        ),
        ...activateTab(state, incoming.id),
    };
}

function removeTabFromWorkspaceState(
    state: Pick<
        EditorWorkspaceState,
        | "tabs"
        | "pinnedTabIds"
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
        pinnedTabIds: state.pinnedTabIds.filter((id) => id !== tabId),
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
    const tabIds = new Set(tabs.map((tab) => tab.id));
    const pinnedTabIds = [
        ...targetPane.pinnedTabIds,
        ...sourcePane.pinnedTabIds,
    ].filter(
        (tabId, index, items) =>
            tabIds.has(tabId) && items.indexOf(tabId) === index,
    );
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
        pinnedTabIds,
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
    TState extends EditorWorkspaceReadableState,
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
    workspace: Pick<EditorWorkspaceState, "panes" | "focusedPaneId">,
    paneId?: string | null,
) {
    return getResolvedFocusedPaneId(
        workspace.panes,
        paneId ?? workspace.focusedPaneId,
    );
}

function buildSplitPaneProjection(
    workspace: Pick<
        EditorWorkspaceState,
        "panes" | "focusedPaneId" | "layoutTree"
    >,
    anchorPaneId: string,
    direction: WorkspaceSplitDirection,
    nextPane: EditorPaneState,
) {
    return buildWorkspaceSnapshot({
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
    workspace: Pick<
        EditorWorkspaceState,
        "panes" | "focusedPaneId" | "layoutTree"
    >,
    options?: {
        preferredFocusedPaneId?: string | null;
    },
) {
    let nextPanes = workspace.panes;
    let nextLayoutTree = workspace.layoutTree;
    let nextFocusedPaneId = workspace.focusedPaneId;

    for (const pane of [...nextPanes]) {
        if (pane.tabIds.length > 0) {
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
    return panes.find((pane) => pane.tabIds.includes(tabId)) ?? null;
}

function activatePaneTab(
    state: Pick<EditorWorkspaceState, "panes" | "focusedPaneId" | "layoutTree">,
    paneId: string,
    tabId: string,
    options?: { recordNavigation?: boolean },
) {
    const targetPane = state.panes.find((pane) => pane.id === paneId);
    if (!targetPane) {
        return null;
    }

    return buildWorkspaceSnapshot({
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
    setState: (updater: (state: { tabs: Tab[] }) => { tabs: Tab[] }) => void,
) {
    if (entry.kind === "note" && !entry.content) {
        void loadResourceHistoryEntryContent(
            getResourceHandler("note"),
            tabId,
            historyIndex,
            entry.noteId,
            setState,
        );
    }

    if (entry.kind === "file" && !entry.content) {
        void loadResourceHistoryEntryContent(
            getResourceHandler("file"),
            tabId,
            historyIndex,
            entry.relativePath,
            setState,
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

function getNextTerminalTitle(tabs: readonly Tab[]) {
    const count = tabs.filter((tab) => isTerminalTab(tab)).length;
    return `Terminal ${count + 1}`;
}

function resolvePinnedAwareTabReorder(
    pane: EditorPaneState,
    fromIndex: number,
    toIndex: number,
) {
    if (
        fromIndex === toIndex ||
        fromIndex < 0 ||
        toIndex < 0 ||
        fromIndex >= pane.tabs.length ||
        toIndex >= pane.tabs.length
    ) {
        return null;
    }

    const pinnedIds = new Set(pane.pinnedTabIds);
    const tab = pane.tabs[fromIndex];
    if (!tab) {
        return null;
    }

    const pinnedCount = pane.pinnedTabIds.length;
    const isPinned = pinnedIds.has(tab.id);
    const boundedToIndex = isPinned
        ? Math.min(Math.max(toIndex, 0), Math.max(0, pinnedCount - 1))
        : Math.min(Math.max(toIndex, pinnedCount), pane.tabs.length - 1);

    if (fromIndex === boundedToIndex) {
        return null;
    }

    const tabs = [...pane.tabs];
    const [movingTab] = tabs.splice(fromIndex, 1);
    if (!movingTab) {
        return null;
    }
    tabs.splice(boundedToIndex, 0, movingTab);

    return {
        tabs,
        pinnedTabIds: tabs
            .map((candidate) => candidate.id)
            .filter((tabId) => pinnedIds.has(tabId)),
    };
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
        EditorWorkspaceState,
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
    const projection = buildWorkspaceSnapshot({
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
    TState extends Pick<
        EditorWorkspaceState,
        "panes" | "focusedPaneId" | "layoutTree"
    >,
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
        projection: buildWorkspaceSnapshot(compactedWorkspace),
        didChange,
    };
}

function renameNoteAcrossWorkspace<
    TState extends Pick<
        EditorWorkspaceState,
        "panes" | "focusedPaneId" | "layoutTree"
    >,
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
        projection: buildWorkspaceSnapshot({
            panes: nextPanes,
            focusedPaneId: workspace.focusedPaneId,
            layoutTree: workspace.layoutTree,
        }),
        didChange:
            nextPanes.length !== workspace.panes.length ||
            nextPanes.some((pane, index) => pane !== workspace.panes[index]),
    };
}

function convertNoteToFileAcrossWorkspace<
    TState extends Pick<
        EditorWorkspaceState,
        | "panes"
        | "focusedPaneId"
        | "layoutTree"
        | "_pendingForceReloads"
        | "_noteReloadVersions"
        | "_noteReloadMetadata"
        | "noteExternalConflicts"
    >,
>(
    state: TState,
    oldNoteId: string,
    newRelativePath: string,
    newTitle: string,
    newPath: string,
    mimeType: string | null,
    viewer: FileViewerMode,
) {
    const workspace = getEffectivePaneWorkspace(state);
    const nextPanes = workspace.panes.map((pane) => {
        let didChange = false;
        const tabs = pane.tabs.map((tab) => {
            if (!isNoteTab(tab) || tab.noteId !== oldNoteId) {
                return tab;
            }

            didChange = true;
            const history = tab.history.map((entry) => {
                if (entry.kind !== "note" || entry.noteId !== oldNoteId) {
                    return entry;
                }

                return createFileHistoryEntry(
                    newRelativePath,
                    newTitle,
                    newPath,
                    entry.content,
                    mimeType,
                    viewer,
                );
            });
            return buildTabFromHistory(tab.id, history, tab.historyIndex);
        });

        return didChange ? updatePaneWithTabs(pane, tabs) : pane;
    });

    return {
        projection: buildWorkspaceSnapshot({
            panes: nextPanes,
            focusedPaneId: workspace.focusedPaneId,
            layoutTree: workspace.layoutTree,
        }),
        didChange:
            nextPanes.length !== workspace.panes.length ||
            nextPanes.some((pane, index) => pane !== workspace.panes[index]),
        pendingForceReloads: new Set(
            [...state._pendingForceReloads].filter((key) => key !== oldNoteId),
        ),
        reloadVersions: Object.fromEntries(
            Object.entries(state._noteReloadVersions).filter(
                ([key]) => key !== oldNoteId,
            ),
        ),
        reloadMetadata: Object.fromEntries(
            Object.entries(state._noteReloadMetadata).filter(
                ([key]) => key !== oldNoteId,
            ),
        ),
        noteExternalConflicts: new Set(
            [...state.noteExternalConflicts].filter((key) => key !== oldNoteId),
        ),
    };
}

function deleteMapAcrossWorkspace<
    TState extends Pick<
        EditorWorkspaceState,
        "panes" | "focusedPaneId" | "layoutTree"
    >,
>(state: TState, relativePath: string) {
    const workspace = getEffectivePaneWorkspace(state);
    const nextPanes = workspace.panes.map((pane) => {
        const tabs = pane.tabs.filter(
            (tab) => !isMapTab(tab) || tab.relativePath !== relativePath,
        );
        return tabs.length !== pane.tabs.length
            ? updatePaneWithTabs(pane, tabs)
            : pane;
    });

    const compactedWorkspace = removeEmptyPanesFromWorkspace({
        panes: nextPanes,
        focusedPaneId: workspace.focusedPaneId,
        layoutTree: workspace.layoutTree,
    });

    return {
        projection: buildWorkspaceSnapshot(compactedWorkspace),
        didChange:
            compactedWorkspace.layoutTree !== workspace.layoutTree ||
            compactedWorkspace.focusedPaneId !== workspace.focusedPaneId ||
            compactedWorkspace.panes.length !== workspace.panes.length ||
            compactedWorkspace.panes.some(
                (pane, index) => pane !== workspace.panes[index],
            ),
    };
}

function renameMapAcrossWorkspace<
    TState extends Pick<
        EditorWorkspaceState,
        "panes" | "focusedPaneId" | "layoutTree"
    >,
>(
    state: TState,
    oldRelativePath: string,
    newRelativePath: string,
    newTitle: string,
) {
    const workspace = getEffectivePaneWorkspace(state);
    const nextPanes = workspace.panes.map((pane) => {
        let didChange = false;
        const tabs = pane.tabs.map((tab) => {
            if (!isMapTab(tab) || tab.relativePath !== oldRelativePath) {
                return tab;
            }

            didChange = true;
            return {
                ...tab,
                relativePath: newRelativePath,
                title: newTitle,
            };
        });

        return didChange ? updatePaneWithTabs(pane, tabs) : pane;
    });

    return {
        projection: buildWorkspaceSnapshot({
            panes: nextPanes,
            focusedPaneId: workspace.focusedPaneId,
            layoutTree: workspace.layoutTree,
        }),
        didChange:
            nextPanes.length !== workspace.panes.length ||
            nextPanes.some((pane, index) => pane !== workspace.panes[index]),
    };
}

function replacePaneInWorkspace(
    workspace: ReturnType<typeof getEffectivePaneWorkspace>,
    paneId: string,
    nextPane: EditorPaneState,
    options?: {
        focusedPaneId?: string | null;
        tabsById?: Record<string, Tab>;
    },
) {
    return buildWorkspaceSnapshot({
        panes: workspace.panes.map((pane) =>
            pane.id === paneId ? nextPane : pane,
        ),
        focusedPaneId: options?.focusedPaneId ?? workspace.focusedPaneId,
        layoutTree: workspace.layoutTree,
        tabsById: options?.tabsById,
    });
}

function mutatePaneWorkspace(
    state: Pick<
        EditorWorkspaceState,
        | "panes"
        | "focusedPaneId"
        | "layoutTree"
        | "tabsById"
        | "tabs"
        | "activeTabId"
        | "activationHistory"
        | "tabNavigationHistory"
        | "tabNavigationIndex"
    >,
    paneId: string,
    mutate: (pane: EditorPaneState) => Partial<PaneWorkspaceState>,
    options?: {
        focusedPaneId?: string | null;
    },
) {
    const workspace = getEffectivePaneWorkspace(state);
    const pane = workspace.panes.find((candidate) => candidate.id === paneId);
    if (!pane) {
        return null;
    }

    const nextPane = createEditorPaneState(pane.id, {
        ...pane,
        ...mutate(pane),
        tabsById: state.tabsById,
    });

    return replacePaneInWorkspace(workspace, pane.id, nextPane, {
        focusedPaneId: options?.focusedPaneId ?? pane.id,
        tabsById: state.tabsById,
    });
}

function mutateFocusedPaneWorkspace(
    state: Pick<
        EditorWorkspaceState,
        | "panes"
        | "focusedPaneId"
        | "layoutTree"
        | "tabsById"
        | "tabs"
        | "activeTabId"
        | "activationHistory"
        | "tabNavigationHistory"
        | "tabNavigationIndex"
    >,
    mutate: (pane: EditorPaneState) => Partial<PaneWorkspaceState>,
    options?: {
        preserveFocus?: boolean;
    },
) {
    const workspace = getEffectivePaneWorkspace(state);
    const focusedPane = selectEditorPaneState(workspace);
    return mutatePaneWorkspace(state, focusedPane.id, mutate, {
        focusedPaneId: options?.preserveFocus
            ? workspace.focusedPaneId
            : focusedPane.id,
    });
}

export function createEditorWorkspaceSlice<TState extends EditorWorkspaceStore>(
    _set: WorkspaceSetState<TState>,
    _get: WorkspaceGetState<TState>,
    _api: Pick<StoreApi<TState>, "setState">,
): EditorWorkspaceStore {
    // Narrow to the base interface — safe because TState extends EditorWorkspaceStore
    const set = _set as unknown as WorkspaceSetState<EditorWorkspaceStore>;
    const get = _get as unknown as WorkspaceGetState<EditorWorkspaceStore>;
    const api = _api as unknown as Pick<
        StoreApi<EditorWorkspaceStore>,
        "setState"
    >;
    return {
        layoutTree: createInitialLayout(INITIAL_EDITOR_PANE_ID),
        panes: [createEditorPaneState(INITIAL_EDITOR_PANE_ID)],
        focusedPaneId: INITIAL_EDITOR_PANE_ID,
        tabsById: {},
        tabs: [],
        pinnedTabIds: [],
        activeTabId: null,
        recentlyClosedTabs: [],
        activationHistory: [],
        tabNavigationHistory: [],
        tabNavigationIndex: -1,
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
            set(
                (state) =>
                    mutateFocusedPaneWorkspace(state, (pane) =>
                        openOrReuseHistoryTab(pane, {
                            kind: "note",
                            noteId,
                            title,
                            content,
                        }),
                    ) ?? state,
            );
        },

        openPdf: (entryId, title, path) => {
            set(
                (state) =>
                    mutateFocusedPaneWorkspace(state, (pane) =>
                        openOrReuseHistoryTab(pane, {
                            kind: "pdf",
                            entryId,
                            title,
                            path,
                        }),
                    ) ?? state,
            );
        },

        openMap: (relativePath, title) => {
            set((state) => {
                const existing = selectEditorWorkspaceTabs(state).find(
                    (tab) => isMapTab(tab) && tab.relativePath === relativePath,
                );
                if (existing) {
                    const workspace = getEffectivePaneWorkspace(state);
                    const targetPane = findPaneContainingTab(
                        workspace.panes,
                        existing.id,
                    );
                    if (!targetPane) {
                        return state;
                    }
                    return (
                        activatePaneTab(
                            workspace,
                            targetPane.id,
                            existing.id,
                        ) ?? state
                    );
                }
                const newTab = createMapTab(relativePath, title);
                return (
                    mutateFocusedPaneWorkspace(state, (pane) =>
                        insertNormalizedTab(pane, newTab),
                    ) ?? state
                );
            });
        },

        openGraph: () => {
            set((state) => {
                const existing = selectEditorWorkspaceTabs(state).find((tab) =>
                    isGraphTab(tab),
                );
                if (existing) {
                    const workspace = getEffectivePaneWorkspace(state);
                    const targetPane = findPaneContainingTab(
                        workspace.panes,
                        existing.id,
                    );
                    if (!targetPane) {
                        return state;
                    }
                    return (
                        activatePaneTab(
                            workspace,
                            targetPane.id,
                            existing.id,
                        ) ?? state
                    );
                }
                const newTab = createGraphTab();
                return (
                    mutateFocusedPaneWorkspace(state, (pane) =>
                        insertNormalizedTab(pane, newTab),
                    ) ?? state
                );
            });
        },

        openChatHistory: () => {
            set((state) => {
                const existing = selectEditorWorkspaceTabs(state).find((tab) =>
                    isChatHistoryTab(tab),
                );
                if (existing) {
                    const workspace = getEffectivePaneWorkspace(state);
                    const targetPane = findPaneContainingTab(
                        workspace.panes,
                        existing.id,
                    );
                    if (!targetPane) {
                        return state;
                    }
                    return (
                        activatePaneTab(
                            workspace,
                            targetPane.id,
                            existing.id,
                        ) ?? state
                    );
                }
                const newTab = createChatHistoryTab();
                return (
                    mutateFocusedPaneWorkspace(state, (pane) =>
                        insertNormalizedTab(pane, newTab),
                    ) ?? state
                );
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
            set(
                (state) =>
                    mutateFocusedPaneWorkspace(state, (pane) =>
                        openOrReuseHistoryTab(pane, {
                            kind: "file",
                            relativePath,
                            title,
                            path,
                            content,
                            mimeType,
                            viewer,
                            sizeBytes: options?.sizeBytes ?? null,
                            contentTruncated:
                                options?.contentTruncated ?? false,
                        }),
                    ) ?? state,
            );
        },

        openReview: (sessionId, options) => {
            set((state) => {
                const workspace = getEffectivePaneWorkspace(state);
                const existingPane = workspace.panes.find((pane) =>
                    pane.tabs.some(
                        (tab) =>
                            isReviewTab(tab) && tab.sessionId === sessionId,
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
                        return buildWorkspaceSnapshot({
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
                        buildWorkspaceSnapshot({
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
                    return buildWorkspaceSnapshot({
                        panes: workspace.panes.map((pane) =>
                            pane.id === focusedPane.id ? nextPane : pane,
                        ),
                        focusedPaneId: workspace.focusedPaneId,
                        layoutTree: workspace.layoutTree,
                    });
                }

                return buildWorkspaceSnapshot({
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
                const requestedHistorySessionId =
                    options?.historySessionId ?? null;

                const existingPane = workspace.panes.find((pane) =>
                    pane.tabs.some(
                        (tab) =>
                            isChatTab(tab) &&
                            (tab.sessionId === sessionId ||
                                (!!requestedHistorySessionId &&
                                    tab.historySessionId ===
                                        requestedHistorySessionId)),
                    ),
                );
                const existing =
                    existingPane?.tabs.find(
                        (tab): tab is ChatTab =>
                            isChatTab(tab) &&
                            (tab.sessionId === sessionId ||
                                (!!requestedHistorySessionId &&
                                    tab.historySessionId ===
                                        requestedHistorySessionId)),
                    ) ?? null;
                if (existingPane && existing) {
                    const nextTitle = options?.title ?? existing.title;
                    const nextHistorySessionId =
                        requestedHistorySessionId ?? existing.historySessionId;
                    const nextTab =
                        nextTitle === existing.title &&
                        existing.sessionId === sessionId &&
                        existing.historySessionId === nextHistorySessionId
                            ? existing
                            : {
                                  ...existing,
                                  title: nextTitle,
                                  sessionId,
                                  ...(nextHistorySessionId
                                      ? {
                                            historySessionId:
                                                nextHistorySessionId,
                                        }
                                      : {}),
                              };
                    const nextPane =
                        nextTab === existing
                            ? existingPane
                            : createEditorPaneState(existingPane.id, {
                                  ...existingPane,
                                  tabs: existingPane.tabs.map((tab) =>
                                      tab.id === existing.id
                                          ? nextTab
                                          : tab,
                                  ),
                              });
                    if (options?.background) {
                        if (nextPane === existingPane) {
                            return state;
                        }
                        return buildWorkspaceSnapshot({
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
                        buildWorkspaceSnapshot({
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
                    requestedHistorySessionId,
                );

                const targetPaneId =
                    options?.paneId ?? workspace.focusedPaneId ?? null;
                const targetPane = targetPaneId
                    ? (workspace.panes.find((p) => p.id === targetPaneId) ??
                      null)
                    : null;
                const focusedPane =
                    targetPane ?? selectEditorPaneState(workspace);

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
                    return buildWorkspaceSnapshot({
                        panes: workspace.panes.map((pane) =>
                            pane.id === focusedPane.id ? nextPane : pane,
                        ),
                        focusedPaneId: workspace.focusedPaneId,
                        layoutTree: workspace.layoutTree,
                    });
                }

                return buildWorkspaceSnapshot({
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

        openTerminal: (options) => {
            const workspace = getEffectivePaneWorkspace(get());
            const requestedPane = options?.paneId
                ? (workspace.panes.find((pane) => pane.id === options.paneId) ??
                  null)
                : null;

            if (options?.paneId && !requestedPane) {
                return null;
            }

            const targetPane = requestedPane ?? selectEditorPaneState(workspace);
            const newTab = createTerminalTab({
                cwd: options?.cwd ?? useVaultStore.getState().vaultPath,
                title:
                    options?.title ??
                    getNextTerminalTitle(selectEditorWorkspaceTabs(workspace)),
            });

            set((state) => {
                const currentWorkspace = getEffectivePaneWorkspace(state);
                const currentTargetPane =
                    currentWorkspace.panes.find(
                        (pane) => pane.id === targetPane.id,
                    ) ?? selectEditorPaneState(currentWorkspace);

                return buildWorkspaceSnapshot({
                    panes: currentWorkspace.panes.map((pane) =>
                        pane.id === currentTargetPane.id
                            ? createEditorPaneState(
                                  pane.id,
                                  insertNormalizedTab(pane, newTab),
                              )
                            : pane,
                    ),
                    focusedPaneId: currentTargetPane.id,
                    layoutTree: currentWorkspace.layoutTree,
                });
            });

            return newTab.id;
        },

        replaceAiSessionId: (fromSessionId, toSessionId, historySessionId) => {
            if (
                !fromSessionId ||
                !toSessionId ||
                (fromSessionId === toSessionId && !historySessionId)
            ) {
                return;
            }

            set((state) => {
                const workspace = getEffectivePaneWorkspace(state);
                let panesChanged = false;
                const panes = workspace.panes.map((pane) => {
                    let paneChanged = false;
                    const tabs = pane.tabs.map((tab) => {
                        const nextTab = replaceAiSessionTabReference(
                            tab,
                            fromSessionId,
                            toSessionId,
                            historySessionId,
                        );
                        if (nextTab !== tab) {
                            paneChanged = true;
                        }
                        return nextTab;
                    });

                    if (!paneChanged) {
                        return pane;
                    }

                    panesChanged = true;
                    return createEditorPaneState(pane.id, {
                        ...pane,
                        tabs,
                    });
                });

                let recentlyClosedChanged = false;
                const recentlyClosedTabs = state.recentlyClosedTabs.map(
                    (entry) => {
                        const nextTab = replaceAiSessionTabReference(
                            entry.tab,
                            fromSessionId,
                            toSessionId,
                            historySessionId,
                        );
                        if (nextTab === entry.tab) {
                            return entry;
                        }

                        recentlyClosedChanged = true;
                        return {
                            ...entry,
                            tab: nextTab,
                        };
                    },
                );

                if (!panesChanged && !recentlyClosedChanged) {
                    return state;
                }

                if (!panesChanged) {
                    return { recentlyClosedTabs };
                }

                const snapshot = buildWorkspaceSnapshot({
                    panes,
                    focusedPaneId: workspace.focusedPaneId,
                    layoutTree: workspace.layoutTree,
                });

                return {
                    ...snapshot,
                    recentlyClosedTabs: recentlyClosedChanged
                        ? recentlyClosedTabs
                        : state.recentlyClosedTabs,
                };
            });
        },

        goBack: () => {
            const workspace = getEffectivePaneWorkspace(get());
            const focusedPane = selectEditorPaneState(workspace);

            if (getTabOpenBehavior() === "history") {
                const tab = getReusableHistoryTab(focusedPane);
                if (!tab) return;
                get().navigateToHistoryIndex(tab.historyIndex - 1);
                return;
            }

            for (
                let idx = focusedPane.tabNavigationIndex - 1;
                idx >= 0;
                idx -= 1
            ) {
                const tabId = focusedPane.tabNavigationHistory[idx];
                if (!focusedPane.tabIds.includes(tabId)) continue;
                set(
                    (state) =>
                        mutatePaneWorkspace(
                            state,
                            selectEditorPaneState(
                                getEffectivePaneWorkspace(state),
                            ).id,
                            (pane) => ({
                                ...activateTab(pane, tabId, {
                                    recordNavigation: false,
                                }),
                                tabNavigationIndex: idx,
                            }),
                        ) ?? state,
                );
                return;
            }
        },

        goForward: () => {
            const workspace = getEffectivePaneWorkspace(get());
            const focusedPane = selectEditorPaneState(workspace);

            if (getTabOpenBehavior() === "history") {
                const tab = getReusableHistoryTab(focusedPane);
                if (!tab) return;
                get().navigateToHistoryIndex(tab.historyIndex + 1);
                return;
            }

            for (
                let idx = focusedPane.tabNavigationIndex + 1;
                idx < focusedPane.tabNavigationHistory.length;
                idx += 1
            ) {
                const tabId = focusedPane.tabNavigationHistory[idx];
                if (!focusedPane.tabIds.includes(tabId)) continue;
                set(
                    (state) =>
                        mutatePaneWorkspace(
                            state,
                            selectEditorPaneState(
                                getEffectivePaneWorkspace(state),
                            ).id,
                            (pane) => ({
                                ...activateTab(pane, tabId, {
                                    recordNavigation: false,
                                }),
                                tabNavigationIndex: idx,
                            }),
                        ) ?? state,
                );
                return;
            }
        },

        navigateToHistoryIndex: (targetIndex) => {
            const state = get();
            const workspace = getEffectivePaneWorkspace(state);
            const focusedPane = selectEditorPaneState(workspace);
            const tabIdx = focusedPane.tabs.findIndex(
                (tab) => tab.id === focusedPane.activeTabId,
            );
            if (tabIdx === -1) return;
            const raw = focusedPane.tabs[tabIdx];
            if (!isNavigableHistoryTab(raw)) return;
            const tab = normalizeHistoryTab(raw) as NavigableHistoryTab;
            if (targetIndex < 0 || targetIndex >= tab.history.length) return;
            if (targetIndex === tab.historyIndex) return;

            const currentSnapshot = createHistorySnapshot(tab);
            const history = tab.history.map((h, i) =>
                i === tab.historyIndex ? currentSnapshot : h,
            );
            const entry = history[targetIndex];

            const tabs = [...focusedPane.tabs];
            tabs[tabIdx] = buildTabFromHistory(tab.id, history, targetIndex);
            set(
                (currentState) =>
                    mutatePaneWorkspace(currentState, focusedPane.id, () => ({
                        tabs,
                    })) ?? currentState,
            );

            loadHistoryEntryContentIfNeeded(
                tab.id,
                targetIndex,
                entry,
                (updater) => api.setState((state) => updater(state)),
            );
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
                const projection = buildWorkspaceSnapshot(
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
                    state.recentlyClosedTabs[
                        state.recentlyClosedTabs.length - 1
                    ];
                if (!closed) return state;
                const projection = mutateFocusedPaneWorkspace(state, (pane) =>
                    insertNormalizedTab(pane, closed.tab, closed.index),
                );
                if (!projection) {
                    return state;
                }

                return {
                    ...projection,
                    recentlyClosedTabs: state.recentlyClosedTabs.slice(0, -1),
                };
            });
        },

        switchTab: (tabId) =>
            set((state) => {
                if (state.activeTabId === tabId) {
                    return state;
                }

                const workspace = getEffectivePaneWorkspace(state);
                const targetPane = findPaneContainingTab(
                    workspace.panes,
                    tabId,
                );
                if (!targetPane) {
                    return activateTab(state, tabId);
                }

                const projection = activatePaneTab(
                    workspace,
                    targetPane.id,
                    tabId,
                );
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

                return buildWorkspaceSnapshot({
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

                return buildWorkspaceSnapshot({
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
                return buildWorkspaceSnapshot({
                    panes: workspace.panes,
                    focusedPaneId: workspace.focusedPaneId,
                    layoutTree: balanceSplit(workspace.layoutTree, splitId),
                });
            }),

        unifyAllPanesInto: (paneId) =>
            set((state) => {
                const workspace = getEffectivePaneWorkspace(state);
                if (workspace.panes.length <= 1) {
                    return state;
                }

                const targetPaneId = getSplitAnchorPaneId(workspace, paneId);
                const targetPane = workspace.panes.find(
                    (candidate) => candidate.id === targetPaneId,
                );
                if (!targetPane) {
                    return state;
                }

                const mergedPane = workspace.panes
                    .filter((candidate) => candidate.id !== targetPaneId)
                    .reduce(
                        (currentPane, candidate) =>
                            mergePaneStates(currentPane, candidate),
                        targetPane,
                    );

                return buildWorkspaceSnapshot({
                    panes: [mergedPane],
                    focusedPaneId: targetPaneId,
                    layoutTree: createInitialLayout(targetPaneId),
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

                return buildWorkspaceSnapshot({
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
                    currentSourcePane?.tabs.find((tab) => tab.id === tabId) ??
                    null;

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

                return buildWorkspaceSnapshot(nextWorkspace);
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
                    currentSourcePane?.tabs.find((tab) => tab.id === tabId) ??
                    null;

                if (!currentSourcePane || !currentTargetPane || !movingTab) {
                    return state;
                }

                const nextSourcePane = createEditorPaneState(
                    currentSourcePane.id,
                    removeTabFromWorkspaceState(currentSourcePane, tabId),
                );
                const splitDirection =
                    position === "left" || position === "right"
                        ? "row"
                        : "column";
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
                        pane.id === currentSourcePane.id
                            ? nextSourcePane
                            : pane,
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

                return buildWorkspaceSnapshot(
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
                if (
                    !sourcePane ||
                    !targetPane ||
                    sourcePane.id === targetPane.id
                ) {
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

                return buildWorkspaceSnapshot(
                    removeEmptyPanesFromWorkspace(
                        {
                            panes: workspace.panes.map((pane) => {
                                if (pane.id === sourcePane.id) {
                                    return nextSourcePane;
                                }
                                if (pane.id === targetPane.id) {
                                    return nextTargetPane;
                                }
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

        pinPaneTab: (paneId, tabId) => {
            set((state) => {
                const workspace = getEffectivePaneWorkspace(state);
                const pane = workspace.panes.find(
                    (candidate) => candidate.id === paneId,
                );
                if (!pane || !pane.tabIds.includes(tabId)) {
                    return state;
                }
                if (pane.pinnedTabIds.includes(tabId)) {
                    return state;
                }

                return buildWorkspaceSnapshot({
                    panes: workspace.panes.map((candidate) =>
                        candidate.id === paneId
                            ? createEditorPaneState(candidate.id, {
                                  ...candidate,
                                  pinnedTabIds: [
                                      ...candidate.pinnedTabIds,
                                      tabId,
                                  ],
                              })
                            : candidate,
                    ),
                    focusedPaneId: workspace.focusedPaneId,
                    layoutTree: workspace.layoutTree,
                });
            });
        },

        unpinPaneTab: (paneId, tabId) => {
            set((state) => {
                const workspace = getEffectivePaneWorkspace(state);
                const pane = workspace.panes.find(
                    (candidate) => candidate.id === paneId,
                );
                if (!pane || !pane.pinnedTabIds.includes(tabId)) {
                    return state;
                }

                return buildWorkspaceSnapshot({
                    panes: workspace.panes.map((candidate) =>
                        candidate.id === paneId
                            ? createEditorPaneState(candidate.id, {
                                  ...candidate,
                                  pinnedTabIds:
                                      candidate.pinnedTabIds.filter(
                                          (candidateTabId) =>
                                              candidateTabId !== tabId,
                                      ),
                              })
                            : candidate,
                    ),
                    focusedPaneId: workspace.focusedPaneId,
                    layoutTree: workspace.layoutTree,
                });
            });
        },

        togglePaneTabPinned: (paneId, tabId) => {
            const pane = getEffectivePaneWorkspace(get()).panes.find(
                (candidate) => candidate.id === paneId,
            );
            if (!pane || !pane.tabIds.includes(tabId)) {
                return;
            }
            if (pane.pinnedTabIds.includes(tabId)) {
                get().unpinPaneTab(paneId, tabId);
                return;
            }
            get().pinPaneTab(paneId, tabId);
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

                const reorder = resolvePinnedAwareTabReorder(
                    pane,
                    fromIndex,
                    toIndex,
                );
                if (!reorder) {
                    return state;
                }

                return buildWorkspaceSnapshot({
                    panes: workspace.panes.map((candidate) =>
                        candidate.id === paneId
                            ? createEditorPaneState(candidate.id, {
                                  ...candidate,
                                  ...reorder,
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

                return buildWorkspaceSnapshot({
                    panes: nextPanes,
                    focusedPaneId:
                        workspace.focusedPaneId === paneId
                            ? recipientPaneId
                            : getResolvedFocusedPaneId(
                                  nextPanes,
                                  workspace.focusedPaneId,
                              ),
                    layoutTree: closePaneAndCollapse(
                        workspace.layoutTree,
                        paneId,
                    ),
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
            set((state) => {
                const workspace = getEffectivePaneWorkspace(state);
                const targetPane = findPaneContainingTab(
                    workspace.panes,
                    tabId,
                );
                if (!targetPane) {
                    return state;
                }

                const nextTabs = patchHistoryTabById(
                    targetPane.tabs,
                    tabId,
                    (tab) =>
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
                );

                if (nextTabs === targetPane.tabs) {
                    return state;
                }

                return replacePaneInWorkspace(
                    workspace,
                    targetPane.id,
                    createEditorPaneState(targetPane.id, {
                        ...targetPane,
                        tabs: nextTabs,
                        tabsById: state.tabsById,
                    }),
                    {
                        focusedPaneId: workspace.focusedPaneId,
                        tabsById: state.tabsById,
                    },
                );
            });
        },

        updateTabTitle: (tabId, title) => {
            set((state) => {
                const workspace = getEffectivePaneWorkspace(state);
                let didChange = false;
                const nextPanes = workspace.panes.map((pane) => {
                    const nextTabs = updateTabTitleInTabs(
                        pane.tabs,
                        tabId,
                        title,
                    );
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

                return buildWorkspaceSnapshot({
                    panes: nextPanes,
                    focusedPaneId: workspace.focusedPaneId,
                    layoutTree: workspace.layoutTree,
                });
            });
        },

        updateFileHistoryTitle: (tabId, relativePath, title) => {
            set((state) => {
                const workspace = getEffectivePaneWorkspace(state);
                const targetPane = findPaneContainingTab(
                    workspace.panes,
                    tabId,
                );
                if (!targetPane) {
                    return state;
                }

                let didChange = false;
                const nextTabs = targetPane.tabs.map((rawTab) => {
                    if (rawTab.id !== tabId || !isFileTab(rawTab)) {
                        return rawTab;
                    }
                    const tab = ensureFileTabDefaults(rawTab);
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
                        return rawTab;
                    }
                    return buildTabFromHistory(
                        tab.id,
                        history,
                        tab.historyIndex,
                    );
                });

                if (!didChange) {
                    return state;
                }

                return replacePaneInWorkspace(
                    workspace,
                    targetPane.id,
                    createEditorPaneState(targetPane.id, {
                        ...targetPane,
                        tabs: nextTabs,
                        tabsById: state.tabsById,
                    }),
                    {
                        focusedPaneId: workspace.focusedPaneId,
                        tabsById: state.tabsById,
                    },
                );
            });
        },

        updatePdfPage: (tabId, page) => {
            set((state) => {
                const workspace = getEffectivePaneWorkspace(state);
                const targetPane = findPaneContainingTab(
                    workspace.panes,
                    tabId,
                );
                if (!targetPane) {
                    return state;
                }

                const nextTabs = patchHistoryTabById(
                    targetPane.tabs,
                    tabId,
                    (tab) =>
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
                );

                if (nextTabs === targetPane.tabs) {
                    return state;
                }

                return replacePaneInWorkspace(
                    workspace,
                    targetPane.id,
                    createEditorPaneState(targetPane.id, {
                        ...targetPane,
                        tabs: nextTabs,
                        tabsById: state.tabsById,
                    }),
                    {
                        focusedPaneId: workspace.focusedPaneId,
                        tabsById: state.tabsById,
                    },
                );
            });
        },

        updatePdfZoom: (tabId, zoom) => {
            set((state) => {
                const workspace = getEffectivePaneWorkspace(state);
                const targetPane = findPaneContainingTab(
                    workspace.panes,
                    tabId,
                );
                if (!targetPane) {
                    return state;
                }

                const nextTabs = patchHistoryTabById(
                    targetPane.tabs,
                    tabId,
                    (tab) =>
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
                );

                if (nextTabs === targetPane.tabs) {
                    return state;
                }

                return replacePaneInWorkspace(
                    workspace,
                    targetPane.id,
                    createEditorPaneState(targetPane.id, {
                        ...targetPane,
                        tabs: nextTabs,
                        tabsById: state.tabsById,
                    }),
                    {
                        focusedPaneId: workspace.focusedPaneId,
                        tabsById: state.tabsById,
                    },
                );
            });
        },

        updatePdfViewMode: (tabId, viewMode) => {
            set((state) => {
                const workspace = getEffectivePaneWorkspace(state);
                const targetPane = findPaneContainingTab(
                    workspace.panes,
                    tabId,
                );
                if (!targetPane) {
                    return state;
                }

                const nextTabs = patchHistoryTabById(
                    targetPane.tabs,
                    tabId,
                    (tab) =>
                        !isPdfTab(tab)
                            ? tab
                            : patchCurrentHistoryEntry(tab, (entry) =>
                                  entry.kind !== "pdf" ||
                                  entry.viewMode === viewMode
                                      ? entry
                                      : {
                                            ...entry,
                                            viewMode,
                                        },
                              ),
                );

                if (nextTabs === targetPane.tabs) {
                    return state;
                }

                return replacePaneInWorkspace(
                    workspace,
                    targetPane.id,
                    createEditorPaneState(targetPane.id, {
                        ...targetPane,
                        tabs: nextTabs,
                        tabsById: state.tabsById,
                    }),
                    {
                        focusedPaneId: workspace.focusedPaneId,
                        tabsById: state.tabsById,
                    },
                );
            });
        },

        updatePdfScrollTop: (tabId, scrollTop) => {
            set((state) => {
                const workspace = getEffectivePaneWorkspace(state);
                const targetPane = findPaneContainingTab(
                    workspace.panes,
                    tabId,
                );
                if (!targetPane) {
                    return state;
                }

                const nextScrollTop = Math.max(0, Math.round(scrollTop));
                const nextTabs = patchHistoryTabById(
                    targetPane.tabs,
                    tabId,
                    (tab) =>
                        !isPdfTab(tab)
                            ? tab
                            : patchCurrentHistoryEntry(tab, (entry) =>
                                  entry.kind !== "pdf" ||
                                  entry.scrollTop === nextScrollTop
                                      ? entry
                                      : {
                                            ...entry,
                                            scrollTop: nextScrollTop,
                                        },
                              ),
                );

                if (nextTabs === targetPane.tabs) {
                    return state;
                }

                return replacePaneInWorkspace(
                    workspace,
                    targetPane.id,
                    createEditorPaneState(targetPane.id, {
                        ...targetPane,
                        tabs: nextTabs,
                        tabsById: state.tabsById,
                    }),
                    {
                        focusedPaneId: workspace.focusedPaneId,
                        tabsById: state.tabsById,
                    },
                );
            });
        },

        updatePdfScrollPosition: (tabId, scrollTop, scrollLeft) => {
            set((state) => {
                const workspace = getEffectivePaneWorkspace(state);
                const targetPane = findPaneContainingTab(
                    workspace.panes,
                    tabId,
                );
                if (!targetPane) {
                    return state;
                }

                const nextScrollTop = Math.max(0, Math.round(scrollTop));
                const nextScrollLeft = Math.max(0, Math.round(scrollLeft));
                const nextTabs = patchHistoryTabById(
                    targetPane.tabs,
                    tabId,
                    (tab) =>
                        !isPdfTab(tab)
                            ? tab
                            : patchCurrentHistoryEntry(tab, (entry) =>
                                  entry.kind !== "pdf" ||
                                  (entry.scrollTop === nextScrollTop &&
                                      entry.scrollLeft === nextScrollLeft)
                                      ? entry
                                      : {
                                            ...entry,
                                            scrollTop: nextScrollTop,
                                            scrollLeft: nextScrollLeft,
                                        },
                              ),
                );

                if (nextTabs === targetPane.tabs) {
                    return state;
                }

                return replacePaneInWorkspace(
                    workspace,
                    targetPane.id,
                    createEditorPaneState(targetPane.id, {
                        ...targetPane,
                        tabs: nextTabs,
                        tabsById: state.tabsById,
                    }),
                    {
                        focusedPaneId: workspace.focusedPaneId,
                        tabsById: state.tabsById,
                    },
                );
            });
        },

        hydrateWorkspace: (panes, focusedPaneId, layoutTree) => {
            const seenSingletonKinds = new Set<string>();
            const hydratedPanes = panes.flatMap((pane, index) => {
                const hydratedTabs: Tab[] = pane.tabs.flatMap((tab): Tab[] => {
                    const normalized = normalizeHydratedTab(tab);
                    if (!normalized) {
                        return [];
                    }
                    const singletonKind =
                        getSingletonWorkspaceTabKind(normalized);
                    if (singletonKind) {
                        if (seenSingletonKinds.has(singletonKind)) {
                            return [];
                        }
                        seenSingletonKinds.add(singletonKind);
                    }
                    return [normalized];
                });

                return [
                    createEditorPaneState(
                        pane.id?.trim() || `pane-${index + 1}`,
                        {
                            tabs: hydratedTabs,
                            activeTabId: pane.activeTabId,
                            activationHistory: pane.activationHistory,
                            tabNavigationHistory: pane.tabNavigationHistory,
                            tabNavigationIndex: pane.tabNavigationIndex,
                        },
                    ),
                ];
            });

            set({
                ...buildWorkspaceSnapshot({
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
            } as Partial<EditorWorkspaceStore>);
        },

        hydrateTabs: (tabs, activeTabId) => {
            // Detached windows and a few test helpers still hydrate a
            // single-pane workspace directly through this API.
            const seenSingletonKinds = new Set<string>();
            const hydratedTabs: Tab[] = tabs.flatMap((tab): Tab[] => {
                const normalized = normalizeHydratedTab(tab);
                if (!normalized) {
                    return [];
                }
                const singletonKind = getSingletonWorkspaceTabKind(normalized);
                if (singletonKind) {
                    if (seenSingletonKinds.has(singletonKind)) {
                        return [];
                    }
                    seenSingletonKinds.add(singletonKind);
                }
                return [normalized];
            });
            const nextActiveTabId =
                activeTabId &&
                hydratedTabs.some((tab) => tab.id === activeTabId)
                    ? activeTabId
                    : (hydratedTabs[0]?.id ?? null);
            const projection = buildWorkspaceSnapshot({
                panes: [
                    createEditorPaneState(INITIAL_EDITOR_PANE_ID, {
                        tabs: hydratedTabs,
                        activeTabId: nextActiveTabId,
                        activationHistory: nextActiveTabId
                            ? [nextActiveTabId]
                            : [],
                        tabNavigationHistory: nextActiveTabId
                            ? [nextActiveTabId]
                            : [],
                        tabNavigationIndex: nextActiveTabId ? 0 : -1,
                    }),
                ],
                focusedPaneId: INITIAL_EDITOR_PANE_ID,
                layoutTree: createInitialLayout(INITIAL_EDITOR_PANE_ID),
            });
            set({
                ...projection,
                recentlyClosedTabs: [],
                dirtyTabIds: new Set<string>(),
            } as Partial<EditorWorkspaceStore>);
        },

        insertExternalTab: (tab, index) => {
            set((state) => {
                const incoming = normalizeExternalTab(tab);
                if (!incoming) {
                    return state;
                }
                return (
                    mutateFocusedPaneWorkspace(state, (pane) =>
                        insertNormalizedTab(pane, incoming, index),
                    ) ?? state
                );
            });
        },

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
                if (!state._pendingForceFileReloads.has(relativePath))
                    return state;
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
                if (!state.fileExternalConflicts.has(relativePath))
                    return state;
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
                const noteExternalConflicts = new Set(
                    state.noteExternalConflicts,
                );
                const hadPendingForceReload =
                    pendingForceReloads.delete(noteId);
                const hadExternalConflict =
                    noteExternalConflicts.delete(noteId);
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
                const pendingForceReloads = new Set(
                    state._pendingForceFileReloads,
                );
                const fileExternalConflicts = new Set(
                    state.fileExternalConflicts,
                );
                const hadPendingForceReload =
                    pendingForceReloads.delete(relativePath);
                const hadExternalConflict =
                    fileExternalConflicts.delete(relativePath);
                const hadReloadVersion =
                    relativePath in state._fileReloadVersions;
                const hadReloadMetadata =
                    relativePath in state._fileReloadMetadata;

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

        handleMapDeleted: (relativePath) => {
            set((state) => {
                const next = deleteMapAcrossWorkspace(state, relativePath);
                return next.didChange ? next.projection : state;
            });
        },

        handleMapRenamed: (oldRelativePath, newRelativePath, newTitle) => {
            set((state) => {
                const next = renameMapAcrossWorkspace(
                    state,
                    oldRelativePath,
                    newRelativePath,
                    newTitle,
                );
                return next.didChange ? next.projection : state;
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

        handleNoteConvertedToFile: (
            oldNoteId,
            newRelativePath,
            newTitle,
            newPath,
            mimeType,
            viewer,
        ) => {
            set((state) => {
                const next = convertNoteToFileAcrossWorkspace(
                    state,
                    oldNoteId,
                    newRelativePath,
                    newTitle,
                    newPath,
                    mimeType,
                    viewer,
                );
                if (!next.didChange) {
                    return {
                        ...state,
                        _pendingForceReloads: next.pendingForceReloads,
                        _noteReloadVersions: next.reloadVersions,
                        _noteReloadMetadata: next.reloadMetadata,
                        noteExternalConflicts: next.noteExternalConflicts,
                    };
                }

                return {
                    ...next.projection,
                    _pendingForceReloads: next.pendingForceReloads,
                    _noteReloadVersions: next.reloadVersions,
                    _noteReloadMetadata: next.reloadMetadata,
                    noteExternalConflicts: next.noteExternalConflicts,
                };
            });
        },
    };
}
