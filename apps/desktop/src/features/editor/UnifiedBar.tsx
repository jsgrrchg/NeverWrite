import {
    Fragment,
    useCallback,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
    type MouseEvent as ReactMouseEvent,
} from "react";
import { createPortal } from "react-dom";
import { confirm } from "@neverwrite/runtime";
import { getCurrentWindow } from "@neverwrite/runtime";
import { getCurrentWebview } from "@neverwrite/runtime";
import { openPath, revealItemInDir } from "@neverwrite/runtime";
import {
    getCurrentWindowLabel,
    publishWindowTabDropZone,
} from "../../app/detachedWindows";
import {
    useEditorStore,
    isChatTab,
    isChatHistoryTab,
    isNoteTab,
    isReviewTab,
    isFileTab,
    isPdfTab,
    selectEditorPaneState,
    selectEditorWorkspaceTabs,
    selectFocusedEditorTab,
    selectFocusedPaneId,
} from "../../app/store/editorStore";
import { useLayoutStore } from "../../app/store/layoutStore";
import { useSettingsStore } from "../../app/store/settingsStore";
import { useVaultStore } from "../../app/store/vaultStore";
import {
    ContextMenu,
    type ContextMenuState,
} from "../../components/context-menu/ContextMenu";
import { revealNoteInTree } from "../../app/utils/navigation";
import {
    closeOpenTabsForVaultPath,
    insertVaultEntryTab,
    moveVaultEntryToTrash,
} from "../../app/utils/vaultEntries";
import { vaultInvoke } from "../../app/utils/vaultInvoke";
import {
    emitFileTreeNoteDrag,
    FILE_TREE_NOTE_DRAG_EVENT,
    type FileTreeNoteDragDetail,
} from "../ai/dragEvents";
import { useChatStore } from "../ai/store/chatStore";
import {
    buildTabFileDragDetail,
    resolveComposerDropTarget,
} from "./tabDragAttachments";
import { renderEditorTabActivityIndicator } from "./EditorTabActivityIndicator";
import { useResponsiveEditorTabLayout } from "./editorTabStripLayout";
import { buildNewTabContextMenuEntries } from "./newTabMenuActions";
import { useCommandStore } from "../command-palette/store/commandStore";
import { isSearchTab, SEARCH_TAB_TITLE } from "../search/searchTab";
import { getTabStripDropIndex, useActiveTabStripReveal } from "./tabStrip";
import { WindowChrome } from "../../components/layout/WindowChrome";
import { getDesktopPlatform } from "../../app/utils/platform";
import { REQUEST_CLOSE_ACTIVE_TAB_EVENT } from "./Editor";
import { renderEditorTabLeadingIcon } from "./editorTabIcons";
import {
    getChromeIconButtonStyle,
    getChromeNavigationButtonStyle,
} from "./workspaceChromeControls";
import { useWorkspaceTabDrag } from "./useWorkspaceTabDrag";
import { useDetachedTabWindowDrop } from "./useDetachedTabWindowDrop";
import { logError } from "../../app/utils/runtimeLog";

const DRAGGING_TAB_PLACEHOLDER_OPACITY = 0.18;
const TAB_STRIP_FADE_WIDTH = 18;
const EMPTY_TAB_STRIP_OVERFLOW_STATE = {
    hasOverflow: false,
    showLeadingFade: false,
    showTrailingFade: false,
};

function getAppWindow() {
    return getCurrentWindow();
}

function startWindowDrag(event: ReactMouseEvent<HTMLElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    const appWindow = getAppWindow();
    void appWindow.startDragging().catch(() => {
        // Ignore denied / unsupported drag attempts and keep the bar interactive.
    });
}

function toggleWindowMaximize() {
    if (getDesktopPlatform() !== "windows") return;
    const appWindow = getAppWindow();
    if (typeof appWindow.toggleMaximize !== "function") return;
    void appWindow.toggleMaximize().catch(() => {
        // Ignore denied / unsupported maximize attempts.
    });
}

async function getWindowContentScreenOrigin() {
    const appWindow = getAppWindow();
    if (
        typeof appWindow.innerPosition !== "function" ||
        typeof appWindow.scaleFactor !== "function"
    ) {
        return { x: window.screenX, y: window.screenY };
    }

    try {
        const [innerPosition, scaleFactor] = await Promise.all([
            appWindow.innerPosition(),
            appWindow.scaleFactor(),
        ]);
        const logicalPosition =
            typeof innerPosition.toLogical === "function"
                ? innerPosition.toLogical(scaleFactor)
                : {
                      x: innerPosition.x / scaleFactor,
                      y: innerPosition.y / scaleFactor,
                  };

        return {
            x: logicalPosition.x,
            y: logicalPosition.y,
        };
    } catch {
        return { x: window.screenX, y: window.screenY };
    }
}

interface UnifiedBarProps {
    windowMode: "main" | "note";
}

export function UnifiedBar({ windowMode }: UnifiedBarProps) {
    const desktopPlatform = getDesktopPlatform();
    // Detached note windows on Windows now use the native `titleBarOverlay`
    // (min/max/close painted by DWM in the top-right 140px), so the trailing
    // drag zone has to reserve that width — otherwise tabs slide under the
    // caption buttons. Main windows already reserve 152 (140 for the native
    // controls + 12 for the right-panel toggle and its margins).
    const trailingDragZoneWidth =
        windowMode === "main" ? 152 : desktopPlatform === "windows" ? 140 : 8;
    const focusedPane = useEditorStore(selectEditorPaneState);
    const tabs = focusedPane.tabs;
    const activeTabId = focusedPane.activeTabId;
    const switchTab = useEditorStore((s) => s.switchTab);
    const closeTab = useEditorStore((s) => s.closeTab);
    const reorderPaneTabs = useEditorStore((s) => s.reorderPaneTabs);
    const moveTabToPaneDropTarget = useEditorStore(
        (s) => s.moveTabToPaneDropTarget,
    );
    const goBack = useEditorStore((s) => s.goBack);
    const goForward = useEditorStore((s) => s.goForward);
    const navigateToHistoryIndex = useEditorStore(
        (s) => s.navigateToHistoryIndex,
    );
    const tabOpenBehavior = useSettingsStore((s) => s.tabOpenBehavior);
    const developerModeEnabled = useSettingsStore(
        (s) => s.developerModeEnabled,
    );
    const developerTerminalEnabled = useSettingsStore(
        (s) => s.developerTerminalEnabled,
    );
    const fileTreeShowExtensions = useSettingsStore(
        (s) => s.fileTreeShowExtensions,
    );
    const focusedPaneId = useEditorStore(selectFocusedPaneId);
    const showHistoryNavigationButtons = tabOpenBehavior === "history";
    // Primitive selectors — stable when values don't change
    const canGoBack = useEditorStore((s) => {
        const pane = selectEditorPaneState(s);
        if (tabOpenBehavior === "history") {
            const tab = pane.tabs.find((t) => t.id === pane.activeTabId);
            return tab && (isNoteTab(tab) || isFileTab(tab) || isPdfTab(tab))
                ? tab.historyIndex > 0
                : false;
        }
        if (pane.tabNavigationIndex <= 0) return false;
        return pane.tabNavigationHistory
            .slice(0, pane.tabNavigationIndex)
            .some((tabId) => pane.tabs.some((tab) => tab.id === tabId));
    });
    const canGoForward = useEditorStore((s) => {
        const pane = selectEditorPaneState(s);
        if (tabOpenBehavior === "history") {
            const tab = pane.tabs.find((t) => t.id === pane.activeTabId);
            return tab && (isNoteTab(tab) || isFileTab(tab) || isPdfTab(tab))
                ? tab.historyIndex < tab.history.length - 1
                : false;
        }
        if (pane.tabNavigationIndex >= pane.tabNavigationHistory.length - 1) {
            return false;
        }
        return pane.tabNavigationHistory
            .slice(pane.tabNavigationIndex + 1)
            .some((tabId) => pane.tabs.some((tab) => tab.id === tabId));
    });
    const sidebarCollapsed = useLayoutStore((s) => s.sidebarCollapsed);
    const toggleSidebar = useLayoutStore((s) => s.toggleSidebar);
    const rightPanelCollapsed = useLayoutStore((s) => s.rightPanelCollapsed);
    const toggleRightPanel = useLayoutStore((s) => s.toggleRightPanel);
    const chatSessionsById = useChatStore((s) => s.sessionsById);
    const vaultPath = useVaultStore((s) => s.vaultPath);
    const refreshEntries = useVaultStore((s) => s.refreshEntries);
    const [tabContextMenu, setTabContextMenu] = useState<ContextMenuState<{
        tabId: string;
    }> | null>(null);
    const [historyContextMenu, setHistoryContextMenu] =
        useState<ContextMenuState<void> | null>(null);
    const [newTabContextMenu, setNewTabContextMenu] =
        useState<ContextMenuState<void> | null>(null);
    const [externalFileDropActive, setExternalFileDropActive] = useState(false);
    const [tabStripOverflowState, setTabStripOverflowState] = useState(
        EMPTY_TAB_STRIP_OVERFLOW_STATE,
    );
    const canCreateSplit = true;

    const handleMoveTabFileToTrash = useCallback(
        async (path: string, title: string) => {
            if (!vaultPath || !path.startsWith(vaultPath)) {
                return;
            }

            const relativePath = path
                .slice(vaultPath.length)
                .replace(/^[/\\]+/, "");
            const approved = await confirm(`Move "${title}" to Trash?`, {
                title: "Move File to Trash",
                kind: "warning",
            });
            if (!approved) return;

            try {
                await moveVaultEntryToTrash(relativePath);
                closeOpenTabsForVaultPath(path);
                await refreshEntries();
            } catch (error) {
                logError("unified-bar", "Failed to move file to trash", error);
            }
        },
        [refreshEntries, vaultPath],
    );

    const tabDropZoneRef = useRef<HTMLDivElement | null>(null);
    const detachedTabWindowDrop = useDetachedTabWindowDrop({
        vaultPath,
        windowMode,
        getTabById: (tabId) =>
            selectEditorWorkspaceTabs(useEditorStore.getState()).find(
                (tab) => tab.id === tabId,
            ) ?? null,
        getWorkspaceTabCount: () =>
            selectEditorWorkspaceTabs(useEditorStore.getState()).length,
        closeTab,
    });

    const {
        dragPreviewNodeRef,
        dragPreviewTabId,
        dragOffsetX,
        draggingTabId,
        detachPreviewActive,
        internalDragActiveRef,
        projectedDropIndex,
        tabStripRef,
        visualTabs,
        registerTabNode,
        handlePointerDown,
        handlePointerMove,
        handlePointerUp,
        handleLostPointerCapture,
        consumeSuppressedClick,
    } = useWorkspaceTabDrag({
        tabs,
        onCommitReorder: (fromIndex, toIndex) => {
            if (!focusedPaneId) {
                return;
            }
            reorderPaneTabs(focusedPaneId, fromIndex, toIndex);
        },
        onActivate: switchTab,
        liveReorder: false,
        resolveExternalDropTarget: (tabId, coords) => {
            const composerTarget = resolveComposerDropTarget(
                coords.clientX,
                coords.clientY,
            );
            if (composerTarget.type !== "none") {
                return composerTarget;
            }

            return detachedTabWindowDrop.resolveDetachDropTarget(tabId, coords);
        },
        onCommitExternalDrop: (tabId, target, coords) => {
            if (target.type !== "detach-window") {
                return;
            }

            return detachedTabWindowDrop.commitDetachDrop(tabId, coords);
        },
        onDetachStart: detachedTabWindowDrop.handleDetachStart,
        onDetachMove: detachedTabWindowDrop.handleDetachMove,
        onDetachCancel: detachedTabWindowDrop.handleDetachCancel,
        buildAttachmentDetail: (tabId, phase, coords) => {
            const tab = selectEditorWorkspaceTabs(
                useEditorStore.getState(),
            ).find((item) => item.id === tabId);
            if (!tab) {
                return null;
            }

            return buildTabFileDragDetail(tab, phase, coords, {
                resolveNotePath: (noteId) =>
                    useVaultStore
                        .getState()
                        .notes.find((note) => note.id === noteId)?.path ?? null,
            });
        },
    });
    const tabOrderKey = visualTabs.map((tab) => tab.id).join("|");
    const tabLayout = useResponsiveEditorTabLayout({
        stripRef: tabStripRef,
        tabCount: visualTabs.length,
        freeze: draggingTabId !== null,
    });

    const clearTabStripOverflowState = useCallback(() => {
        setTabStripOverflowState((current) =>
            current.hasOverflow ||
            current.showLeadingFade ||
            current.showTrailingFade
                ? EMPTY_TAB_STRIP_OVERFLOW_STATE
                : current,
        );
    }, []);

    const syncTabStripOverflowState = useCallback(() => {
        const strip = tabStripRef.current;
        if (!strip) {
            clearTabStripOverflowState();
            return;
        }

        const maxScrollLeft = Math.max(
            0,
            strip.scrollWidth - strip.clientWidth,
        );
        const next = {
            hasOverflow: maxScrollLeft > 1,
            showLeadingFade: strip.scrollLeft > 1,
            showTrailingFade: strip.scrollLeft < maxScrollLeft - 1,
        };

        setTabStripOverflowState((current) =>
            current.hasOverflow === next.hasOverflow &&
            current.showLeadingFade === next.showLeadingFade &&
            current.showTrailingFade === next.showTrailingFade
                ? current
                : next,
        );
    }, [clearTabStripOverflowState, tabStripRef]);

    const handleTabStripRef = useCallback(
        (node: HTMLDivElement | null) => {
            tabStripRef.current = node;
            if (node === null) {
                clearTabStripOverflowState();
            }
        },
        [clearTabStripOverflowState, tabStripRef],
    );

    useLayoutEffect(() => {
        const strip = tabStripRef.current;
        if (!strip) {
            return;
        }

        const handleScroll = () => {
            syncTabStripOverflowState();
        };

        const frame = window.requestAnimationFrame(syncTabStripOverflowState);
        let resizeObserver: ResizeObserver | null = null;

        strip.addEventListener("scroll", handleScroll, { passive: true });

        if (typeof ResizeObserver !== "undefined") {
            resizeObserver = new ResizeObserver(() => {
                syncTabStripOverflowState();
            });
            resizeObserver.observe(strip);
        }

        window.addEventListener("resize", syncTabStripOverflowState);

        return () => {
            window.cancelAnimationFrame(frame);
            strip.removeEventListener("scroll", handleScroll);
            resizeObserver?.disconnect();
            window.removeEventListener("resize", syncTabStripOverflowState);
        };
    }, [
        syncTabStripOverflowState,
        tabLayout.density,
        tabOrderKey,
        tabStripRef,
    ]);

    const handleTabClick = useCallback(
        (tabId: string) => {
            if (consumeSuppressedClick(tabId)) return;
            switchTab(tabId);
        },
        [consumeSuppressedClick, switchTab],
    );
    const draggingOriginalIndex = draggingTabId
        ? tabs.findIndex((tab) => tab.id === draggingTabId)
        : -1;
    const insertionIndicatorIndex =
        draggingOriginalIndex === -1 || projectedDropIndex == null
            ? null
            : projectedDropIndex > draggingOriginalIndex
              ? projectedDropIndex + 1
              : projectedDropIndex;

    const handleCloseTab = useCallback(
        async (tabId: string) => {
            const state = useEditorStore.getState();
            const currentTabs = selectEditorWorkspaceTabs(state);
            const focusedTab = selectFocusedEditorTab(state);
            const targetTab =
                currentTabs.find((candidate) => candidate.id === tabId) ??
                null;
            if (!targetTab) {
                return;
            }

            if (windowMode === "note" && currentTabs.length === 1) {
                const appWindow = getAppWindow();
                await appWindow.close().catch((error) => {
                    logError("unified-bar", "Failed to close window", error);
                });
                return;
            }

            if (windowMode === "main" && tabId === focusedTab?.id) {
                const activeTab = focusedTab;
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
            }

            if (isChatTab(targetTab)) {
                const session = useChatStore.getState().sessionsById[targetTab.sessionId];
                if (
                    session &&
                    (session.status === "streaming" ||
                        session.status === "waiting_permission" ||
                        session.status === "waiting_user_input")
                ) {
                    const confirmed = await confirm(
                        "The AI agent is still running. Are you sure you want to close this tab?",
                    );
                    if (!confirmed) {
                        return;
                    }
                }
            }

            closeTab(tabId, { reason: "user" });
        },
        [closeTab, windowMode],
    );

    const closeTabIdsWithProtection = useCallback(
        async (
            tabIds: string[],
            options: {
                reason: "bulk-user" | "user";
            },
        ) => {
            const state = useEditorStore.getState();
            const currentTabs = selectEditorWorkspaceTabs(state);
            const tabsToClose = tabIds
                .map(
                    (tabId) =>
                        currentTabs.find((candidate) => candidate.id === tabId) ??
                        null,
                )
                .filter((tab): tab is (typeof currentTabs)[number] => tab !== null);

            if (tabsToClose.length === 0) {
                return false;
            }

            const sessionsById = useChatStore.getState().sessionsById;
            const hasActiveAgent = tabsToClose.some((tab) => {
                if (!isChatTab(tab)) return false;
                const session = sessionsById[tab.sessionId];
                return (
                    session &&
                    (session.status === "streaming" ||
                        session.status === "waiting_permission" ||
                        session.status === "waiting_user_input")
                );
            });

            if (hasActiveAgent) {
                const confirmed = await confirm(
                    "An AI agent is still running. Are you sure you want to close these tabs?",
                );
                if (!confirmed) {
                    return false;
                }
            }

            for (const id of tabIds) {
                useEditorStore.getState().closeTab(id, {
                    reason: options.reason,
                });
            }

            return true;
        },
        [],
    );

    const getExternalFileDropTarget = useCallback(
        (clientX: number, clientY: number) => {
            const strip = tabStripRef.current;
            if (strip) {
                const rect = strip.getBoundingClientRect();
                const isOverStrip =
                    clientX >= rect.left &&
                    clientX <= rect.right &&
                    clientY >= rect.top &&
                    clientY <= rect.bottom;
                if (isOverStrip) {
                    return {
                        insertIndex: getTabStripDropIndex(strip, clientX),
                    };
                }
            }

            const dropZone = tabDropZoneRef.current;
            if (!dropZone) {
                return null;
            }

            const rect = dropZone.getBoundingClientRect();
            const isOverDropZone =
                clientX >= rect.left &&
                clientX <= rect.right &&
                clientY >= rect.top &&
                clientY <= rect.bottom;

            if (!isOverDropZone) {
                return null;
            }

            return { insertIndex: tabs.length };
        },
        [tabs.length, tabStripRef],
    );

    const handleOpenDroppedVaultFiles = useCallback(
        async (paths: string[], insertIndex: number) => {
            const entriesByPath = new Map(
                useVaultStore
                    .getState()
                    .entries.map((entry) => [entry.path, entry]),
            );
            let nextIndex = insertIndex;

            for (const path of paths) {
                const entry = entriesByPath.get(path);
                if (!entry) {
                    continue;
                }

                const inserted = await insertVaultEntryTab(entry, nextIndex);
                if (inserted) {
                    nextIndex += 1;
                }
            }
        },
        [],
    );

    const handleOpenDroppedTreeItems = useCallback(
        async (detail: FileTreeNoteDragDetail, insertIndex: number) => {
            let nextIndex = insertIndex;

            for (const note of detail.notes) {
                try {
                    const noteDetail = await vaultInvoke<{ content: string }>(
                        "read_note",
                        {
                            noteId: note.id,
                        },
                    );
                    useEditorStore.getState().insertExternalTab(
                        {
                            id: crypto.randomUUID(),
                            kind: "note",
                            noteId: note.id,
                            title: note.title,
                            content: noteDetail.content,
                        },
                        nextIndex,
                    );
                    nextIndex += 1;
                } catch (error) {
                    logError(
                        "unified-bar",
                        "Failed to open dropped note tab",
                        error,
                    );
                }
            }

            for (const file of detail.files ?? []) {
                const entry = useVaultStore
                    .getState()
                    .entries.find((item) => item.path === file.filePath);
                if (!entry) {
                    continue;
                }

                const inserted = await insertVaultEntryTab(entry, nextIndex);
                if (inserted) {
                    nextIndex += 1;
                }
            }
        },
        [],
    );

    const closeOtherTabs = useCallback(async (tabId: string) => {
        const tabIds = selectEditorPaneState(useEditorStore.getState())
            .tabs.filter((tab) => tab.id !== tabId)
            .map((tab) => tab.id);

        await closeTabIdsWithProtection(tabIds, {
            reason: "bulk-user",
        });
    }, [closeTabIdsWithProtection]);

    const closeTabsToTheRight = useCallback(async (tabId: string) => {
        const pane = selectEditorPaneState(useEditorStore.getState());
        const index = pane.tabs.findIndex((tab) => tab.id === tabId);
        if (index === -1) return;

        const tabIds = pane.tabs
            .slice(index + 1)
            .map((tab) => tab.id)
            .reverse();

        await closeTabIdsWithProtection(tabIds, {
            reason: "bulk-user",
        });
    }, [closeTabIdsWithProtection]);

    const closeTabsToTheLeft = useCallback(async (tabId: string) => {
        const pane = selectEditorPaneState(useEditorStore.getState());
        const index = pane.tabs.findIndex((tab) => tab.id === tabId);
        if (index === -1) return;

        const tabIds = pane.tabs.slice(0, index).map((tab) => tab.id);

        await closeTabIdsWithProtection(tabIds, {
            reason: "bulk-user",
        });
    }, [closeTabIdsWithProtection]);

    const emitTabDragDetail = useCallback(
        (tabId: string, phase: "attach" | "start" | "move" | "end") => {
            const tab = selectEditorWorkspaceTabs(
                useEditorStore.getState(),
            ).find((item) => item.id === tabId);
            if (!tab) {
                return;
            }

            const detail = buildTabFileDragDetail(
                tab,
                phase,
                { clientX: 0, clientY: 0 },
                {
                    resolveNotePath: (noteId) =>
                        useVaultStore
                            .getState()
                            .notes.find((note) => note.id === noteId)?.path ??
                        null,
                },
            );
            if (!detail) {
                return;
            }

            emitFileTreeNoteDrag({
                ...detail,
                origin: {
                    kind: "workspace-tab",
                    tabId,
                },
            });
        },
        [],
    );

    const draggedPreviewTab =
        draggingTabId && dragPreviewTabId === draggingTabId
            ? (tabs.find((tab) => tab.id === draggingTabId) ?? null)
            : null;
    const showFloatingTabPreview =
        draggedPreviewTab !== null && dragPreviewTabId !== null;

    useLayoutEffect(() => {
        const label = getCurrentWindowLabel();
        let disposed = false;
        let frame: number | null = null;
        let publishVersion = 0;
        let resizeObserver: ResizeObserver | null = null;
        const cleanupListeners: Array<() => void> = [];

        const schedulePublish = () => {
            if (disposed) return;
            if (frame !== null) {
                window.cancelAnimationFrame(frame);
            }

            frame = window.requestAnimationFrame(() => {
                frame = null;
                const dropZone = tabDropZoneRef.current;
                if (!dropZone) {
                    publishWindowTabDropZone(label, null);
                    return;
                }

                const rect = dropZone.getBoundingClientRect();
                if (rect.width <= 0 || rect.height <= 0) {
                    publishWindowTabDropZone(label, null);
                    return;
                }

                const nextVersion = publishVersion + 1;
                publishVersion = nextVersion;
                const nextRect = {
                    left: rect.left,
                    top: rect.top,
                    width: rect.width,
                    height: rect.height,
                };

                void getWindowContentScreenOrigin().then((origin) => {
                    if (disposed || publishVersion !== nextVersion) return;

                    const left = origin.x + nextRect.left;
                    const top = origin.y + nextRect.top;
                    publishWindowTabDropZone(label, {
                        left: Math.round(left),
                        top: Math.round(top),
                        right: Math.round(left + nextRect.width),
                        bottom: Math.round(top + nextRect.height),
                        vaultPath,
                    });
                });
            });
        };

        schedulePublish();
        window.addEventListener("resize", schedulePublish);
        window.addEventListener("focus", schedulePublish);

        const strip = tabStripRef.current;
        if (strip && typeof ResizeObserver !== "undefined") {
            resizeObserver = new ResizeObserver(() => {
                schedulePublish();
            });
            resizeObserver.observe(strip);
        }

        const appWindow = getAppWindow();

        void Promise.resolve(
            appWindow.onMoved(() => {
                schedulePublish();
            }),
        ).then((unlisten) => {
            if (typeof unlisten !== "function") {
                return;
            }
            if (disposed) {
                void unlisten();
                return;
            }
            cleanupListeners.push(unlisten);
        });

        void Promise.resolve(
            appWindow.onResized(() => {
                schedulePublish();
            }),
        ).then((unlisten) => {
            if (typeof unlisten !== "function") {
                return;
            }
            if (disposed) {
                void unlisten();
                return;
            }
            cleanupListeners.push(unlisten);
        });

        void Promise.resolve(
            appWindow.onScaleChanged(() => {
                schedulePublish();
            }),
        ).then((unlisten) => {
            if (typeof unlisten !== "function") {
                return;
            }
            if (disposed) {
                void unlisten();
                return;
            }
            cleanupListeners.push(unlisten);
        });

        return () => {
            disposed = true;
            if (frame !== null) {
                window.cancelAnimationFrame(frame);
            }
            resizeObserver?.disconnect();
            window.removeEventListener("resize", schedulePublish);
            window.removeEventListener("focus", schedulePublish);
            cleanupListeners.forEach((unlisten) => {
                void unlisten();
            });
            publishWindowTabDropZone(label, null);
        };
    }, [tabOrderKey, tabStripRef, vaultPath]);

    useActiveTabStripReveal({
        stripRef: tabStripRef,
        activeTabId,
        draggingTabId,
        tabOrderKey,
        tabIdAttribute: "data-tab-id",
    });

    useEffect(() => {
        let mounted = true;
        let unlisten: (() => void) | null = null;

        void getCurrentWebview()
            .onDragDropEvent((event) => {
                const { type } = event.payload;
                const position = (
                    event.payload as {
                        position?: { x: number; y: number };
                        paths?: string[];
                    }
                ).position;

                const dropTarget = position
                    ? getExternalFileDropTarget(position.x, position.y)
                    : null;

                if (type === "enter" || type === "over") {
                    if (mounted) {
                        setExternalFileDropActive(dropTarget !== null);
                    }
                    return;
                }

                if (mounted) {
                    setExternalFileDropActive(false);
                }

                if (type !== "drop" || !dropTarget) {
                    return;
                }

                const paths =
                    (event.payload as { paths?: string[] }).paths ?? [];
                if (paths.length === 0) {
                    return;
                }

                void handleOpenDroppedVaultFiles(paths, dropTarget.insertIndex);
            })
            .then((fn) => {
                if (mounted) {
                    unlisten = fn;
                    return;
                }
                fn();
            });

        return () => {
            mounted = false;
            unlisten?.();
        };
    }, [getExternalFileDropTarget, handleOpenDroppedVaultFiles]);

    useEffect(() => {
        const handleTreeDrag = (event: Event) => {
            const detail = (event as CustomEvent<FileTreeNoteDragDetail>)
                .detail;
            const hasTabPayload =
                detail.notes.length > 0 || (detail.files?.length ?? 0) > 0;
            if (!hasTabPayload) {
                if (detail.phase !== "attach") {
                    setExternalFileDropActive(false);
                }
                return;
            }

            if (detail.phase === "cancel") {
                setExternalFileDropActive(false);
                return;
            }

            if (detail.origin?.kind === "workspace-tab") {
                setExternalFileDropActive(false);
                return;
            }

            // Ignore events from internal tab reorder drags — the reorder
            // commit handles positioning.  Without this guard the handler
            // opens a duplicate tab at the drop position.
            if (internalDragActiveRef.current) {
                if (detail.phase === "end") {
                    setExternalFileDropActive(false);
                }
                return;
            }

            if (detail.phase === "attach") {
                void handleOpenDroppedTreeItems(detail, tabs.length);
                return;
            }

            const dropTarget = getExternalFileDropTarget(detail.x, detail.y);
            setExternalFileDropActive(dropTarget !== null);

            if (detail.phase !== "end" || !dropTarget) {
                return;
            }

            setExternalFileDropActive(false);
            void handleOpenDroppedTreeItems(detail, dropTarget.insertIndex);
        };

        window.addEventListener(FILE_TREE_NOTE_DRAG_EVENT, handleTreeDrag);
        return () =>
            window.removeEventListener(
                FILE_TREE_NOTE_DRAG_EVENT,
                handleTreeDrag,
            );
    }, [
        getExternalFileDropTarget,
        handleOpenDroppedTreeItems,
        internalDragActiveRef,
        tabs.length,
    ]);

    const hasTabs = visualTabs.length > 0;

    return (
        <>
            <WindowChrome
                onBackgroundMouseDown={(event) => {
                    if (event.target === event.currentTarget) {
                        startWindowDrag(event);
                    }
                }}
                showLeadingInset
                onLeadingInsetMouseDown={startWindowDrag}
                shellStyle={{
                    // Detached note windows adopt the same chrome as an
                    // in-window pane bar: solid --bg-secondary surface with a
                    // single bottom border. Keeps the tear-off visually
                    // consistent with the panes the user just dragged from.
                    background: "var(--bg-secondary)",
                    borderBottom: "1px solid var(--border)",
                }}
                barStyle={{ padding: "0 6px" }}
            >
                {windowMode === "main" && (
                    <>
                        <button
                            onClick={toggleSidebar}
                            title={
                                sidebarCollapsed
                                    ? "Show sidebar"
                                    : "Hide sidebar"
                            }
                            className="no-drag flex items-center justify-center shrink-0 ub-nav-btn"
                            style={{
                                alignSelf: "center",
                                marginLeft: 10,
                                marginRight: 2,
                                width: 30,
                                height: 30,
                                borderRadius: 9,
                                border: "1px solid var(--border)",
                                background: "var(--bg-secondary)",
                                boxShadow:
                                    "0 1px 3px rgba(0,0,0,0.10), 0 1px 1px rgba(0,0,0,0.06)",
                                color: "var(--text-secondary)",
                                opacity: sidebarCollapsed ? 0.55 : 0.85,
                                cursor: "pointer",
                            }}
                        >
                            <svg
                                width="14"
                                height="14"
                                viewBox="0 0 16 16"
                                fill="none"
                            >
                                <rect
                                    x="1"
                                    y="2"
                                    width="4"
                                    height="12"
                                    rx="1"
                                    fill="currentColor"
                                    opacity={sidebarCollapsed ? 0.4 : 1}
                                />
                                <rect
                                    x="7"
                                    y="2"
                                    width="8"
                                    height="2"
                                    rx="1"
                                    fill="currentColor"
                                />
                                <rect
                                    x="7"
                                    y="7"
                                    width="8"
                                    height="2"
                                    rx="1"
                                    fill="currentColor"
                                />
                                <rect
                                    x="7"
                                    y="12"
                                    width="8"
                                    height="2"
                                    rx="1"
                                    fill="currentColor"
                                />
                            </svg>
                        </button>
                        {showHistoryNavigationButtons && (
                            <>
                                <button
                                    onMouseDown={(e) => e.stopPropagation()}
                                    onClick={goBack}
                                    onContextMenu={(e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        if (!canGoBack) return;
                                        const rect =
                                            e.currentTarget.getBoundingClientRect();
                                        setHistoryContextMenu({
                                            x: rect.left,
                                            y: rect.bottom + 4,
                                            payload: undefined,
                                        });
                                    }}
                                    disabled={!canGoBack}
                                    title="Go back"
                                    className="no-drag flex items-center justify-center shrink-0 ub-nav-btn"
                                    style={{
                                        alignSelf: "center",
                                        marginRight: 0,
                                        ...getChromeNavigationButtonStyle(
                                            "leading",
                                            canGoBack,
                                        ),
                                    }}
                                >
                                    <svg
                                        width="14"
                                        height="14"
                                        viewBox="0 0 16 16"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="1.8"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                    >
                                        <path d="M9.5 3L4.5 8l5 5" />
                                    </svg>
                                </button>
                                <button
                                    onMouseDown={(e) => e.stopPropagation()}
                                    onClick={goForward}
                                    disabled={!canGoForward}
                                    title="Go forward"
                                    className="no-drag flex items-center justify-center shrink-0 ub-nav-btn"
                                    style={{
                                        alignSelf: "center",
                                        marginRight: 4,
                                        ...getChromeNavigationButtonStyle(
                                            "trailing",
                                            canGoForward,
                                        ),
                                    }}
                                >
                                    <svg
                                        width="14"
                                        height="14"
                                        viewBox="0 0 16 16"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="1.8"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                    >
                                        <path d="M6.5 3L11.5 8l-5 5" />
                                    </svg>
                                </button>
                            </>
                        )}
                    </>
                )}

                {hasTabs ? (
                    <>
                        <div
                            onMouseDown={startWindowDrag}
                            style={{ width: 10, flexShrink: 0 }}
                        />

                        <div
                            ref={tabDropZoneRef}
                            className="no-drag flex min-w-0 flex-1 overflow-hidden items-center"
                        >
                            <div className="no-drag relative flex min-w-0 flex-1 overflow-hidden">
                                <div
                                    ref={handleTabStripRef}
                                    data-tab-strip="true"
                                    data-tab-density={tabLayout.density}
                                    data-tab-overflowing={
                                        tabStripOverflowState.hasOverflow ||
                                        undefined
                                    }
                                    className="no-drag relative flex min-w-0 shrink overflow-x-auto scrollbar-hidden items-end self-stretch"
                                    style={{
                                        gap: tabLayout.stripGap,
                                        padding: `0 ${tabLayout.stripPaddingX}px`,
                                        background: detachPreviewActive
                                            ? "color-mix(in srgb, var(--accent) 8%, transparent)"
                                            : externalFileDropActive
                                              ? "color-mix(in srgb, var(--accent) 10%, transparent)"
                                              : "transparent",
                                        boxShadow: detachPreviewActive
                                            ? "inset 0 0 0 1px color-mix(in srgb, var(--accent) 24%, transparent)"
                                            : externalFileDropActive
                                              ? "inset 0 0 0 1px color-mix(in srgb, var(--accent) 20%, transparent)"
                                              : "none",
                                        transition:
                                            "background-color 120ms ease, box-shadow 120ms ease",
                                    }}
                                    onWheel={(event) => {
                                        if (event.deltaY !== 0) {
                                            event.currentTarget.scrollLeft +=
                                                event.deltaY;
                                            event.preventDefault();
                                        }
                                    }}
                                >
                                    {insertionIndicatorIndex === 0 && (
                                        <div
                                            aria-hidden="true"
                                            className="shrink-0 rounded-full"
                                            style={{
                                                width: 3,
                                                height: 22,
                                                backgroundColor:
                                                    "var(--accent)",
                                                boxShadow:
                                                    "0 0 0 1px color-mix(in srgb, var(--accent) 22%, transparent)",
                                            }}
                                        />
                                    )}
                                    {visualTabs.map((tab, index) => {
                                        const isActive = tab.id === activeTabId;
                                        const isDragging =
                                            tab.id === draggingTabId;
                                        const tabTooltip = isSearchTab(tab)
                                            ? SEARCH_TAB_TITLE
                                            : isNoteTab(tab)
                                              ? tab.noteId
                                              : tab.kind === "file"
                                                ? tab.relativePath
                                                : tab.title;

                                        return (
                                            <Fragment key={tab.id}>
                                                <div
                                                    data-tab-id={tab.id}
                                                    ref={(node) =>
                                                        registerTabNode(
                                                            tab.id,
                                                            node,
                                                        )
                                                    }
                                                    title={tabTooltip}
                                                    onClick={() =>
                                                        handleTabClick(tab.id)
                                                    }
                                                    onContextMenu={(event) => {
                                                        event.preventDefault();
                                                        setTabContextMenu({
                                                            x: event.clientX,
                                                            y: event.clientY,
                                                            payload: {
                                                                tabId: tab.id,
                                                            },
                                                        });
                                                    }}
                                                    onPointerDown={(event) =>
                                                        handlePointerDown(
                                                            tab.id,
                                                            index,
                                                            event,
                                                        )
                                                    }
                                                    onPointerMove={(event) =>
                                                        handlePointerMove(
                                                            tab.id,
                                                            event,
                                                        )
                                                    }
                                                    onPointerUp={(event) =>
                                                        handlePointerUp(
                                                            event.pointerId,
                                                            {
                                                                clientX:
                                                                    event.clientX,
                                                                clientY:
                                                                    event.clientY,
                                                                screenX:
                                                                    event.screenX,
                                                                screenY:
                                                                    event.screenY,
                                                            },
                                                        )
                                                    }
                                                    onPointerCancel={(event) =>
                                                        handlePointerUp(
                                                            event.pointerId,
                                                            {
                                                                clientX:
                                                                    event.clientX,
                                                                clientY:
                                                                    event.clientY,
                                                                screenX:
                                                                    event.screenX,
                                                                screenY:
                                                                    event.screenY,
                                                            },
                                                        )
                                                    }
                                                    onLostPointerCapture={(
                                                        event,
                                                    ) =>
                                                        handleLostPointerCapture(
                                                            event.pointerId,
                                                        )
                                                    }
                                                    className="group no-drag flex items-center cursor-pointer ub-tab"
                                                    data-active={
                                                        isActive || undefined
                                                    }
                                                    data-dragging={
                                                        isDragging || undefined
                                                    }
                                                    style={{
                                                        width: tabLayout.tabWidth,
                                                        minWidth:
                                                            tabLayout.tabWidth,
                                                        maxWidth: 240,
                                                        height: 33,
                                                        flexShrink: 0,
                                                        boxSizing: "border-box",
                                                        gap: tabLayout.tabGap,
                                                        padding: `0 ${tabLayout.tabPaddingX}px`,
                                                        borderRight:
                                                            "1px solid color-mix(in srgb, var(--border) 45%, transparent)",
                                                        background: isActive
                                                            ? "var(--bg-primary)"
                                                            : "transparent",
                                                        color: isActive
                                                            ? "var(--text-primary)"
                                                            : "var(--text-secondary)",
                                                        boxShadow: isActive
                                                            ? "inset 0 -2px 0 0 var(--accent)"
                                                            : "none",
                                                        zIndex: isActive
                                                            ? 10
                                                            : isDragging
                                                              ? 20
                                                              : 0,
                                                        opacity: isDragging
                                                            ? DRAGGING_TAB_PLACEHOLDER_OPACITY
                                                            : 1,
                                                        transform: isDragging
                                                            ? `translateX(${dragOffsetX}px)`
                                                            : undefined,
                                                        transition: isDragging
                                                            ? "none"
                                                            : "transform 250ms cubic-bezier(0.2, 0.8, 0.2, 1), background 150ms ease, color 150ms ease, box-shadow 150ms ease",
                                                        willChange: isDragging
                                                            ? "transform"
                                                            : undefined,
                                                    }}
                                                >
                                                    {renderEditorTabLeadingIcon(
                                                        tab,
                                                        chatSessionsById,
                                                    )}
                                                    {renderEditorTabActivityIndicator(
                                                        tab,
                                                        chatSessionsById,
                                                    )}
                                                    <span
                                                        className="flex-1 truncate font-medium"
                                                        style={{
                                                            fontSize:
                                                                tabLayout.titleFontSize,
                                                        }}
                                                    >
                                                        {isSearchTab(tab)
                                                            ? SEARCH_TAB_TITLE
                                                            : fileTreeShowExtensions &&
                                                                isNoteTab(tab)
                                                            ? `${
                                                                  tab.noteId
                                                                      .split(
                                                                          "/",
                                                                      )
                                                                      .pop() ||
                                                                  tab.title
                                                              }${
                                                                  tab.noteId
                                                                      ? ".md"
                                                                      : ""
                                                              }`
                                                            : tab.title}
                                                    </span>
                                                    <button
                                                        onClick={(event) => {
                                                            event.stopPropagation();
                                                            void handleCloseTab(
                                                                tab.id,
                                                            );
                                                        }}
                                                        className={`no-drag shrink-0 rounded-md flex items-center justify-center transition-[background-color,opacity,transform] duration-150 ease-out hover:bg-gray-500/30 active:bg-gray-500/55 active:scale-90 ${
                                                            isActive
                                                                ? "opacity-70 hover:opacity-100"
                                                                : "opacity-0 group-hover:opacity-65 hover:opacity-100!"
                                                        }`}
                                                        style={{
                                                            width: tabLayout.closeButtonSize,
                                                            height: tabLayout.closeButtonSize,
                                                        }}
                                                    >
                                                        <svg
                                                            width={
                                                                tabLayout.closeIconSize
                                                            }
                                                            height={
                                                                tabLayout.closeIconSize
                                                            }
                                                            viewBox="0 0 16 16"
                                                            fill="none"
                                                            stroke="currentColor"
                                                            strokeWidth="2.1"
                                                            strokeLinecap="round"
                                                            strokeLinejoin="round"
                                                        >
                                                            <path d="M4 4l8 8M4 12l8-8" />
                                                        </svg>
                                                    </button>
                                                </div>
                                                {insertionIndicatorIndex ===
                                                    index + 1 && (
                                                    <div
                                                        aria-hidden="true"
                                                        className="shrink-0 rounded-full"
                                                        style={{
                                                            width: 3,
                                                            height: 22,
                                                            backgroundColor:
                                                                "var(--accent)",
                                                            boxShadow:
                                                                "0 0 0 1px color-mix(in srgb, var(--accent) 22%, transparent)",
                                                        }}
                                                    />
                                                )}
                                            </Fragment>
                                        );
                                    })}

                                    <button
                                        data-new-tab-button="true"
                                        onMouseDown={(e) => e.stopPropagation()}
                                        onClick={() => {
                                            useCommandStore
                                                .getState()
                                                .openQuickSwitcher();
                                        }}
                                        onContextMenu={(event) => {
                                            event.preventDefault();
                                            event.stopPropagation();
                                            setNewTabContextMenu({
                                                x: event.clientX,
                                                y: event.clientY,
                                                payload: undefined,
                                            });
                                        }}
                                        title="New tab"
                                        className="no-drag flex items-center justify-center shrink-0 ub-chrome-btn"
                                        style={{
                                            fontSize: 18,
                                            lineHeight: 1,
                                            alignSelf: "center",
                                            marginLeft: 4,
                                            flexShrink: 0,
                                            ...getChromeIconButtonStyle(false),
                                        }}
                                    >
                                        +
                                    </button>
                                </div>

                                <div
                                    onMouseDown={startWindowDrag}
                                    onDoubleClick={() => toggleWindowMaximize()}
                                    className="drag min-w-2 flex-1"
                                />
                            </div>
                            {tabStripOverflowState.showLeadingFade && (
                                <div
                                    data-tab-strip-fade="leading"
                                    aria-hidden="true"
                                    style={{
                                        position: "absolute",
                                        left: 0,
                                        top: 0,
                                        bottom: 0,
                                        width: TAB_STRIP_FADE_WIDTH,
                                        pointerEvents: "none",
                                        background:
                                            "linear-gradient(90deg, color-mix(in srgb, var(--bg-tertiary) 96%, transparent), transparent)",
                                    }}
                                />
                            )}
                            {tabStripOverflowState.showTrailingFade && (
                                <div
                                    data-tab-strip-fade="trailing"
                                    aria-hidden="true"
                                    style={{
                                        position: "absolute",
                                        right: 0,
                                        top: 0,
                                        bottom: 0,
                                        width: TAB_STRIP_FADE_WIDTH,
                                        pointerEvents: "none",
                                        background:
                                            "linear-gradient(270deg, color-mix(in srgb, var(--bg-tertiary) 96%, transparent), transparent)",
                                    }}
                                />
                            )}
                        </div>
                        {showFloatingTabPreview && draggedPreviewTab
                            ? createPortal(
                                  <div
                                      ref={dragPreviewNodeRef}
                                      data-tab-drag-preview="true"
                                      style={{
                                          position: "fixed",
                                          left: 0,
                                          top: 0,
                                          width: tabLayout.tabWidth,
                                          minWidth: tabLayout.tabWidth,
                                          height: 30,
                                          display: "flex",
                                          alignItems: "center",
                                          gap: tabLayout.tabGap,
                                          padding: `0 ${tabLayout.tabPaddingX}px`,
                                          borderRadius: 9,
                                          border: "1px solid color-mix(in srgb, var(--accent) 16%, var(--border))",
                                          background:
                                              "color-mix(in srgb, var(--bg-primary) 94%, white 6%)",
                                          color: "var(--text-primary)",
                                          boxShadow:
                                              "0 14px 32px rgba(15, 23, 42, 0.18)",
                                          pointerEvents: "none",
                                          zIndex: 9999,
                                          willChange: "transform",
                                      }}
                                  >
                                      {renderEditorTabLeadingIcon(
                                          draggedPreviewTab,
                                          chatSessionsById,
                                      )}
                                      <span
                                          style={{
                                              flex: 1,
                                              minWidth: 0,
                                              overflow: "hidden",
                                              textOverflow: "ellipsis",
                                              whiteSpace: "nowrap",
                                              fontSize: tabLayout.titleFontSize,
                                              fontWeight: 600,
                                          }}
                                      >
                                          {draggedPreviewTab.title}
                                      </span>
                                  </div>,
                                  document.body,
                              )
                            : null}

                        <div
                            data-window-drag-trailing-spacer="true"
                            onMouseDown={startWindowDrag}
                            className="flex items-center justify-end shrink-0"
                            style={{ width: trailingDragZoneWidth }}
                        >
                            {windowMode === "main" && (
                                <button
                                    type="button"
                                    onMouseDown={(event) =>
                                        event.stopPropagation()
                                    }
                                    onClick={toggleRightPanel}
                                    title={
                                        rightPanelCollapsed
                                            ? "Show right panel"
                                            : "Hide right panel"
                                    }
                                    aria-label={
                                        rightPanelCollapsed
                                            ? "Show right panel"
                                            : "Hide right panel"
                                    }
                                    className="no-drag flex items-center justify-center shrink-0 ub-nav-btn"
                                    style={{
                                        alignSelf: "center",
                                        marginLeft: 2,
                                        marginRight: 10,
                                        width: 30,
                                        height: 30,
                                        borderRadius: 9,
                                        border: "1px solid var(--border)",
                                        background: "var(--bg-secondary)",
                                        boxShadow:
                                            "0 1px 3px rgba(0,0,0,0.10), 0 1px 1px rgba(0,0,0,0.06)",
                                        color: "var(--text-secondary)",
                                        opacity: rightPanelCollapsed
                                            ? 0.55
                                            : 0.85,
                                        cursor: "pointer",
                                    }}
                                >
                                    <svg
                                        width="14"
                                        height="14"
                                        viewBox="0 0 16 16"
                                        fill="none"
                                    >
                                        <rect
                                            x="11"
                                            y="2"
                                            width="4"
                                            height="12"
                                            rx="1"
                                            fill="currentColor"
                                            opacity={
                                                rightPanelCollapsed ? 0.4 : 1
                                            }
                                        />
                                        <rect
                                            x="1"
                                            y="2"
                                            width="8"
                                            height="2"
                                            rx="1"
                                            fill="currentColor"
                                        />
                                        <rect
                                            x="1"
                                            y="7"
                                            width="8"
                                            height="2"
                                            rx="1"
                                            fill="currentColor"
                                        />
                                        <rect
                                            x="1"
                                            y="12"
                                            width="8"
                                            height="2"
                                            rx="1"
                                            fill="currentColor"
                                        />
                                    </svg>
                                </button>
                            )}
                        </div>

                    </>
                ) : (
                    <>
                        <div
                            ref={tabDropZoneRef}
                            onMouseDown={startWindowDrag}
                            onDoubleClick={() => toggleWindowMaximize()}
                            className="flex-1"
                            style={{
                                minHeight: 30,
                                borderRadius: 12,
                                background: externalFileDropActive
                                    ? "color-mix(in srgb, var(--accent) 10%, transparent)"
                                    : "transparent",
                                boxShadow: externalFileDropActive
                                    ? "inset 0 0 0 1px color-mix(in srgb, var(--accent) 20%, transparent)"
                                    : "none",
                                transition:
                                    "background-color 120ms ease, box-shadow 120ms ease",
                            }}
                        />
                        <div
                            data-window-drag-trailing-spacer="true"
                            onMouseDown={startWindowDrag}
                            className="flex items-center justify-end shrink-0"
                            style={{ width: trailingDragZoneWidth }}
                        >
                            {windowMode === "main" && (
                                <button
                                    type="button"
                                    onMouseDown={(event) =>
                                        event.stopPropagation()
                                    }
                                    onClick={toggleRightPanel}
                                    title={
                                        rightPanelCollapsed
                                            ? "Show right panel"
                                            : "Hide right panel"
                                    }
                                    aria-label={
                                        rightPanelCollapsed
                                            ? "Show right panel"
                                            : "Hide right panel"
                                    }
                                    className="no-drag flex items-center justify-center shrink-0 ub-nav-btn"
                                    style={{
                                        alignSelf: "center",
                                        marginLeft: 2,
                                        marginRight: 10,
                                        width: 30,
                                        height: 30,
                                        borderRadius: 9,
                                        border: "1px solid var(--border)",
                                        background: "var(--bg-secondary)",
                                        boxShadow:
                                            "0 1px 3px rgba(0,0,0,0.10), 0 1px 1px rgba(0,0,0,0.06)",
                                        color: "var(--text-secondary)",
                                        opacity: rightPanelCollapsed
                                            ? 0.55
                                            : 0.85,
                                        cursor: "pointer",
                                    }}
                                >
                                    <svg
                                        width="14"
                                        height="14"
                                        viewBox="0 0 16 16"
                                        fill="none"
                                    >
                                        <rect
                                            x="11"
                                            y="2"
                                            width="4"
                                            height="12"
                                            rx="1"
                                            fill="currentColor"
                                            opacity={
                                                rightPanelCollapsed ? 0.4 : 1
                                            }
                                        />
                                        <rect
                                            x="1"
                                            y="2"
                                            width="8"
                                            height="2"
                                            rx="1"
                                            fill="currentColor"
                                        />
                                        <rect
                                            x="1"
                                            y="7"
                                            width="8"
                                            height="2"
                                            rx="1"
                                            fill="currentColor"
                                        />
                                        <rect
                                            x="1"
                                            y="12"
                                            width="8"
                                            height="2"
                                            rx="1"
                                            fill="currentColor"
                                        />
                                    </svg>
                                </button>
                            )}
                        </div>

                    </>
                )}
            </WindowChrome>
            {historyContextMenu &&
                (() => {
                    const currentActiveTab = selectFocusedEditorTab(
                        useEditorStore.getState(),
                    );
                    if (!currentActiveTab || !isNoteTab(currentActiveTab)) {
                        return null;
                    }
                    return (
                        <ContextMenu
                            menu={historyContextMenu}
                            onClose={() => setHistoryContextMenu(null)}
                            minWidth={160}
                            maxHeight={290}
                            entries={currentActiveTab.history
                                .slice(0, currentActiveTab.historyIndex)
                                .map((entry, idx) => ({
                                    label:
                                        entry.title ||
                                        (entry.kind === "note"
                                            ? entry.noteId
                                            : entry.kind === "pdf"
                                              ? entry.entryId
                                              : entry.relativePath),
                                    action: () => navigateToHistoryIndex(idx),
                                }))
                                .reverse()}
                        />
                    );
                })()}
            {newTabContextMenu && (
                <ContextMenu
                    menu={newTabContextMenu}
                    onClose={() => setNewTabContextMenu(null)}
                    entries={buildNewTabContextMenuEntries({
                        paneId: focusedPaneId ?? undefined,
                        developerModeEnabled,
                        developerTerminalEnabled,
                    })}
                />
            )}
            {tabContextMenu && (
                <ContextMenu
                    menu={tabContextMenu}
                    onClose={() => setTabContextMenu(null)}
                    minWidth={132}
                    entries={(() => {
                        const tab = tabs.find(
                            (entry) =>
                                entry.id === tabContextMenu.payload.tabId,
                        );
                        if (!tab) return [];
                        const isPdf = tab.kind === "pdf";
                        const isFile = tab.kind === "file";
                        const isReview = isReviewTab(tab);
                        const noteId = isNoteTab(tab) ? tab.noteId : null;
                        const filePath = isPdf
                            ? tab.path
                            : isFile
                              ? tab.path
                              : (useVaultStore
                                    .getState()
                                    .notes.find((note) => note.id === noteId)
                                    ?.path ?? null);

                        const tabIndex = tabs.findIndex(
                            (entry) => entry.id === tab.id,
                        );
                        const splitEntries = focusedPaneId
                            ? [
                                  { type: "separator" as const },
                                  {
                                      label: "Open in New Left Pane",
                                      action: () =>
                                          moveTabToPaneDropTarget(
                                              tab.id,
                                              focusedPaneId,
                                              "left",
                                          ),
                                      disabled: !canCreateSplit,
                                  },
                                  {
                                      label: "Open in New Down Pane",
                                      action: () =>
                                          moveTabToPaneDropTarget(
                                              tab.id,
                                              focusedPaneId,
                                              "down",
                                          ),
                                      disabled: !canCreateSplit,
                                  },
                              ]
                            : [];

                        if (isChatTab(tab)) {
                            return [
                                {
                                    label: "Close",
                                    action: () => void handleCloseTab(tab.id),
                                },
                                {
                                    label: "Close Others",
                                    action: () => closeOtherTabs(tab.id),
                                    disabled: tabs.length <= 1,
                                },
                                ...splitEntries,
                            ];
                        }

                        if (
                            isReview ||
                            isChatHistoryTab(tab) ||
                            tab.kind === "graph"
                        ) {
                            return [
                                {
                                    label: "Close",
                                    action: () => void handleCloseTab(tab.id),
                                },
                                {
                                    label: "Close Others",
                                    action: () => closeOtherTabs(tab.id),
                                    disabled: tabs.length <= 1,
                                },
                                ...splitEntries,
                            ];
                        }

                        return [
                            {
                                label: "Close",
                                action: () => void handleCloseTab(tab.id),
                            },
                            {
                                label: "Close Others",
                                action: () => closeOtherTabs(tab.id),
                                disabled: tabs.length <= 1,
                            },
                            {
                                label: "Close Right",
                                action: () => closeTabsToTheRight(tab.id),
                                disabled:
                                    tabIndex === -1 ||
                                    tabIndex >= tabs.length - 1,
                            },
                            {
                                label: "Close Left",
                                action: () => closeTabsToTheLeft(tab.id),
                                disabled: tabIndex <= 0,
                            },
                            ...splitEntries,
                            { type: "separator" as const },
                            ...(!isPdf && !isFile
                                ? [
                                      {
                                          label: "Reveal in Tree",
                                          action: () => {
                                              if (noteId)
                                                  revealNoteInTree(noteId);
                                          },
                                      },
                                  ]
                                : []),
                            {
                                label: "Reveal in Finder",
                                action: () => {
                                    if (!filePath) return;
                                    void revealItemInDir(filePath);
                                },
                                disabled: !filePath,
                            },
                            {
                                label: "Copy Path",
                                action: () =>
                                    void navigator.clipboard.writeText(
                                        isPdf
                                            ? tab.path
                                            : isFile
                                              ? tab.relativePath
                                              : (noteId ?? ""),
                                    ),
                            },
                            ...(isPdf || isFile
                                ? [
                                      { type: "separator" as const },
                                      {
                                          label: "Open Externally",
                                          action: () => void openPath(tab.path),
                                      },
                                      {
                                          label: "Move File to Trash",
                                          action: () =>
                                              void handleMoveTabFileToTrash(
                                                  tab.path,
                                                  tab.title,
                                              ),
                                          danger: true,
                                          disabled: !vaultPath,
                                      },
                                  ]
                                : []),
                            ...(isPdf || isFile || isNoteTab(tab)
                                ? [
                                      {
                                          label: "Add to Chat",
                                          action: () =>
                                              emitTabDragDetail(
                                                  tab.id,
                                                  "attach",
                                              ),
                                      },
                                  ]
                                : []),
                        ];
                    })()}
                />
            )}
        </>
    );
}
