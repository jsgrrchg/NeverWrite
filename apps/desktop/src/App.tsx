import React, { useState, useEffect, useCallback, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { perfCount } from "./app/utils/perfInstrumentation";
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
import { UnifiedBar } from "./features/editor/UnifiedBar";
import {
    Editor,
    REQUEST_CLOSE_ACTIVE_TAB_EVENT,
} from "./features/editor/Editor";
import { FileTabView } from "./features/editor/FileTabView";
import { AIReviewView } from "./features/ai/components/AIReviewView";
import { useAutoOpenReviewTab } from "./features/ai/hooks/useAutoOpenReviewTab";
import { NewTabView } from "./features/editor/NewTabView";
import { SearchView } from "./features/search/SearchView";
import { PdfTabView } from "./features/pdf/PdfTabView";
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
    useEditorStore,
    type TabInput,
    isFileTab,
    isGraphTab,
    isMapTab,
    isNoteTab,
    isPdfTab,
    isReviewTab,
    readPersistedSession,
    markSessionReady,
} from "./app/store/editorStore";
import { useVaultStore, type VaultNoteChange } from "./app/store/vaultStore";
import { useLayoutStore } from "./app/store/layoutStore";
import { useSettingsStore } from "./app/store/settingsStore";
import {
    getYouTubeEmbedUrl,
    OPEN_YOUTUBE_MODAL_EVENT,
    type OpenYouTubeModalPayload,
} from "./features/editor/youtube";
import { formatShortcutAction } from "./app/shortcuts/format";
import {
    matchesShortcutAction,
    getShortcutDefinition,
} from "./app/shortcuts/registry";
import { getDesktopPlatform } from "./app/utils/platform";
import { invalidateLivePreviewNoteCache } from "./features/editor/extensions/livePreviewBlocks";
import {
    flushChatTabsPersistence,
    markChatTabsReady,
    readPersistedChatWorkspace,
    resetChatTabsStore,
    useChatTabsStore,
} from "./features/ai/store/chatTabsStore";
import { resetChatStore, useChatStore } from "./features/ai/store/chatStore";
import { shouldAllowNativeContextMenu } from "./features/spellcheck/contextMenu";

function isTextLikeMimeType(mimeType: string | null | undefined) {
    if (!mimeType) return false;
    return (
        mimeType.startsWith("text/") ||
        mimeType === "application/json" ||
        mimeType === "application/yaml" ||
        mimeType === "application/toml" ||
        mimeType === "application/xml"
    );
}

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

const WEB_CLIPPER_CLIP_SAVED_EVENT = "vaultai:web-clipper/clip-saved";
const WEB_CLIPPER_ROUTE_CLIP_EVENT = "vaultai:web-clipper/route-clip";
const WEB_CLIPPER_ROUTE_POLL_MS = 100;
const WEB_CLIPPER_ROUTE_TIMEOUT_MS = 10_000;

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

function RightPanel() {
    const rightPanelView = useLayoutStore((s) => s.rightPanelView);
    if (rightPanelView === "chat") {
        return <AIChatPanel />;
    }
    if (rightPanelView === "outline") {
        return <OutlineRightPanel />;
    }
    return <LinksPanel />;
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
    const activeNoteId = useEditorStore((s) => {
        const tab = s.tabs.find((t) => t.id === s.activeTabId);
        return tab && isNoteTab(tab) ? tab.noteId : null;
    });
    const activeContent = useEditorStore((s) => {
        const tab = s.tabs.find((t) => t.id === s.activeTabId);
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

function YouTubeModalHost() {
    const [video, setVideo] = useState<OpenYouTubeModalPayload | null>(null);

    useEffect(() => {
        const handleOpen = (event: Event) => {
            const customEvent = event as CustomEvent<OpenYouTubeModalPayload>;
            if (!customEvent.detail?.href) return;
            setVideo(customEvent.detail);
        };

        window.addEventListener(OPEN_YOUTUBE_MODAL_EVENT, handleOpen);
        return () =>
            window.removeEventListener(OPEN_YOUTUBE_MODAL_EVENT, handleOpen);
    }, []);

    useEffect(() => {
        if (!video) return;

        const handleKey = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                event.preventDefault();
                setVideo(null);
            }
        };

        window.addEventListener("keydown", handleKey, true);
        return () => window.removeEventListener("keydown", handleKey, true);
    }, [video]);

    if (!video) return null;

    const embedUrl = getYouTubeEmbedUrl(video.href);
    if (!embedUrl) return null;

    return (
        <div
            className="fixed inset-0 flex items-center justify-center p-6"
            style={{
                zIndex: 10000,
                background: "rgb(0 0 0 / 0.66)",
            }}
            onClick={() => setVideo(null)}
        >
            <div
                className="w-full max-w-5xl"
                onClick={(event) => event.stopPropagation()}
            >
                <div
                    style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        marginBottom: 10,
                        color: "white",
                    }}
                >
                    <div
                        style={{
                            fontSize: 14,
                            fontWeight: 700,
                            lineHeight: 1.35,
                            paddingRight: 16,
                        }}
                    >
                        {video.title}
                    </div>
                    <button
                        type="button"
                        onClick={() => setVideo(null)}
                        style={{
                            width: 34,
                            height: 34,
                            borderRadius: 999,
                            border: "1px solid rgb(255 255 255 / 0.18)",
                            background: "rgb(255 255 255 / 0.08)",
                            color: "white",
                            cursor: "pointer",
                            fontSize: 18,
                            lineHeight: 1,
                        }}
                        aria-label="Close video"
                    >
                        ×
                    </button>
                </div>
                <div
                    style={{
                        position: "relative",
                        width: "100%",
                        aspectRatio: "16 / 9",
                        borderRadius: 18,
                        overflow: "hidden",
                        border: "1px solid rgb(255 255 255 / 0.08)",
                        boxShadow: "0 24px 80px rgb(0 0 0 / 0.45)",
                        background: "black",
                    }}
                >
                    <iframe
                        title={video.title}
                        src={embedUrl}
                        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                        allowFullScreen
                        referrerPolicy="strict-origin-when-cross-origin"
                        loading="lazy"
                        style={{
                            position: "absolute",
                            inset: 0,
                            width: "100%",
                            height: "100%",
                            border: "none",
                        }}
                    />
                </div>
            </div>
        </div>
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
        const hasVault = () => useVaultStore.getState().vaultPath !== null;
        const hasActiveTab = () =>
            useEditorStore.getState().activeTabId !== null;
        const hasRecentlyClosedTab = () =>
            useEditorStore.getState().recentlyClosedTabs.length > 0;
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
                void invoke<{ id: string; title: string; path: string }>(
                    "create_map",
                    { vaultPath, name },
                ).then((entry) => {
                    useEditorStore
                        .getState()
                        .openMap(entry.path, entry.id, entry.title);
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

type EditorPanelView =
    | "pdf"
    | "file"
    | "new"
    | "search"
    | "ai-review"
    | "editor"
    | "map"
    | "graph";

const LazyExcalidrawTabView = React.lazy(() =>
    import("./features/maps/ExcalidrawTabView").then((m) => ({
        default: m.ExcalidrawTabView,
    })),
);

const LazyGraphTabView = React.lazy(() =>
    import("./features/graph/GraphTabView").then((m) => ({
        default: m.GraphTabView,
    })),
);

const GRAPH_KEEP_ALIVE_MS = 15 * 60 * 1000;

function renderEditorPanelView(
    view: EditorPanelView,
    emptyStateMessage?: string,
) {
    switch (view) {
        case "pdf":
            return <PdfTabView />;
        case "file":
            return <FileTabView />;
        case "ai-review":
            return <AIReviewView />;
        case "map":
            return (
                <React.Suspense fallback={null}>
                    <LazyExcalidrawTabView />
                </React.Suspense>
            );
        case "new":
            return <NewTabView />;
        case "search":
            return <SearchView />;
        case "graph":
            return null;
        default:
            return <Editor emptyStateMessage={emptyStateMessage} />;
    }
}

function EditorPanel({ emptyStateMessage }: { emptyStateMessage?: string }) {
    const view = useEditorStore((s): EditorPanelView => {
        const tab = s.tabs.find((t) => t.id === s.activeTabId);
        if (!tab) return "editor";
        if (isPdfTab(tab)) return "pdf";
        if (isFileTab(tab)) return "file";
        if (isReviewTab(tab)) return "ai-review";
        if (isMapTab(tab)) return "map";
        if (isGraphTab(tab)) return "graph";
        if (!isNoteTab(tab)) return "editor";
        if (tab.noteId === "") return "new";
        if (tab.noteId === "__search__") return "search";
        return "editor";
    });
    const hasGraphTab = useEditorStore((s) =>
        s.tabs.some((tab) => isGraphTab(tab)),
    );
    const isGraphActive = view === "graph";
    const [keepAlive, setKeepAlive] = useState(false);
    const [prevIsGraphActive, setPrevIsGraphActive] = useState(isGraphActive);
    const [prevHasGraphTab, setPrevHasGraphTab] = useState(hasGraphTab);

    // Adjust keep-alive based on prop changes (setState during render pattern)
    if (
        prevIsGraphActive !== isGraphActive ||
        prevHasGraphTab !== hasGraphTab
    ) {
        setPrevIsGraphActive(isGraphActive);
        setPrevHasGraphTab(hasGraphTab);
        if (!hasGraphTab) {
            if (keepAlive) setKeepAlive(false);
        } else if (prevIsGraphActive && !isGraphActive) {
            if (!keepAlive) setKeepAlive(true);
        } else if (isGraphActive && keepAlive) {
            setKeepAlive(false);
        }
    }

    // Timer to expire keep-alive (setState only in async callback)
    useEffect(() => {
        if (!keepAlive) return;
        const timeoutId = window.setTimeout(() => {
            perfCount("graph.lifecycle.keepAliveExpired");
            setKeepAlive(false);
        }, GRAPH_KEEP_ALIVE_MS);
        return () => window.clearTimeout(timeoutId);
    }, [keepAlive]);

    const keepGraphMounted = hasGraphTab && (isGraphActive || keepAlive);

    return (
        <div className="relative flex-1 min-h-0 min-w-0 w-full overflow-hidden">
            {keepGraphMounted && (
                <div
                    style={{
                        position: "absolute",
                        inset: 0,
                        visibility: isGraphActive ? "visible" : "hidden",
                        pointerEvents: isGraphActive ? "auto" : "none",
                    }}
                >
                    <React.Suspense fallback={null}>
                        <LazyGraphTabView isVisible={isGraphActive} />
                    </React.Suspense>
                </div>
            )}
            {!isGraphActive && renderEditorPanelView(view, emptyStateMessage)}
        </div>
    );
}

export default function App() {
    const sidebarView = useLayoutStore((s) => s.sidebarView);
    const setSidebarView = useLayoutStore((s) => s.setSidebarView);
    const bottomPanelView = useLayoutStore((s) => s.bottomPanelView);
    const restoreVault = useVaultStore((s) => s.restoreVault);
    const vaultPath = useVaultStore((s) => s.vaultPath);
    const applyVaultNoteChange = useVaultStore((s) => s.applyVaultNoteChange);
    const refreshEntries = useVaultStore((s) => s.refreshEntries);
    const hydrateTabs = useEditorStore((s) => s.hydrateTabs);
    const insertExternalTab = useEditorStore((s) => s.insertExternalTab);
    const tabs = useEditorStore((s) => s.tabs);
    const activeTabId = useEditorStore((s) => s.activeTabId);
    const restoreChatWorkspace = useChatTabsStore((s) => s.restoreWorkspace);
    const developerModeEnabled = useSettingsStore(
        (s) => s.developerModeEnabled,
    );
    const developerTerminalEnabled = useSettingsStore(
        (s) => s.developerTerminalEnabled,
    );
    const windowMode = getWindowMode();
    const vaultParam = new URLSearchParams(window.location.search).get("vault");
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
        () => void openSettingsWindow(vaultPath),
        [vaultPath],
    );

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
    useDynamicScrollbars();
    useAutoOpenReviewTab();

    const restoreSessionForCurrentVault = useCallback(async () => {
        const vaultPath = useVaultStore.getState().vaultPath;
        const session = readPersistedSession(vaultPath);
        if (
            !session?.noteIds.length &&
            !session?.tabs?.length &&
            !session?.pdfTabs?.length &&
            !session?.fileTabs?.length &&
            !session?.mapTabs?.length &&
            !session?.hasGraphTab
        ) {
            return;
        }

        const restoredTabs: TabInput[] = [];

        if (session?.tabs?.length) {
            restoredTabs.push(...session.tabs);
        } else {
            for (const entry of session?.noteIds ?? []) {
                try {
                    const detail = await vaultInvoke<{ content: string }>(
                        "read_note",
                        {
                            noteId: entry.noteId,
                        },
                    );
                    const history = (
                        entry.history ?? [
                            { noteId: entry.noteId, title: entry.title },
                        ]
                    ).map((h) => ({
                        noteId: h.noteId,
                        title: h.title,
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
                        noteId: entry.noteId,
                        title: entry.title,
                        content: detail.content,
                        history,
                        historyIndex,
                    });
                } catch {
                    // Nota eliminada o no encontrada, se omite
                }
            }

            for (const pdfEntry of session?.pdfTabs ?? []) {
                const history = (
                    pdfEntry.history ?? [
                        {
                            entryId: pdfEntry.entryId,
                            title: pdfEntry.title,
                            path: pdfEntry.path,
                            page: pdfEntry.page ?? 1,
                            zoom: pdfEntry.zoom ?? 1,
                            viewMode: pdfEntry.viewMode ?? "continuous",
                        },
                    ]
                ).map((entry) => ({
                    entryId: entry.entryId,
                    title: entry.title,
                    path: entry.path,
                    page: entry.page ?? 1,
                    zoom: entry.zoom ?? 1,
                    viewMode: entry.viewMode ?? "continuous",
                }));
                const historyIndex = Math.min(
                    pdfEntry.historyIndex ?? history.length - 1,
                    history.length - 1,
                );
                const currentEntry = history[historyIndex];
                restoredTabs.push({
                    id: crypto.randomUUID(),
                    kind: "pdf",
                    entryId: currentEntry?.entryId ?? pdfEntry.entryId,
                    title: currentEntry?.title ?? pdfEntry.title,
                    path: currentEntry?.path ?? pdfEntry.path,
                    page: currentEntry?.page ?? pdfEntry.page ?? 1,
                    zoom: currentEntry?.zoom ?? pdfEntry.zoom ?? 1,
                    viewMode:
                        currentEntry?.viewMode ??
                        pdfEntry.viewMode ??
                        "continuous",
                    history,
                    historyIndex,
                });
            }

            for (const fileEntry of session?.fileTabs ?? []) {
                let content = fileEntry.content ?? "";
                const viewer =
                    fileEntry.viewer ??
                    (fileEntry.mimeType?.startsWith("image/")
                        ? "image"
                        : "text");

                if (!content && viewer === "text") {
                    try {
                        const detail = await vaultInvoke<{ content: string }>(
                            "read_vault_file",
                            {
                                relativePath: fileEntry.relativePath,
                            },
                        );
                        content = detail.content;
                    } catch {
                        content = "";
                    }
                }

                const history = (
                    fileEntry.history ?? [
                        {
                            relativePath: fileEntry.relativePath,
                            title: fileEntry.title,
                            path: fileEntry.path,
                            mimeType: fileEntry.mimeType ?? null,
                            viewer,
                        },
                    ]
                ).map((h) => ({
                    relativePath: h.relativePath,
                    title: h.title,
                    path: h.path,
                    mimeType: h.mimeType ?? null,
                    viewer:
                        h.viewer ??
                        (h.mimeType?.startsWith("image/") ? "image" : "text"),
                    content: "",
                }));
                const historyIndex = Math.min(
                    fileEntry.historyIndex ?? history.length - 1,
                    history.length - 1,
                );
                if (history[historyIndex]) {
                    history[historyIndex].content = content;
                }

                restoredTabs.push({
                    id: crypto.randomUUID(),
                    kind: "file",
                    relativePath: fileEntry.relativePath,
                    title: fileEntry.title,
                    path: fileEntry.path,
                    mimeType: fileEntry.mimeType ?? null,
                    viewer,
                    content,
                    history,
                    historyIndex,
                });
            }
        }

        for (const mapEntry of session?.mapTabs ?? []) {
            if (
                restoredTabs.some(
                    (tab) =>
                        tab.kind === "map" &&
                        tab.filePath === mapEntry.filePath,
                )
            ) {
                continue;
            }

            restoredTabs.push({
                id: crypto.randomUUID(),
                kind: "map",
                filePath: mapEntry.filePath,
                relativePath: mapEntry.relativePath,
                title: mapEntry.title,
            });
        }

        if (session?.hasGraphTab) {
            restoredTabs.push({
                id: crypto.randomUUID(),
                kind: "graph",
                title: "Graph View",
            });
        }

        if (!restoredTabs.length) return;

        // Find active tab: check PDF first, then note
        let activeTab: TabInput | undefined;
        if (session?.activeGraphTab) {
            activeTab = restoredTabs.find((tab) => tab.kind === "graph");
        }
        if (!activeTab && session?.activeMapFilePath) {
            activeTab = restoredTabs.find(
                (tab) =>
                    tab.kind === "map" &&
                    tab.filePath === session.activeMapFilePath,
            );
        }
        if (!activeTab && session?.activePdfEntryId) {
            activeTab = restoredTabs.find(
                (tab) =>
                    tab.kind === "pdf" &&
                    tab.entryId === session.activePdfEntryId,
            );
        }
        if (!activeTab && session?.activeNoteId) {
            activeTab = restoredTabs.find(
                (tab) => isNoteTab(tab) && tab.noteId === session.activeNoteId,
            );
        }
        if (!activeTab && session?.activeFilePath) {
            activeTab = restoredTabs.find(
                (tab) =>
                    isFileTab(tab) &&
                    tab.relativePath === session.activeFilePath,
            );
        }
        hydrateTabs(restoredTabs, activeTab?.id ?? null);
    }, [hydrateTabs]);

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
        if (windowMode !== "main") return;

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

        let unlisten: (() => void) | undefined;
        const pendingNoteReloads = pendingNoteReloadsRef.current;
        const noteReloadVersions = noteReloadVersionRef.current;
        const pendingFileReloads = pendingFileReloadsRef.current;
        const fileReloadVersions = fileReloadVersionRef.current;

        void listen<VaultNoteChange>("vault://note-changed", (event) => {
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
                const openTab = useEditorStore
                    .getState()
                    .tabs.find((t) => isNoteTab(t) && t.noteId === noteId);
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

                        void vaultInvoke<{ title: string; content: string }>(
                            "read_note",
                            {
                                noteId,
                            },
                        ).then((detail) => {
                            if (
                                noteReloadVersions.get(noteId) !== nextVersion
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
                change.relative_path &&
                isTextLikeMimeType(change.entry.mime_type)
            ) {
                const relativePath = change.relative_path;
                const openTab = useEditorStore
                    .getState()
                    .tabs.find(
                        (t) =>
                            isFileTab(t) &&
                            t.viewer === "text" &&
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
                                });
                        });
                    }, 180);

                    pendingFileReloads.set(relativePath, timer);
                }
            } else if (change.kind === "delete") {
                invalidateLivePreviewNoteCache(change.note_id);
            }
        }).then((cleanup) => {
            unlisten = cleanup;
        });

        return () => {
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
            if (unlisten) {
                void unlisten();
            }
        };
    }, [applyVaultNoteChange, refreshEntries, windowMode]);

    useEffect(() => {
        let unlisten: (() => void) | undefined;

        void getCurrentWindow()
            .listen<AttachExternalTabPayload>(
                ATTACH_EXTERNAL_TAB_EVENT,
                (event) => {
                    insertExternalTab(event.payload.tab);
                },
            )
            .then((cleanup) => {
                unlisten = cleanup;
            });

        return () => {
            if (unlisten) {
                void unlisten();
            }
        };
    }, [insertExternalTab]);

    useEffect(() => {
        if (windowMode !== "main") return;

        let unlisten: (() => void) | undefined;

        void listen<WebClipperSavedPayload>(
            WEB_CLIPPER_CLIP_SAVED_EVENT,
            (event) => {
                openWebClipperClip(event.payload);
            },
        ).then((cleanup) => {
            unlisten = cleanup;
        });

        return () => {
            if (unlisten) {
                void unlisten();
            }
        };
    }, [openWebClipperClip, windowMode]);

    useEffect(() => {
        if (windowMode !== "main") return;

        let unlisten: (() => void) | undefined;

        void listen<WebClipperSavedPayload>(
            WEB_CLIPPER_ROUTE_CLIP_EVENT,
            (event) => {
                void routeWebClipperClip(event.payload);
            },
        ).then((cleanup) => {
            unlisten = cleanup;
        });

        return () => {
            if (unlisten) {
                void unlisten();
            }
        };
    }, [routeWebClipperClip, windowMode]);

    if (windowMode === "ghost") {
        const title =
            new URLSearchParams(window.location.search).get("title") ?? "Tab";
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
                <UnifiedBar windowMode="note" />
                <div className="flex-1 min-h-0 min-w-0 overflow-hidden flex flex-col">
                    <EditorPanel emptyStateMessage="Esta ventana no tiene ninguna nota abierta" />
                </div>
                <YouTubeModalHost />
                <CommandPalette />
                <QuickSwitcher />
            </div>
        );
    }

    return (
        <div className="h-full flex flex-col overflow-hidden">
            <UnifiedBar windowMode="main" />

            <div className="relative flex-1 flex overflow-hidden">
                <ActivityBar
                    active={sidebarView}
                    onChange={(view) => {
                        setSidebarView(view);
                        useLayoutStore.getState().expandSidebar();
                    }}
                    onOpenSettings={openSettings}
                />
                <div className="flex-1 overflow-hidden">
                    <AppLayout
                        left={<SidebarPanel view={sidebarView} />}
                        center={<EditorPanel />}
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
