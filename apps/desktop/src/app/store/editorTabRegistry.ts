import {
    buildTabFromHistory,
    createFileHistoryEntry,
    createFileTab,
    createHistoryEntryFromTab,
    createNoteHistoryEntry,
    createNoteTab,
    createPdfHistoryEntry,
    createPdfTab,
    ensureFileTabDefaults,
    ensureMapTabDefaults,
    ensureNoteTabHistory,
    ensurePdfTabDefaults,
    isFileTab,
    isNoteTab,
    isPdfTab,
    type FileHistoryEntry,
    type FileTab,
    type FileTabInput,
    type FileViewerMode,
    type HistoryTab,
    type HistoryTabInput,
    type MapHistoryEntry,
    type MapTab,
    type MapTabInput,
    type NoteHistoryEntry,
    type NoteTab,
    type NoteTabInput,
    type PdfHistoryEntry,
    type PdfTab,
    type PdfTabInput,
    type TabHistoryEntry,
} from "./editorTabs";

interface HistoryTabByKindMap {
    note: NoteTab;
    pdf: PdfTab;
    file: FileTab;
    map: MapTab;
}

interface HistoryTabInputByKindMap {
    note: NoteTabInput;
    pdf: PdfTabInput;
    file: FileTabInput;
    map: MapTabInput;
}

interface HistoryEntryByKindMap {
    note: NoteHistoryEntry;
    pdf: PdfHistoryEntry;
    file: FileHistoryEntry;
    map: MapHistoryEntry;
}

interface OpenPayloadByKindMap {
    note: {
        kind: "note";
        noteId: string;
        title: string;
        content: string;
    };
    pdf: {
        kind: "pdf";
        entryId: string;
        title: string;
        path: string;
    };
    file: {
        kind: "file";
        relativePath: string;
        title: string;
        path: string;
        content: string;
        mimeType: string | null;
        viewer: FileViewerMode;
        sizeBytes?: number | null;
        contentTruncated?: boolean;
    };
    map: {
        kind: "map";
        relativePath: string;
        title: string;
    };
}

export type HistoryTabKind = keyof HistoryTabByKindMap;
export type OpenableHistoryTabKind = Exclude<HistoryTabKind, "map">;
export type HistoryTabByKind<K extends HistoryTabKind> = HistoryTabByKindMap[K];
export type HistoryTabInputByKind<K extends HistoryTabKind> =
    HistoryTabInputByKindMap[K];
export type HistoryEntryByKind<K extends HistoryTabKind> =
    HistoryEntryByKindMap[K];
export type HistoryOpenPayload<K extends HistoryTabKind> =
    OpenPayloadByKindMap[K];
export type OpenableHistoryPayload = HistoryOpenPayload<OpenableHistoryTabKind>;

export interface HistoryTabHandler<K extends HistoryTabKind> {
    kind: K;
    normalizeTab: (input: HistoryTabInputByKind<K>) => HistoryTabByKind<K>;
    createInitialTab: (payload: HistoryOpenPayload<K>) => HistoryTabByKind<K>;
    createOpenEntry: (payload: HistoryOpenPayload<K>) => HistoryEntryByKind<K>;
    entryFromTab: (tab: HistoryTabByKind<K>) => HistoryEntryByKind<K>;
    buildFromHistory: (
        id: string,
        history: TabHistoryEntry[],
        historyIndex: number,
    ) => HistoryTabByKind<K>;
    matchesOpenTarget: (
        tab: HistoryTabByKind<K>,
        payload: HistoryOpenPayload<K>,
    ) => boolean;
    replaceCurrentEntry?: (
        tab: HistoryTabByKind<K>,
        payload: HistoryOpenPayload<K>,
    ) => HistoryTabByKind<K>;
    fingerprint: (tab: HistoryTabByKind<K>) => string;
    serializeForSession: (tab: HistoryTabByKind<K>) => unknown;
    isValidTab?: (tab: HistoryTabByKind<K>) => boolean;
}

function serializeNoteTabForSession(tab: NoteTab) {
    return {
        noteId: tab.noteId,
        title: tab.title,
        history: tab.history
            .filter((entry): entry is NoteHistoryEntry => entry.kind === "note")
            .map((entry) => ({
                noteId: entry.noteId,
                title: entry.title,
            })),
        historyIndex: tab.historyIndex,
    };
}

function serializePdfTabForSession(tab: PdfTab) {
    return {
        entryId: tab.entryId,
        title: tab.title,
        path: tab.path,
        page: tab.page,
        zoom: tab.zoom,
        viewMode: tab.viewMode,
        history: tab.history
            .filter((entry): entry is PdfHistoryEntry => entry.kind === "pdf")
            .map((entry) => ({
                entryId: entry.entryId,
                title: entry.title,
                path: entry.path,
                page: entry.page,
                zoom: entry.zoom,
                viewMode: entry.viewMode,
            })),
        historyIndex: tab.historyIndex,
    };
}

function serializeFileTabForSession(tab: FileTab) {
    return {
        relativePath: tab.relativePath,
        title: tab.title,
        path: tab.path,
        mimeType: tab.mimeType,
        viewer: tab.viewer,
        ...(typeof tab.sizeBytes === "number"
            ? { sizeBytes: tab.sizeBytes }
            : {}),
        ...(tab.contentTruncated ? { contentTruncated: true } : {}),
        history: tab.history
            .filter((entry): entry is FileHistoryEntry => entry.kind === "file")
            .map((entry) => ({
                relativePath: entry.relativePath,
                title: entry.title,
                path: entry.path,
                mimeType: entry.mimeType,
                viewer: entry.viewer,
                ...(typeof entry.sizeBytes === "number"
                    ? { sizeBytes: entry.sizeBytes }
                    : {}),
                ...(entry.contentTruncated ? { contentTruncated: true } : {}),
            })),
        historyIndex: tab.historyIndex,
    };
}

function serializeMapTabForSession(tab: MapTab) {
    return {
        relativePath: tab.relativePath,
        title: tab.title,
    };
}

function createSessionFingerprint(kind: HistoryTabKind, payload: unknown) {
    return `|${kind}|${JSON.stringify(payload)}`;
}

// Invariants:
// - Only note/pdf/file/map belong to the history-tab capability model.
// - Special tabs like graph/review stay outside this registry on purpose.
// - The store should delegate history mechanics to these handlers instead of
//   branching on kind for normalize/open/persist/restore behavior.

const noteTabHandler: HistoryTabHandler<"note"> = {
    kind: "note",
    normalizeTab: (input) => ensureNoteTabHistory(input),
    createInitialTab: (payload) =>
        createNoteTab(payload.noteId, payload.title, payload.content),
    createOpenEntry: (payload) =>
        createNoteHistoryEntry(payload.noteId, payload.title, payload.content),
    entryFromTab: (tab) => createHistoryEntryFromTab(tab) as NoteHistoryEntry,
    buildFromHistory: (id, history, historyIndex) =>
        buildTabFromHistory(id, history, historyIndex) as NoteTab,
    matchesOpenTarget: (tab, payload) => tab.noteId === payload.noteId,
    replaceCurrentEntry: (tab, payload) =>
        buildTabFromHistory(
            tab.id,
            tab.history.map((entry, index) =>
                index === tab.historyIndex && entry.kind === "note"
                    ? createNoteHistoryEntry(
                          payload.noteId,
                          payload.title,
                          payload.content,
                      )
                    : entry,
            ),
            tab.historyIndex,
        ) as NoteTab,
    fingerprint: (tab) =>
        createSessionFingerprint("note", serializeNoteTabForSession(tab)),
    serializeForSession: serializeNoteTabForSession,
};

const pdfTabHandler: HistoryTabHandler<"pdf"> = {
    kind: "pdf",
    normalizeTab: (input) => ensurePdfTabDefaults(input),
    createInitialTab: (payload) =>
        createPdfTab(payload.entryId, payload.title, payload.path),
    createOpenEntry: (payload) =>
        createPdfHistoryEntry(
            payload.entryId,
            payload.title,
            payload.path,
            1,
            1,
            "continuous",
        ),
    entryFromTab: (tab) => createHistoryEntryFromTab(tab) as PdfHistoryEntry,
    buildFromHistory: (id, history, historyIndex) =>
        buildTabFromHistory(id, history, historyIndex) as PdfTab,
    matchesOpenTarget: (tab, payload) => tab.entryId === payload.entryId,
    fingerprint: (tab) =>
        createSessionFingerprint("pdf", serializePdfTabForSession(tab)),
    serializeForSession: serializePdfTabForSession,
};

const fileTabHandler: HistoryTabHandler<"file"> = {
    kind: "file",
    normalizeTab: (input) => ensureFileTabDefaults(input),
    createInitialTab: (payload) =>
        createFileTab(
            payload.relativePath,
            payload.title,
            payload.path,
            payload.content,
            payload.mimeType,
            payload.viewer,
            {
                sizeBytes: payload.sizeBytes,
                contentTruncated: payload.contentTruncated,
            },
        ),
    createOpenEntry: (payload) =>
        createFileHistoryEntry(
            payload.relativePath,
            payload.title,
            payload.path,
            payload.content,
            payload.mimeType,
            payload.viewer,
            {
                sizeBytes: payload.sizeBytes,
                contentTruncated: payload.contentTruncated,
            },
        ),
    entryFromTab: (tab) => createHistoryEntryFromTab(tab) as FileHistoryEntry,
    buildFromHistory: (id, history, historyIndex) =>
        buildTabFromHistory(id, history, historyIndex) as FileTab,
    matchesOpenTarget: (tab, payload) =>
        tab.relativePath === payload.relativePath,
    replaceCurrentEntry: (tab, payload) =>
        buildTabFromHistory(
            tab.id,
            tab.history.map((entry, index) =>
                index === tab.historyIndex && entry.kind === "file"
                    ? createFileHistoryEntry(
                          payload.relativePath,
                          payload.title,
                          payload.path,
                          payload.content,
                          payload.mimeType,
                          payload.viewer,
                          {
                              sizeBytes: payload.sizeBytes,
                              contentTruncated: payload.contentTruncated,
                          },
                      )
                    : entry,
            ),
            tab.historyIndex,
        ) as FileTab,
    fingerprint: (tab) =>
        createSessionFingerprint("file", serializeFileTabForSession(tab)),
    serializeForSession: serializeFileTabForSession,
};

const mapTabHandler: HistoryTabHandler<"map"> = {
    kind: "map",
    normalizeTab: (input) => ensureMapTabDefaults(input),
    createInitialTab: (payload) => ({
        id: crypto.randomUUID(),
        kind: "map",
        relativePath: payload.relativePath,
        title: payload.title,
        history: [],
        historyIndex: -1,
    }),
    createOpenEntry: (payload) => ({
        kind: "map",
        relativePath: payload.relativePath,
        title: payload.title,
    }),
    entryFromTab: (tab) => createHistoryEntryFromTab(tab) as MapHistoryEntry,
    buildFromHistory: (id, history, historyIndex) =>
        buildTabFromHistory(id, history, historyIndex) as MapTab,
    matchesOpenTarget: (tab, payload) =>
        tab.relativePath === payload.relativePath,
    fingerprint: (tab) =>
        createSessionFingerprint("map", serializeMapTabForSession(tab)),
    serializeForSession: serializeMapTabForSession,
    isValidTab: (tab) => tab.relativePath.length > 0,
};

export const historyTabHandlers: {
    [K in HistoryTabKind]: HistoryTabHandler<K>;
} = {
    note: noteTabHandler,
    pdf: pdfTabHandler,
    file: fileTabHandler,
    map: mapTabHandler,
};

export function getHistoryTabHandler<K extends HistoryTabKind>(kind: K) {
    return historyTabHandlers[kind] as HistoryTabHandler<K>;
}

export function getHistoryTabKind(tab: HistoryTabInput): HistoryTabKind {
    if (isNoteTab(tab)) return "note";
    if (isPdfTab(tab)) return "pdf";
    if (isFileTab(tab)) return "file";
    return "map";
}

export function normalizeHistoryTab(tab: HistoryTabInput): HistoryTab | null {
    const kind = getHistoryTabKind(tab);
    const handler = getHistoryTabHandler(kind) as HistoryTabHandler<
        typeof kind
    >;
    const normalized = handler.normalizeTab(tab as never);
    return handler.isValidTab && !handler.isValidTab(normalized)
        ? null
        : normalized;
}

export function getOpenableHistoryTabHandler<K extends OpenableHistoryTabKind>(
    kind: K,
) {
    return getHistoryTabHandler(kind);
}

export function createHistorySnapshot(tab: HistoryTab): TabHistoryEntry {
    return getHistoryTabHandler(tab.kind).entryFromTab(tab as never);
}
