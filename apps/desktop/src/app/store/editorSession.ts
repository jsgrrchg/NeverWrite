import {
    fileViewerNeedsTextContent,
    isFileTab,
    isGraphTab,
    isHistoryTab,
    isMapTab,
    isNoteTab,
    normalizeFileViewer,
    isPdfTab,
    isChatTab,
    isReviewTab,
    type FileViewerMode,
    type PdfViewMode,
    type Tab,
    type TabInput,
} from "./editorTabs";
import { getHistoryTabHandler, normalizeHistoryTab } from "./editorTabRegistry";
import { safeStorageGetItem, safeStorageSetItem } from "../utils/safeStorage";
import { vaultInvoke } from "../utils/vaultInvoke";
import { toVaultRelativePath } from "../utils/vaultPaths";
import { useLayoutStore } from "./layoutStore";
import { getEffectivePaneWorkspace } from "./editorWorkspace";
import {
    createInitialLayout,
    getLayoutPaneIds,
    normalizeLayoutTree,
    type WorkspaceLayoutNode,
} from "./workspaceLayoutTree";

const SESSION_KEY = "neverwrite.session.tabs";
const SESSION_KEY_PREFIX = "neverwrite.session.tabs:";
export const EDITOR_SESSION_VERSION = 2;

export interface PersistedSessionPane {
    id: string;
    tabs: TabInput[];
    activeTabId: string | null;
    activationHistory?: string[];
    tabNavigationHistory?: string[];
    tabNavigationIndex?: number;
}

export interface PersistedWorkspacePane {
    id: string;
    tabIds: string[];
    activeTabId: string | null;
    activationHistory?: string[];
    tabNavigationHistory?: string[];
    tabNavigationIndex?: number;
}

type PersistedNoteWorkspaceTab = {
    id: string;
    kind: "note";
    noteId: string;
    title: string;
    content?: string;
    history?: Array<{ noteId: string; title: string }>;
    historyIndex?: number;
};

type PersistedPdfWorkspaceTab = {
    id: string;
    kind: "pdf";
    entryId: string;
    title: string;
    path: string;
    page?: number;
    zoom?: number;
    viewMode?: PdfViewMode;
    history?: Array<{
        entryId: string;
        title: string;
        path: string;
        page?: number;
        zoom?: number;
        viewMode?: PdfViewMode;
    }>;
    historyIndex?: number;
};

type PersistedFileWorkspaceTab = {
    id: string;
    kind: "file";
    relativePath: string;
    title: string;
    path: string;
    mimeType?: string | null;
    viewer?: FileViewerMode;
    sizeBytes?: number | null;
    contentTruncated?: boolean;
    content?: string;
    history?: Array<{
        relativePath: string;
        title: string;
        path: string;
        mimeType?: string | null;
        viewer?: FileViewerMode;
        sizeBytes?: number | null;
        contentTruncated?: boolean;
    }>;
    historyIndex?: number;
};

type PersistedMapWorkspaceTab = {
    id: string;
    kind: "map";
    relativePath: string;
    title: string;
    filePath?: string;
};

type PersistedGraphWorkspaceTab = {
    id: string;
    kind: "graph";
    title: string;
};

type PersistedChatWorkspaceTab = {
    id: string;
    kind: "ai-chat";
    sessionId: string;
    title: string;
};

type PersistedWorkspaceTab =
    | PersistedNoteWorkspaceTab
    | PersistedPdfWorkspaceTab
    | PersistedFileWorkspaceTab
    | PersistedMapWorkspaceTab
    | PersistedGraphWorkspaceTab
    | PersistedChatWorkspaceTab;

export interface PersistedSessionV2 {
    version: 2;
    panes: PersistedWorkspacePane[];
    focusedPaneId: string | null;
    layoutTree?: WorkspaceLayoutNode;
    paneSizes?: number[];
    tabsById: Record<string, PersistedWorkspaceTab>;
}

export interface PersistedLegacySession {
    panes?: PersistedSessionPane[];
    focusedPaneId?: string | null;
    layoutTree?: WorkspaceLayoutNode;
    paneSizes?: number[];
    tabs?: TabInput[];
    activeTabId?: string | null;
    noteIds: Array<{
        noteId: string;
        title: string;
        history?: Array<{ noteId: string; title: string }>;
        historyIndex?: number;
    }>;
    pdfTabs?: Array<{
        entryId: string;
        title: string;
        path: string;
        page?: number;
        zoom?: number;
        viewMode?: PdfViewMode;
        history?: Array<{
            entryId: string;
            title: string;
            path: string;
            page?: number;
            zoom?: number;
            viewMode?: PdfViewMode;
        }>;
        historyIndex?: number;
    }>;
    fileTabs?: Array<{
        relativePath: string;
        title: string;
        path: string;
        mimeType?: string | null;
        viewer?: FileViewerMode;
        sizeBytes?: number | null;
        contentTruncated?: boolean;
        content?: string;
        history?: Array<{
            relativePath: string;
            title: string;
            path: string;
            mimeType?: string | null;
            viewer?: FileViewerMode;
            sizeBytes?: number | null;
            contentTruncated?: boolean;
        }>;
        historyIndex?: number;
    }>;
    mapTabs?: Array<{
        relativePath: string;
        title: string;
        filePath?: string;
    }>;
    hasGraphTab?: boolean;
    activeNoteId: string | null;
    activePdfEntryId?: string | null;
    activeFilePath?: string | null;
    activeMapRelativePath?: string | null;
    activeMapFilePath?: string | null;
    activeGraphTab?: boolean;
}

export type PersistedSession = PersistedSessionV2 | PersistedLegacySession;

export interface EditorSessionState {
    panes?: Array<{
        id: string;
        tabs: Tab[];
        tabIds?: string[];
        activeTabId: string | null;
        activationHistory: string[];
        tabNavigationHistory: string[];
        tabNavigationIndex: number;
    }>;
    focusedPaneId?: string | null;
    layoutTree?: WorkspaceLayoutNode;
    paneSizes?: number[];
    tabsById?: Record<string, Tab>;
    tabs: Tab[];
    activeTabId: string | null;
    activationHistory?: string[];
    tabNavigationHistory?: string[];
    tabNavigationIndex?: number;
}

export interface RestoredEditorSession {
    panes?: PersistedSessionPane[];
    focusedPaneId?: string | null;
    layoutTree?: WorkspaceLayoutNode;
    paneSizes?: number[];
    tabs: TabInput[];
    activeTabId: string | null;
}

let sessionReady = false;

export function markSessionReady() {
    sessionReady = true;
}

export function isSessionReady() {
    return sessionReady;
}

export function getEditorSessionKey(vaultPath: string) {
    return `${SESSION_KEY_PREFIX}${vaultPath}`;
}

export function readPersistedSession(
    vaultPath: string | null,
): PersistedSession | null {
    try {
        const raw =
            (vaultPath
                ? safeStorageGetItem(getEditorSessionKey(vaultPath))
                : null) ?? safeStorageGetItem(SESSION_KEY);
        if (!raw) return null;
        return JSON.parse(raw) as PersistedSession;
    } catch {
        return null;
    }
}

export function writePersistedSession(
    vaultPath: string,
    session: PersistedSession,
) {
    safeStorageSetItem(getEditorSessionKey(vaultPath), JSON.stringify(session));
}

function isPersistedSessionV2(
    session: PersistedSession | null | undefined,
): session is PersistedSessionV2 {
    return session?.version === EDITOR_SESSION_VERSION;
}

export function hasPersistedSessionData(
    session: PersistedSession | null | undefined,
) {
    if (isPersistedSessionV2(session)) {
        return Boolean(
            session.panes.length > 0 ||
            Object.keys(session.tabsById).length > 0,
        );
    }

    return Boolean(
        session &&
        (session.panes?.length ||
            session.noteIds.length ||
            session.tabs?.length ||
            session.pdfTabs?.length ||
            session.fileTabs?.length ||
            session.mapTabs?.length ||
            session.hasGraphTab),
    );
}

function serializeWorkspaceTabForSession(
    tab: Tab,
): PersistedWorkspaceTab | null {
    if (isReviewTab(tab)) {
        return null;
    }

    if (isHistoryTab(tab)) {
        const normalized = normalizeHistoryTab(tab);
        if (!normalized) {
            return null;
        }

        const serialized = getHistoryTabHandler(
            normalized.kind,
        ).serializeForSession(normalized as never) as Record<string, unknown>;

        if (isNoteTab(normalized)) {
            return {
                id: normalized.id,
                kind: normalized.kind,
                ...serialized,
                content: normalized.content,
            } as PersistedWorkspaceTab;
        }

        if (isFileTab(normalized)) {
            return {
                id: normalized.id,
                kind: normalized.kind,
                ...serialized,
                content: normalized.content,
            } as PersistedWorkspaceTab;
        }

        return {
            id: normalized.id,
            kind: normalized.kind,
            ...serialized,
        } as PersistedWorkspaceTab;
    }

    if (isChatTab(tab)) {
        return {
            id: tab.id,
            kind: "ai-chat",
            sessionId: tab.sessionId,
            title: tab.title,
        };
    }

    if (isGraphTab(tab)) {
        return {
            id: tab.id,
            kind: "graph",
            title: tab.title,
        };
    }

    return null;
}

function buildPersistedWorkspaceTabsById(
    panes: readonly {
        tabs: Tab[];
    }[],
) {
    const entries = panes.flatMap((pane) =>
        pane.tabs.flatMap((tab) => {
            const serialized = serializeWorkspaceTabForSession(tab);
            return serialized ? ([[serialized.id, serialized]] as const) : [];
        }),
    );

    return Object.fromEntries(entries);
}

function buildPersistedWorkspacePanes(
    state: EditorSessionState,
): PersistedWorkspacePane[] | undefined {
    const workspace = getEffectivePaneWorkspace({
        panes: state.panes ?? [],
        focusedPaneId: state.focusedPaneId ?? null,
        layoutTree: state.layoutTree,
        tabsById: state.tabsById ?? {},
        tabs: state.tabs,
        activeTabId: state.activeTabId,
        activationHistory: state.activationHistory ?? [],
        tabNavigationHistory: state.tabNavigationHistory ?? [],
        tabNavigationIndex: state.tabNavigationIndex ?? -1,
    });
    const tabsById = buildPersistedWorkspaceTabsById(workspace.panes);

    const persistedPanes = workspace.panes
        .map((pane) => ({
            id: pane.id,
            tabIds: pane.tabs
                .map((tab) => tab.id)
                .filter((tabId) => Boolean(tabsById[tabId])),
            activeTabId:
                pane.activeTabId &&
                pane.tabs.some(
                    (tab) =>
                        tab.id === pane.activeTabId &&
                        Boolean(tabsById[tab.id]),
                )
                    ? pane.activeTabId
                    : null,
            activationHistory: pane.activationHistory.filter((tabId) =>
                Boolean(tabsById[tabId]),
            ),
            tabNavigationHistory: pane.tabNavigationHistory.filter((tabId) =>
                Boolean(tabsById[tabId]),
            ),
            tabNavigationIndex: pane.tabNavigationIndex,
        }))
        .filter((pane) => pane.id.trim().length > 0);

    if (persistedPanes.some((pane) => pane.tabIds.length > 0)) {
        return persistedPanes.filter((pane) => pane.tabIds.length > 0);
    }

    if (!persistedPanes.some((pane) => pane.activeTabId)) {
        return undefined;
    }

    return persistedPanes.length > 0 ? [persistedPanes[0]] : undefined;
}

function compactRestoredPanes(panes: PersistedSessionPane[]) {
    if (panes.some((pane) => pane.tabs.length > 0)) {
        return panes.filter((pane) => pane.tabs.length > 0);
    }

    return panes.length > 0 ? [panes[0]] : [];
}

function normalizePaneSizesForPersistence(count: number, paneSizes?: number[]) {
    const normalizedCount = Math.max(1, Math.floor(count) || 1);
    const incoming = (paneSizes ?? []).filter(
        (value) => Number.isFinite(value) && value > 0,
    );

    if (incoming.length === normalizedCount) {
        const total = incoming.reduce((sum, value) => sum + value, 0);
        if (total > 0) {
            return incoming.map((value) => value / total);
        }
    }

    return Array.from({ length: normalizedCount }, () => 1 / normalizedCount);
}

function buildLegacyRowLayoutTree(
    paneIds: readonly string[],
    paneSizes?: readonly number[],
): WorkspaceLayoutNode {
    if (paneIds.length <= 1) {
        return createInitialLayout(paneIds[0] ?? "primary");
    }

    return normalizeLayoutTree({
        type: "split",
        id: "split-1",
        direction: "row",
        children: paneIds.map((paneId) => ({
            type: "pane" as const,
            id: paneId,
            paneId,
        })),
        sizes: normalizePaneSizesForPersistence(paneIds.length, [
            ...(paneSizes ?? []),
        ]),
    });
}

function normalizeLayoutTreeForPersistence(
    layoutTree: WorkspaceLayoutNode | undefined,
    paneIds: readonly string[],
    paneSizes?: readonly number[],
) {
    if (layoutTree) {
        try {
            const normalizedTree = normalizeLayoutTree(layoutTree);
            if (
                JSON.stringify(getLayoutPaneIds(normalizedTree)) ===
                JSON.stringify(paneIds)
            ) {
                return normalizedTree;
            }
        } catch {
            // Fall back to the legacy row migration when persisted tree data is invalid.
        }
    }

    return buildLegacyRowLayoutTree(paneIds, paneSizes);
}

function getLayoutTreeSignature(tree: WorkspaceLayoutNode): string {
    if (tree.type === "pane") {
        return `pane:${tree.paneId}`;
    }

    return `split:${tree.id}:${tree.direction}:${tree.sizes
        .map((size) => size.toFixed(6))
        .join(
            ",",
        )}[${tree.children.map((child) => getLayoutTreeSignature(child)).join("|")}]`;
}

export function getEditorSessionSignature(state: EditorSessionState) {
    return JSON.stringify(buildPersistedSession(state));
}

export function buildPersistedSession(
    state: EditorSessionState,
): PersistedSession {
    const workspace = getEffectivePaneWorkspace({
        panes: state.panes ?? [],
        focusedPaneId: state.focusedPaneId ?? null,
        layoutTree: state.layoutTree,
        tabsById: state.tabsById ?? {},
        tabs: state.tabs,
        activeTabId: state.activeTabId,
        activationHistory: state.activationHistory ?? [],
        tabNavigationHistory: state.tabNavigationHistory ?? [],
        tabNavigationIndex: state.tabNavigationIndex ?? -1,
    });
    const panes = buildPersistedWorkspacePanes(state) ?? [];
    const persistedPaneIds = panes.map((pane) => pane.id);
    const paneSizes =
        persistedPaneIds.length > 1
            ? normalizePaneSizesForPersistence(
                  persistedPaneIds.length,
                  state.paneSizes ?? useLayoutStore.getState().editorPaneSizes,
              )
            : undefined;
    const layoutTree =
        persistedPaneIds.length > 0
            ? normalizeLayoutTreeForPersistence(
                  state.layoutTree,
                  persistedPaneIds,
                  paneSizes,
              )
            : undefined;
    const tabsById = buildPersistedWorkspaceTabsById(workspace.panes);
    const focusedPaneId =
        panes.find((pane) => pane.id === workspace.focusedPaneId)?.id ??
        panes[0]?.id ??
        null;

    return {
        version: EDITOR_SESSION_VERSION,
        panes,
        focusedPaneId,
        layoutTree,
        paneSizes,
        tabsById,
    };
}

function normalizeRestoredTabInput(tab: TabInput): TabInput | null {
    if (isReviewTab(tab) || isChatTab(tab)) {
        return null;
    }
    if (isHistoryTab(tab)) {
        return normalizeHistoryTab(tab);
    }
    if (isGraphTab(tab) || isMapTab(tab)) {
        return tab;
    }
    return null;
}

async function restoreLegacyNoteTabs(session: PersistedSession) {
    const restoredTabs: TabInput[] = [];
    for (const entry of session.noteIds ?? []) {
        try {
            const detail = await vaultInvoke<{ content: string }>("read_note", {
                noteId: entry.noteId,
            });
            const history = (
                entry.history ?? [{ noteId: entry.noteId, title: entry.title }]
            ).map((historyEntry) => ({
                noteId: historyEntry.noteId,
                title: historyEntry.title,
                content: "",
            }));
            const historyIndex = Math.min(
                entry.historyIndex ?? history.length - 1,
                history.length - 1,
            );
            if (history[historyIndex]) {
                history[historyIndex].content = detail.content;
            }
            restoredTabs.push({
                id: crypto.randomUUID(),
                kind: "note",
                noteId: entry.noteId,
                title: entry.title,
                content: detail.content,
                history,
                historyIndex,
            });
        } catch {
            // Deleted note or missing file; skip.
        }
    }
    return restoredTabs;
}

function restoreLegacyPersistedPaneTabs(
    panes: PersistedSessionPane[],
): PersistedSessionPane[] {
    const seenGraph = new Set<string>();

    return panes.map((pane, index) => {
        const tabs = pane.tabs.flatMap((tab): TabInput[] => {
            const normalized = normalizeRestoredTabInput(tab);
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
        const activeTabId =
            pane.activeTabId && tabs.some((tab) => tab.id === pane.activeTabId)
                ? pane.activeTabId
                : (tabs[0]?.id ?? null);

        return {
            id: pane.id || `pane-${index + 1}`,
            tabs,
            activeTabId,
            activationHistory: (pane.activationHistory ?? []).filter((tabId) =>
                tabs.some((tab) => tab.id === tabId),
            ),
            tabNavigationHistory: (pane.tabNavigationHistory ?? []).filter(
                (tabId) => tabs.some((tab) => tab.id === tabId),
            ),
            tabNavigationIndex:
                typeof pane.tabNavigationIndex === "number"
                    ? pane.tabNavigationIndex
                    : activeTabId
                      ? 0
                      : -1,
        };
    });
}

async function restorePersistedWorkspaceTabsById(
    tabsById: Record<string, PersistedWorkspaceTab>,
    vaultPath: string | null,
) {
    const restoredTabsById: Record<string, TabInput> = {};
    const seenGraph = new Set<string>();

    for (const tab of Object.values(tabsById)) {
        if (tab.kind === "ai-chat") {
            restoredTabsById[tab.id] = {
                id: tab.id,
                kind: "ai-chat",
                sessionId: tab.sessionId,
                title: tab.title,
            };
            continue;
        }

        if (tab.kind === "graph") {
            if (seenGraph.size > 0) {
                continue;
            }
            seenGraph.add(tab.id);
            restoredTabsById[tab.id] = {
                id: tab.id,
                kind: "graph",
                title: tab.title,
            };
            continue;
        }

        if (tab.kind === "map") {
            const relativePath =
                tab.relativePath ||
                (tab.filePath
                    ? toVaultRelativePath(tab.filePath, vaultPath)
                    : null);
            if (!relativePath) {
                continue;
            }

            restoredTabsById[tab.id] = {
                id: tab.id,
                kind: "map",
                relativePath,
                title: tab.title,
            };
            continue;
        }

        if (tab.kind === "pdf") {
            restoredTabsById[tab.id] = {
                id: tab.id,
                kind: "pdf",
                entryId: tab.entryId,
                title: tab.title,
                path: tab.path,
                page: tab.page ?? 1,
                zoom: tab.zoom ?? 1,
                viewMode: tab.viewMode ?? "continuous",
                history: tab.history,
                historyIndex: tab.historyIndex,
            };
            continue;
        }

        if (tab.kind === "note") {
            let content = tab.content ?? "";

            if (!content) {
                try {
                    const detail = await vaultInvoke<{ content: string }>(
                        "read_note",
                        {
                            noteId: tab.noteId,
                        },
                    );
                    content = detail.content;
                } catch {
                    content = "";
                }
            }

            if (!content) {
                continue;
            }

            try {
                restoredTabsById[tab.id] = {
                    id: tab.id,
                    kind: "note",
                    noteId: tab.noteId,
                    title: tab.title,
                    content,
                    history: (
                        tab.history ?? [
                            { noteId: tab.noteId, title: tab.title },
                        ]
                    ).map((historyEntry, index, history) => ({
                        kind: "note" as const,
                        noteId: historyEntry.noteId,
                        title: historyEntry.title,
                        content:
                            index ===
                            Math.min(
                                tab.historyIndex ?? history.length - 1,
                                history.length - 1,
                            )
                                ? content
                                : "",
                    })),
                    historyIndex: Math.min(
                        tab.historyIndex ??
                            Math.max(0, (tab.history?.length ?? 1) - 1),
                        Math.max(0, (tab.history?.length ?? 1) - 1),
                    ),
                };
            } catch {
                // Malformed payload; skip.
            }
            continue;
        }

        const viewer = normalizeFileViewer(
            tab.viewer,
            tab.path,
            tab.mimeType ?? null,
        );
        let content = tab.content ?? "";
        let sizeBytes =
            typeof tab.sizeBytes === "number" ? tab.sizeBytes : null;
        let contentTruncated = Boolean(tab.contentTruncated);

        if (!content && fileViewerNeedsTextContent(viewer)) {
            try {
                const detail = await vaultInvoke<{
                    content: string;
                    size_bytes?: number | null;
                    content_truncated?: boolean;
                }>("read_vault_file", {
                    relativePath: tab.relativePath,
                });
                content = detail.content;
                sizeBytes = detail.size_bytes ?? null;
                contentTruncated = Boolean(detail.content_truncated);
            } catch {
                content = "";
            }
        }

        const history = (
            tab.history ?? [
                {
                    relativePath: tab.relativePath,
                    title: tab.title,
                    path: tab.path,
                    mimeType: tab.mimeType ?? null,
                    viewer,
                    sizeBytes,
                    contentTruncated,
                },
            ]
        ).map((historyEntry) => ({
            kind: "file" as const,
            relativePath: historyEntry.relativePath,
            title: historyEntry.title,
            path: historyEntry.path,
            mimeType: historyEntry.mimeType ?? null,
            viewer: normalizeFileViewer(
                historyEntry.viewer,
                historyEntry.path,
                historyEntry.mimeType ?? null,
            ),
            sizeBytes:
                typeof historyEntry.sizeBytes === "number"
                    ? historyEntry.sizeBytes
                    : null,
            contentTruncated: Boolean(historyEntry.contentTruncated),
            content: "",
        }));
        const historyIndex = Math.min(
            tab.historyIndex ?? history.length - 1,
            history.length - 1,
        );
        if (history[historyIndex]) {
            history[historyIndex].content = content;
        }

        restoredTabsById[tab.id] = {
            id: tab.id,
            kind: "file",
            relativePath: tab.relativePath,
            title: tab.title,
            path: tab.path,
            content,
            mimeType: tab.mimeType ?? null,
            viewer,
            sizeBytes,
            contentTruncated,
            history,
            historyIndex,
        };
    }

    return restoredTabsById;
}

function restorePersistedWorkspacePanes(
    panes: PersistedWorkspacePane[],
    tabsById: Record<string, TabInput>,
): PersistedSessionPane[] {
    return panes.map((pane, index) => {
        const tabs = pane.tabIds
            .map((tabId) => tabsById[tabId] ?? null)
            .filter((tab): tab is TabInput => tab !== null);
        const availableTabIds = new Set(tabs.map((tab) => tab.id));
        const activeTabId =
            pane.activeTabId && availableTabIds.has(pane.activeTabId)
                ? pane.activeTabId
                : (tabs[0]?.id ?? null);

        return {
            id: pane.id || `pane-${index + 1}`,
            tabs,
            activeTabId,
            activationHistory: (pane.activationHistory ?? []).filter((tabId) =>
                availableTabIds.has(tabId),
            ),
            tabNavigationHistory: (pane.tabNavigationHistory ?? []).filter(
                (tabId) => availableTabIds.has(tabId),
            ),
            tabNavigationIndex:
                typeof pane.tabNavigationIndex === "number"
                    ? pane.tabNavigationIndex
                    : activeTabId
                      ? 0
                      : -1,
        };
    });
}

function restoreLegacyPdfTabs(session: PersistedSession) {
    return (session.pdfTabs ?? []).map((entry) => {
        const history = (
            entry.history ?? [
                {
                    entryId: entry.entryId,
                    title: entry.title,
                    path: entry.path,
                    page: entry.page ?? 1,
                    zoom: entry.zoom ?? 1,
                    viewMode: entry.viewMode ?? "continuous",
                },
            ]
        ).map((historyEntry) => ({
            entryId: historyEntry.entryId,
            title: historyEntry.title,
            path: historyEntry.path,
            page: historyEntry.page ?? 1,
            zoom: historyEntry.zoom ?? 1,
            viewMode: historyEntry.viewMode ?? "continuous",
        }));
        const historyIndex = Math.min(
            entry.historyIndex ?? history.length - 1,
            history.length - 1,
        );
        const currentEntry = history[historyIndex];
        return {
            id: crypto.randomUUID(),
            kind: "pdf" as const,
            entryId: currentEntry?.entryId ?? entry.entryId,
            title: currentEntry?.title ?? entry.title,
            path: currentEntry?.path ?? entry.path,
            page: currentEntry?.page ?? entry.page ?? 1,
            zoom: currentEntry?.zoom ?? entry.zoom ?? 1,
            viewMode: currentEntry?.viewMode ?? entry.viewMode ?? "continuous",
            history,
            historyIndex,
        };
    });
}

async function restoreLegacyFileTabs(session: PersistedSession) {
    const restoredTabs: TabInput[] = [];
    for (const entry of session.fileTabs ?? []) {
        let content = entry.content ?? "";
        const viewer = normalizeFileViewer(
            entry.viewer,
            entry.path,
            entry.mimeType ?? null,
        );

        if (!content && fileViewerNeedsTextContent(viewer)) {
            try {
                const detail = await vaultInvoke<{
                    content: string;
                    size_bytes?: number | null;
                    content_truncated?: boolean;
                }>("read_vault_file", {
                    relativePath: entry.relativePath,
                });
                content = detail.content;
                entry.sizeBytes = detail.size_bytes ?? null;
                entry.contentTruncated = Boolean(detail.content_truncated);
            } catch {
                content = "";
            }
        }

        const history = (
            entry.history ?? [
                {
                    relativePath: entry.relativePath,
                    title: entry.title,
                    path: entry.path,
                    mimeType: entry.mimeType ?? null,
                    viewer,
                    sizeBytes:
                        typeof entry.sizeBytes === "number"
                            ? entry.sizeBytes
                            : null,
                    contentTruncated: Boolean(entry.contentTruncated),
                },
            ]
        ).map((historyEntry) => ({
            relativePath: historyEntry.relativePath,
            title: historyEntry.title,
            path: historyEntry.path,
            mimeType: historyEntry.mimeType ?? null,
            viewer: normalizeFileViewer(
                historyEntry.viewer,
                historyEntry.path,
                historyEntry.mimeType ?? null,
            ),
            sizeBytes:
                typeof historyEntry.sizeBytes === "number"
                    ? historyEntry.sizeBytes
                    : null,
            contentTruncated: Boolean(historyEntry.contentTruncated),
            content: "",
        }));
        const historyIndex = Math.min(
            entry.historyIndex ?? history.length - 1,
            history.length - 1,
        );
        if (history[historyIndex]) {
            history[historyIndex].content = content;
        }

        restoredTabs.push({
            id: crypto.randomUUID(),
            kind: "file",
            relativePath: entry.relativePath,
            title: entry.title,
            path: entry.path,
            mimeType: entry.mimeType ?? null,
            viewer,
            content,
            sizeBytes:
                typeof entry.sizeBytes === "number" ? entry.sizeBytes : null,
            contentTruncated: Boolean(entry.contentTruncated),
            history,
            historyIndex,
        });
    }
    return restoredTabs;
}

function restoreLegacyMapTabs(
    session: PersistedSession,
    vaultPath: string | null,
    existingTabs: TabInput[],
) {
    const restoredTabs: TabInput[] = [];
    for (const entry of session.mapTabs ?? []) {
        const relativePath =
            entry.relativePath ||
            (entry.filePath
                ? toVaultRelativePath(entry.filePath, vaultPath)
                : null);
        if (!relativePath) {
            continue;
        }
        if (
            existingTabs.some(
                (tab) => isMapTab(tab) && tab.relativePath === relativePath,
            ) ||
            restoredTabs.some(
                (tab) => isMapTab(tab) && tab.relativePath === relativePath,
            )
        ) {
            continue;
        }
        restoredTabs.push({
            id: crypto.randomUUID(),
            kind: "map",
            relativePath,
            title: entry.title,
        });
    }
    return restoredTabs;
}

function resolveRestoredActiveTabId(
    session: PersistedLegacySession,
    tabs: TabInput[],
    vaultPath: string | null,
) {
    if (session.activeGraphTab) {
        const activeGraph = tabs.find((tab) => isGraphTab(tab));
        if (activeGraph) return activeGraph.id;
    }

    const activeLegacyMapRelativePath = session.activeMapFilePath
        ? toVaultRelativePath(session.activeMapFilePath, vaultPath)
        : null;
    if (session.activeMapRelativePath) {
        const activeMap = tabs.find(
            (tab) =>
                isMapTab(tab) &&
                tab.relativePath === session.activeMapRelativePath,
        );
        if (activeMap) return activeMap.id;
    }
    if (activeLegacyMapRelativePath) {
        const activeMap = tabs.find(
            (tab) =>
                isMapTab(tab) &&
                tab.relativePath === activeLegacyMapRelativePath,
        );
        if (activeMap) return activeMap.id;
    }
    if (session.activePdfEntryId) {
        const activePdf = tabs.find(
            (tab) => isPdfTab(tab) && tab.entryId === session.activePdfEntryId,
        );
        if (activePdf) return activePdf.id;
    }
    if (session.activeNoteId) {
        const activeNote = tabs.find(
            (tab) => isNoteTab(tab) && tab.noteId === session.activeNoteId,
        );
        if (activeNote) return activeNote.id;
    }
    if (session.activeFilePath) {
        const activeFile = tabs.find(
            (tab) =>
                isFileTab(tab) && tab.relativePath === session.activeFilePath,
        );
        if (activeFile) return activeFile.id;
    }
    return null;
}

function buildNormalizedPersistedSessionFromRestored(
    restored: RestoredEditorSession,
): PersistedSessionV2 {
    const panes =
        restored.panes && restored.panes.length > 0
            ? restored.panes
            : [
                  {
                      id: "primary",
                      tabs: restored.tabs,
                      activeTabId: restored.activeTabId,
                      activationHistory: restored.activeTabId
                          ? [restored.activeTabId]
                          : [],
                      tabNavigationHistory: restored.activeTabId
                          ? [restored.activeTabId]
                          : [],
                      tabNavigationIndex: restored.activeTabId ? 0 : -1,
                  },
              ];

    return buildPersistedSession({
        panes: panes.map((pane) => ({
            id: pane.id,
            tabs: pane.tabs.flatMap((tab) => {
                const normalized = normalizeHydratedSessionTab(tab);
                return normalized ? [normalized] : [];
            }),
            activeTabId: pane.activeTabId,
            activationHistory: pane.activationHistory ?? [],
            tabNavigationHistory: pane.tabNavigationHistory ?? [],
            tabNavigationIndex: pane.tabNavigationIndex ?? -1,
        })),
        focusedPaneId: restored.focusedPaneId ?? panes[0]?.id ?? null,
        layoutTree: restored.layoutTree,
        paneSizes: restored.paneSizes,
        tabs: panes.flatMap((pane) =>
            pane.tabs.flatMap((tab) => {
                const normalized = normalizeHydratedSessionTab(tab);
                return normalized ? [normalized] : [];
            }),
        ),
        activeTabId: restored.activeTabId,
        tabsById: Object.fromEntries(
            panes.flatMap((pane) =>
                pane.tabs.flatMap((tab) => {
                    const normalized = normalizeHydratedSessionTab(tab);
                    return normalized
                        ? ([[normalized.id, normalized]] as const)
                        : [];
                }),
            ),
        ),
    }) as PersistedSessionV2;
}

function normalizeHydratedSessionTab(tab: TabInput): Tab | null {
    if (isReviewTab(tab)) {
        return null;
    }
    if (isHistoryTab(tab)) {
        return normalizeHistoryTab(tab);
    }
    if (isChatTab(tab) || isGraphTab(tab)) {
        return tab;
    }
    return null;
}

async function upgradeLegacyPersistedSession(
    session: PersistedLegacySession,
    vaultPath: string | null,
    options?: { includeMaps?: boolean },
): Promise<PersistedSessionV2 | null> {
    if (session.panes?.length) {
        const restoredPanes = compactRestoredPanes(
            restoreLegacyPersistedPaneTabs(session.panes),
        );
        const restoredLayoutTree = normalizeLayoutTreeForPersistence(
            session.layoutTree,
            restoredPanes.map((pane) => pane.id),
            session.paneSizes,
        );
        const requestedFocusedPaneId =
            typeof session.focusedPaneId === "string"
                ? session.focusedPaneId
                : (restoredPanes[0]?.id ?? null);
        const focusedPane =
            restoredPanes.find((pane) => pane.id === requestedFocusedPaneId) ??
            restoredPanes[0] ??
            null;

        if (!focusedPane) {
            return null;
        }

        return buildNormalizedPersistedSessionFromRestored({
            panes: restoredPanes,
            focusedPaneId: focusedPane.id,
            layoutTree: restoredLayoutTree,
            paneSizes: normalizePaneSizesForPersistence(
                restoredPanes.length,
                session.paneSizes,
            ),
            tabs: focusedPane.tabs,
            activeTabId: focusedPane.activeTabId,
        });
    }

    const restoredTabs: TabInput[] = [];
    if (session.tabs?.length) {
        restoredTabs.push(...session.tabs);
    } else {
        restoredTabs.push(...(await restoreLegacyNoteTabs(session)));
        restoredTabs.push(...restoreLegacyPdfTabs(session));
        restoredTabs.push(...(await restoreLegacyFileTabs(session)));
    }

    if (options?.includeMaps) {
        restoredTabs.push(
            ...restoreLegacyMapTabs(session, vaultPath, restoredTabs),
        );
    }

    if (session.hasGraphTab) {
        restoredTabs.push({
            id: crypto.randomUUID(),
            kind: "graph",
            title: "Graph View",
        });
    }

    if (!restoredTabs.length) {
        return null;
    }

    return buildNormalizedPersistedSessionFromRestored({
        paneSizes: normalizePaneSizesForPersistence(1, session.paneSizes),
        tabs: restoredTabs,
        activeTabId: resolveRestoredActiveTabId(
            session,
            restoredTabs,
            vaultPath,
        ),
    });
}

export async function restorePersistedSession(
    vaultPath: string | null,
    options?: { includeMaps?: boolean },
): Promise<RestoredEditorSession | null> {
    const storedSession = readPersistedSession(vaultPath);
    if (!hasPersistedSessionData(storedSession)) {
        return null;
    }

    const session = isPersistedSessionV2(storedSession)
        ? storedSession
        : await upgradeLegacyPersistedSession(
              storedSession,
              vaultPath,
              options,
          );

    if (!session) {
        return null;
    }

    if (!isPersistedSessionV2(storedSession) && vaultPath) {
        writePersistedSession(vaultPath, session);
    }

    if (session.panes.length) {
        const restoredTabsById = await restorePersistedWorkspaceTabsById(
            session.tabsById,
            vaultPath,
        );
        const restoredPanes = compactRestoredPanes(
            restorePersistedWorkspacePanes(session.panes, restoredTabsById),
        );
        const restoredLayoutTree = normalizeLayoutTreeForPersistence(
            session.layoutTree,
            restoredPanes.map((pane) => pane.id),
            session.paneSizes,
        );
        const requestedFocusedPaneId =
            typeof session.focusedPaneId === "string"
                ? session.focusedPaneId
                : (restoredPanes[0]?.id ?? null);
        const focusedPane =
            restoredPanes.find((pane) => pane.id === requestedFocusedPaneId) ??
            restoredPanes[0] ??
            null;

        if (!focusedPane) {
            return null;
        }

        return {
            panes: restoredPanes,
            focusedPaneId: focusedPane.id,
            layoutTree: restoredLayoutTree,
            paneSizes: normalizePaneSizesForPersistence(
                restoredPanes.length,
                session.paneSizes,
            ),
            tabs: focusedPane.tabs,
            activeTabId: focusedPane.activeTabId,
        };
    }

    const restoredTabsById = await restorePersistedWorkspaceTabsById(
        session.tabsById,
        vaultPath,
    );
    const restoredTabs = Object.values(restoredTabsById);
    if (!restoredTabs.length) {
        return null;
    }

    return {
        paneSizes: normalizePaneSizesForPersistence(1, session.paneSizes),
        tabs: restoredTabs,
        activeTabId: restoredTabs[0]?.id ?? null,
    };
}
