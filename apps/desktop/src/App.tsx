import { useState, useEffect, useCallback, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { getCurrentWindow } from "@neverwrite/runtime";
import { listen } from "@neverwrite/runtime";
import { getCurrentWebview } from "@neverwrite/runtime";
import { open } from "@neverwrite/runtime";
import { invoke } from "@neverwrite/runtime";
import { resolveDeferredUnlisten } from "./app/utils/deferredUnlisten";
import { vaultInvoke } from "./app/utils/vaultInvoke";
import { AppLayout } from "./components/layout/AppLayout";
import { SidebarShell } from "./components/layout/SidebarShell";
import { LinksPanel } from "./features/notes/LinksPanel";
import { OutlinePanel } from "./features/notes/OutlinePanel";
import { AIChatWorkspaceHost } from "./features/ai/AIChatWorkspaceHost";
import { AIChatDetachedWindowHost } from "./features/ai/AIChatDetachedWindowHost";
import { createNewChatInWorkspace } from "./features/ai/chatPaneMovement";
import { WorkspaceTerminalHost } from "./features/terminal/WorkspaceTerminalHost";
import { migrateLegacyTerminalTabsToWorkspace } from "./features/terminal/legacyTerminalMigration";
import { UnifiedBar } from "./features/editor/UnifiedBar";
import { REQUEST_CLOSE_ACTIVE_TAB_EVENT } from "./features/editor/Editor";
import { EditorPaneContent } from "./features/editor/EditorPaneContent";
import { MultiPaneWorkspace } from "./features/editor/MultiPaneWorkspace";
import { EditorChromeBar } from "./features/editor/EditorChromeBar";
import { openUntitledMarkdownNote } from "./features/editor/markdownNoteCreation";
import { useBookmarkStore } from "./app/store/bookmarkStore";
import { CommandPalette } from "./features/command-palette/CommandPalette";
import { QuickSwitcher } from "./features/quick-switcher/QuickSwitcher";
import { SettingsPanel } from "./features/settings";
import { useCommandStore } from "./features/command-palette/store/commandStore";
import { getPathBaseName } from "./app/utils/path";
import {
    ATTACH_EXTERNAL_TAB_EVENT,
    type AttachExternalTabPayload,
    getCurrentWindowLabel,
    getWindowMode,
    openDetachedNoteWindow,
    openSettingsWindow,
    openVaultWindow,
    readDetachedWindowPayload,
} from "./app/detachedWindows";
import { bootstrapDetachedWindow } from "./app/detachedWindowBootstrap";
import {
    buildWindowSessionEntry,
    refreshWindowSessionSnapshot,
    restoreWindowSession,
    writeWindowSessionEntry,
} from "./app/windowSession";
import {
    fileViewerNeedsTextContent,
    useEditorStore,
    isChatTab,
    isFileTab,
    isNoteTab,
    isTerminalTab,
    getEffectivePaneWorkspace,
    selectEditorWorkspaceTabs,
    selectFocusedPaneId,
    selectFocusedEditorTab,
    selectLeafPaneIds,
    selectPaneNeighbor,
    selectPaneCount,
    selectPaneState,
} from "./app/store/editorStore";
import {
    buildPersistedSession,
    isSessionReady,
    writePersistedSession,
    markSessionReady,
    restorePersistedSession,
} from "./app/store/editorSession";
import { useVaultStore, type VaultNoteChange } from "./app/store/vaultStore";
import { useLayoutStore } from "./app/store/layoutStore";
import { useSettingsStore } from "./app/store/settingsStore";
import { formatShortcutAction } from "./app/shortcuts/format";
import {
    matchesShortcutAction,
    getShortcutDefinition,
} from "./app/shortcuts/registry";
import { getDesktopPlatform } from "./app/utils/platform";
import {
    decreaseAppZoom,
    increaseAppZoom,
    readAppZoom,
    resetAppZoom,
    subscribeAppZoom,
} from "./app/utils/appZoom";
import { invalidateLivePreviewNoteCache } from "./features/editor/extensions/livePreviewBlocks";
import {
    canUseExcalidrawRuntime,
    readSearchParam,
} from "./app/utils/safeBrowser";
import { getVaultChangeSyncStrategy } from "./app/utils/vaultChangeSync";
import { logError } from "./app/utils/runtimeLog";
import {
    flushChatTabsPersistence,
    markChatTabsReady,
    readPersistedChatWorkspace,
    resetChatTabsStore,
    useChatTabsStore,
} from "./features/ai/store/chatTabsStore";
import { resetChatStore, useChatStore } from "./features/ai/store/chatStore";
import { useTerminalRuntimeStore } from "./features/terminal/terminalRuntimeStore";
import { shouldAllowNativeContextMenu } from "./features/spellcheck/contextMenu";
import { YouTubeModalHost } from "./features/editor/YouTubeModalHost";
import { ClipNotification } from "./features/clip/ClipNotification";
import { useClipImportStore } from "./features/clip/clipImportStore";
import { useAppUpdateStore } from "./features/updates/store";
import {
    buildWindowOperationalState,
    WINDOW_OPERATIONAL_STATE_PUBLISH_DEBOUNCE_MS,
    writeWindowOperationalState,
} from "./features/updates/sensitiveState";

interface WebClipperSavedPayload {
    requestId: string;
    vaultPath: string;
    targetWindowLabel: string | null;
    noteId: string;
    title: string;
    relativePath: string;
    content: string;
}

const WEB_CLIPPER_CLIP_SAVED_EVENT = "neverwrite:web-clipper/clip-saved";
const WEB_CLIPPER_ROUTE_CLIP_EVENT = "neverwrite:web-clipper/route-clip";
const MENU_ACTION_EVENT = "menu-action";
const DOCK_OPEN_VAULT_EVENT = "dock-open-vault";
const EXCALIDRAW_RUNTIME_SUPPORTED = canUseExcalidrawRuntime();

function cycleEditorTabs(backward: boolean) {
    const state = useEditorStore.getState();
    const pane = selectPaneState(state);
    const idx = pane.tabs.findIndex((tab) => tab.id === pane.activeTabId);
    if (idx === -1 || pane.tabs.length <= 1) return;

    const offset = backward ? pane.tabs.length - 1 : 1;
    state.switchTab(pane.tabs[(idx + offset) % pane.tabs.length].id);
}

function openEmptyTab() {
    // Cmd+T opens the unified quick switcher palette instead of a blank draft tab.
    if (!useVaultStore.getState().vaultPath) return;
    useCommandStore.getState().openQuickSwitcher();
}

function toggleLivePreviewSetting() {
    const { livePreviewEnabled, setSetting } = useSettingsStore.getState();
    setSetting("livePreviewEnabled", !livePreviewEnabled);
}

function zoomInApp() {
    increaseAppZoom();
}

function zoomOutApp() {
    decreaseAppZoom();
}

function resetAppToActualSize() {
    resetAppZoom();
}

type RightPanelTab = "outline" | "links";

// The right panel lives outside the center column, so its tab bar starts at
// Y=0 of the window. On Windows that zone is owned by the native
// `titleBarOverlay` (34px tall caption strip anchored to the window's
// top-right), which would otherwise paint min/max/close on top of the tab
// bar. Reserve a matching 34px drag strip at the top of the panel — same
// pattern as `EditorChromeBar` for the center column.
const IS_WINDOWS_DESKTOP = getDesktopPlatform() === "windows";

const RIGHT_PANEL_TABS: Array<{
    value: RightPanelTab;
    label: string;
    icon: React.ReactNode;
}> = [
    {
        value: "outline",
        label: "Outline",
        icon: (
            <svg
                width="12"
                height="12"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
            >
                <path d="M3 3.5h10" />
                <path d="M5.5 8h7.5" />
                <path d="M8 12.5h5" />
                <path d="M3 8h.01" />
                <path d="M5.5 12.5h.01" />
            </svg>
        ),
    },
    {
        value: "links",
        label: "Links",
        icon: (
            <svg
                width="12"
                height="12"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
            >
                <path d="M10 2h4v4M14 2l-6 6M6 4H3a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-3" />
            </svg>
        ),
    },
];

function RightPanelTabBar({
    view,
    onSelect,
    onCollapse,
}: {
    view: RightPanelTab;
    onSelect: (view: RightPanelTab) => void;
    onCollapse: () => void;
}) {
    return (
        <div
            className="flex items-center gap-1"
            style={{ padding: "8px 8px 6px", flexShrink: 0 }}
        >
            {RIGHT_PANEL_TABS.map((tab) => {
                const active = view === tab.value;
                return (
                    <button
                        key={tab.value}
                        type="button"
                        onClick={() => onSelect(tab.value)}
                        title={tab.label}
                        data-active={active || undefined}
                        className="ub-sidebar-tab flex items-center justify-center gap-1.5 text-[11px] font-medium rounded-md"
                        style={{
                            flex: 1,
                            minWidth: 0,
                            height: 26,
                            padding: "0 6px",
                            border: active
                                ? "1px solid color-mix(in srgb, var(--accent) 22%, var(--border))"
                                : "1px solid transparent",
                            background: active
                                ? "color-mix(in srgb, var(--bg-primary) 60%, transparent)"
                                : "transparent",
                            color: active
                                ? "var(--text-primary)"
                                : "var(--text-secondary)",
                            boxShadow: active
                                ? "0 1px 2px rgb(0 0 0 / 0.12)"
                                : "none",
                            transition:
                                "background-color 120ms ease, color 120ms ease, border-color 120ms ease, transform 120ms ease",
                        }}
                    >
                        {tab.icon}
                        <span className="truncate">{tab.label}</span>
                    </button>
                );
            })}
            <button
                type="button"
                onClick={onCollapse}
                title="Hide right panel"
                aria-label="Hide right panel"
                className="ub-chrome-btn flex items-center justify-center shrink-0 rounded-md"
                style={{
                    width: 26,
                    height: 26,
                    border: "1px solid transparent",
                    background: "transparent",
                    color: "var(--text-secondary)",
                    opacity: 0.82,
                }}
            >
                <svg
                    width="16"
                    height="16"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                >
                    <rect x="2" y="2.5" width="12" height="11" rx="2.2" />
                    <path d="M6 2.5v11" />
                </svg>
            </button>
        </div>
    );
}

function RightPanel() {
    const rightPanelView = useLayoutStore((s) => s.rightPanelView);
    const activateRightView = useLayoutStore((s) => s.activateRightView);
    const toggleRightPanel = useLayoutStore((s) => s.toggleRightPanel);
    return (
        <div className="flex h-full min-h-0 flex-col overflow-hidden">
            {IS_WINDOWS_DESKTOP && (
                <div
                    aria-hidden="true"
                    data-right-panel-titlebar-inset
                    style={
                        {
                            height: 34,
                            flexShrink: 0,
                            WebkitAppRegion: "drag",
                            backgroundColor: "var(--sidebar-vibrancy-tint)",
                        } as React.CSSProperties
                    }
                />
            )}
            <RightPanelTabBar
                view={rightPanelView}
                onSelect={activateRightView}
                onCollapse={toggleRightPanel}
            />
            <div className="min-h-0 flex-1 overflow-hidden">
                {rightPanelView === "outline" && <OutlineRightPanel />}
                {rightPanelView === "links" && <LinksPanel />}
            </div>
        </div>
    );
}

const VAULT_OVERLAY_STRIP_LABEL: React.CSSProperties = {
    fontSize: "0.68em",
    letterSpacing: "0.12em",
    fontWeight: 600,
};

function VaultOpeningOverlay() {
    const isLoading = useVaultStore((s) => s.isLoading);
    const openState = useVaultStore((s) => s.vaultOpenState);
    const cancelOpenVault = useVaultStore((s) => s.cancelOpenVault);
    const [cancelHovered, setCancelHovered] = useState(false);

    if (!isLoading) return null;

    const hasProgress = openState.total > 0;
    const vaultName = openState.path
        ? getPathBaseName(openState.path)
        : "Vault";
    const progressUnit = openState.message.toLowerCase().includes("link")
        ? "links"
        : "notes";

    return (
        <div
            className="absolute inset-0 flex items-center justify-center p-6"
            style={{
                zIndex: 50,
                background: "rgb(6 10 15 / 0.78)",
                backdropFilter: "blur(10px)",
            }}
        >
            <div
                className="w-full max-w-md rounded-sm p-4"
                style={{
                    backgroundColor: "var(--bg-secondary)",
                    border: "1px solid color-mix(in srgb, var(--border) 50%, transparent)",
                    boxShadow: "0 8px 24px rgb(0 0 0 / 0.28)",
                }}
            >
                <div
                    className="uppercase"
                    style={{
                        ...VAULT_OVERLAY_STRIP_LABEL,
                        color: "var(--accent)",
                    }}
                >
                    Opening vault
                </div>
                <div
                    className="mt-2 text-lg font-semibold"
                    style={{ color: "var(--text-primary)" }}
                >
                    {vaultName}
                </div>
                <div
                    className="mt-1 text-sm"
                    style={{ color: "var(--text-secondary)" }}
                >
                    {openState.message || "Preparing vault..."}
                </div>

                <div
                    className="mt-4 h-1.5 overflow-hidden rounded-sm"
                    style={{
                        backgroundColor:
                            "color-mix(in srgb, var(--border) 35%, transparent)",
                    }}
                >
                    <div
                        style={{
                            width: hasProgress
                                ? `${Math.min(
                                      100,
                                      Math.max(
                                          6,
                                          (openState.processed /
                                              openState.total) *
                                              100,
                                      ),
                                  )}%`
                                : "18%",
                            height: "100%",
                            background:
                                "linear-gradient(90deg, var(--accent), color-mix(in srgb, var(--accent) 50%, white))",
                            transition: "width 160ms ease",
                        }}
                    />
                </div>

                <div className="mt-3 flex items-center justify-between">
                    <span
                        className="uppercase"
                        style={{
                            ...VAULT_OVERLAY_STRIP_LABEL,
                            color: "var(--text-secondary)",
                        }}
                    >
                        {openState.stage.replaceAll("_", " ")}
                    </span>
                    <span
                        className="text-xs"
                        style={{
                            color: "var(--text-secondary)",
                            opacity: 0.85,
                        }}
                    >
                        {hasProgress
                            ? `${openState.processed.toLocaleString()} / ${openState.total.toLocaleString()} ${progressUnit}`
                            : "Preparing index"}
                    </span>
                </div>

                {openState.snapshot_used && (
                    <div
                        className="mt-2 text-[11px]"
                        style={{
                            color: "var(--text-secondary)",
                            opacity: 0.85,
                        }}
                    >
                        Reusing persisted snapshot before syncing changes.
                    </div>
                )}

                <div className="mt-4 flex justify-end">
                    <button
                        type="button"
                        onClick={() => void cancelOpenVault()}
                        onMouseEnter={() => setCancelHovered(true)}
                        onMouseLeave={() => setCancelHovered(false)}
                        onFocus={() => setCancelHovered(true)}
                        onBlur={() => setCancelHovered(false)}
                        className="rounded-sm px-2.5 py-1 text-xs uppercase"
                        style={{
                            color: cancelHovered
                                ? "var(--text-primary)"
                                : "var(--text-secondary)",
                            backgroundColor: cancelHovered
                                ? "color-mix(in srgb, var(--text-primary) 14%, transparent)"
                                : "transparent",
                            border: cancelHovered
                                ? "1px solid color-mix(in srgb, var(--text-primary) 18%, transparent)"
                                : "1px solid color-mix(in srgb, var(--border) 50%, transparent)",
                            letterSpacing: "0.1em",
                            fontWeight: 600,
                            cursor: "pointer",
                            transition:
                                "background-color 120ms ease, color 120ms ease, border-color 120ms ease",
                        }}
                    >
                        Cancel
                    </button>
                </div>
            </div>
        </div>
    );
}

function OutlineRightPanel() {
    const activeNoteId = useEditorStore((state) => {
        const tab = selectFocusedEditorTab(state);
        return tab && isNoteTab(tab) ? tab.noteId : null;
    });
    const activeContent = useEditorStore((state) => {
        const tab = selectFocusedEditorTab(state);
        return tab && isNoteTab(tab) ? tab.content : null;
    });
    const queueSelectionReveal = useEditorStore((s) => s.queueSelectionReveal);

    if (!activeNoteId) {
        return (
            <div
                className="flex items-center justify-center h-full text-xs"
                style={{ color: "var(--text-secondary)" }}
            >
                No note open
            </div>
        );
    }

    return (
        <OutlinePanel
            content={activeContent}
            onSelectHeading={(selection) =>
                queueSelectionReveal({
                    noteId: activeNoteId,
                    anchor: selection.anchor,
                    head: selection.head,
                })
            }
        />
    );
}

// Register all initial commands
function useRegisterCommands(
    openSettings: () => void,
    developerCommandsEnabled: boolean,
) {
    const register = useCommandStore((s) => s.register);
    const openCommandPalette = useCommandStore((s) => s.openCommandPalette);
    const openQuickSwitcher = useCommandStore((s) => s.openQuickSwitcher);

    useEffect(() => {
        const platform = getDesktopPlatform();
        const commandPaletteShortcut = getShortcutDefinition("command_palette");
        const quickSwitcherShortcut = getShortcutDefinition("quick_switcher");
        const openVaultShortcut = getShortcutDefinition("open_vault");
        const newNoteShortcut = getShortcutDefinition("new_note");
        const newAgentShortcut = getShortcutDefinition("new_agent");
        const closeTabShortcut = getShortcutDefinition("close_tab");
        const newTabShortcut = getShortcutDefinition("new_tab");
        const reopenClosedTabShortcut =
            getShortcutDefinition("reopen_closed_tab");
        const toggleSidebarShortcut = getShortcutDefinition(
            "toggle_left_sidebar",
        );
        const toggleRightPanelShortcut =
            getShortcutDefinition("toggle_right_panel");
        const zoomInShortcut = getShortcutDefinition("zoom_in");
        const zoomOutShortcut = getShortcutDefinition("zoom_out");
        const resetZoomShortcut = getShortcutDefinition("reset_zoom");
        const openSettingsShortcut = getShortcutDefinition("open_settings");
        const toggleLivePreviewShortcut = getShortcutDefinition(
            "toggle_live_preview",
        );
        const nextTabShortcut = getShortcutDefinition("next_tab");
        const previousTabShortcut = getShortcutDefinition("previous_tab");
        const goBackShortcut = getShortcutDefinition("go_back");
        const goForwardShortcut = getShortcutDefinition("go_forward");
        const hasVault = () => useVaultStore.getState().vaultPath !== null;
        const hasActiveTab = () =>
            selectFocusedEditorTab(useEditorStore.getState()) !== null;
        const canSplitPane = () => true;
        const canClosePane = () =>
            selectPaneCount(useEditorStore.getState()) > 1;
        const hasRecentlyClosedTab = () =>
            useEditorStore.getState().recentlyClosedTabs.length > 0;
        const hasPaneNeighbor = (
            direction: "left" | "right" | "up" | "down",
        ) => {
            const state = useEditorStore.getState();
            const focusedPaneId = selectFocusedPaneId(state);
            return focusedPaneId
                ? selectPaneNeighbor(state, focusedPaneId, direction) !== null
                : false;
        };
        const developerModeEnabled = () =>
            developerCommandsEnabled &&
            useSettingsStore.getState().developerModeEnabled &&
            useSettingsStore.getState().developerTerminalEnabled;
        const activeTerminalTab = () => {
            const tab = selectFocusedEditorTab(useEditorStore.getState());
            return tab && isTerminalTab(tab) ? tab : null;
        };
        const canRestartActiveTerminal = () =>
            developerModeEnabled() && activeTerminalTab() !== null;

        // Navigation
        register({
            id: "nav:command-palette",
            label: commandPaletteShortcut.label,
            shortcut: formatShortcutAction(commandPaletteShortcut.id, platform),
            category: commandPaletteShortcut.category,
            execute: openCommandPalette,
        });

        register({
            id: "nav:quick-switcher",
            label: quickSwitcherShortcut.label,
            shortcut: formatShortcutAction(quickSwitcherShortcut.id, platform),
            category: quickSwitcherShortcut.category,
            when: hasVault,
            execute: openQuickSwitcher,
        });

        register({
            id: "nav:next-tab",
            label: nextTabShortcut.label,
            shortcut: formatShortcutAction(nextTabShortcut.id, platform),
            category: nextTabShortcut.category,
            when: hasActiveTab,
            execute: () => cycleEditorTabs(false),
        });

        register({
            id: "nav:previous-tab",
            label: previousTabShortcut.label,
            shortcut: formatShortcutAction(previousTabShortcut.id, platform),
            category: previousTabShortcut.category,
            when: hasActiveTab,
            execute: () => cycleEditorTabs(true),
        });

        register({
            id: "nav:back",
            label: goBackShortcut.label,
            shortcut: formatShortcutAction(goBackShortcut.id, platform),
            category: goBackShortcut.category,
            execute: () => useEditorStore.getState().goBack(),
        });

        register({
            id: "nav:forward",
            label: goForwardShortcut.label,
            shortcut: formatShortcutAction(goForwardShortcut.id, platform),
            category: goForwardShortcut.category,
            execute: () => useEditorStore.getState().goForward(),
        });

        // Vault
        register({
            id: "vault:open",
            label: openVaultShortcut.label,
            shortcut: formatShortcutAction(openVaultShortcut.id, platform),
            category: openVaultShortcut.category,
            execute: () => {
                void open({ directory: true, title: "Select vault" }).then(
                    (selected) => {
                        if (selected)
                            void useVaultStore.getState().openVault(selected);
                    },
                );
            },
        });

        register({
            id: "vault:new-note",
            label: newNoteShortcut.label,
            shortcut: formatShortcutAction(newNoteShortcut.id, platform),
            category: newNoteShortcut.category,
            when: hasVault,
            execute: () => {
                void openUntitledMarkdownNote();
            },
        });

        register({
            id: "ai:new-agent",
            label: newAgentShortcut.label,
            shortcut: formatShortcutAction(newAgentShortcut.id, platform),
            category: newAgentShortcut.category,
            when: hasVault,
            execute: () => {
                void createNewChatInWorkspace();
            },
        });

        register({
            id: "vault:new-concept-map",
            label: "New Concept Map",
            category: "Vault",
            when: hasVault,
            execute: () => {
                const vaultPath = useVaultStore.getState().vaultPath;
                if (!vaultPath) return;
                const name = `Map ${new Date().toLocaleDateString("en-CA")}`;
                void invoke<{
                    id: string;
                    title: string;
                    relative_path: string;
                }>("create_map", { vaultPath, name }).then((entry) => {
                    useEditorStore
                        .getState()
                        .openMap(entry.relative_path, entry.title);
                });
            },
        });

        // Editor
        register({
            id: "editor:close-tab",
            label: closeTabShortcut.label,
            shortcut: formatShortcutAction(closeTabShortcut.id, platform),
            category: closeTabShortcut.category,
            when: hasActiveTab,
            execute: () => {
                const state = useEditorStore.getState();
                const activeTab = selectFocusedEditorTab(state);
                if (!activeTab) return;

                if (isNoteTab(activeTab)) {
                    window.dispatchEvent(
                        new Event(REQUEST_CLOSE_ACTIVE_TAB_EVENT),
                    );
                    return;
                }

                state.closeTab(activeTab.id);
            },
        });

        register({
            id: "editor:new-tab",
            label: newTabShortcut.label,
            shortcut: formatShortcutAction(newTabShortcut.id, platform),
            category: newTabShortcut.category,
            when: hasVault,
            execute: openEmptyTab,
        });

        register({
            id: "editor:reopen-closed-tab",
            label: reopenClosedTabShortcut.label,
            shortcut: formatShortcutAction(
                reopenClosedTabShortcut.id,
                platform,
            ),
            category: reopenClosedTabShortcut.category,
            when: hasRecentlyClosedTab,
            execute: () => useEditorStore.getState().reopenLastClosedTab(),
        });

        register({
            id: "editor:toggle-live-preview",
            label: toggleLivePreviewShortcut.label,
            shortcut: formatShortcutAction(
                toggleLivePreviewShortcut.id,
                platform,
            ),
            category: toggleLivePreviewShortcut.category,
            execute: toggleLivePreviewSetting,
        });

        register({
            id: "app:zoom-in",
            label: zoomInShortcut.label,
            shortcut: formatShortcutAction(zoomInShortcut.id, platform),
            category: zoomInShortcut.category,
            execute: zoomInApp,
        });

        register({
            id: "app:zoom-out",
            label: zoomOutShortcut.label,
            shortcut: formatShortcutAction(zoomOutShortcut.id, platform),
            category: zoomOutShortcut.category,
            execute: zoomOutApp,
        });

        register({
            id: "app:zoom-reset",
            label: resetZoomShortcut.label,
            shortcut: formatShortcutAction(resetZoomShortcut.id, platform),
            category: resetZoomShortcut.category,
            execute: resetAppToActualSize,
        });

        register({
            id: "workspace:split-right",
            label: "Split Right",
            category: "Workspace",
            when: canSplitPane,
            execute: () => {
                useEditorStore.getState().splitEditorPane("row");
            },
        });

        register({
            id: "workspace:split-down",
            label: "Split Down",
            category: "Workspace",
            when: canSplitPane,
            execute: () => {
                useEditorStore.getState().splitEditorPane("column");
            },
        });

        register({
            id: "workspace:focus-left",
            label: "Focus Pane Left",
            category: "Workspace",
            when: () => hasPaneNeighbor("left"),
            execute: () => {
                useEditorStore.getState().focusPaneNeighbor("left");
            },
        });

        register({
            id: "workspace:focus-right",
            label: "Focus Pane Right",
            category: "Workspace",
            when: () => hasPaneNeighbor("right"),
            execute: () => {
                useEditorStore.getState().focusPaneNeighbor("right");
            },
        });

        register({
            id: "workspace:focus-up",
            label: "Focus Pane Up",
            category: "Workspace",
            when: () => hasPaneNeighbor("up"),
            execute: () => {
                useEditorStore.getState().focusPaneNeighbor("up");
            },
        });

        register({
            id: "workspace:focus-down",
            label: "Focus Pane Down",
            category: "Workspace",
            when: () => hasPaneNeighbor("down"),
            execute: () => {
                useEditorStore.getState().focusPaneNeighbor("down");
            },
        });

        register({
            id: "workspace:balance-layout",
            label: "Balance Layout",
            category: "Workspace",
            when: canClosePane,
            execute: () => {
                useEditorStore.getState().balancePaneLayout();
            },
        });

        register({
            id: "workspace:close-pane",
            label: "Close Pane",
            category: "Workspace",
            when: canClosePane,
            execute: () => {
                const state = useEditorStore.getState();
                const focusedPaneId = selectFocusedPaneId(state);
                if (!focusedPaneId) {
                    return;
                }
                state.closePane(focusedPaneId);
            },
        });

        // Layout
        register({
            id: "layout:toggle-sidebar",
            label: toggleSidebarShortcut.label,
            shortcut: formatShortcutAction(toggleSidebarShortcut.id, platform),
            category: toggleSidebarShortcut.category,
            execute: () => useLayoutStore.getState().toggleSidebar(),
        });

        register({
            id: "layout:toggle-right-panel",
            label: toggleRightPanelShortcut.label,
            shortcut: formatShortcutAction(
                toggleRightPanelShortcut.id,
                platform,
            ),
            category: toggleRightPanelShortcut.category,
            execute: () => useLayoutStore.getState().toggleRightPanel(),
        });

        register({
            id: "app:open-settings",
            label: openSettingsShortcut.label,
            shortcut: formatShortcutAction(openSettingsShortcut.id, platform),
            category: openSettingsShortcut.category,
            execute: openSettings,
        });

        register({
            id: "developer:restart-terminal",
            label: "Restart Active Terminal",
            category: "Developer",
            when: canRestartActiveTerminal,
            execute: () => {
                const tab = activeTerminalTab();
                if (!tab) return;
                void useTerminalRuntimeStore
                    .getState()
                    .restart(tab.terminalId);
            },
        });

        register({
            id: "developer:new-terminal-tab",
            label: "New Terminal",
            category: "Developer",
            when: developerModeEnabled,
            execute: () => {
                useEditorStore.getState().openTerminal();
            },
        });
    }, [
        register,
        openCommandPalette,
        openQuickSwitcher,
        openSettings,
        developerCommandsEnabled,
    ]);
}

// Global keyboard shortcuts that dispatch to the command store
function useGlobalShortcuts(openSettings: () => void) {
    const openCommandPalette = useCommandStore((s) => s.openCommandPalette);
    const closeModal = useCommandStore((s) => s.closeModal);
    const activeModal = useCommandStore((s) => s.activeModal);

    useEffect(() => {
        const platform = getDesktopPlatform();
        const handler = (e: KeyboardEvent) => {
            if (e.defaultPrevented) return;

            // Escape closes any modal
            if (e.key === "Escape" && activeModal) {
                e.preventDefault();
                closeModal();
                return;
            }

            if (matchesShortcutAction(e, "open_settings", platform)) {
                e.preventDefault();
                openSettings();
                return;
            }

            if (matchesShortcutAction(e, "command_palette", platform)) {
                e.preventDefault();
                if (activeModal === "command-palette") {
                    closeModal();
                } else {
                    openCommandPalette();
                }
                return;
            }

            if (matchesShortcutAction(e, "quick_switcher", platform)) {
                e.preventDefault();
                if (activeModal === "quick-switcher") {
                    closeModal();
                } else {
                    useCommandStore.getState().execute("nav:quick-switcher");
                }
                return;
            }

            if (matchesShortcutAction(e, "open_vault", platform)) {
                e.preventDefault();
                useCommandStore.getState().execute("vault:open");
                return;
            }

            if (matchesShortcutAction(e, "toggle_left_sidebar", platform)) {
                e.preventDefault();
                useCommandStore.getState().execute("layout:toggle-sidebar");
                return;
            }

            if (matchesShortcutAction(e, "toggle_right_panel", platform)) {
                e.preventDefault();
                useCommandStore.getState().execute("layout:toggle-right-panel");
                return;
            }

            if (matchesShortcutAction(e, "zoom_in", platform)) {
                e.preventDefault();
                useCommandStore.getState().execute("app:zoom-in");
                return;
            }

            if (matchesShortcutAction(e, "zoom_out", platform)) {
                e.preventDefault();
                useCommandStore.getState().execute("app:zoom-out");
                return;
            }

            if (matchesShortcutAction(e, "reset_zoom", platform)) {
                e.preventDefault();
                useCommandStore.getState().execute("app:zoom-reset");
                return;
            }

            if (matchesShortcutAction(e, "new_note", platform)) {
                e.preventDefault();
                useCommandStore.getState().execute("vault:new-note");
                return;
            }

            if (matchesShortcutAction(e, "new_agent", platform)) {
                e.preventDefault();
                useCommandStore.getState().execute("ai:new-agent");
                return;
            }

            if (matchesShortcutAction(e, "close_tab", platform)) {
                e.preventDefault();
                useCommandStore.getState().execute("editor:close-tab");
                return;
            }

            if (matchesShortcutAction(e, "reopen_closed_tab", platform)) {
                e.preventDefault();
                useCommandStore.getState().execute("editor:reopen-closed-tab");
                return;
            }

            if (matchesShortcutAction(e, "next_tab", platform)) {
                e.preventDefault();
                cycleEditorTabs(false);
                return;
            }

            if (matchesShortcutAction(e, "previous_tab", platform)) {
                e.preventDefault();
                cycleEditorTabs(true);
                return;
            }

            if (matchesShortcutAction(e, "new_tab", platform)) {
                e.preventDefault();
                useCommandStore.getState().execute("editor:new-tab");
                return;
            }

            if (matchesShortcutAction(e, "toggle_live_preview", platform)) {
                e.preventDefault();
                useCommandStore
                    .getState()
                    .execute("editor:toggle-live-preview");
                return;
            }
        };

        window.addEventListener("keydown", handler, true);
        return () => window.removeEventListener("keydown", handler, true);
    }, [activeModal, closeModal, openCommandPalette, openSettings]);
}

function useAppWebviewZoom() {
    const [appZoom, setAppZoom] = useState(() => readAppZoom());

    useEffect(() => {
        return subscribeAppZoom((nextZoom) => {
            setAppZoom(nextZoom);
        });
    }, []);

    useEffect(() => {
        const applyZoom = async () => {
            try {
                await getCurrentWebview().setZoom(appZoom);
            } catch {
                // Ignore unsupported environments such as tests.
            }
        };

        void applyZoom();
    }, [appZoom]);
}

function useNativeMenuActions(windowMode: ReturnType<typeof getWindowMode>) {
    useEffect(() => {
        let disposed = false;
        let unlisten: (() => void) | null = null;

        resolveDeferredUnlisten(
            listen<string>(MENU_ACTION_EVENT, (event) => {
                if (disposed) return;
                useCommandStore.getState().execute(event.payload);
            }),
            {
                isDisposed: () => disposed,
                onResolved: (cleanup) => {
                    unlisten = cleanup;
                },
            },
        );

        return () => {
            disposed = true;
            unlisten?.();
        };
    }, []);

    useEffect(() => {
        if (windowMode !== "main") return;

        let disposed = false;
        let unlisten: (() => void) | null = null;

        resolveDeferredUnlisten(
            listen<string>(DOCK_OPEN_VAULT_EVENT, (event) => {
                if (disposed) return;
                void openVaultWindow(event.payload);
            }),
            {
                isDisposed: () => disposed,
                onResolved: (cleanup) => {
                    unlisten = cleanup;
                },
            },
        );

        return () => {
            disposed = true;
            unlisten?.();
        };
    }, [windowMode]);
}

function canScrollElement(element: HTMLElement) {
    const style = window.getComputedStyle(element);
    const canScrollY =
        (style.overflowY === "auto" ||
            style.overflowY === "scroll" ||
            style.overflowY === "overlay") &&
        element.scrollHeight > element.clientHeight;
    const canScrollX =
        (style.overflowX === "auto" ||
            style.overflowX === "scroll" ||
            style.overflowX === "overlay") &&
        element.scrollWidth > element.clientWidth;

    return canScrollY || canScrollX;
}

function resolveScrollbarActivationTarget(element: HTMLElement) {
    const editorShell = element.closest(".editor-shell");
    if (editorShell instanceof HTMLElement && element.closest(".cm-editor")) {
        return editorShell;
    }

    return element;
}

function findScrollableAncestor(target: EventTarget | null) {
    let current = target instanceof HTMLElement ? target : null;

    while (current) {
        if (canScrollElement(current)) {
            return resolveScrollbarActivationTarget(current);
        }
        current = current.parentElement;
    }

    return null;
}

function useDynamicScrollbars() {
    useEffect(() => {
        const activeTimers = new Map<HTMLElement, number>();

        const markActive = (element: HTMLElement | null) => {
            if (!element) return;

            element.dataset.scrollbarActive = "true";

            const existing = activeTimers.get(element);
            if (existing) {
                window.clearTimeout(existing);
            }

            const timeout = window.setTimeout(() => {
                delete element.dataset.scrollbarActive;
                activeTimers.delete(element);
            }, 650);

            activeTimers.set(element, timeout);
        };

        const handleScroll = (event: Event) => {
            const element =
                event.target instanceof HTMLElement ? event.target : null;
            markActive(
                element && canScrollElement(element)
                    ? resolveScrollbarActivationTarget(element)
                    : null,
            );
        };

        const handleWheel = (event: WheelEvent) => {
            markActive(findScrollableAncestor(event.target));
        };

        const handleTouchMove = (event: TouchEvent) => {
            markActive(findScrollableAncestor(event.target));
        };

        window.addEventListener("scroll", handleScroll, true);
        window.addEventListener("wheel", handleWheel, {
            capture: true,
            passive: true,
        });
        window.addEventListener("touchmove", handleTouchMove, {
            capture: true,
            passive: true,
        });

        return () => {
            window.removeEventListener("scroll", handleScroll, true);
            window.removeEventListener("wheel", handleWheel, true);
            window.removeEventListener("touchmove", handleTouchMove, true);

            for (const timeout of activeTimers.values()) {
                window.clearTimeout(timeout);
            }
        };
    }, []);
}

export default function App() {
    const editorPaneSizes = useLayoutStore((s) => s.editorPaneSizes);
    const setEditorPaneSizes = useLayoutStore((s) => s.setEditorPaneSizes);
    const restoreVault = useVaultStore((s) => s.restoreVault);
    const vaultPath = useVaultStore((s) => s.vaultPath);
    const applyVaultNoteChange = useVaultStore((s) => s.applyVaultNoteChange);
    const refreshEntries = useVaultStore((s) => s.refreshEntries);
    const refreshStructure = useVaultStore((s) => s.refreshStructure);
    const hydrateWorkspace = useEditorStore((s) => s.hydrateWorkspace);
    const hydrateTabs = useEditorStore((s) => s.hydrateTabs);
    const workspaceTabs = useEditorStore(useShallow(selectEditorWorkspaceTabs));
    const workspacePinnedTabIds = useEditorStore(
        useShallow((state) =>
            getEffectivePaneWorkspace(state).panes.flatMap(
                (pane) => pane.pinnedTabIds,
            ),
        ),
    );
    const focusedWorkspaceTabId = useEditorStore(
        (state) => selectFocusedEditorTab(state)?.id ?? null,
    );
    const chatTabsReady = useChatTabsStore((s) => s.isReady);
    const hydrateChatWorkspace = useChatTabsStore((s) => s.hydrateForVault);
    const restoreChatWorkspace = useChatTabsStore((s) => s.restoreWorkspace);
    const windowMode = getWindowMode();
    const vaultParam = readSearchParam("vault");
    const [windowSessionReady, setWindowSessionReady] = useState(
        !(
            windowMode === "main" &&
            getCurrentWindowLabel() === "main" &&
            vaultParam === null
        ),
    );
    const pendingNoteReloadsRef = useRef<
        Map<string, ReturnType<typeof setTimeout>>
    >(new Map());
    const noteReloadVersionRef = useRef<Map<string, number>>(new Map());
    const pendingFileReloadsRef = useRef<
        Map<string, ReturnType<typeof setTimeout>>
    >(new Map());
    const fileReloadVersionRef = useRef<Map<string, number>>(new Map());

    const openSettings = useCallback(
        (section?: string) =>
            void openSettingsWindow(
                vaultPath,
                section ? { section } : undefined,
            ),
        [vaultPath],
    );
    useEffect(() => {
        if (windowMode !== "main") {
            return;
        }
        void useAppUpdateStore.getState().initialize({ backgroundCheck: true });
    }, [windowMode]);

    useEffect(() => {
        if (windowMode === "settings" || windowMode === "ghost") {
            writeWindowOperationalState(getCurrentWindowLabel(), null);
            return;
        }

        const label = getCurrentWindowLabel();
        let publishTimer: number | null = null;

        const publishNow = () => {
            publishTimer = null;
            const editor = useEditorStore.getState();
            const chat = useChatStore.getState();
            writeWindowOperationalState(
                label,
                buildWindowOperationalState({
                    label,
                    windowMode,
                    vaultPath,
                    tabs: selectEditorWorkspaceTabs(editor),
                    dirtyTabIds: editor.dirtyTabIds,
                    sessionsById: chat.sessionsById,
                }),
            );
        };

        const schedulePublish = () => {
            if (publishTimer !== null) {
                window.clearTimeout(publishTimer);
            }
            publishTimer = window.setTimeout(
                publishNow,
                WINDOW_OPERATIONAL_STATE_PUBLISH_DEBOUNCE_MS,
            );
        };

        publishNow();
        const unsubscribeEditor = useEditorStore.subscribe(schedulePublish);
        const unsubscribeChat = useChatStore.subscribe(schedulePublish);

        return () => {
            if (publishTimer !== null) {
                window.clearTimeout(publishTimer);
            }
            unsubscribeEditor();
            unsubscribeChat();
            writeWindowOperationalState(label, null);
        };
    }, [vaultPath, windowMode]);

    const showWebClipperSavedNotice = useCallback(
        (payload: WebClipperSavedPayload) => {
            const currentWindowLabel = getCurrentWindowLabel();
            const currentVaultPath = useVaultStore.getState().vaultPath;
            if (
                payload.targetWindowLabel !== null &&
                payload.targetWindowLabel !== currentWindowLabel
            ) {
                return;
            }
            if (!currentVaultPath || currentVaultPath !== payload.vaultPath) {
                return;
            }

            useClipImportStore.getState().showNotice({
                id: payload.requestId,
                title: payload.title,
                message: "Saved to vault.",
                relativePath: payload.relativePath,
            });
        },
        [],
    );

    const routeWebClipperClip = useCallback(
        (payload: WebClipperSavedPayload) => {
            showWebClipperSavedNotice(payload);
        },
        [showWebClipperSavedNotice],
    );

    useRegisterCommands(openSettings, windowMode === "main");
    useGlobalShortcuts(openSettings);
    useAppWebviewZoom();
    useNativeMenuActions(windowMode);
    useDynamicScrollbars();
    const restoreSessionForCurrentVault = useCallback(async () => {
        const vaultPath = useVaultStore.getState().vaultPath;
        const restored = await restorePersistedSession(vaultPath, {
            includeMaps: EXCALIDRAW_RUNTIME_SUPPORTED,
        });
        const restoredPanes = restored
            ? restored.panes?.length && restored.panes.length > 0
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
                  ]
            : [
                  {
                      id: "primary",
                      tabs: [],
                      activeTabId: null,
                  },
              ];
        const migrated = migrateLegacyTerminalTabsToWorkspace({
            vaultPath,
            panes: restoredPanes,
            focusedPaneId:
                restored?.focusedPaneId ?? restoredPanes[0]?.id ?? null,
        });

        if (!restored && !migrated.migrated) {
            setEditorPaneSizes(1, []);
            return;
        }
        const paneCount = migrated.panes.length;
        setEditorPaneSizes(paneCount, restored?.paneSizes ?? []);
        hydrateWorkspace(
            migrated.panes,
            restored?.focusedPaneId ?? migrated.panes[0]?.id ?? null,
            restored?.layoutTree,
        );
    }, [hydrateWorkspace, setEditorPaneSizes]);

    useEffect(() => {
        const blockNativeContextMenu = (event: MouseEvent) => {
            if (shouldAllowNativeContextMenu(event.target)) {
                return;
            }

            event.preventDefault();
        };

        window.addEventListener("contextmenu", blockNativeContextMenu, true);
        return () =>
            window.removeEventListener(
                "contextmenu",
                blockNativeContextMenu,
                true,
            );
    }, []);

    useEffect(() => {
        if (windowMode === "settings") return;
        if (windowMode === "ghost") return;
        if (!windowSessionReady) return;

        const label = getCurrentWindowLabel();
        const entry = buildWindowSessionEntry({
            label,
            windowMode,
            vaultPath,
            tabs: workspaceTabs,
            activeTabId: focusedWorkspaceTabId,
            pinnedTabIds: workspacePinnedTabIds,
        });

        writeWindowSessionEntry(label, entry);

        const refresh = () => {
            void refreshWindowSessionSnapshot();
        };

        refresh();
        window.addEventListener("focus", refresh);
        const interval = window.setInterval(refresh, 2000);

        return () => {
            window.removeEventListener("focus", refresh);
            window.clearInterval(interval);
        };
    }, [
        focusedWorkspaceTabId,
        vaultPath,
        windowMode,
        windowSessionReady,
        workspacePinnedTabIds,
        workspaceTabs,
    ]);

    useEffect(() => {
        if (!isSessionReady()) return;
        if (!vaultPath) return;

        const timer = window.setTimeout(() => {
            const editor = useEditorStore.getState();
            const paneIds = selectLeafPaneIds(editor);
            const focusedPaneId = selectFocusedPaneId(editor);
            writePersistedSession(
                vaultPath,
                buildPersistedSession({
                    panes: paneIds.map((paneId) =>
                        selectPaneState(editor, paneId),
                    ),
                    focusedPaneId,
                    layoutTree: editor.layoutTree,
                    paneSizes: useLayoutStore.getState().editorPaneSizes,
                }),
            );
        }, 250);

        return () => window.clearTimeout(timer);
    }, [editorPaneSizes, vaultPath]);

    useEffect(() => {
        if (windowMode === "settings") return;
        if (windowMode === "ghost") return;

        const label = getCurrentWindowLabel();
        const registerRoute = () => {
            void invoke("register_window_vault_route", {
                label,
                windowMode,
                vaultPath,
            });
        };
        const unregisterRoute = () => {
            void invoke("unregister_window_vault_route", { label });
        };

        registerRoute();
        window.addEventListener("focus", registerRoute);
        window.addEventListener("beforeunload", unregisterRoute);

        return () => {
            window.removeEventListener("focus", registerRoute);
            window.removeEventListener("beforeunload", unregisterRoute);
            unregisterRoute();
        };
    }, [vaultPath, windowMode]);

    useEffect(() => {
        if (windowMode === "settings") return;
        if (windowMode !== "main") {
            const payload = readDetachedWindowPayload(getCurrentWindowLabel());
            let cancelled = false;

            void bootstrapDetachedWindow(payload, {
                openVault: async (path) => {
                    if (cancelled) return;
                    await useVaultStore.getState().openVault(path);
                },
                hydrateTabs: (tabs, activeTabId, pinnedTabIds, options) => {
                    if (cancelled) return;
                    hydrateTabs(tabs, activeTabId, pinnedTabIds, options);
                },
                hydrateAiSessions: (sessions, activeTabId, tabs) => {
                    if (cancelled) return;
                    const activeTab = tabs.find(
                        (tab) => tab.id === activeTabId,
                    );
                    const activeChatSessionId =
                        activeTab && isChatTab(activeTab)
                            ? activeTab.sessionId
                            : null;

                    for (const session of sessions) {
                        useChatStore
                            .getState()
                            .upsertSession(
                                session,
                                session.sessionId === activeChatSessionId,
                            );
                    }
                },
            });

            return () => {
                cancelled = true;
            };
        }

        void (async () => {
            if (vaultParam) {
                await useVaultStore
                    .getState()
                    .openVault(decodeURIComponent(vaultParam));
                await restoreSessionForCurrentVault();
            } else if (getCurrentWindowLabel() === "main") {
                const restored = await restoreWindowSession({
                    openPrimaryVault: async (path) => {
                        await useVaultStore.getState().openVault(path);
                    },
                    restorePrimaryVaultSession: restoreSessionForCurrentVault,
                    openVaultWindow,
                    openDetachedNoteWindow,
                });
                if (restored) {
                    markSessionReady();
                    return;
                }
            } else {
                await restoreVault();
                await restoreSessionForCurrentVault();
            }

            markSessionReady();
            setWindowSessionReady(true);
        })();
    }, [
        hydrateTabs,
        restoreSessionForCurrentVault,
        restoreVault,
        vaultParam,
        windowMode,
    ]);

    useEffect(() => {
        if (windowMode !== "main") return;

        resetChatStore();
        resetChatTabsStore();

        if (!vaultPath) return;

        let cancelled = false;

        void (async () => {
            const workspace = readPersistedChatWorkspace(vaultPath);
            let restoredWorkspace = false;

            try {
                const initialization =
                    await useChatStore.getState().initialize();
                if (cancelled) return;

                if (!initialization.sessionInventoryLoaded) {
                    // Keep the persisted tab layout intact when session
                    // discovery fails so we do not overwrite it with an empty
                    // workspace on the next persistence flush.
                    hydrateChatWorkspace(workspace);
                    restoredWorkspace = true;
                    return;
                }

                const chatState = useChatStore.getState();
                restoreChatWorkspace(
                    workspace,
                    Object.values(chatState.sessionsById).map((session) => ({
                        sessionId: session.sessionId,
                        historySessionId: session.historySessionId,
                        runtimeId: session.runtimeId,
                    })),
                    chatState.activeSessionId,
                );
                restoredWorkspace = true;

                const restoredChatWorkspace = useChatTabsStore.getState();
                const persistedChatMetadataBySessionId = new Map(
                    (workspace?.tabs ?? []).map((tab) => [tab.sessionId, tab]),
                );
                const restoredChatMetadataBySessionId = new Map(
                    restoredChatWorkspace.tabs.map((tab) => [tab.sessionId, tab]),
                );
                const restoredChatMetadataByHistoryId = new Map(
                    restoredChatWorkspace.tabs.flatMap((tab) =>
                        tab.historySessionId
                            ? [[tab.historySessionId, tab] as const]
                            : [],
                    ),
                );
                const sessionIdByHistoryId = new Map(
                    Object.values(chatState.sessionsById).flatMap((session) =>
                        session.historySessionId
                            ? [
                                  [
                                      session.historySessionId,
                                      session.sessionId,
                                  ] as const,
                              ]
                            : [],
                    ),
                );
                const resolveEditorChatHistorySessionId = (
                    sessionId: string,
                    historySessionId?: string | null,
                ) =>
                    historySessionId ??
                    chatState.sessionsById[sessionId]?.historySessionId ??
                    persistedChatMetadataBySessionId.get(sessionId)
                        ?.historySessionId ??
                    restoredChatMetadataBySessionId.get(sessionId)
                        ?.historySessionId ??
                    (sessionId.startsWith("persisted:")
                        ? sessionId.slice("persisted:".length)
                        : null);

                const initialEditorState = useEditorStore.getState();
                for (const tab of selectEditorWorkspaceTabs(
                    initialEditorState,
                ).filter(isChatTab)) {
                    const resolvedHistorySessionId =
                        resolveEditorChatHistorySessionId(
                            tab.sessionId,
                            tab.historySessionId,
                        );
                    if (!resolvedHistorySessionId) {
                        continue;
                    }

                    const resolvedSessionId =
                        sessionIdByHistoryId.get(resolvedHistorySessionId) ??
                        restoredChatMetadataByHistoryId.get(
                            resolvedHistorySessionId,
                        )?.sessionId ??
                        tab.sessionId;

                    if (
                        resolvedSessionId !== tab.sessionId ||
                        resolvedHistorySessionId !== tab.historySessionId
                    ) {
                        useEditorStore.getState().replaceAiSessionId(
                            tab.sessionId,
                            resolvedSessionId,
                            resolvedHistorySessionId,
                        );
                    }
                }

                const editorState = useEditorStore.getState();
                const focusedEditorTab = selectFocusedEditorTab(editorState);
                await useChatStore.getState().reconcileRestoredWorkspaceTabs(
                    selectEditorWorkspaceTabs(editorState)
                        .filter((tab) => isChatTab(tab))
                        .map((tab) => {
                            const resolvedHistorySessionId =
                                resolveEditorChatHistorySessionId(
                                    tab.sessionId,
                                    tab.historySessionId,
                                );
                            const metadata =
                                restoredChatMetadataBySessionId.get(
                                    tab.sessionId,
                                ) ??
                                (resolvedHistorySessionId
                                    ? restoredChatMetadataByHistoryId.get(
                                          resolvedHistorySessionId,
                                      )
                                    : undefined);
                            return {
                                id: tab.id,
                                sessionId: tab.sessionId,
                                historySessionId:
                                    resolvedHistorySessionId ?? null,
                                runtimeId:
                                    metadata?.runtimeId ??
                                    chatState.sessionsById[tab.sessionId]
                                        ?.runtimeId ??
                                    null,
                            };
                        }),
                    isChatTab(focusedEditorTab) ? focusedEditorTab.id : null,
                );
            } catch (error) {
                if (!restoredWorkspace) {
                    hydrateChatWorkspace(workspace);
                }
                logError(
                    "chat",
                    "Failed to restore chat workspace on startup",
                    error,
                );
            } finally {
                if (!cancelled) {
                    markChatTabsReady();
                }
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [hydrateChatWorkspace, restoreChatWorkspace, vaultPath, windowMode]);

    // Load bookmarks when vault changes
    useEffect(() => {
        if (vaultPath) {
            useBookmarkStore.getState().loadForVault(vaultPath);
        } else {
            useBookmarkStore.getState().reset();
        }
    }, [vaultPath]);

    useEffect(() => {
        if (windowMode !== "main") return;

        const flush = () => {
            flushChatTabsPersistence();
        };

        window.addEventListener("beforeunload", flush);
        return () => {
            window.removeEventListener("beforeunload", flush);
        };
    }, [windowMode]);

    useEffect(() => {
        if (windowMode !== "main") return;

        let disposed = false;
        let unlisten: (() => void) | null = null;
        const pendingNoteReloads = pendingNoteReloadsRef.current;
        const noteReloadVersions = noteReloadVersionRef.current;
        const pendingFileReloads = pendingFileReloadsRef.current;
        const fileReloadVersions = fileReloadVersionRef.current;

        resolveDeferredUnlisten(
            listen<VaultNoteChange>("vault://note-changed", (event) => {
                if (disposed) return;

                // Only process changes for the current vault
                const currentVaultPath = useVaultStore.getState().vaultPath;
                if (
                    event.payload.vault_path &&
                    currentVaultPath &&
                    event.payload.vault_path !== currentVaultPath
                )
                    return;

                const syncStrategy = getVaultChangeSyncStrategy(event.payload);
                if (
                    syncStrategy === "apply-note-change-and-refresh-entries"
                ) {
                    applyVaultNoteChange(event.payload);
                    void refreshEntries();
                } else if (syncStrategy === "refresh-entries") {
                    void refreshEntries();
                } else if (syncStrategy === "refresh-structure") {
                    void refreshStructure();
                }

                // Reload editor content for open tabs when file changes externally
                const change = event.payload;
                void useChatStore
                    .getState()
                    .reconcileTrackedFilesFromVaultChange(change);
                if (change.kind === "upsert" && change.note) {
                    invalidateLivePreviewNoteCache(change.note.id);
                    const noteId = change.note.id;
                    const openTab = selectEditorWorkspaceTabs(
                        useEditorStore.getState(),
                    ).find((t) => isNoteTab(t) && t.noteId === noteId);
                    if (openTab) {
                        const previousTimer =
                            pendingNoteReloads.get(noteId) ?? null;
                        if (previousTimer) {
                            clearTimeout(previousTimer);
                        }

                        const nextVersion =
                            (noteReloadVersions.get(noteId) ?? 0) + 1;
                        noteReloadVersions.set(noteId, nextVersion);

                        const timer = setTimeout(() => {
                            pendingNoteReloads.delete(noteId);

                            void vaultInvoke<{
                                title: string;
                                content: string;
                            }>("read_note", {
                                noteId,
                            }).then((detail) => {
                                if (
                                    noteReloadVersions.get(noteId) !==
                                    nextVersion
                                ) {
                                    return;
                                }
                                useEditorStore
                                    .getState()
                                    .reloadNoteContent(noteId, {
                                        title: detail.title,
                                        content: detail.content,
                                        origin: change.origin,
                                        opId: change.op_id,
                                        revision: change.revision,
                                        contentHash: change.content_hash,
                                    });
                            });
                        }, 180);

                        pendingNoteReloads.set(noteId, timer);
                    }
                } else if (
                    change.kind === "upsert" &&
                    change.entry?.kind === "file" &&
                    change.relative_path
                ) {
                    const relativePath = change.relative_path;
                    const openTab = selectEditorWorkspaceTabs(
                        useEditorStore.getState(),
                    ).find(
                        (t) =>
                            isFileTab(t) &&
                            fileViewerNeedsTextContent(t.viewer) &&
                            t.relativePath === relativePath,
                    );
                    if (openTab) {
                        const previousTimer =
                            pendingFileReloads.get(relativePath) ?? null;
                        if (previousTimer) {
                            clearTimeout(previousTimer);
                        }

                        const nextVersion =
                            (fileReloadVersions.get(relativePath) ?? 0) + 1;
                        fileReloadVersions.set(relativePath, nextVersion);

                        const timer = setTimeout(() => {
                            pendingFileReloads.delete(relativePath);

                            void vaultInvoke<{
                                file_name: string;
                                content: string;
                                size_bytes?: number | null;
                                content_truncated?: boolean;
                            }>("read_vault_file", {
                                relativePath,
                            }).then((detail) => {
                                if (
                                    fileReloadVersions.get(relativePath) !==
                                    nextVersion
                                ) {
                                    return;
                                }
                                useEditorStore
                                    .getState()
                                    .reloadFileContent(relativePath, {
                                        title: detail.file_name,
                                        content: detail.content,
                                        sizeBytes: detail.size_bytes ?? null,
                                        contentTruncated: Boolean(
                                            detail.content_truncated,
                                        ),
                                        origin: change.origin,
                                        opId: change.op_id,
                                        revision: change.revision,
                                        contentHash: change.content_hash,
                                    });
                            });
                        }, 180);

                        pendingFileReloads.set(relativePath, timer);
                    }
                } else if (change.kind === "delete") {
                    invalidateLivePreviewNoteCache(change.note_id);
                    if (change.relative_path) {
                        useEditorStore
                            .getState()
                            .handleFileDeleted(change.relative_path);
                    }
                }
            }),
            {
                isDisposed: () => disposed,
                onResolved: (cleanup) => {
                    unlisten = cleanup;
                },
            },
        );

        return () => {
            disposed = true;
            for (const timer of pendingNoteReloads.values()) {
                clearTimeout(timer);
            }
            pendingNoteReloads.clear();
            noteReloadVersions.clear();
            for (const timer of pendingFileReloads.values()) {
                clearTimeout(timer);
            }
            pendingFileReloads.clear();
            fileReloadVersions.clear();
            unlisten?.();
        };
    }, [applyVaultNoteChange, refreshEntries, refreshStructure, windowMode]);

    useEffect(() => {
        let disposed = false;
        let unlisten: (() => void) | null = null;

        resolveDeferredUnlisten(
            getCurrentWindow().listen<AttachExternalTabPayload>(
                ATTACH_EXTERNAL_TAB_EVENT,
                (event) => {
                    if (disposed) return;
                    for (const session of event.payload.aiSessions ?? []) {
                        useChatStore
                            .getState()
                            .upsertSession(
                                session,
                                isChatTab(event.payload.tab) &&
                                    session.sessionId ===
                                        event.payload.tab.sessionId,
                            );
                    }
                    const editor = useEditorStore.getState();
                    const targetPaneId =
                        selectFocusedPaneId(editor) ??
                        selectLeafPaneIds(editor)[0] ??
                        null;

                    if (targetPaneId) {
                        editor.insertExternalTabInPane(
                            event.payload.tab,
                            targetPaneId,
                        );
                        return;
                    }

                    editor.insertExternalTab(event.payload.tab);
                },
            ),
            {
                isDisposed: () => disposed,
                onResolved: (cleanup) => {
                    unlisten = cleanup;
                },
            },
        );

        return () => {
            disposed = true;
            unlisten?.();
        };
    }, []);

    useEffect(() => {
        if (windowMode !== "main") return;

        let disposed = false;
        let unlisten: (() => void) | null = null;

        resolveDeferredUnlisten(
            listen<WebClipperSavedPayload>(
                WEB_CLIPPER_CLIP_SAVED_EVENT,
                (event) => {
                    if (disposed) return;
                    showWebClipperSavedNotice(event.payload);
                },
            ),
            {
                isDisposed: () => disposed,
                onResolved: (cleanup) => {
                    unlisten = cleanup;
                },
            },
        );

        return () => {
            disposed = true;
            unlisten?.();
        };
    }, [showWebClipperSavedNotice, windowMode]);

    useEffect(() => {
        if (windowMode !== "main") return;

        let disposed = false;
        let unlisten: (() => void) | null = null;

        resolveDeferredUnlisten(
            listen<WebClipperSavedPayload>(
                WEB_CLIPPER_ROUTE_CLIP_EVENT,
                (event) => {
                    if (disposed) return;
                    void routeWebClipperClip(event.payload);
                },
            ),
            {
                isDisposed: () => disposed,
                onResolved: (cleanup) => {
                    unlisten = cleanup;
                },
            },
        );

        return () => {
            disposed = true;
            unlisten?.();
        };
    }, [routeWebClipperClip, windowMode]);

    if (windowMode === "ghost") {
        const title = readSearchParam("title") ?? "Tab";
        return (
            <div
                style={{
                    width: "100%",
                    height: "100%",
                    display: "flex",
                    alignItems: "center",
                    padding: "0 12px",
                    background: "var(--bg-secondary)",
                    color: "var(--text-primary)",
                    fontSize: 12,
                    fontWeight: 500,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    userSelect: "none",
                    pointerEvents: "none",
                }}
            >
                {title}
            </div>
        );
    }

    if (windowMode === "settings") {
        return <SettingsPanel standalone onClose={() => {}} />;
    }

    if (windowMode === "note") {
        return (
            <div className="h-full min-h-0 min-w-0 flex flex-col overflow-hidden">
                <AIChatDetachedWindowHost />
                <WorkspaceTerminalHost />
                <UnifiedBar windowMode="note" />
                <div className="flex-1 min-h-0 min-w-0 overflow-hidden flex flex-col">
                    <EditorPaneContent emptyStateMessage="Esta ventana no tiene ninguna nota abierta" />
                </div>
                <YouTubeModalHost />
                <CommandPalette />
                <QuickSwitcher />
            </div>
        );
    }

    return (
        <div className="h-full flex flex-col overflow-hidden">
            <AIChatWorkspaceHost
                startupReady={chatTabsReady}
                listenWithoutChatTabs
            />
            <WorkspaceTerminalHost />

            {/* EditorChromeBar only renders on Windows (to reserve the
                trailing space for the native titleBarOverlay controls). On
                macOS it returns null: the sidebar owns the traffic-light
                inset and the pane bars are free to sit flush against the top
                of the window, giving the editor more vertical real estate. */}
            <div className="relative flex-1 flex overflow-hidden">
                <AppLayout
                    left={<SidebarShell onOpenSettings={openSettings} />}
                    center={
                        <div className="flex h-full min-h-0 flex-col overflow-hidden">
                            <EditorChromeBar />
                            {/* Editor body paints its own opaque background so
                                the translucent surfaces above read as frosted
                                strips while the editor surface stays solid. */}
                            <div
                                className="min-h-0 flex-1 overflow-hidden"
                                style={{
                                    backgroundColor: "var(--bg-primary)",
                                }}
                            >
                                <MultiPaneWorkspace />
                            </div>
                        </div>
                    }
                    right={<RightPanel />}
                />
                <VaultOpeningOverlay />
            </div>

            <YouTubeModalHost />
            <ClipNotification />
            <CommandPalette />
            <QuickSwitcher />
        </div>
    );
}
