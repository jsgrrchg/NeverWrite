import { useState, useEffect, useCallback, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { resolveDeferredUnlisten } from "./app/utils/deferredUnlisten";
import { vaultInvoke } from "./app/utils/vaultInvoke";
import { AppLayout } from "./components/layout/AppLayout";
import { ActivityBar, type SidebarView } from "./components/layout/ActivityBar";
import { FileTree } from "./features/vault/FileTree";
import { VaultSwitcher } from "./features/vault/VaultSwitcher";
import { TagsPanel } from "./features/tags/TagsPanel";
import { SearchPanel } from "./features/search/SearchPanel";
import { LinksPanel } from "./features/notes/LinksPanel";
import { OutlinePanel } from "./features/notes/OutlinePanel";
import { AIChatPanel } from "./features/ai/AIChatPanel";
import { AIChatDetachedWindowHost } from "./features/ai/AIChatDetachedWindowHost";
import { UnifiedBar } from "./features/editor/UnifiedBar";
import { REQUEST_CLOSE_ACTIVE_TAB_EVENT } from "./features/editor/Editor";
import { useAutoOpenReviewTab } from "./features/ai/hooks/useAutoOpenReviewTab";
import { EditorPaneContent } from "./features/editor/EditorPaneContent";
import { MultiPaneWorkspace } from "./features/editor/MultiPaneWorkspace";
import { WorkspaceChromeBar } from "./features/editor/WorkspaceChromeBar";
import { MapsPanel } from "./features/maps/MapsPanel";
import { BookmarksPanel } from "./features/bookmarks/BookmarksPanel";
import { useBookmarkStore } from "./app/store/bookmarkStore";
import { CommandPalette } from "./features/command-palette/CommandPalette";
import { QuickSwitcher } from "./features/quick-switcher/QuickSwitcher";
import { SettingsPanel } from "./features/settings";
import { useCommandStore } from "./features/command-palette/store/commandStore";
import {
    DEVELOPER_PANEL_NEW_TAB_EVENT,
    DEVELOPER_PANEL_RESTART_EVENT,
    DeveloperPanel,
} from "./features/devtools/DeveloperPanel";
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
    readWindowSessionSnapshot,
    refreshWindowSessionSnapshot,
    restoreWindowSession,
    writeWindowSessionEntry,
} from "./app/windowSession";
import {
    fileViewerNeedsTextContent,
    useEditorStore,
    isFileTab,
    isNoteTab,
    selectEditorWorkspaceTabs,
    selectFocusedPaneId,
    selectFocusedEditorTab,
    selectLeafPaneIds,
    selectPaneNeighbor,
    selectPaneCount,
    selectPaneState,
} from "./app/store/editorStore";
import { MAX_EDITOR_PANES } from "./app/store/workspaceLayoutTree";
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
import { invalidateLivePreviewNoteCache } from "./features/editor/extensions/livePreviewBlocks";
import {
    canUseExcalidrawRuntime,
    readSearchParam,
} from "./app/utils/safeBrowser";
import {
    flushChatTabsPersistence,
    markChatTabsReady,
    readPersistedChatWorkspace,
    resetChatTabsStore,
    useChatTabsStore,
} from "./features/ai/store/chatTabsStore";
import { resetChatStore, useChatStore } from "./features/ai/store/chatStore";
import { shouldAllowNativeContextMenu } from "./features/spellcheck/contextMenu";
import { YouTubeModalHost } from "./features/editor/YouTubeModalHost";
import { useAppUpdateStore } from "./features/updates/store";
import {
    buildWindowOperationalState,
    WINDOW_OPERATIONAL_STATE_PUBLISH_DEBOUNCE_MS,
    writeWindowOperationalState,
} from "./features/updates/sensitiveState";

function shouldApplyVaultChangeToVaultStore(change: VaultNoteChange) {
    return (
        change.origin === "external" ||
        change.origin === "unknown" ||
        change.origin === "agent"
    );
}

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
const WEB_CLIPPER_ROUTE_POLL_MS = 100;
const WEB_CLIPPER_ROUTE_TIMEOUT_MS = 10_000;
const MENU_ACTION_EVENT = "menu-action";
const DOCK_OPEN_VAULT_EVENT = "dock-open-vault";
const EXCALIDRAW_RUNTIME_SUPPORTED = canUseExcalidrawRuntime();

function waitForWindowRoute(ms: number) {
    return new Promise<void>((resolve) => {
        window.setTimeout(resolve, ms);
    });
}

function SidebarPanel({ view }: { view: SidebarView }) {
    return (
        <div className="h-full flex flex-col overflow-hidden">
            <div className="flex-1 overflow-hidden">
                {view === "files" ? (
                    <FileTree />
                ) : view === "search" ? (
                    <SearchPanel autoFocus />
                ) : view === "bookmarks" ? (
                    <BookmarksPanel />
                ) : view === "maps" ? (
                    <MapsPanel />
                ) : (
                    <TagsPanel />
                )}
            </div>
            {view !== "maps" && <VaultSwitcher />}
        </div>
    );
}

function cycleEditorTabs(backward: boolean) {
    const { tabs, activeTabId, switchTab } = useEditorStore.getState();
    const idx = tabs.findIndex((tab) => tab.id === activeTabId);
    if (idx === -1 || tabs.length <= 1) return;

    const offset = backward ? tabs.length - 1 : 1;
    switchTab(tabs[(idx + offset) % tabs.length].id);
}

function openEmptyTab() {
    if (!useVaultStore.getState().vaultPath) return;

    useEditorStore.getState().insertExternalTab({
        id: crypto.randomUUID(),
        noteId: "",
        title: "New Tab",
        content: "",
    });
}

function toggleLivePreviewSetting() {
    const { livePreviewEnabled, setSetting } = useSettingsStore.getState();
    setSetting("livePreviewEnabled", !livePreviewEnabled);
}

function adjustEditorFontSize(delta: number) {
    const { editorFontSize, setSetting } = useSettingsStore.getState();
    setSetting(
        "editorFontSize",
        Math.max(10, Math.min(24, editorFontSize + delta)),
    );
}

function RightPanel() {
    const rightPanelView = useLayoutStore((s) => s.rightPanelView);
    return (
        <>
            {/* Always mount AIChatPanel so its Tauri event listeners stay
                bound even when a ChatTab lives in the editor workspace and
                the sidebar is switched to outline/links. */}
            <div
                style={{
                    display: rightPanelView === "chat" ? "contents" : "none",
                }}
            >
                <AIChatPanel />
            </div>
            {rightPanelView === "outline" && <OutlineRightPanel />}
            {rightPanelView === "links" && <LinksPanel />}
        </>
    );
}

function VaultOpeningOverlay() {
    const isLoading = useVaultStore((s) => s.isLoading);
    const openState = useVaultStore((s) => s.vaultOpenState);
    const cancelOpenVault = useVaultStore((s) => s.cancelOpenVault);

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
                background:
                    "linear-gradient(180deg, rgb(6 10 15 / 0.72), rgb(6 10 15 / 0.82))",
                backdropFilter: "blur(10px)",
            }}
        >
            <div
                className="w-full max-w-md rounded-xl p-5"
                style={{
                    backgroundColor:
                        "color-mix(in srgb, var(--bg-secondary) 92%, black)",
                    border: "1px solid color-mix(in srgb, var(--border) 82%, white 6%)",
                    boxShadow: "0 24px 80px rgb(0 0 0 / 0.35)",
                }}
            >
                <div
                    className="text-[11px] uppercase tracking-[0.18em]"
                    style={{ color: "var(--accent)" }}
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
                    className="mt-4 h-2 overflow-hidden rounded-full"
                    style={{ backgroundColor: "var(--bg-primary)" }}
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

                <div
                    className="mt-3 flex items-center justify-between text-xs"
                    style={{ color: "var(--text-secondary)" }}
                >
                    <span>{openState.stage.replaceAll("_", " ")}</span>
                    <span>
                        {hasProgress
                            ? `${openState.processed.toLocaleString()} / ${openState.total.toLocaleString()} ${progressUnit}`
                            : "Preparing index"}
                    </span>
                </div>

                {openState.snapshot_used && (
                    <div
                        className="mt-3 text-xs"
                        style={{ color: "var(--text-secondary)" }}
                    >
                        Reusing persisted snapshot before syncing changes.
                    </div>
                )}

                <div className="mt-5 flex justify-end">
                    <button
                        type="button"
                        onClick={() => void cancelOpenVault()}
                        className="rounded-md px-3 py-1.5 text-sm"
                        style={{
                            color: "var(--text-primary)",
                            border: "1px solid var(--border)",
                            backgroundColor: "var(--bg-primary)",
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
    openSearchPanel: () => void,
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
        const closeTabShortcut = getShortcutDefinition("close_tab");
        const newTabShortcut = getShortcutDefinition("new_tab");
        const reopenClosedTabShortcut =
            getShortcutDefinition("reopen_closed_tab");
        const toggleSidebarShortcut = getShortcutDefinition(
            "toggle_left_sidebar",
        );
        const toggleRightPanelShortcut =
            getShortcutDefinition("toggle_right_panel");
        const searchInVaultShortcut = getShortcutDefinition("search_in_vault");
        const openSettingsShortcut = getShortcutDefinition("open_settings");
        const toggleLivePreviewShortcut = getShortcutDefinition(
            "toggle_live_preview",
        );
        const nextTabShortcut = getShortcutDefinition("next_tab");
        const previousTabShortcut = getShortcutDefinition("previous_tab");
        const hasVault = () => useVaultStore.getState().vaultPath !== null;
        const hasActiveTab = () =>
            useEditorStore.getState().activeTabId !== null;
        const canSplitPane = () =>
            selectPaneCount(useEditorStore.getState()) < MAX_EDITOR_PANES;
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
            label: "Back",
            shortcut: platform === "macos" ? "⌘[" : "Ctrl+[",
            category: "Navigation",
            execute: () => useEditorStore.getState().goBack(),
        });

        register({
            id: "nav:forward",
            label: "Forward",
            shortcut: platform === "macos" ? "⌘]" : "Ctrl+]",
            category: "Navigation",
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
                const { notes, createNote } = useVaultStore.getState();
                let name = "Untitled";
                let i = 1;
                while (
                    notes.some(
                        (n) => n.id === name || n.id.endsWith(`/${name}`),
                    )
                ) {
                    name = `Untitled ${i++}`;
                }
                void createNote(name).then((note) => {
                    if (note)
                        useEditorStore
                            .getState()
                            .openNote(note.id, note.title, "");
                });
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
                const { activeTabId, tabs, closeTab } =
                    useEditorStore.getState();
                if (!activeTabId) return;

                const activeTab = tabs.find((tab) => tab.id === activeTabId);
                if (
                    activeTab &&
                    isNoteTab(activeTab) &&
                    activeTab.noteId !== ""
                ) {
                    window.dispatchEvent(
                        new Event(REQUEST_CLOSE_ACTIVE_TAB_EVENT),
                    );
                    return;
                }

                closeTab(activeTabId);
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
            id: "editor:font-size-up",
            label: "Increase Font Size",
            shortcut: platform === "macos" ? "⌘=" : "Ctrl+=",
            category: "Editor",
            execute: () => adjustEditorFontSize(1),
        });

        register({
            id: "editor:font-size-down",
            label: "Decrease Font Size",
            shortcut: platform === "macos" ? "⌘-" : "Ctrl-",
            category: "Editor",
            execute: () => adjustEditorFontSize(-1),
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
            id: "vault:search",
            label: searchInVaultShortcut.label,
            shortcut: formatShortcutAction(searchInVaultShortcut.id, platform),
            category: searchInVaultShortcut.category,
            when: hasVault,
            execute: openSearchPanel,
        });

        register({
            id: "app:open-settings",
            label: openSettingsShortcut.label,
            shortcut: formatShortcutAction(openSettingsShortcut.id, platform),
            category: openSettingsShortcut.category,
            execute: openSettings,
        });

        register({
            id: "developer:toggle-panel",
            label: "Toggle Developer Panel",
            category: "Developer",
            when: developerModeEnabled,
            execute: () => {
                const layout = useLayoutStore.getState();
                if (
                    layout.bottomPanelCollapsed ||
                    layout.bottomPanelView !== "terminal"
                ) {
                    layout.activateBottomView("terminal");
                    return;
                }
                layout.toggleBottomPanel();
            },
        });

        register({
            id: "developer:restart-terminal",
            label: "Restart Active Terminal",
            category: "Developer",
            when: developerModeEnabled,
            execute: () => {
                useLayoutStore.getState().activateBottomView("terminal");
                window.setTimeout(() => {
                    window.dispatchEvent(
                        new Event(DEVELOPER_PANEL_RESTART_EVENT),
                    );
                }, 0);
            },
        });

        register({
            id: "developer:new-terminal-tab",
            label: "New Terminal Tab",
            category: "Developer",
            when: developerModeEnabled,
            execute: () => {
                useLayoutStore.getState().activateBottomView("terminal");
                window.setTimeout(() => {
                    window.dispatchEvent(
                        new Event(DEVELOPER_PANEL_NEW_TAB_EVENT),
                    );
                }, 0);
            },
        });
    }, [
        register,
        openCommandPalette,
        openQuickSwitcher,
        openSearchPanel,
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

            if (matchesShortcutAction(e, "search_in_vault", platform)) {
                e.preventDefault();
                useCommandStore.getState().execute("vault:search");
                return;
            }

            if (matchesShortcutAction(e, "new_note", platform)) {
                e.preventDefault();
                useCommandStore.getState().execute("vault:new-note");
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
    const sidebarView = useLayoutStore((s) => s.sidebarView);
    const editorPaneSizes = useLayoutStore((s) => s.editorPaneSizes);
    const setSidebarView = useLayoutStore((s) => s.setSidebarView);
    const setEditorPaneSizes = useLayoutStore((s) => s.setEditorPaneSizes);
    const bottomPanelView = useLayoutStore((s) => s.bottomPanelView);
    const restoreVault = useVaultStore((s) => s.restoreVault);
    const vaultPath = useVaultStore((s) => s.vaultPath);
    const applyVaultNoteChange = useVaultStore((s) => s.applyVaultNoteChange);
    const refreshEntries = useVaultStore((s) => s.refreshEntries);
    const hydrateWorkspace = useEditorStore((s) => s.hydrateWorkspace);
    const hydrateTabs = useEditorStore((s) => s.hydrateTabs);
    const tabs = useEditorStore((s) => s.tabs);
    const activeTabId = useEditorStore((s) => s.activeTabId);
    const restoreChatWorkspace = useChatTabsStore((s) => s.restoreWorkspace);
    const developerModeEnabled = useSettingsStore(
        (s) => s.developerModeEnabled,
    );
    const developerTerminalEnabled = useSettingsStore(
        (s) => s.developerTerminalEnabled,
    );
    const paneCount = useEditorStore(selectPaneCount);
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

    const openSearchPanel = useCallback(() => {
        useLayoutStore.getState().setSidebarView("search");
        useLayoutStore.getState().expandSidebar();
    }, []);

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
                    tabs: editor.tabs,
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

    const openWebClipperClip = useCallback(
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

            useEditorStore
                .getState()
                .openNote(payload.noteId, payload.title, payload.content);
        },
        [],
    );

    const routeWebClipperClip = useCallback(
        async (payload: WebClipperSavedPayload) => {
            if (getCurrentWindowLabel() !== "main") {
                return;
            }
            if (useVaultStore.getState().vaultPath === payload.vaultPath) {
                openWebClipperClip({
                    ...payload,
                    targetWindowLabel: getCurrentWindowLabel(),
                });
                return;
            }

            const currentWindowLabel = getCurrentWindowLabel();
            let targetLabel =
                readWindowSessionSnapshot().find(
                    (entry) =>
                        entry.kind === "vault" &&
                        entry.vaultPath === payload.vaultPath,
                )?.label ?? null;

            if (!targetLabel) {
                const existingLabels = new Set(
                    (await getAllWebviewWindows()).map(
                        (window) => window.label,
                    ),
                );

                await openVaultWindow(payload.vaultPath);

                const deadline = Date.now() + WEB_CLIPPER_ROUTE_TIMEOUT_MS;
                while (Date.now() <= deadline) {
                    const matchingEntry = readWindowSessionSnapshot().find(
                        (entry) =>
                            entry.kind === "vault" &&
                            entry.vaultPath === payload.vaultPath &&
                            !existingLabels.has(entry.label),
                    );
                    if (matchingEntry) {
                        targetLabel = matchingEntry.label;
                        break;
                    }
                    await waitForWindowRoute(WEB_CLIPPER_ROUTE_POLL_MS);
                }
            }

            if (!targetLabel || targetLabel === currentWindowLabel) {
                if (useVaultStore.getState().vaultPath === payload.vaultPath) {
                    openWebClipperClip({
                        ...payload,
                        targetWindowLabel: currentWindowLabel,
                    });
                }
                return;
            }

            const currentWindow = getCurrentWindow();
            const targetWindow = (await getAllWebviewWindows()).find(
                (window) => window.label === targetLabel,
            );

            await targetWindow?.setFocus?.();
            await currentWindow.emitTo(
                targetLabel,
                WEB_CLIPPER_CLIP_SAVED_EVENT,
                {
                    ...payload,
                    targetWindowLabel: targetLabel,
                } satisfies WebClipperSavedPayload,
            );
        },
        [openWebClipperClip],
    );

    useRegisterCommands(openSearchPanel, openSettings, windowMode === "main");
    useGlobalShortcuts(openSettings);
    useNativeMenuActions(windowMode);
    useDynamicScrollbars();
    useAutoOpenReviewTab();

    const restoreSessionForCurrentVault = useCallback(async () => {
        const vaultPath = useVaultStore.getState().vaultPath;
        const restored = await restorePersistedSession(vaultPath, {
            includeMaps: EXCALIDRAW_RUNTIME_SUPPORTED,
        });
        if (!restored) {
            setEditorPaneSizes(1, []);
            return;
        }
        const paneCount = restored.panes?.length ?? 1;
        setEditorPaneSizes(paneCount, restored.paneSizes ?? []);
        if (restored.panes?.length) {
            hydrateWorkspace(
                restored.panes,
                restored.focusedPaneId,
                restored.layoutTree,
            );
            return;
        }
        hydrateTabs(restored.tabs, restored.activeTabId);
    }, [hydrateTabs, hydrateWorkspace, setEditorPaneSizes]);

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
            tabs,
            activeTabId,
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
    }, [activeTabId, tabs, vaultPath, windowMode, windowSessionReady]);

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
                    tabs: editor.tabs,
                    activeTabId: editor.activeTabId,
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
                hydrateTabs: (tabs, activeTabId) => {
                    if (cancelled) return;
                    hydrateTabs(tabs, activeTabId);
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
            await useChatStore.getState().initialize();
            if (cancelled) return;

            const chatState = useChatStore.getState();
            const workspace = readPersistedChatWorkspace(vaultPath);
            restoreChatWorkspace(
                workspace,
                Object.values(chatState.sessionsById).map((session) => ({
                    sessionId: session.sessionId,
                    historySessionId: session.historySessionId,
                    runtimeId: session.runtimeId,
                })),
                chatState.activeSessionId,
            );
            const restoredChatWorkspace = useChatTabsStore.getState();
            await useChatStore.getState().reconcileRestoredWorkspaceTabs(
                restoredChatWorkspace.tabs.map((tab) => ({
                    id: tab.id,
                    sessionId: tab.sessionId,
                    historySessionId: tab.historySessionId ?? null,
                    runtimeId: tab.runtimeId ?? null,
                })),
                restoredChatWorkspace.activeTabId,
            );
            markChatTabsReady();
        })();

        return () => {
            cancelled = true;
        };
    }, [restoreChatWorkspace, vaultPath, windowMode]);

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

                if (shouldApplyVaultChangeToVaultStore(event.payload)) {
                    applyVaultNoteChange(event.payload);
                    void refreshEntries();
                }

                // Reload editor content for open tabs when file changes externally
                const change = event.payload;
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
    }, [applyVaultNoteChange, refreshEntries, windowMode]);

    useEffect(() => {
        let disposed = false;
        let unlisten: (() => void) | null = null;

        resolveDeferredUnlisten(
            getCurrentWindow().listen<AttachExternalTabPayload>(
                ATTACH_EXTERNAL_TAB_EVENT,
                (event) => {
                    if (disposed) return;
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
                    openWebClipperClip(event.payload);
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
    }, [openWebClipperClip, windowMode]);

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
            {paneCount > 1 ? (
                <WorkspaceChromeBar />
            ) : (
                <UnifiedBar windowMode="main" />
            )}

            <div className="relative flex-1 flex overflow-hidden">
                <ActivityBar
                    active={sidebarView}
                    onChange={(view) => {
                        setSidebarView(view);
                        useLayoutStore.getState().expandSidebar();
                    }}
                    onOpenSettings={openSettings}
                />
                <div className="min-w-0 flex-1 overflow-hidden">
                    <AppLayout
                        left={<SidebarPanel view={sidebarView} />}
                        center={
                            paneCount > 1 ? (
                                <MultiPaneWorkspace />
                            ) : (
                                <EditorPaneContent />
                            )
                        }
                        right={<RightPanel />}
                        bottom={
                            developerModeEnabled &&
                            developerTerminalEnabled &&
                            bottomPanelView === "terminal" ? (
                                <DeveloperPanel />
                            ) : undefined
                        }
                    />
                </div>
                <VaultOpeningOverlay />
            </div>

            <YouTubeModalHost />
            <CommandPalette />
            <QuickSwitcher />
        </div>
    );
}
