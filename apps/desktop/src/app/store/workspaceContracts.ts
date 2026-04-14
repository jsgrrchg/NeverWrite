import type { FileTreeNoteDragDetail } from "../../features/ai/dragEvents";
import type { Tab } from "./editorTabs";
import type {
    WorkspaceLayoutNode,
    WorkspaceSplitDirection,
} from "./workspaceLayoutTree";

export const WORKSPACE_PHASE0_STATE_FIELDS = [
    "tabs",
    "activeTabId",
    "activationHistory",
    "tabNavigationHistory",
    "tabNavigationIndex",
    "panes",
    "focusedPaneId",
    "layoutTree",
] as const;

export type WorkspaceStateField =
    (typeof WORKSPACE_PHASE0_STATE_FIELDS)[number];

export type WorkspaceInventoryRole =
    | "ownership"
    | "derived-selection"
    | "rendering"
    | "drag-drop"
    | "review-targeting"
    | "chat-sidebar-bridge"
    | "chrome-navigation";

export interface WorkspacePaneStateContract {
    id: string;
    tabIds: string[];
    activeTabId: string | null;
    activationHistory: string[];
    tabNavigationHistory: string[];
    tabNavigationIndex: number;
}

export interface WorkspaceTreeStateContract {
    focusedPaneId: string;
    layoutTree: WorkspaceLayoutNode;
    tabsById: Record<string, Tab>;
    panesById: Record<string, WorkspacePaneStateContract>;
}

export interface WorkspaceDragPayload {
    kind: "workspace-tab";
    tabId: string;
    sourcePaneId: string;
    tabKind: Tab["kind"];
    fileAttachmentDetail?: FileTreeNoteDragDetail | null;
}

export type WorkspaceDropTarget =
    | { type: "strip"; paneId: string; index: number }
    | { type: "pane-center"; paneId: string }
    | {
          type: "split";
          paneId: string;
          direction: WorkspaceSplitDirection;
      }
    | { type: "composer" }
    | { type: "detach-window" }
    | { type: "none" };

export interface WorkspacePhase0InventoryEntry {
    id: string;
    role: WorkspaceInventoryRole;
    file: string;
    symbols: string[];
    reads: WorkspaceStateField[];
    writes: WorkspaceStateField[];
    summary: string;
    migrationIntent: string;
}

export interface WorkspacePhase0Inconsistency {
    id: string;
    files: string[];
    symbols: string[];
    summary: string;
    impact: string;
    targetPhase: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
}

/**
 * Phase 0 inventory of the current hybrid workspace model.
 *
 * This file intentionally lives next to the store so future phases can migrate
 * against a stable contract instead of re-discovering the same ownership edges.
 */
export const WORKSPACE_PHASE0_INVENTORY = [
    {
        id: "editor-store-hybrid-ownership",
        role: "ownership",
        file: "apps/desktop/src/app/store/editorStore.ts",
        symbols: [
            "LegacyWorkspaceState",
            "EditorPaneState",
            "createEditorPaneState",
            "hydrateWorkspace",
            "switchTab",
            "closeTab",
            "moveTabToPane",
            "moveTabToPaneDropTarget",
            "moveTabToNewSplit",
        ],
        reads: [
            "tabs",
            "activeTabId",
            "activationHistory",
            "tabNavigationHistory",
            "tabNavigationIndex",
            "panes",
            "focusedPaneId",
            "layoutTree",
        ],
        writes: [
            "tabs",
            "activeTabId",
            "activationHistory",
            "tabNavigationHistory",
            "tabNavigationIndex",
            "panes",
            "focusedPaneId",
            "layoutTree",
        ],
        summary:
            "The editor store still owns workspace state in a hybrid shape: panes keep full tab objects while the focused pane is projected back into legacy global tab fields.",
        migrationIntent:
            "Phase 1 extracts this subsystem. Phase 2 normalizes ownership into tabsById + pane.tabIds and removes the need for global tab copies.",
    },
    {
        id: "editor-store-focused-pane-projection-bridge",
        role: "derived-selection",
        file: "apps/desktop/src/app/store/editorStore.ts",
        symbols: ["buildFocusedPaneProjection"],
        reads: ["panes", "focusedPaneId", "layoutTree"],
        writes: [
            "tabs",
            "activeTabId",
            "activationHistory",
            "tabNavigationHistory",
            "tabNavigationIndex",
            "panes",
            "focusedPaneId",
            "layoutTree",
        ],
        summary:
            "This bridge reconstructs legacy global workspace fields from the focused pane and is the main adapter keeping the two models apparently coherent.",
        migrationIntent:
            "Keep it explicit during Phase 0, then delete it once consumers read from normalized pane ownership instead of the focused-pane projection.",
    },
    {
        id: "workspace-chrome-global-navigation",
        role: "chrome-navigation",
        file: "apps/desktop/src/features/editor/WorkspaceChromeBar.tsx",
        symbols: ["WorkspaceChromeBar", "goBack", "goForward"],
        reads: [
            "tabs",
            "activeTabId",
            "tabNavigationHistory",
            "tabNavigationIndex",
        ],
        writes: [],
        summary:
            "Top-level window chrome still renders editorial Back/Forward based on the global workspace projection instead of pane-local history.",
        migrationIntent:
            "Phase 2b moves this responsibility into pane headers so the top bar can become pure window chrome.",
    },
    {
        id: "unified-bar-global-tab-strip",
        role: "rendering",
        file: "apps/desktop/src/features/editor/UnifiedBar.tsx",
        symbols: [
            "UnifiedBar",
            "tabs",
            "activeTabId",
            "reorderTabs",
            "moveTabToPaneDropTarget",
            "goBack",
            "goForward",
            "navigateToHistoryIndex",
        ],
        reads: [
            "tabs",
            "activeTabId",
            "tabNavigationHistory",
            "tabNavigationIndex",
            "focusedPaneId",
        ],
        writes: [],
        summary:
            "UnifiedBar still behaves like a global tab strip and global navigation surface even though panes already have their own tab bars.",
        migrationIntent:
            "Phase 2 demotes UnifiedBar to global chrome and removes it from primary tab ownership, reorder, move and split interactions.",
    },
    {
        id: "editor-pane-bar-pane-tab-strip",
        role: "rendering",
        file: "apps/desktop/src/features/editor/EditorPaneBar.tsx",
        symbols: [
            "EditorPaneBar",
            "selectEditorPaneState",
            "reorderPaneTabs",
            "moveTabToPane",
            "moveTabToNewSplit",
            "closePane",
        ],
        reads: ["panes", "focusedPaneId", "layoutTree"],
        writes: [],
        summary:
            "EditorPaneBar already renders pane-local tabs and pane-local structural actions, which makes it the correct long-term home for workspace tab strips.",
        migrationIntent:
            "Phase 2 keeps this surface and re-roots ownership fully in panes instead of the global projection.",
    },
    {
        id: "workspace-pane-drop-preview",
        role: "drag-drop",
        file: "apps/desktop/src/features/editor/workspaceTabDropPreview.ts",
        symbols: [
            "CrossPaneTabDropPreview",
            "dispatchCrossPaneTabDropPreview",
            "resolvePaneDropPosition",
            "resolveWorkspaceTabDropTarget",
            "toCrossPaneTabDropPreview",
        ],
        reads: [],
        writes: [],
        summary:
            "Workspace tab drop hit-testing now resolves pane centers, edges and target strip insertion points through a single pane-centric target resolver.",
        migrationIntent:
            "Phase 3 is the canonical home for pane hit-testing; later phases should layer composer and detach targets on top of this resolver instead of bypassing it.",
    },
    {
        id: "workspace-tab-drag-hook",
        role: "drag-drop",
        file: "apps/desktop/src/features/editor/useWorkspaceTabDrag.ts",
        symbols: [
            "useWorkspaceTabDrag",
            "resolveCurrentWorkspaceDropTarget",
            "publishWorkspaceDropPreview",
            "onCommitWorkspaceDrop",
        ],
        reads: [],
        writes: [],
        summary:
            "Pointer-based tab dragging now flows through a shared hook that owns drag previews, drop-target resolution, commit routing and cancellation semantics for workspace tabs.",
        migrationIntent:
            "Keep both pane bars and any future workspace tab surfaces on this hook so drag rules do not fork again.",
    },
    {
        id: "composer-drop-zone-attachments",
        role: "drag-drop",
        file: "apps/desktop/src/features/editor/tabDragAttachments.ts",
        symbols: [
            "buildTabFileDragDetail",
            "isPointOverAiComposerDropZone",
            "resolveComposerDropTarget",
        ],
        reads: [],
        writes: [],
        summary:
            "Composer attachment drag is modeled as an external drop-zone concern, and the shared workspace drag resolver can now return `composer` without routing that intent through layout ownership.",
        migrationIntent:
            "Phase 4 preserves this as a specialized drop target instead of letting it compete with structural workspace ownership.",
    },
    {
        id: "detached-window-drop-infrastructure",
        role: "drag-drop",
        file: "apps/desktop/src/app/detachedWindows.ts",
        symbols: [
            "resolveDetachWindowDropTarget",
            "findWindowTabDropTarget",
            "commitDetachedTabDrop",
            "createGhostWindow",
            "publishWindowTabDropZone",
        ],
        reads: [],
        writes: [],
        summary:
            "Detached-window routing is now modeled as infrastructure behind the shared drag contract, so workspace tab surfaces can resolve `detach-window` without owning cross-window attach logic.",
        migrationIntent:
            "Phase 5 keeps ghost previews and multi-window routing here, while the workspace drag hook stays responsible only for target resolution and commit intent.",
    },
    {
        id: "app-global-shortcuts-and-sidebar-chat-host",
        role: "chat-sidebar-bridge",
        file: "apps/desktop/src/App.tsx",
        symbols: [
            "RightPanel",
            "AIChatPanel",
            "cycleEditorTabs",
            "tabs",
            "activeTabId",
        ],
        reads: ["tabs", "activeTabId", "panes", "focusedPaneId"],
        writes: [],
        summary:
            "The app shell still owns the auxiliary chat sidebar, while workspace chat tabs remain the primary chat surface.",
        migrationIntent:
            "Phase 2c keeps the right panel as contextual support and leaves future shortcut cleanup to focused-pane-aware commands.",
    },
    {
        id: "ai-chat-panel-sidebar-primary-surface",
        role: "chat-sidebar-bridge",
        file: "apps/desktop/src/features/ai/AIChatPanel.tsx",
        symbols: [
            "AIChatPanel",
            "AIChatPanel",
            "AIChatSessionList",
            "openChatSessionInWorkspace",
            "createNewChatInWorkspace",
        ],
        reads: [],
        writes: [],
        summary:
            "AIChatPanel now acts as a launcher and inspector for workspace-owned chat sessions instead of rendering the primary composer surface itself.",
        migrationIntent:
            "Keep this panel auxiliary and resist reintroducing a second primary chat surface here.",
    },
    {
        id: "chat-tabs-session-metadata-store",
        role: "chat-sidebar-bridge",
        file: "apps/desktop/src/features/ai/store/chatTabsStore.ts",
        symbols: [
            "ChatWorkspaceTab",
            "openSessionTab",
            "restoreWorkspace",
            "reorderTabs",
        ],
        reads: [],
        writes: [],
        summary:
            "chatTabsStore now keeps lightweight chat session metadata for restore and launcher flows without deciding where sessions render.",
        migrationIntent:
            "Phase 2c keeps this metadata role narrow and leaves rendering ownership to workspace chat tabs.",
    },
    {
        id: "chat-pane-movement-bridge",
        role: "chat-sidebar-bridge",
        file: "apps/desktop/src/features/ai/chatPaneMovement.ts",
        symbols: ["openChatSessionInWorkspace", "createNewChatInWorkspace"],
        reads: ["focusedPaneId"],
        writes: [],
        summary:
            "This module resolves chat actions against the focused workspace pane and keeps chat creation/opening workspace-first.",
        migrationIntent:
            "Keep workspace opening and sidebar reveal as distinct intentions so the chat UI does not split ownership again.",
    },
    {
        id: "review-targeting-picks-active-tab-per-pane",
        role: "review-targeting",
        file: "apps/desktop/src/features/editor/useEditableFileResource.ts",
        symbols: [
            "selectEditorPaneState",
            "paneState.activeTabId",
            "paneState.tabs.find(...)",
        ],
        reads: ["panes", "focusedPaneId"],
        writes: [],
        summary:
            "Review and editor targeting already resolve through pane context, which is the right invariant to preserve during the workspace refactor.",
        migrationIntent:
            "Later phases should migrate the read path to pane.tabIds + tabsById without changing the review targeting semantics.",
    },
    {
        id: "review-sync-stays-above-layout",
        role: "review-targeting",
        file: "apps/desktop/src/features/editor/editorReviewSync.ts",
        symbols: ["syncEditorReviewState", "applyTrackedChangesToEditor"],
        reads: [],
        writes: [],
        summary:
            "Review sync is largely stateless with respect to pane layout and should remain an observer of pane/editor context, not a workspace owner.",
        migrationIntent:
            "Validate it against the new workspace model in Phase 6, but keep it out of layout ownership.",
    },
] as const satisfies readonly WorkspacePhase0InventoryEntry[];

export const WORKSPACE_PHASE0_INCONSISTENCIES = [
    {
        id: "duplicate-tab-reorder-paths",
        files: [
            "apps/desktop/src/app/store/editorStore.ts",
            "apps/desktop/src/features/editor/UnifiedBar.tsx",
            "apps/desktop/src/features/editor/EditorPaneBar.tsx",
        ],
        symbols: ["reorderTabs", "reorderPaneTabs"],
        summary:
            "Global reorder mutates only state.tabs while pane reorder mutates only pane.tabs, so the two visible tab strips can diverge.",
        impact: "This is the clearest split-brain symptom of double ownership and one of the strongest sources of drag/reorder inconsistency today.",
        targetPhase: 0,
    },
    {
        id: "focused-pane-projection-keeps-legacy-model-alive",
        files: ["apps/desktop/src/app/store/editorStore.ts"],
        symbols: ["buildFocusedPaneProjection"],
        summary:
            "The store rebuilds global tabs, activeTabId and navigation history from the focused pane after pane mutations.",
        impact: "This bridge preserves the current UX, but it also hides the architectural mismatch and keeps consumers coupled to legacy global fields.",
        targetPhase: 0,
    },
    {
        id: "global-navigation-still-lives-in-window-chrome",
        files: [
            "apps/desktop/src/features/editor/WorkspaceChromeBar.tsx",
            "apps/desktop/src/features/editor/UnifiedBar.tsx",
            "apps/desktop/src/App.tsx",
        ],
        symbols: ["goBack", "goForward", "cycleEditorTabs"],
        summary:
            "Tab navigation is still exposed as a global window-level concern instead of a pane-local concern.",
        impact: "This keeps pane headers from becoming self-sufficient and reinforces the old focused-pane projection model.",
        targetPhase: 0,
    },
] as const satisfies readonly WorkspacePhase0Inconsistency[];
