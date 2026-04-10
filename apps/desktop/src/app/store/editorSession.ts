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

const SESSION_KEY = "neverwrite.session.tabs";
const SESSION_KEY_PREFIX = "neverwrite.session.tabs:";

export interface PersistedSessionPane {
    id: string;
    tabs: TabInput[];
    activeTabId: string | null;
    activationHistory?: string[];
    tabNavigationHistory?: string[];
    tabNavigationIndex?: number;
}

export interface PersistedSession {
    panes?: PersistedSessionPane[];
    focusedPaneId?: string | null;
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

export interface EditorSessionState {
    panes?: Array<{
        id: string;
        tabs: Tab[];
        activeTabId: string | null;
        activationHistory: string[];
        tabNavigationHistory: string[];
        tabNavigationIndex: number;
    }>;
    focusedPaneId?: string | null;
    paneSizes?: number[];
    tabs: Tab[];
    activeTabId: string | null;
}

export interface RestoredEditorSession {
    panes?: PersistedSessionPane[];
    focusedPaneId?: string | null;
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

export function hasPersistedSessionData(
    session: PersistedSession | null | undefined,
) {
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

function normalizePersistedTabs(tabs: Tab[]) {
    return tabs.flatMap((tab): TabInput[] => {
        if (!isHistoryTab(tab)) {
            return isGraphTab(tab) || isMapTab(tab) ? [tab] : [];
        }

        const normalized = normalizeHistoryTab(tab);
        return normalized ? [normalized] : [];
    });
}

function buildPersistedPanes(
    state: EditorSessionState,
): PersistedSessionPane[] | undefined {
    if (!state.panes?.length) {
        const tabs = normalizePersistedTabs(state.tabs);
        const activeTabId =
            state.activeTabId &&
            tabs.some((tab) => tab.id === state.activeTabId)
                ? state.activeTabId
                : null;
        return tabs.length > 0 || activeTabId
            ? [
                  {
                      id: "primary",
                      tabs,
                      activeTabId,
                      activationHistory: activeTabId ? [activeTabId] : [],
                      tabNavigationHistory: activeTabId ? [activeTabId] : [],
                      tabNavigationIndex: activeTabId ? 0 : -1,
                  },
              ]
            : undefined;
    }

    const persistedPanes = state.panes
        .map((pane) => ({
            id: pane.id,
            tabs: normalizePersistedTabs(pane.tabs),
            activeTabId:
                pane.activeTabId &&
                pane.tabs.some((tab) => tab.id === pane.activeTabId)
                    ? pane.activeTabId
                    : null,
            activationHistory: pane.activationHistory.filter((tabId) =>
                pane.tabs.some((tab) => tab.id === tabId),
            ),
            tabNavigationHistory: pane.tabNavigationHistory.filter((tabId) =>
                pane.tabs.some((tab) => tab.id === tabId),
            ),
            tabNavigationIndex: pane.tabNavigationIndex,
        }))
        .filter((pane) => pane.id.trim().length > 0);

    if (persistedPanes.some((pane) => pane.tabs.length > 0)) {
        return persistedPanes.filter((pane) => pane.tabs.length > 0);
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
    const normalizedCount = Math.max(1, Math.min(3, Math.floor(count) || 1));
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

export function getEditorSessionSignature(state: EditorSessionState) {
    const panes = buildPersistedPanes(state);
    if (panes?.length) {
        let signature = state.focusedPaneId ?? "";
        const paneSizes = normalizePaneSizesForPersistence(
            panes.length,
            state.paneSizes ?? useLayoutStore.getState().editorPaneSizes,
        );
        signature += `|sizes:${paneSizes.map((value) => value.toFixed(6)).join(",")}`;
        for (const pane of panes) {
            signature += `|pane:${pane.id}:${pane.activeTabId ?? ""}`;
            for (const tab of pane.tabs) {
                if (isGraphTab(tab)) {
                    signature += "|graph";
                    continue;
                }
                if (isHistoryTab(tab)) {
                    const normalized = normalizeHistoryTab(tab);
                    if (!normalized) {
                        continue;
                    }
                    signature += getHistoryTabHandler(
                        normalized.kind,
                    ).fingerprint(normalized as never);
                }
            }
        }
        return signature;
    }

    let signature = state.activeTabId ?? "";
    for (const tab of state.tabs) {
        if (isReviewTab(tab) || isChatTab(tab)) {
            continue;
        }
        if (isGraphTab(tab)) {
            signature += "|graph";
            continue;
        }
        if (isHistoryTab(tab)) {
            const normalized = normalizeHistoryTab(tab);
            if (!normalized) {
                continue;
            }
            signature += getHistoryTabHandler(normalized.kind).fingerprint(
                normalized as never,
            );
        }
    }
    return signature;
}

export function buildPersistedSession(
    state: EditorSessionState,
): PersistedSession {
    const panes = buildPersistedPanes(state);
    const allTabs =
        state.panes?.length && panes?.length
            ? panes.flatMap((pane) => pane.tabs)
            : state.tabs;
    const activeTab =
        state.tabs.find((tab) => tab.id === state.activeTabId) ?? null;
    const normalizedTabs = allTabs.flatMap((tab) => {
        if (!isHistoryTab(tab)) {
            return [];
        }
        const normalized = normalizeHistoryTab(tab);
        return normalized ? [normalized] : [];
    });

    const noteIds: PersistedSession["noteIds"] = [];
    const pdfTabs: NonNullable<PersistedSession["pdfTabs"]> = [];
    const fileTabs: NonNullable<PersistedSession["fileTabs"]> = [];
    const mapTabs: NonNullable<PersistedSession["mapTabs"]> = [];

    for (const tab of normalizedTabs) {
        const serialized = getHistoryTabHandler(tab.kind).serializeForSession(
            tab as never,
        );
        if (isNoteTab(tab)) {
            noteIds.push(serialized as PersistedSession["noteIds"][number]);
            continue;
        }
        if (isPdfTab(tab)) {
            pdfTabs.push(
                serialized as NonNullable<PersistedSession["pdfTabs"]>[number],
            );
            continue;
        }
        if (isMapTab(tab)) {
            mapTabs.push(
                serialized as NonNullable<PersistedSession["mapTabs"]>[number],
            );
            continue;
        }
        fileTabs.push(
            serialized as NonNullable<PersistedSession["fileTabs"]>[number],
        );
    }

    const paneSizes = panes?.length
        ? normalizePaneSizesForPersistence(
              panes.length,
              state.paneSizes ?? useLayoutStore.getState().editorPaneSizes,
          )
        : undefined;

    return {
        panes,
        focusedPaneId: state.focusedPaneId ?? panes?.[0]?.id ?? null,
        paneSizes,
        activeTabId: activeTab?.id ?? null,
        noteIds,
        pdfTabs,
        fileTabs,
        mapTabs,
        hasGraphTab: allTabs.some((tab) => isGraphTab(tab)),
        activeNoteId:
            activeTab && isNoteTab(activeTab) ? activeTab.noteId : null,
        activePdfEntryId:
            activeTab && isPdfTab(activeTab) ? activeTab.entryId : null,
        activeFilePath:
            activeTab && isFileTab(activeTab) ? activeTab.relativePath : null,
        activeMapRelativePath:
            activeTab && isMapTab(activeTab) ? activeTab.relativePath : null,
        activeGraphTab: activeTab ? isGraphTab(activeTab) : false,
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

function restorePersistedPaneTabs(
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
    session: PersistedSession,
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

export async function restorePersistedSession(
    vaultPath: string | null,
    options?: { includeMaps?: boolean },
): Promise<RestoredEditorSession | null> {
    const session = readPersistedSession(vaultPath);
    if (!hasPersistedSessionData(session)) {
        return null;
    }

    if (session?.panes?.length) {
        const restoredPanes = compactRestoredPanes(
            restorePersistedPaneTabs(session.panes),
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
            paneSizes: normalizePaneSizesForPersistence(
                restoredPanes.length,
                session.paneSizes,
            ),
            tabs: focusedPane.tabs,
            activeTabId: focusedPane.activeTabId,
        };
    }

    const restoredTabs: TabInput[] = [];
    if (session?.tabs?.length) {
        restoredTabs.push(...session.tabs);
    } else if (session) {
        restoredTabs.push(...(await restoreLegacyNoteTabs(session)));
        restoredTabs.push(...restoreLegacyPdfTabs(session));
        restoredTabs.push(...(await restoreLegacyFileTabs(session)));
    }

    if (session && options?.includeMaps) {
        restoredTabs.push(
            ...restoreLegacyMapTabs(session, vaultPath, restoredTabs),
        );
    }

    if (session?.hasGraphTab) {
        restoredTabs.push({
            id: crypto.randomUUID(),
            kind: "graph",
            title: "Graph View",
        });
    }

    if (!restoredTabs.length) {
        return null;
    }

    return {
        paneSizes: normalizePaneSizesForPersistence(1, session?.paneSizes),
        tabs: restoredTabs,
        activeTabId: session
            ? resolveRestoredActiveTabId(session, restoredTabs, vaultPath)
            : null,
    };
}
