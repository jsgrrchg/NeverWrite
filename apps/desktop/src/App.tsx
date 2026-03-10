import { useState, useEffect, useCallback } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
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
import { CommandPalette } from "./features/command-palette/CommandPalette";
import { QuickSwitcher } from "./features/quick-switcher/QuickSwitcher";
import { SettingsPanel } from "./features/settings";
import { useCommandStore } from "./features/command-palette/store/commandStore";
import {
    ATTACH_EXTERNAL_TAB_EVENT,
    type AttachExternalTabPayload,
    getCurrentWindowLabel,
    getWindowMode,
    openSettingsWindow,
    readDetachedWindowPayload,
} from "./app/detachedWindows";
import {
    useEditorStore,
    type Tab,
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
    markChatTabsReady,
    readPersistedChatWorkspace,
    resetChatTabsStore,
    useChatTabsStore,
} from "./features/ai/store/chatTabsStore";
import { resetChatStore, useChatStore } from "./features/ai/store/chatStore";

function SidebarPanel({ view }: { view: SidebarView }) {
    return (
        <div className="h-full flex flex-col overflow-hidden">
            <div className="flex-1 overflow-hidden">
                {view === "files" ? (
                    <FileTree />
                ) : view === "search" ? (
                    <SearchPanel autoFocus />
                ) : (
                    <TagsPanel />
                )}
            </div>
            <VaultSwitcher />
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
    const vaultName = openState.path?.split("/").pop() ?? "Vault";
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
    const activeNoteId = useEditorStore(
        (s) => s.tabs.find((t) => t.id === s.activeTabId)?.noteId ?? null,
    );
    const activeContent = useEditorStore(
        (s) => s.tabs.find((t) => t.id === s.activeTabId)?.content ?? null,
    );
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
function useRegisterCommands(openSearchPanel: () => void) {
    const register = useCommandStore((s) => s.register);
    const openCommandPalette = useCommandStore((s) => s.openCommandPalette);
    const openQuickSwitcher = useCommandStore((s) => s.openQuickSwitcher);

    useEffect(() => {
        const hasVault = () => useVaultStore.getState().vaultPath !== null;
        const hasActiveTab = () =>
            useEditorStore.getState().activeTabId !== null;

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
    }, [register, openCommandPalette, openQuickSwitcher, openSearchPanel]);
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

export default function App() {
    const sidebarView = useLayoutStore((s) => s.sidebarView);
    const setSidebarView = useLayoutStore((s) => s.setSidebarView);
    const restoreVault = useVaultStore((s) => s.restoreVault);
    const vaultPath = useVaultStore((s) => s.vaultPath);
    const applyVaultNoteChange = useVaultStore((s) => s.applyVaultNoteChange);
    const hydrateTabs = useEditorStore((s) => s.hydrateTabs);
    const insertExternalTab = useEditorStore((s) => s.insertExternalTab);
    const restoreChatWorkspace = useChatTabsStore((s) => s.restoreWorkspace);
    const windowMode = getWindowMode();

    const openSearchPanel = useCallback(() => {
        useLayoutStore.getState().setSidebarView("search");
        useLayoutStore.getState().expandSidebar();
    }, []);

    const openSettings = useCallback(() => void openSettingsWindow(), []);

    useRegisterCommands(openSearchPanel);
    useGlobalShortcuts(openSearchPanel, openSettings);
    useDynamicScrollbars();

    const restoreSessionForCurrentVault = useCallback(async () => {
        const vaultPath = useVaultStore.getState().vaultPath;
        const session = readPersistedSession(vaultPath);
        if (!session?.noteIds.length) return;

        const restoredTabs: Tab[] = [];
        for (const entry of session.noteIds) {
            try {
                const detail = await invoke<{ content: string }>("read_note", {
                    noteId: entry.noteId,
                });
                // Restore history entries (content only for current entry)
                const history = (entry.history ?? [{ noteId: entry.noteId, title: entry.title }])
                    .map((h) => ({
                        noteId: h.noteId,
                        title: h.title,
                        content: "",
                    }));
                const historyIndex = Math.min(
                    entry.historyIndex ?? history.length - 1,
                    history.length - 1,
                );
                // Fill in content for the current history entry
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

        if (!restoredTabs.length) return;

        const activeTab = restoredTabs.find(
            (tab) => tab.noteId === session.activeNoteId,
        );
        hydrateTabs(restoredTabs, activeTab?.id ?? null);
    }, [hydrateTabs]);

    useEffect(() => {
        const blockNativeContextMenu = (event: MouseEvent) => {
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
        if (windowMode !== "main") {
            const payload = readDetachedWindowPayload(getCurrentWindowLabel());
            if (payload) hydrateTabs(payload.tabs, payload.activeTabId);
            return;
        }

        void (async () => {
            const vaultParam = new URLSearchParams(window.location.search).get(
                "vault",
            );

            if (vaultParam) {
                await useVaultStore
                    .getState()
                    .openVault(decodeURIComponent(vaultParam));
                await restoreSessionForCurrentVault();
            } else {
                await restoreVault();
                await restoreSessionForCurrentVault();
            }

            markSessionReady();
        })();
    }, [hydrateTabs, restoreSessionForCurrentVault, restoreVault, windowMode]);

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
                Object.keys(chatState.sessionsById),
                chatState.activeSessionId,
            );
            markChatTabsReady();
        })();

        return () => {
            cancelled = true;
        };
    }, [
        restoreChatWorkspace,
        vaultPath,
        windowMode,
    ]);

    useEffect(() => {
        if (windowMode !== "main") return;

        let unlisten: (() => void) | undefined;

        void listen<VaultNoteChange>("vault://note-changed", (event) => {
            applyVaultNoteChange(event.payload);

            // Reload editor content for open tabs when file changes externally
            const change = event.payload;
            if (change.kind === "upsert" && change.note) {
                invalidateLivePreviewNoteCache(change.note.id);
                const noteId = change.note.id;
                const openTab = useEditorStore
                    .getState()
                    .tabs.find((t) => t.noteId === noteId);
                if (openTab) {
                    void invoke<{ title: string; content: string }>(
                        "read_note",
                        {
                            noteId,
                        },
                    ).then((detail) => {
                        useEditorStore.getState().reloadNoteContent(noteId, {
                            title: detail.title,
                            content: detail.content,
                        });
                    });
                }
            } else if (change.kind === "delete") {
                invalidateLivePreviewNoteCache(change.note_id);
            }
        }).then((cleanup) => {
            unlisten = cleanup;
        });

        return () => {
            if (unlisten) {
                void unlisten();
            }
        };
    }, [applyVaultNoteChange, windowMode]);

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

    if (windowMode === "settings") {
        return <SettingsPanel standalone onClose={() => {}} />;
    }

    if (windowMode === "note") {
        return (
            <div className="h-full flex flex-col overflow-hidden">
                <UnifiedBar windowMode="note" />
                <div className="flex-1 overflow-hidden">
                    <Editor emptyStateMessage="Esta ventana no tiene ninguna nota abierta" />
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
                    onChange={setSidebarView}
                    onOpenSettings={openSettings}
                />
                <div className="flex-1 overflow-hidden">
                    <AppLayout
                        left={<SidebarPanel view={sidebarView} />}
                        center={<Editor />}
                        right={<RightPanel />}
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
