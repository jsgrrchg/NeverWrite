import { create } from "zustand";
import {
    buildPersistedSession,
    getEditorSessionSignature,
    isSessionReady,
    writePersistedSession,
} from "./editorSession";
import {
    createEditorWorkspaceSlice,
    type EditorWorkspaceStore,
} from "./editorWorkspace";
import { useVaultStore } from "./vaultStore";

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
export {
    createEditorPaneState,
    getEffectivePaneWorkspace,
    selectEditorPaneActiveTab,
    selectEditorPaneState,
    selectEditorPaneTabs,
    selectEditorWorkspaceTabs,
    selectFocusedEditorTab,
    selectFocusedPaneId,
    selectLeafPaneIds,
    selectPaneCount,
    selectPaneNeighbor,
    selectPaneState,
} from "./editorWorkspace";
export type {
    EditorPaneInput,
    EditorPaneState,
    EditorWorkspaceState,
    EditorWorkspaceStore,
    ReloadedDetail,
    WorkspacePaneNeighborDirection,
} from "./editorWorkspace";

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

export interface EditorStore extends EditorWorkspaceStore {
    pendingReveal: PendingReveal | null;
    pendingSelectionReveal: PendingSelectionReveal | null;
    currentSelection: EditorSelectionContext | null;
    queueReveal: (reveal: PendingReveal) => void;
    clearPendingReveal: () => void;
    queueSelectionReveal: (reveal: PendingSelectionReveal) => void;
    clearPendingSelectionReveal: () => void;
    setCurrentSelection: (selection: EditorSelectionContext) => void;
    clearCurrentSelection: () => void;
}

export const useEditorStore = create<EditorStore>((set, get, api) => ({
    ...createEditorWorkspaceSlice<EditorStore>(set, get, api),
    pendingReveal: null,
    pendingSelectionReveal: null,
    currentSelection: null,

    queueReveal: (pendingReveal) => set({ pendingReveal }),

    clearPendingReveal: () => set({ pendingReveal: null }),

    queueSelectionReveal: (pendingSelectionReveal) =>
        set({ pendingSelectionReveal }),

    clearPendingSelectionReveal: () => set({ pendingSelectionReveal: null }),

    setCurrentSelection: (currentSelection) => set({ currentSelection }),

    clearCurrentSelection: () => set({ currentSelection: null }),
}));

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
