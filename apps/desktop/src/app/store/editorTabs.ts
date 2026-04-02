import { toVaultRelativePath } from "../utils/vaultPaths";
import { useVaultStore } from "./vaultStore";

export type PdfViewMode = "single" | "continuous";
export type FileViewerMode = "text" | "image";

export interface NoteHistoryEntry {
    kind: "note";
    noteId: string;
    title: string;
    content: string;
}

export interface PdfHistoryEntry {
    kind: "pdf";
    entryId: string;
    title: string;
    path: string;
    page: number;
    zoom: number;
    viewMode: PdfViewMode;
}

export interface FileHistoryEntry {
    kind: "file";
    relativePath: string;
    title: string;
    path: string;
    content: string;
    mimeType: string | null;
    viewer: FileViewerMode;
}

export interface MapHistoryEntry {
    kind: "map";
    relativePath: string;
    title: string;
    filePath?: string;
}

export type TabHistoryEntry =
    | NoteHistoryEntry
    | PdfHistoryEntry
    | FileHistoryEntry
    | MapHistoryEntry;

export type NoteHistoryEntryInput = Omit<
    NoteHistoryEntry,
    "kind" | "content"
> & {
    kind?: "note";
    content?: string;
};

export type PdfHistoryEntryInput = Omit<
    PdfHistoryEntry,
    "kind" | "page" | "zoom" | "viewMode"
> & {
    kind?: "pdf";
    page?: number;
    zoom?: number;
    viewMode?: PdfViewMode;
};

export type FileHistoryEntryInput = Omit<
    FileHistoryEntry,
    "kind" | "content" | "mimeType" | "viewer"
> & {
    kind?: "file";
    content?: string;
    mimeType?: string | null;
    viewer?: FileViewerMode;
};

export type MapHistoryEntryInput = Omit<MapHistoryEntry, "kind"> & {
    kind?: "map";
};

export type TabHistoryEntryInput =
    | NoteHistoryEntryInput
    | PdfHistoryEntryInput
    | FileHistoryEntryInput
    | MapHistoryEntryInput;

export interface NoteTab {
    id: string;
    kind: "note";
    noteId: string;
    title: string;
    content: string;
    history: TabHistoryEntry[];
    historyIndex: number;
}

export interface PdfTab {
    id: string;
    kind: "pdf";
    entryId: string;
    title: string;
    path: string;
    page: number;
    zoom: number;
    viewMode: PdfViewMode;
    history: TabHistoryEntry[];
    historyIndex: number;
}

export interface FileTab {
    id: string;
    kind: "file";
    relativePath: string;
    path: string;
    title: string;
    content: string;
    mimeType: string | null;
    viewer: FileViewerMode;
    history: TabHistoryEntry[];
    historyIndex: number;
}

export interface ReviewTab {
    id: string;
    kind: "ai-review";
    sessionId: string;
    title: string;
}

export interface MapTab {
    id: string;
    kind: "map";
    relativePath: string;
    title: string;
    history: TabHistoryEntry[];
    historyIndex: number;
}

export interface GraphTab {
    id: string;
    kind: "graph";
    title: string;
}

export type Tab = NoteTab | PdfTab | FileTab | ReviewTab | MapTab | GraphTab;

export type NoteTabInput = Omit<
    NoteTab,
    "kind" | "history" | "historyIndex"
> & {
    kind?: "note";
    history?: TabHistoryEntryInput[];
    historyIndex?: number;
};

export type PdfTabInput = Omit<
    PdfTab,
    "kind" | "history" | "historyIndex" | "page" | "zoom" | "viewMode"
> & {
    kind?: "pdf";
    page?: number;
    zoom?: number;
    viewMode?: PdfViewMode;
    history?: TabHistoryEntryInput[];
    historyIndex?: number;
};

export type FileTabInput = Omit<
    FileTab,
    "kind" | "history" | "historyIndex" | "mimeType" | "viewer"
> & {
    kind?: "file";
    mimeType?: string | null;
    viewer?: FileViewerMode;
    history?: TabHistoryEntryInput[];
    historyIndex?: number;
};

export type MapTabInput = Omit<MapTab, "kind" | "history" | "historyIndex"> & {
    kind?: "map";
    history?: TabHistoryEntryInput[];
    historyIndex?: number;
};

export type TabInput =
    | NoteTabInput
    | PdfTabInput
    | FileTabInput
    | ReviewTab
    | MapTabInput
    | GraphTab;

export type HistoryTab = NoteTab | PdfTab | FileTab | MapTab;
export type NavigableHistoryTab = NoteTab | PdfTab | FileTab;
export type HistoryTabInput =
    | NoteTabInput
    | PdfTabInput
    | FileTabInput
    | MapTabInput;
export type NavigableHistoryTabInput =
    | NoteTabInput
    | PdfTabInput
    | FileTabInput;
export type TransientTab = ReviewTab | GraphTab;
export type ResourceBackedTab = NoteTab | FileTab;
export type TabCloseReason =
    | "user"
    | "bulk-user"
    | "delete"
    | "cleanup"
    | "detach"
    | "stale-doc"
    | "dispatch-failed";

export interface RecentlyClosedTab {
    tab: Tab;
    index: number;
}

type AnyTabLike = Tab | TabInput;

function inferTabKind(tab: AnyTabLike | null | undefined): Tab["kind"] | null {
    if (!tab) return null;
    if ("kind" in tab && typeof tab.kind === "string") {
        return tab.kind;
    }
    if ("noteId" in tab) return "note";
    if ("entryId" in tab) return "pdf";
    if ("sessionId" in tab) return "ai-review";
    if (
        "path" in tab ||
        "mimeType" in tab ||
        "viewer" in tab ||
        "content" in tab
    ) {
        return "file";
    }
    if ("relativePath" in tab || "filePath" in tab) {
        return "map";
    }
    return null;
}

export function isNoteTab(tab: Tab | null | undefined): tab is NoteTab;
export function isNoteTab(
    tab: TabInput | null | undefined,
): tab is NoteTabInput;
export function isNoteTab(
    tab: Tab | TabInput | null | undefined,
): tab is NoteTab | NoteTabInput {
    return inferTabKind(tab) === "note";
}

export function isPdfTab(tab: Tab | null | undefined): tab is PdfTab;
export function isPdfTab(tab: TabInput | null | undefined): tab is PdfTabInput;
export function isPdfTab(
    tab: Tab | TabInput | null | undefined,
): tab is PdfTab | PdfTabInput {
    return inferTabKind(tab) === "pdf";
}

export function isFileTab(tab: Tab | null | undefined): tab is FileTab;
export function isFileTab(
    tab: TabInput | null | undefined,
): tab is FileTabInput;
export function isFileTab(
    tab: Tab | TabInput | null | undefined,
): tab is FileTab | FileTabInput {
    return inferTabKind(tab) === "file";
}

export function isReviewTab(tab: Tab | null | undefined): tab is ReviewTab;
export function isReviewTab(tab: TabInput | null | undefined): tab is ReviewTab;
export function isReviewTab(
    tab: Tab | TabInput | null | undefined,
): tab is ReviewTab {
    return inferTabKind(tab) === "ai-review";
}

export function isMapTab(tab: Tab | null | undefined): tab is MapTab;
export function isMapTab(tab: TabInput | null | undefined): tab is MapTabInput;
export function isMapTab(
    tab: Tab | TabInput | null | undefined,
): tab is MapTab | MapTabInput {
    return inferTabKind(tab) === "map";
}

export function isGraphTab(tab: Tab | null | undefined): tab is GraphTab;
export function isGraphTab(tab: TabInput | null | undefined): tab is GraphTab;
export function isGraphTab(
    tab: Tab | TabInput | null | undefined,
): tab is GraphTab {
    return inferTabKind(tab) === "graph";
}

export function isHistoryTab(tab: Tab | null | undefined): tab is HistoryTab;
export function isHistoryTab(
    tab: TabInput | null | undefined,
): tab is HistoryTabInput;
export function isHistoryTab(
    tab: Tab | TabInput | null | undefined,
): tab is HistoryTab | HistoryTabInput {
    const kind = inferTabKind(tab);
    return (
        kind === "note" || kind === "pdf" || kind === "file" || kind === "map"
    );
}

export function isNavigableHistoryTab(
    tab: Tab | null | undefined,
): tab is NavigableHistoryTab;
export function isNavigableHistoryTab(
    tab: TabInput | null | undefined,
): tab is NavigableHistoryTabInput;
export function isNavigableHistoryTab(
    tab: Tab | TabInput | null | undefined,
): tab is NavigableHistoryTab | NavigableHistoryTabInput {
    const kind = inferTabKind(tab);
    return kind === "note" || kind === "pdf" || kind === "file";
}

export function isTransientTab(
    tab: Tab | null | undefined,
): tab is TransientTab;
export function isTransientTab(
    tab: TabInput | null | undefined,
): tab is TransientTab;
export function isTransientTab(
    tab: Tab | TabInput | null | undefined,
): tab is TransientTab {
    const kind = inferTabKind(tab);
    return kind === "ai-review" || kind === "graph";
}

export function isResourceBackedTab(
    tab: Tab | null | undefined,
): tab is ResourceBackedTab;
export function isResourceBackedTab(
    tab: TabInput | null | undefined,
): tab is NoteTabInput | FileTabInput;
export function isResourceBackedTab(
    tab: Tab | TabInput | null | undefined,
): tab is ResourceBackedTab | NoteTabInput | FileTabInput {
    const kind = inferTabKind(tab);
    return kind === "note" || kind === "file";
}

export function createNoteHistoryEntry(
    noteId: string,
    title: string,
    content: string,
): NoteHistoryEntry {
    return {
        kind: "note",
        noteId,
        title,
        content,
    };
}

export function createPdfHistoryEntry(
    entryId: string,
    title: string,
    path: string,
    page: number,
    zoom: number,
    viewMode: PdfViewMode,
): PdfHistoryEntry {
    return {
        kind: "pdf",
        entryId,
        title,
        path,
        page,
        zoom,
        viewMode,
    };
}

export function createFileHistoryEntry(
    relativePath: string,
    title: string,
    path: string,
    content: string,
    mimeType: string | null,
    viewer: FileViewerMode,
): FileHistoryEntry {
    return {
        kind: "file",
        relativePath,
        title,
        path,
        content,
        mimeType,
        viewer,
    };
}

export function createMapHistoryEntry(
    relativePath: string,
    title: string,
): MapHistoryEntry {
    return {
        kind: "map",
        relativePath,
        title,
    };
}

function inferHistoryEntryKind(
    entry: TabHistoryEntryInput,
    fallbackKind: "note" | "pdf" | "file" | "map",
) {
    if (entry.kind) return entry.kind;
    if ("noteId" in entry) return "note";
    if ("entryId" in entry) return "pdf";
    if (fallbackKind === "map") return "map";
    if ("relativePath" in entry) return "file";
    return fallbackKind;
}

export function normalizeHistoryEntry(
    entry: TabHistoryEntryInput,
    fallbackKind: "note" | "pdf" | "file" | "map",
): TabHistoryEntry {
    const kind = inferHistoryEntryKind(entry, fallbackKind);

    if (kind === "note") {
        return createNoteHistoryEntry(
            "noteId" in entry ? entry.noteId : "",
            entry.title,
            "content" in entry ? (entry.content ?? "") : "",
        );
    }

    if (kind === "pdf") {
        return createPdfHistoryEntry(
            "entryId" in entry ? entry.entryId : "",
            entry.title,
            "path" in entry ? entry.path : "",
            "page" in entry ? (entry.page ?? 1) : 1,
            "zoom" in entry ? (entry.zoom ?? 1) : 1,
            "viewMode" in entry
                ? (entry.viewMode ?? "continuous")
                : "continuous",
        );
    }

    if (kind === "map") {
        return createMapHistoryEntry(
            "relativePath" in entry ? entry.relativePath : "",
            entry.title,
        );
    }

    const path = "path" in entry ? entry.path : "";
    const mimeType = "mimeType" in entry ? (entry.mimeType ?? null) : null;

    return createFileHistoryEntry(
        "relativePath" in entry ? entry.relativePath : "",
        entry.title,
        path,
        "content" in entry ? (entry.content ?? "") : "",
        mimeType,
        "viewer" in entry
            ? (entry.viewer ?? inferFileViewer(path, mimeType))
            : inferFileViewer(path, mimeType),
    );
}

export function createHistoryEntryFromTab(tab: HistoryTab): TabHistoryEntry {
    if (isPdfTab(tab)) {
        return createPdfHistoryEntry(
            tab.entryId,
            tab.title,
            tab.path,
            tab.page,
            tab.zoom,
            tab.viewMode,
        );
    }

    if (isFileTab(tab)) {
        return createFileHistoryEntry(
            tab.relativePath,
            tab.title,
            tab.path,
            tab.content,
            tab.mimeType,
            tab.viewer,
        );
    }

    if (isMapTab(tab)) {
        return createMapHistoryEntry(tab.relativePath, tab.title);
    }

    return createNoteHistoryEntry(tab.noteId, tab.title, tab.content);
}

export function buildTabFromHistory(
    id: string,
    history: TabHistoryEntry[],
    historyIndex: number,
): HistoryTab {
    const safeIndex = Math.max(0, Math.min(historyIndex, history.length - 1));
    const entry = history[safeIndex];

    if (entry.kind === "pdf") {
        return {
            id,
            kind: "pdf",
            entryId: entry.entryId,
            title: entry.title,
            path: entry.path,
            page: entry.page,
            zoom: entry.zoom,
            viewMode: entry.viewMode,
            history,
            historyIndex: safeIndex,
        };
    }

    if (entry.kind === "file") {
        return {
            id,
            kind: "file",
            relativePath: entry.relativePath,
            title: entry.title,
            path: entry.path,
            content: entry.content,
            mimeType: entry.mimeType,
            viewer: entry.viewer,
            history,
            historyIndex: safeIndex,
        };
    }

    if (entry.kind === "map") {
        return {
            id,
            kind: "map",
            relativePath: entry.relativePath,
            title: entry.title,
            history,
            historyIndex: safeIndex,
        };
    }

    return {
        id,
        kind: "note",
        noteId: entry.noteId,
        title: entry.title,
        content: entry.content,
        history,
        historyIndex: safeIndex,
    };
}

export function createNoteTab(
    noteId: string,
    title: string,
    content: string,
): NoteTab {
    return {
        id: crypto.randomUUID(),
        kind: "note",
        noteId,
        title,
        content,
        history: [createNoteHistoryEntry(noteId, title, content)],
        historyIndex: 0,
    };
}

export function createPdfTab(
    entryId: string,
    title: string,
    path: string,
): PdfTab {
    return {
        id: crypto.randomUUID(),
        kind: "pdf",
        entryId,
        title,
        path,
        page: 1,
        zoom: 1,
        viewMode: "continuous",
        history: [
            createPdfHistoryEntry(entryId, title, path, 1, 1, "continuous"),
        ],
        historyIndex: 0,
    };
}

export function createFileTab(
    relativePath: string,
    title: string,
    path: string,
    content: string,
    mimeType: string | null,
    viewer: FileViewerMode,
): FileTab {
    return {
        id: crypto.randomUUID(),
        kind: "file",
        relativePath,
        title,
        path,
        content,
        mimeType,
        viewer,
        history: [
            createFileHistoryEntry(
                relativePath,
                title,
                path,
                content,
                mimeType,
                viewer,
            ),
        ],
        historyIndex: 0,
    };
}

export function createMapTab(relativePath: string, title: string): MapTab {
    return {
        id: crypto.randomUUID(),
        kind: "map",
        relativePath,
        title,
        history: [],
        historyIndex: -1,
    };
}

export function createGraphTab(): GraphTab {
    return {
        id: crypto.randomUUID(),
        kind: "graph",
        title: "Graph View",
    };
}

export function ensureMapTabDefaults(tab: MapTabInput): MapTab {
    const relativePath =
        tab.relativePath ||
        ("filePath" in tab && typeof tab.filePath === "string"
            ? (toVaultRelativePath(
                  tab.filePath,
                  useVaultStore.getState().vaultPath,
              ) ?? "")
            : "");

    return {
        id: tab.id,
        kind: "map",
        relativePath,
        title: tab.title,
        history:
            tab.history?.map((entry) => normalizeHistoryEntry(entry, "map")) ??
            [],
        historyIndex: tab.historyIndex ?? -1,
    };
}

export function ensurePdfTabDefaults(tab: PdfTabInput): PdfTab {
    if (tab.history && tab.history.length > 0) {
        const history = tab.history.map((entry) =>
            normalizeHistoryEntry(entry, "pdf"),
        );
        const historyIndex = Math.max(
            0,
            Math.min(
                tab.historyIndex ?? history.length - 1,
                history.length - 1,
            ),
        );
        history[historyIndex] = createPdfHistoryEntry(
            tab.entryId,
            tab.title,
            tab.path,
            tab.page ?? 1,
            tab.zoom ?? 1,
            tab.viewMode ?? "continuous",
        );
        return buildTabFromHistory(tab.id, history, historyIndex) as PdfTab;
    }

    return buildTabFromHistory(
        tab.id,
        [
            createPdfHistoryEntry(
                tab.entryId,
                tab.title,
                tab.path,
                tab.page ?? 1,
                tab.zoom ?? 1,
                tab.viewMode ?? "continuous",
            ),
        ],
        0,
    ) as PdfTab;
}

export function ensureFileTabHistory(tab: FileTabInput): FileTab {
    if (tab.history && tab.history.length > 0) {
        const history = tab.history.map((entry) =>
            normalizeHistoryEntry(entry, "file"),
        );
        const historyIndex = Math.max(
            0,
            Math.min(
                tab.historyIndex ?? history.length - 1,
                history.length - 1,
            ),
        );
        history[historyIndex] = createFileHistoryEntry(
            tab.relativePath,
            tab.title,
            tab.path,
            tab.content,
            tab.mimeType ?? null,
            tab.viewer ?? inferFileViewer(tab.path, tab.mimeType ?? null),
        );
        return buildTabFromHistory(tab.id, history, historyIndex) as FileTab;
    }

    const viewer =
        tab.viewer ?? inferFileViewer(tab.path, tab.mimeType ?? null);

    return buildTabFromHistory(
        tab.id,
        [
            createFileHistoryEntry(
                tab.relativePath,
                tab.title,
                tab.path,
                tab.content,
                tab.mimeType ?? null,
                viewer,
            ),
        ],
        0,
    ) as FileTab;
}

export function ensureFileTabDefaults(tab: FileTabInput): FileTab {
    return {
        ...ensureFileTabHistory(tab),
        mimeType: tab.mimeType ?? null,
        viewer: tab.viewer ?? inferFileViewer(tab.path, tab.mimeType ?? null),
    };
}

export function inferFileViewer(
    path: string,
    mimeType: string | null,
): FileViewerMode {
    const extension = path.split(".").pop()?.toLowerCase() ?? "";
    if (mimeType?.startsWith("image/")) return "image";
    if (
        extension === "png" ||
        extension === "jpg" ||
        extension === "jpeg" ||
        extension === "jpe" ||
        extension === "jfif" ||
        extension === "gif" ||
        extension === "webp" ||
        extension === "svg" ||
        extension === "avif" ||
        extension === "bmp" ||
        extension === "ico"
    ) {
        return "image";
    }
    return "text";
}

export function ensureNoteTabHistory(tab: NoteTabInput): NoteTab {
    if (tab.history && tab.history.length > 0) {
        const history = tab.history.map((entry) =>
            normalizeHistoryEntry(entry, "note"),
        );
        const historyIndex = Math.max(
            0,
            Math.min(
                tab.historyIndex ?? history.length - 1,
                history.length - 1,
            ),
        );
        history[historyIndex] = createNoteHistoryEntry(
            tab.noteId,
            tab.title,
            tab.content,
        );
        return buildTabFromHistory(tab.id, history, historyIndex) as NoteTab;
    }
    return buildTabFromHistory(
        tab.id,
        [createNoteHistoryEntry(tab.noteId, tab.title, tab.content)],
        0,
    ) as NoteTab;
}
