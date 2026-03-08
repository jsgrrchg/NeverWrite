import { useState, useEffect, useCallback } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
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
import { useVaultStore } from "./app/store/vaultStore";
import { useLayoutStore } from "./app/store/layoutStore";

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

function OutlineRightPanel() {
    const activeNoteId = useEditorStore(
        (s) => s.tabs.find((t) => t.id === s.activeTabId)?.noteId ?? null,
    );
    const activeContent = useEditorStore(
        (s) => s.tabs.find((t) => t.id === s.activeTabId)?.content ?? null,
    );
    const activeTitle = useEditorStore(
        (s) => s.tabs.find((t) => t.id === s.activeTabId)?.title ?? null,
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
            title={activeTitle}
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

export default function App() {
    const [sidebarView, setSidebarView] = useState<SidebarView>("files");
    const restoreVault = useVaultStore((s) => s.restoreVault);
    const hydrateTabs = useEditorStore((s) => s.hydrateTabs);
    const insertExternalTab = useEditorStore((s) => s.insertExternalTab);
    const windowMode = getWindowMode();

    const openSearchPanel = useCallback(() => {
        setSidebarView("search");
        useLayoutStore.getState().expandSidebar();
    }, []);

    const openSettings = useCallback(() => void openSettingsWindow(), []);

    useRegisterCommands(openSearchPanel);
    useGlobalShortcuts(openSearchPanel, openSettings);

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
                // Opened as a new vault window — skip session restore
                await useVaultStore
                    .getState()
                    .openVault(decodeURIComponent(vaultParam));
            } else {
                await restoreVault();

                const session = readPersistedSession();
                if (session?.noteIds.length) {
                    const restoredTabs: Tab[] = [];
                    for (const { noteId, title } of session.noteIds) {
                        try {
                            const detail = await invoke<{ content: string }>(
                                "read_note",
                                { noteId },
                            );
                            restoredTabs.push({
                                id: crypto.randomUUID(),
                                noteId,
                                title,
                                content: detail.content,
                                isDirty: false,
                            });
                        } catch {
                            // Nota eliminada o no encontrada, se omite
                        }
                    }
                    if (restoredTabs.length > 0) {
                        const activeTab = restoredTabs.find(
                            (t) => t.noteId === session.activeNoteId,
                        );
                        hydrateTabs(restoredTabs, activeTab?.id ?? null);
                    }
                }
            }

            markSessionReady();
        })();
    }, [hydrateTabs, restoreVault, windowMode]);

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
                <CommandPalette />
                <QuickSwitcher />
            </div>
        );
    }

    return (
        <div className="h-full flex flex-col overflow-hidden">
            <UnifiedBar windowMode="main" />

            <div className="flex-1 flex overflow-hidden">
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
            </div>

            <CommandPalette />
            <QuickSwitcher />
        </div>
    );
}
