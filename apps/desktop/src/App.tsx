import React, { useState, useEffect, useCallback, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
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
import { Editor } from "./features/editor/Editor";
import { FileTabView } from "./features/editor/FileTabView";
import { AIReviewView } from "./features/ai/components/AIReviewView";
import { useAutoOpenReviewTab } from "./features/ai/hooks/useAutoOpenReviewTab";
import { NewTabView } from "./features/editor/NewTabView";
import { SearchView } from "./features/search/SearchView";
import { PdfTabView } from "./features/pdf/PdfTabView";
import { MapsPanel } from "./features/maps/MapsPanel";
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

function SidebarPanel({ view }: { view: SidebarView }) {
    return (
        <div className="h-full flex flex-col overflow-hidden">
            <div className="flex-1 overflow-hidden">
                {view === "files" ? (
                    <FileTree />
                ) : view === "search" ? (
                    <SearchPanel autoFocus />
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
    developerCommandsEnabled: boolean,
) {
    const register = useCommandStore((s) => s.register);
    const openCommandPalette = useCommandStore((s) => s.openCommandPalette);
    const openQuickSwitcher = useCommandStore((s) => s.openQuickSwitcher);

    useEffect(() => {
        const hasVault = () => useVaultStore.getState().vaultPath !== null;
        const hasActiveTab = () =>
            useEditorStore.getState().activeTabId !== null;
        const developerModeEnabled = () =>
            developerCommandsEnabled &&
            useSettingsStore.getState().developerModeEnabled &&
            useSettingsStore.getState().developerTerminalEnabled;

        // Navigation
        register({
            id: "nav:command-palette",
            label: "Command Palette",
            shortcut: "\u2318K",
            category: "Navigation",
            execute: openCommandPalette,
        });

        register({
            id: "nav:quick-switcher",
            label: "Quick Switcher",
            shortcut: "\u2318O",
            category: "Navigation",
            when: hasVault,
            execute: openQuickSwitcher,
        });

        // Vault
        register({
            id: "vault:open",
            label: "Open Vault",
            shortcut: "\u2318\u21e7O",
            category: "Vault",
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
            label: "New Note",
            shortcut: "\u2318N",
            category: "Vault",
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
            label: "Close Tab",
            shortcut: "\u2318W",
            category: "Editor",
            when: hasActiveTab,
            execute: () => {
                const { activeTabId, closeTab } = useEditorStore.getState();
                if (activeTabId) closeTab(activeTabId);
            },
        });

        // Layout
        register({
            id: "layout:toggle-sidebar",
            label: "Toggle Sidebar",
            shortcut: "\u2318S",
            category: "View",
            execute: () => useLayoutStore.getState().toggleSidebar(),
        });

        register({
            id: "layout:toggle-right-panel",
            label: "Toggle Right Panel",
            shortcut: "\u2318J",
            category: "View",
            execute: () => useLayoutStore.getState().toggleRightPanel(),
        });

        register({
            id: "vault:search",
            label: "Search in Vault",
            shortcut: "\u2318\u21e7F",
            category: "Navigation",
            when: hasVault,
            execute: openSearchPanel,
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
        developerCommandsEnabled,
    ]);
}

// Global keyboard shortcuts that dispatch to the command store
function useGlobalShortcuts(
    openSearchPanel: () => void,
    openSettings: () => void,
) {
    const openCommandPalette = useCommandStore((s) => s.openCommandPalette);
    const openQuickSwitcher = useCommandStore((s) => s.openQuickSwitcher);
    const closeModal = useCommandStore((s) => s.closeModal);
    const activeModal = useCommandStore((s) => s.activeModal);

    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            const mod = e.metaKey || e.ctrlKey;

            // Escape closes any modal
            if (e.key === "Escape" && activeModal) {
                e.preventDefault();
                closeModal();
                return;
            }

            // Cmd+,: settings
            if (mod && e.key === ",") {
                e.preventDefault();
                openSettings();
                return;
            }

            // Cmd+K: command palette
            if (mod && e.key === "k") {
                e.preventDefault();
                if (activeModal === "command-palette") {
                    closeModal();
                } else {
                    openCommandPalette();
                }
                return;
            }

            // Cmd+O: quick switcher
            if (mod && e.key === "o") {
                e.preventDefault();
                if (activeModal === "quick-switcher") {
                    closeModal();
                } else {
                    openQuickSwitcher();
                }
                return;
            }

            // Cmd+S: toggle sidebar
            if (mod && e.key === "s" && !e.shiftKey) {
                e.preventDefault();
                useLayoutStore.getState().toggleSidebar();
                return;
            }

            // Cmd+J: toggle right panel
            if (mod && e.key === "j") {
                e.preventDefault();
                useLayoutStore.getState().toggleRightPanel();
                return;
            }

            // Cmd+Shift+F: search in vault
            if (mod && e.shiftKey && e.key === "f") {
                e.preventDefault();
                openSearchPanel();
                return;
            }

            // Cmd+N: new note
            if (mod && e.key === "n" && !e.shiftKey) {
                e.preventDefault();
                useCommandStore.getState().execute("vault:new-note");
                return;
            }

            // Cmd+W: close the active editor tab, never the window
            if (mod && e.key === "w" && !e.shiftKey) {
                const { activeTabId, closeTab } = useEditorStore.getState();
                if (!activeTabId) return;
                e.preventDefault();
                closeTab(activeTabId);
                return;
            }

            // Ctrl+Tab / Ctrl+Shift+Tab: cycle tabs
            if (e.ctrlKey && e.key === "Tab") {
                e.preventDefault();
                const { tabs, activeTabId, switchTab } =
                    useEditorStore.getState();
                const idx = tabs.findIndex((t) => t.id === activeTabId);
                if (idx !== -1 && tabs.length > 1) {
                    const offset = e.shiftKey ? tabs.length - 1 : 1;
                    const next = tabs[(idx + offset) % tabs.length];
                    switchTab(next.id);
                }
                return;
            }

            // Cmd+Option+T: cycle tabs backward
            if (e.metaKey && e.altKey && e.key === "t") {
                e.preventDefault();
                const { tabs, activeTabId, switchTab } =
                    useEditorStore.getState();
                const idx = tabs.findIndex((t) => t.id === activeTabId);
                if (idx !== -1 && tabs.length > 1) {
                    const next = tabs[(idx + tabs.length - 1) % tabs.length];
                    switchTab(next.id);
                }
                return;
            }

            // Cmd+T: new tab
            if (mod && e.key === "t" && !e.altKey) {
                e.preventDefault();
                if (useVaultStore.getState().vaultPath) {
                    useEditorStore.getState().insertExternalTab({
                        id: crypto.randomUUID(),
                        noteId: "",
                        title: "New Tab",
                        content: "",
                    });
                }
                return;
            }

            // Cmd+E: toggle live preview
            if (mod && e.key === "e") {
                e.preventDefault();
                const { livePreviewEnabled, setSetting } =
                    useSettingsStore.getState();
                setSetting("livePreviewEnabled", !livePreviewEnabled);
                return;
            }
        };

        window.addEventListener("keydown", handler, true);
        return () => window.removeEventListener("keydown", handler, true);
    }, [
        activeModal,
        closeModal,
        openCommandPalette,
        openQuickSwitcher,
        openSearchPanel,
        openSettings,
    ]);
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
        case "graph":
            return (
                <React.Suspense fallback={null}>
                    <LazyGraphTabView />
                </React.Suspense>
            );
        case "new":
            return <NewTabView />;
        case "search":
            return <SearchView />;
        default:
            return <Editor emptyStateMessage={emptyStateMessage} />;
    }
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

    const openSearchPanel = useCallback(() => {
        useLayoutStore.getState().setSidebarView("search");
        useLayoutStore.getState().expandSidebar();
    }, []);

    const openSettings = useCallback(
        () => void openSettingsWindow(vaultPath),
        [vaultPath],
    );

    useRegisterCommands(openSearchPanel, windowMode === "main");
    useGlobalShortcuts(openSearchPanel, openSettings);
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
                const history = (
                    fileEntry.history ?? [
                        {
                            relativePath: fileEntry.relativePath,
                            title: fileEntry.title,
                            path: fileEntry.path,
                            mimeType: fileEntry.mimeType ?? null,
                            viewer:
                                fileEntry.viewer ??
                                (fileEntry.mimeType?.startsWith("image/")
                                    ? "image"
                                    : "text"),
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
                    history[historyIndex].content = fileEntry.content;
                }

                restoredTabs.push({
                    id: crypto.randomUUID(),
                    kind: "file",
                    relativePath: fileEntry.relativePath,
                    title: fileEntry.title,
                    path: fileEntry.path,
                    mimeType: fileEntry.mimeType ?? null,
                    viewer:
                        fileEntry.viewer ??
                        (fileEntry.mimeType?.startsWith("image/")
                            ? "image"
                            : "text"),
                    content: fileEntry.content,
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

        void listen<VaultNoteChange>("vault://note-changed", (event) => {
            // Only process changes for the current vault
            const currentVaultPath = useVaultStore.getState().vaultPath;
            if (
                event.payload.vault_path &&
                currentVaultPath &&
                event.payload.vault_path !== currentVaultPath
            )
                return;

            applyVaultNoteChange(event.payload);
            void refreshEntries();

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
                                });
                        });
                    }, 180);

                    pendingNoteReloads.set(noteId, timer);
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
            <div className="h-full flex flex-col overflow-hidden">
                <UnifiedBar windowMode="note" />
                <div className="flex-1 overflow-hidden">
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
