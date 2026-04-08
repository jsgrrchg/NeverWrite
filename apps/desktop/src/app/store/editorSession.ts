import {
    isFileTab,
    isGraphTab,
    isHistoryTab,
    isMapTab,
    isNoteTab,
    isPdfTab,
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

const SESSION_KEY = "neverwrite.session.tabs";
const SESSION_KEY_PREFIX = "neverwrite.session.tabs:";

export interface PersistedSession {
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
        content?: string;
        history?: Array<{
            relativePath: string;
            title: string;
            path: string;
            mimeType?: string | null;
            viewer?: FileViewerMode;
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
    tabs: Tab[];
    activeTabId: string | null;
}

export interface RestoredEditorSession {
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
        (session.noteIds.length ||
            session.tabs?.length ||
            session.pdfTabs?.length ||
            session.fileTabs?.length ||
            session.mapTabs?.length ||
            session.hasGraphTab),
    );
}

export function getEditorSessionSignature(state: EditorSessionState) {
    let signature = state.activeTabId ?? "";
    for (const tab of state.tabs) {
        if (isReviewTab(tab)) {
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
    const activeTab =
        state.tabs.find((tab) => tab.id === state.activeTabId) ?? null;
    const normalizedTabs = state.tabs.flatMap((tab) => {
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

    return {
        activeTabId: activeTab?.id ?? null,
        noteIds,
        pdfTabs,
        fileTabs,
        mapTabs,
        hasGraphTab: state.tabs.some((tab) => isGraphTab(tab)),
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
        const viewer =
            entry.viewer ??
            (entry.mimeType?.startsWith("image/") ? "image" : "text");

        if (!content && viewer === "text") {
            try {
                const detail = await vaultInvoke<{ content: string }>(
                    "read_vault_file",
                    { relativePath: entry.relativePath },
                );
                content = detail.content;
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
                },
            ]
        ).map((historyEntry) => ({
            relativePath: historyEntry.relativePath,
            title: historyEntry.title,
            path: historyEntry.path,
            mimeType: historyEntry.mimeType ?? null,
            viewer:
                historyEntry.viewer ??
                (historyEntry.mimeType?.startsWith("image/")
                    ? "image"
                    : "text"),
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
        tabs: restoredTabs,
        activeTabId: session
            ? resolveRestoredActiveTabId(session, restoredTabs, vaultPath)
            : null,
    };
}
