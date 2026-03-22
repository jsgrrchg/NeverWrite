import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
    type ReactNode,
    type CSSProperties,
    type MouseEvent as ReactMouseEvent,
} from "react";
import { createPortal } from "react-dom";
import { confirm } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import {
    ATTACH_EXTERNAL_TAB_EVENT,
    type AttachExternalTabPayload,
    createDetachedWindowPayload,
    createGhostWindow,
    destroyGhostWindow,
    findWindowTabDropTarget,
    getCurrentWindowLabel,
    getDetachedWindowPosition,
    isPointerOutsideCurrentWindow,
    moveGhostWindow,
    openDetachedNoteWindow,
    publishWindowTabDropZone,
} from "../../app/detachedWindows";
import {
    useEditorStore,
    isNoteTab,
    isReviewTab,
    isFileTab,
    isPdfTab,
    type Tab,
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
import {
    buildTabFileDragDetail,
    isPointOverAiComposerDropZone,
} from "./tabDragAttachments";
import { useTabDragReorder } from "./useTabDragReorder";
import { getTabStripDropIndex, getTabStripScrollTarget } from "./tabStrip";
import {
    getTrafficLightSpacerWidth,
    getTitlebarPaddingTop,
} from "../../app/utils/platform";

const appWindow = getCurrentWindow();

function startWindowDrag(event: ReactMouseEvent<HTMLElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    void appWindow.startDragging().catch(() => {
        // Ignore denied / unsupported drag attempts and keep the bar interactive.
    });
}

async function getWindowContentScreenOrigin() {
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

function getChromeButtonStyle(active = false): CSSProperties {
    return {
        width: 30,
        height: 30,
        borderRadius: 9,
        border: active
            ? "1px solid color-mix(in srgb, var(--accent) 20%, var(--border))"
            : "1px solid transparent",
        backgroundColor: active
            ? "color-mix(in srgb, var(--accent) 12%, var(--bg-primary))"
            : "transparent",
        color: active ? "var(--text-primary)" : "var(--text-secondary)",
        boxShadow: active ? "0 8px 20px rgba(15, 23, 42, 0.08)" : "none",
        opacity: active ? 1 : 0.78,
    };
}

const controlsGroupStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 4,
    padding: "0 3px",
    borderRadius: 12,
    border: "1px solid color-mix(in srgb, var(--border) 78%, transparent)",
    background: "color-mix(in srgb, var(--bg-primary) 52%, var(--bg-tertiary))",
    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.05)",
};

function renderTabLeadingIcon(tab: Tab): ReactNode {
    if (tab.kind === "pdf") {
        return (
            <svg
                width="12"
                height="12"
                viewBox="0 0 16 16"
                fill="none"
                className="shrink-0 opacity-65"
            >
                <path
                    d="M4 1.5h5.5L13 5v9a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 14V3A1.5 1.5 0 0 1 4 1.5Z"
                    stroke="#e24b3b"
                    strokeWidth="1"
                />
                <path
                    d="M9.5 1.5V5H13"
                    stroke="#e24b3b"
                    strokeWidth="0.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                />
                <text
                    x="5"
                    y="12"
                    fontSize="4.5"
                    fontWeight="700"
                    fill="#e24b3b"
                    fontFamily="sans-serif"
                >
                    PDF
                </text>
            </svg>
        );
    }

    if (tab.kind === "file") {
        if (tab.mimeType?.startsWith("image/")) {
            return (
                <svg
                    width="12"
                    height="12"
                    viewBox="0 0 16 16"
                    fill="none"
                    className="shrink-0 opacity-55"
                >
                    <rect
                        x="2"
                        y="2.5"
                        width="12"
                        height="11"
                        rx="1.5"
                        stroke="currentColor"
                        strokeWidth="1"
                    />
                    <circle
                        cx="5.5"
                        cy="5.8"
                        r="1.2"
                        stroke="currentColor"
                        strokeWidth="0.8"
                    />
                    <path
                        d="M2.5 11l3-3.5 2.5 2.5 1.5-1.5 4 3.5"
                        stroke="currentColor"
                        strokeWidth="0.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    />
                </svg>
            );
        }
        return (
            <svg
                width="12"
                height="12"
                viewBox="0 0 16 16"
                fill="none"
                className="shrink-0 opacity-55"
            >
                <path
                    d="M4 1.5h5.5L13 5v9a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 14V3A1.5 1.5 0 0 1 4 1.5Z"
                    stroke="currentColor"
                    strokeWidth="1"
                />
                <path
                    d="M9.5 1.5V5H13"
                    stroke="currentColor"
                    strokeWidth="0.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                />
            </svg>
        );
    }

    if (tab.kind === "ai-review") {
        return (
            <svg
                width="12"
                height="12"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="shrink-0 opacity-60"
            >
                <path d="M3 8h10M6 4l-4 4 4 4M10 4l4 4-4 4" />
            </svg>
        );
    }

    if (tab.kind === "map") {
        return (
            <svg
                width="12"
                height="12"
                viewBox="0 0 16 16"
                fill="none"
                className="shrink-0 opacity-55"
            >
                <rect
                    x="2"
                    y="2"
                    width="12"
                    height="12"
                    rx="1.5"
                    stroke="currentColor"
                    strokeWidth="1"
                />
                <circle cx="8" cy="5.5" r="1.3" fill="currentColor" />
                <circle cx="5" cy="10.5" r="1.3" fill="currentColor" />
                <circle cx="11" cy="10.5" r="1.3" fill="currentColor" />
                <path
                    d="M7.15 6.65 5.7 9.3M8.85 6.65l1.45 2.65"
                    stroke="currentColor"
                    strokeWidth="0.85"
                    strokeLinecap="round"
                />
            </svg>
        );
    }

    if (tab.kind === "graph") {
        return (
            <svg
                width="12"
                height="12"
                viewBox="0 0 16 16"
                fill="none"
                className="shrink-0 opacity-55"
            >
                <circle
                    cx="8"
                    cy="8"
                    r="2"
                    stroke="currentColor"
                    strokeWidth="1"
                />
                <circle
                    cx="3"
                    cy="4"
                    r="1.5"
                    stroke="currentColor"
                    strokeWidth="0.8"
                />
                <circle
                    cx="13"
                    cy="4"
                    r="1.5"
                    stroke="currentColor"
                    strokeWidth="0.8"
                />
                <circle
                    cx="4"
                    cy="13"
                    r="1.5"
                    stroke="currentColor"
                    strokeWidth="0.8"
                />
                <circle
                    cx="12"
                    cy="12"
                    r="1.5"
                    stroke="currentColor"
                    strokeWidth="0.8"
                />
                <path
                    d="M6.3 6.8l-2-1.8M9.7 6.8l2-1.8M6.5 9.5l-1.5 2.5M9.5 9.5l1.5 1.5"
                    stroke="currentColor"
                    strokeWidth="0.7"
                    strokeLinecap="round"
                />
            </svg>
        );
    }

    // Note tab (kind is "note" or undefined) — document with text lines
    return (
        <svg
            width="12"
            height="12"
            viewBox="0 0 16 16"
            fill="none"
            className="shrink-0 opacity-50"
        >
            <path
                d="M4 1.5h5.5L13 5v9a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 14V3A1.5 1.5 0 0 1 4 1.5Z"
                stroke="currentColor"
                strokeWidth="1"
            />
            <path
                d="M6 8h4M6 10.5h3"
                stroke="currentColor"
                strokeWidth="0.8"
                strokeLinecap="round"
            />
        </svg>
    );
}

interface UnifiedBarProps {
    windowMode: "main" | "note";
}

export function UnifiedBar({ windowMode }: UnifiedBarProps) {
    const tabs = useEditorStore((s) => s.tabs);
    const activeTabId = useEditorStore((s) => s.activeTabId);
    const switchTab = useEditorStore((s) => s.switchTab);
    const closeTab = useEditorStore((s) => s.closeTab);
    const reorderTabs = useEditorStore((s) => s.reorderTabs);
    const goBack = useEditorStore((s) => s.goBack);
    const goForward = useEditorStore((s) => s.goForward);
    const navigateToHistoryIndex = useEditorStore(
        (s) => s.navigateToHistoryIndex,
    );
    const tabOpenBehavior = useSettingsStore((s) => s.tabOpenBehavior);
    const fileTreeShowExtensions = useSettingsStore(
        (s) => s.fileTreeShowExtensions,
    );
    // Primitive selectors — stable when values don't change
    const canGoBack = useEditorStore((s) => {
        if (tabOpenBehavior === "history") {
            const tab = s.tabs.find((t) => t.id === s.activeTabId);
            return tab && (isNoteTab(tab) || isFileTab(tab) || isPdfTab(tab))
                ? tab.historyIndex > 0
                : false;
        }
        if (s.tabNavigationIndex <= 0) return false;
        return s.tabNavigationHistory
            .slice(0, s.tabNavigationIndex)
            .some((tabId) => s.tabs.some((tab) => tab.id === tabId));
    });
    const canGoForward = useEditorStore((s) => {
        if (tabOpenBehavior === "history") {
            const tab = s.tabs.find((t) => t.id === s.activeTabId);
            return tab && (isNoteTab(tab) || isFileTab(tab) || isPdfTab(tab))
                ? tab.historyIndex < tab.history.length - 1
                : false;
        }
        if (s.tabNavigationIndex >= s.tabNavigationHistory.length - 1) {
            return false;
        }
        return s.tabNavigationHistory
            .slice(s.tabNavigationIndex + 1)
            .some((tabId) => s.tabs.some((tab) => tab.id === tabId));
    });
    const sidebarCollapsed = useLayoutStore((s) => s.sidebarCollapsed);
    const toggleSidebar = useLayoutStore((s) => s.toggleSidebar);
    const rightPanelCollapsed = useLayoutStore((s) => s.rightPanelCollapsed);
    const rightPanelView = useLayoutStore((s) => s.rightPanelView);
    const activateRightView = useLayoutStore((s) => s.activateRightView);
    const vaultPath = useVaultStore((s) => s.vaultPath);
    const refreshEntries = useVaultStore((s) => s.refreshEntries);
    const [tabContextMenu, setTabContextMenu] = useState<ContextMenuState<{
        tabId: string;
    }> | null>(null);
    const [historyContextMenu, setHistoryContextMenu] =
        useState<ContextMenuState<void> | null>(null);
    const [dragPreviewTabId, setDragPreviewTabId] = useState<string | null>(
        null,
    );
    const [externalFileDropActive, setExternalFileDropActive] = useState(false);
    const dragPreviewNodeRef = useRef<HTMLDivElement | null>(null);
    const dragPreviewPosRef = useRef({ clientX: 0, clientY: 0 });
    const dragPreviewFrameRef = useRef<number | null>(null);

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
                console.error("Failed to move file to trash:", error);
            }
        },
        [refreshEntries, vaultPath],
    );

    const ghostRef = useRef<WebviewWindow | null>(null);
    const ghostCancelledRef = useRef(false);
    const tabDropZoneRef = useRef<HTMLDivElement | null>(null);

    const handleDetachStart = useCallback(
        async (tabId: string, coords: { screenX: number; screenY: number }) => {
            const tab = useEditorStore
                .getState()
                .tabs.find((t) => t.id === tabId);
            if (!tab) return;
            ghostCancelledRef.current = false;

            try {
                const ghost = await createGhostWindow(
                    tab.title,
                    coords.screenX,
                    coords.screenY,
                );
                if (ghostCancelledRef.current) {
                    void destroyGhostWindow(ghost);
                    return;
                }
                ghostRef.current = ghost;
            } catch (error) {
                console.error("Failed to create ghost window:", error);
            }
        },
        [],
    );

    const handleDetachMove = useCallback(
        (coords: { screenX: number; screenY: number }) => {
            const ghost = ghostRef.current;
            if (!ghost) return;
            void moveGhostWindow(ghost, coords.screenX, coords.screenY);
        },
        [],
    );

    const handleDetachEnd = useCallback(
        async (tabId: string, coords: { screenX: number; screenY: number }) => {
            ghostCancelledRef.current = true;
            if (ghostRef.current) {
                await destroyGhostWindow(ghostRef.current);
                ghostRef.current = null;
            }

            const currentTabs = useEditorStore.getState().tabs;
            const tab = currentTabs.find((item) => item.id === tabId);
            if (!tab) return;

            const targetWindowLabel = await findWindowTabDropTarget(
                coords.screenX,
                coords.screenY,
                getCurrentWindowLabel(),
                vaultPath,
            );

            if (targetWindowLabel) {
                await appWindow.emitTo(
                    targetWindowLabel,
                    ATTACH_EXTERNAL_TAB_EVENT,
                    { tab } satisfies AttachExternalTabPayload,
                );

                if (windowMode === "note" && currentTabs.length === 1) {
                    await appWindow.close();
                    return;
                }

                closeTab(tabId);
                return;
            }

            await openDetachedNoteWindow(
                createDetachedWindowPayload(tab, vaultPath),
                {
                    title: tab.title,
                    position: getDetachedWindowPosition(
                        coords.screenX,
                        coords.screenY,
                    ),
                },
            );

            if (windowMode === "note" && currentTabs.length === 1) {
                await appWindow.close();
                return;
            }

            closeTab(tabId);
        },
        [closeTab, vaultPath, windowMode],
    );

    const handleDetachCancel = useCallback(() => {
        ghostCancelledRef.current = true;
        if (ghostRef.current) {
            void destroyGhostWindow(ghostRef.current);
            ghostRef.current = null;
        }
    }, []);

    const emitTabDragDetail = useCallback(
        (
            tabId: string,
            phase: "start" | "move" | "end" | "cancel" | "attach",
            coords?: { clientX: number; clientY: number },
        ) => {
            if (phase === "cancel") {
                emitFileTreeNoteDrag({
                    phase: "cancel",
                    x: 0,
                    y: 0,
                    notes: [],
                });
                return;
            }

            const tab = useEditorStore
                .getState()
                .tabs.find((item) => item.id === tabId);
            if (!tab) return;

            if (!coords) return;

            const detail = buildTabFileDragDetail(
                tab,
                phase,
                coords,
            );
            if (detail) {
                emitFileTreeNoteDrag(detail);
            }
        },
        [],
    );

    const applyDragPreviewPosition = useCallback(() => {
        dragPreviewFrameRef.current = null;
        const node = dragPreviewNodeRef.current;
        if (!node) return;
        const { clientX, clientY } = dragPreviewPosRef.current;
        node.style.transform = `translate3d(${clientX + 12}px, ${clientY + 12}px, 0) scale(1.02)`;
    }, []);

    const scheduleDragPreviewPosition = useCallback(() => {
        if (dragPreviewFrameRef.current !== null) return;
        dragPreviewFrameRef.current = window.requestAnimationFrame(
            applyDragPreviewPosition,
        );
    }, [applyDragPreviewPosition]);

    const updateTabDragPreview = useCallback(
        (tabId: string, clientX: number, clientY: number) => {
            dragPreviewPosRef.current = { clientX, clientY };
            setDragPreviewTabId((current) =>
                current === tabId ? current : tabId,
            );
            scheduleDragPreviewPosition();
        },
        [scheduleDragPreviewPosition],
    );

    useLayoutEffect(() => {
        if (dragPreviewTabId !== null) {
            applyDragPreviewPosition();
        }
    }, [applyDragPreviewPosition, dragPreviewTabId]);

    useEffect(() => {
        return () => {
            if (dragPreviewFrameRef.current !== null) {
                window.cancelAnimationFrame(dragPreviewFrameRef.current);
                dragPreviewFrameRef.current = null;
            }
            if (ghostRef.current) {
                void destroyGhostWindow(ghostRef.current);
                ghostRef.current = null;
            }
        };
    }, []);

    const {
        dragOffsetX,
        draggingTabId,
        detachPreviewActive,
        tabStripRef,
        visualTabs,
        registerTabNode,
        handlePointerDown,
        handlePointerMove,
        handlePointerUp,
        handleLostPointerCapture,
        consumeSuppressedClick,
    } = useTabDragReorder({
        tabs,
        onCommitReorder: reorderTabs,
        onActivate: switchTab,
        liveReorder: false,
        shouldDetach: isPointerOutsideCurrentWindow,
        shouldCommitDrag: (tabId, coords) => {
            const tab = useEditorStore
                .getState()
                .tabs.find((item) => item.id === tabId);
            if (!tab) return true;

            const canAttachAsFile =
                buildTabFileDragDetail(
                    tab,
                    "end",
                    {
                        clientX: coords.clientX,
                        clientY: coords.clientY,
                    },
                ) !== null;
            if (!canAttachAsFile) {
                return true;
            }

            return !isPointOverAiComposerDropZone(
                coords.clientX,
                coords.clientY,
            );
        },
        onDetachStart: handleDetachStart,
        onDetachMove: handleDetachMove,
        onDetachEnd: handleDetachEnd,
        onDetachCancel: handleDetachCancel,
        onDragStart: (tabId, coords) => {
            updateTabDragPreview(tabId, coords.clientX, coords.clientY);
            emitTabDragDetail(tabId, "start", {
                clientX: coords.clientX,
                clientY: coords.clientY,
            });
        },
        onDragMove: (tabId, coords) => {
            updateTabDragPreview(tabId, coords.clientX, coords.clientY);
            emitTabDragDetail(tabId, "move", {
                clientX: coords.clientX,
                clientY: coords.clientY,
            });
        },
        onDragEnd: (tabId, coords) => {
            emitTabDragDetail(tabId, "end", {
                clientX: coords.clientX,
                clientY: coords.clientY,
            });
            setDragPreviewTabId(null);
        },
        onDragCancel: (tabId) => {
            emitTabDragDetail(tabId, "cancel");
            setDragPreviewTabId(null);
        },
    });

    const handleTabClick = useCallback(
        (tabId: string) => {
            if (consumeSuppressedClick(tabId)) return;
            switchTab(tabId);
        },
        [consumeSuppressedClick, switchTab],
    );

    const handleTabPointerDownCapture = useCallback(
        (tabId: string, event: React.PointerEvent<HTMLDivElement>) => {
            if (event.button !== 0) return;
            if ((event.target as HTMLElement).closest("button")) return;
            switchTab(tabId);
        },
        [switchTab],
    );

    const handleCloseTab = useCallback(
        async (tabId: string) => {
            if (
                windowMode === "note" &&
                useEditorStore.getState().tabs.length === 1
            ) {
                await appWindow.close().catch((error) => {
                    console.error("No se pudo cerrar la ventana:", error);
                });
                return;
            }

            closeTab(tabId);
        },
        [closeTab, windowMode],
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
                    console.error("Failed to open dropped note tab:", error);
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

    const closeOtherTabs = useCallback((tabId: string) => {
        useEditorStore.setState((state) => {
            const kept = state.tabs.filter((tab) => tab.id === tabId);
            return {
                tabs: kept,
                activeTabId: kept[0]?.id ?? null,
            };
        });
    }, []);

    const closeTabsToTheRight = useCallback((tabId: string) => {
        useEditorStore.setState((state) => {
            const index = state.tabs.findIndex((tab) => tab.id === tabId);
            if (index === -1) return state;
            const kept = state.tabs.slice(0, index + 1);
            return {
                tabs: kept,
                activeTabId:
                    kept.find((tab) => tab.id === state.activeTabId)?.id ??
                    kept[index]?.id ??
                    null,
            };
        });
    }, []);

    const closeTabsToTheLeft = useCallback((tabId: string) => {
        useEditorStore.setState((state) => {
            const index = state.tabs.findIndex((tab) => tab.id === tabId);
            if (index === -1) return state;
            const kept = state.tabs.slice(index);
            return {
                tabs: kept,
                activeTabId:
                    kept.find((tab) => tab.id === state.activeTabId)?.id ??
                    kept[0]?.id ??
                    null,
            };
        });
    }, []);

    const tabOrderKey = visualTabs.map((tab) => tab.id).join("|");
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

    useEffect(() => {
        if (!activeTabId || draggingTabId) return;

        const strip = tabStripRef.current;
        if (!strip) return;

        const activeNode = strip.querySelector<HTMLElement>(
            `[data-tab-id="${CSS.escape(activeTabId)}"]`,
        );
        if (!activeNode) return;

        const stripLeft = strip.scrollLeft;
        const stripRight = stripLeft + strip.clientWidth;
        const nodeLeft = activeNode.offsetLeft;
        const nodeRight = nodeLeft + activeNode.offsetWidth;

        if (nodeLeft >= stripLeft && nodeRight <= stripRight) {
            return;
        }

        const target = getTabStripScrollTarget({
            stripLeft,
            stripWidth: strip.clientWidth,
            scrollWidth: strip.scrollWidth,
            nodeLeft,
            nodeWidth: activeNode.offsetWidth,
        });

        if (target === null || Math.abs(target - strip.scrollLeft) < 1) return;

        strip.scrollTo({
            left: target,
            behavior: "smooth",
        });
    }, [activeTabId, draggingTabId, tabOrderKey, tabStripRef]);

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
    }, [getExternalFileDropTarget, handleOpenDroppedTreeItems, tabs.length]);

    const hasTabs = visualTabs.length > 0;

    return (
        <div
            onMouseDown={(event) => {
                if (event.target === event.currentTarget) {
                    startWindowDrag(event);
                }
            }}
            style={{
                paddingTop: getTitlebarPaddingTop(),
                background:
                    "color-mix(in srgb, var(--bg-tertiary) 92%, transparent)",
                borderBottom: "1px solid var(--border)",
                backdropFilter: "blur(18px)",
                boxShadow: "0 1px 0 rgba(255,255,255,0.04)",
            }}
        >
            <div
                className="flex items-stretch select-none"
                style={{ height: 38, cursor: "default", padding: "0 6px" }}
            >
                <div
                    onMouseDown={startWindowDrag}
                    style={{
                        width: getTrafficLightSpacerWidth(),
                        flexShrink: 0,
                    }}
                />

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
                                width: 30,
                                height: 30,
                                borderRadius: "9px 0 0 9px",
                                border: "1px solid var(--border)",
                                borderRight: "none",
                                backgroundColor: "var(--bg-secondary)",
                                boxShadow:
                                    "0 1px 3px rgba(0,0,0,0.10), 0 1px 1px rgba(0,0,0,0.06)",
                                color: "var(--text-secondary)",
                                opacity: canGoBack ? 0.85 : 0.35,
                                cursor: canGoBack ? "pointer" : "default",
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
                                width: 30,
                                height: 30,
                                borderRadius: "0 9px 9px 0",
                                border: "1px solid var(--border)",
                                backgroundColor: "var(--bg-secondary)",
                                boxShadow:
                                    "0 1px 3px rgba(0,0,0,0.10), 0 1px 1px rgba(0,0,0,0.06)",
                                color: "var(--text-secondary)",
                                opacity: canGoForward ? 0.85 : 0.35,
                                cursor: canGoForward ? "pointer" : "default",
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
                            <div className="no-drag flex min-w-0 flex-1 overflow-hidden">
                                <div
                                    ref={tabStripRef}
                                    data-tab-strip="true"
                                    className="no-drag flex min-w-0 shrink overflow-x-auto scrollbar-hidden items-center"
                                    style={{
                                        gap: 4,
                                        padding: "0 4px",
                                        borderRadius: 12,
                                        background: detachPreviewActive
                                            ? "color-mix(in srgb, var(--accent) 8%, transparent)"
                                            : externalFileDropActive
                                              ? "color-mix(in srgb, var(--accent) 10%, transparent)"
                                              : draggingTabId
                                                ? "color-mix(in srgb, var(--bg-primary) 42%, transparent)"
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
                                    {visualTabs.map((tab, index) => {
                                        const isActive = tab.id === activeTabId;
                                        const isDragging =
                                            tab.id === draggingTabId;
                                        const tabTooltip = isNoteTab(tab)
                                            ? tab.noteId
                                            : tab.kind === "file"
                                              ? tab.relativePath
                                              : tab.title;

                                        return (
                                            <div
                                                key={tab.id}
                                                data-tab-id={tab.id}
                                                ref={(node) =>
                                                    registerTabNode(
                                                        tab.id,
                                                        node,
                                                    )
                                                }
                                                title={tabTooltip}
                                                onPointerDownCapture={(event) =>
                                                    handleTabPointerDownCapture(
                                                        tab.id,
                                                        event,
                                                    )
                                                }
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
                                                onLostPointerCapture={(event) =>
                                                    handleLostPointerCapture(
                                                        event.pointerId,
                                                    )
                                                }
                                                className="group no-drag flex items-center gap-2 px-3 cursor-pointer ub-tab"
                                                data-active={
                                                    isActive || undefined
                                                }
                                                data-dragging={
                                                    isDragging || undefined
                                                }
                                                style={{
                                                    width: 160,
                                                    height: 30,
                                                    borderRadius: 9,
                                                    flexShrink: 0,
                                                    backgroundColor: isActive
                                                        ? "var(--bg-primary)"
                                                        : "color-mix(in srgb, var(--bg-primary) 44%, transparent)",
                                                    color: isActive
                                                        ? "var(--text-primary)"
                                                        : "var(--text-secondary)",
                                                    border: isActive
                                                        ? "1px solid color-mix(in srgb, var(--accent) 12%, var(--border))"
                                                        : "1px solid color-mix(in srgb, var(--border) 48%, transparent)",
                                                    opacity: isDragging ? 0 : 1,
                                                    zIndex: isDragging ? 20 : 0,
                                                    transform: isDragging
                                                        ? `translateX(${dragOffsetX}px) scale(1.02)`
                                                        : undefined,
                                                    transition: isDragging
                                                        ? "none"
                                                        : "transform 250ms cubic-bezier(0.2, 0.8, 0.2, 1), background-color 100ms ease, color 100ms ease, border-color 100ms ease, box-shadow 100ms ease",
                                                    boxShadow: isDragging
                                                        ? "0 10px 28px rgba(0, 0, 0, 0.2)"
                                                        : isActive
                                                          ? "0 10px 24px rgba(15, 23, 42, 0.08)"
                                                          : "none",
                                                    willChange: isDragging
                                                        ? "transform"
                                                        : undefined,
                                                }}
                                            >
                                                {renderTabLeadingIcon(tab)}
                                                <span className="flex-1 truncate text-[12.5px] font-medium">
                                                    {fileTreeShowExtensions &&
                                                    isNoteTab(tab)
                                                        ? (tab.noteId
                                                              .split("/")
                                                              .pop() ??
                                                              tab.title) + ".md"
                                                        : tab.title}
                                                </span>
                                                <button
                                                    onClick={(event) => {
                                                        event.stopPropagation();
                                                        void handleCloseTab(
                                                            tab.id,
                                                        );
                                                    }}
                                                    className={`no-drag shrink-0 rounded w-4 h-4 flex items-center justify-center transition-all ${
                                                        isActive
                                                            ? "opacity-60 hover:opacity-100 hover:bg-gray-500/18 active:bg-gray-500/28"
                                                            : "opacity-0 group-hover:opacity-55 hover:opacity-100! hover:bg-gray-500/18 active:bg-gray-500/28"
                                                    }`}
                                                >
                                                    <svg
                                                        width="10"
                                                        height="10"
                                                        viewBox="0 0 16 16"
                                                        fill="none"
                                                        stroke="currentColor"
                                                        strokeWidth="1.8"
                                                        strokeLinecap="round"
                                                        strokeLinejoin="round"
                                                    >
                                                        <path d="M4 4l8 8M4 12l8-8" />
                                                    </svg>
                                                </button>
                                            </div>
                                        );
                                    })}

                                    <button
                                        onMouseDown={(e) => e.stopPropagation()}
                                        onClick={() => {
                                            if (
                                                !useVaultStore.getState()
                                                    .vaultPath
                                            )
                                                return;
                                            useEditorStore
                                                .getState()
                                                .insertExternalTab({
                                                    id: crypto.randomUUID(),
                                                    kind: "note",
                                                    noteId: "",
                                                    title: "New Tab",
                                                    content: "",
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
                                            ...getChromeButtonStyle(false),
                                        }}
                                    >
                                        +
                                    </button>
                                </div>

                                <div
                                    onMouseDown={startWindowDrag}
                                    className="min-w-2 flex-1"
                                />
                            </div>
                        </div>
                        {showFloatingTabPreview && draggedPreviewTab
                            ? createPortal(
                                  <div
                                      ref={dragPreviewNodeRef}
                                      style={{
                                          position: "fixed",
                                          left: 0,
                                          top: 0,
                                          width: 160,
                                          height: 30,
                                          display: "flex",
                                          alignItems: "center",
                                          gap: 8,
                                          padding: "0 12px",
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
                                      {renderTabLeadingIcon(draggedPreviewTab)}
                                      <span
                                          style={{
                                              flex: 1,
                                              minWidth: 0,
                                              overflow: "hidden",
                                              textOverflow: "ellipsis",
                                              whiteSpace: "nowrap",
                                              fontSize: 12.5,
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
                            onMouseDown={startWindowDrag}
                            className="flex items-center justify-end shrink-0"
                            style={{ width: windowMode === "main" ? 152 : 16 }}
                        >
                            <div style={controlsGroupStyle}>
                                {windowMode === "main" && (
                                    <>
                                        <button
                                            onMouseDown={(e) =>
                                                e.stopPropagation()
                                            }
                                            onClick={() =>
                                                activateRightView("chat")
                                            }
                                            title="AI Chat"
                                            className="no-drag flex items-center justify-center shrink-0 ub-chrome-btn"
                                            data-active={
                                                (!rightPanelCollapsed &&
                                                    rightPanelView ===
                                                        "chat") ||
                                                undefined
                                            }
                                            style={getChromeButtonStyle(
                                                !rightPanelCollapsed &&
                                                    rightPanelView === "chat",
                                            )}
                                        >
                                            <svg
                                                width="14"
                                                height="14"
                                                viewBox="0 0 16 16"
                                                fill="none"
                                                stroke="currentColor"
                                                strokeWidth="1.5"
                                                strokeLinecap="round"
                                                strokeLinejoin="round"
                                            >
                                                <path d="M14 10a2 2 0 0 1-2 2H5l-3 3V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z" />
                                            </svg>
                                        </button>
                                        <button
                                            onMouseDown={(e) =>
                                                e.stopPropagation()
                                            }
                                            onClick={() =>
                                                activateRightView("outline")
                                            }
                                            title="Outline panel"
                                            className="no-drag flex items-center justify-center shrink-0 ub-chrome-btn"
                                            data-active={
                                                (!rightPanelCollapsed &&
                                                    rightPanelView ===
                                                        "outline") ||
                                                undefined
                                            }
                                            style={getChromeButtonStyle(
                                                !rightPanelCollapsed &&
                                                    rightPanelView ===
                                                        "outline",
                                            )}
                                        >
                                            <svg
                                                width="14"
                                                height="14"
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
                                        </button>
                                        <button
                                            onMouseDown={(e) =>
                                                e.stopPropagation()
                                            }
                                            onClick={() =>
                                                activateRightView("links")
                                            }
                                            title="Links panel"
                                            className="no-drag flex items-center justify-center shrink-0 ub-chrome-btn"
                                            data-active={
                                                (!rightPanelCollapsed &&
                                                    rightPanelView ===
                                                        "links") ||
                                                undefined
                                            }
                                            style={getChromeButtonStyle(
                                                !rightPanelCollapsed &&
                                                    rightPanelView === "links",
                                            )}
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
                                    </>
                                )}
                            </div>
                        </div>
                    </>
                ) : (
                    <>
                        <div
                            ref={tabDropZoneRef}
                            onMouseDown={startWindowDrag}
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
                            onMouseDown={startWindowDrag}
                            className="flex items-center justify-end shrink-0"
                            style={{ width: 152 }}
                        >
                            {windowMode === "main" && (
                                <div style={controlsGroupStyle}>
                                    <button
                                        onMouseDown={(e) => e.stopPropagation()}
                                        onClick={() =>
                                            activateRightView("chat")
                                        }
                                        title="AI Chat"
                                        className="no-drag flex items-center justify-center shrink-0 ub-chrome-btn"
                                        data-active={
                                            (!rightPanelCollapsed &&
                                                rightPanelView === "chat") ||
                                            undefined
                                        }
                                        style={getChromeButtonStyle(
                                            !rightPanelCollapsed &&
                                                rightPanelView === "chat",
                                        )}
                                    >
                                        <svg
                                            width="14"
                                            height="14"
                                            viewBox="0 0 16 16"
                                            fill="none"
                                            stroke="currentColor"
                                            strokeWidth="1.5"
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                        >
                                            <path d="M14 10a2 2 0 0 1-2 2H5l-3 3V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z" />
                                        </svg>
                                    </button>
                                    <button
                                        onMouseDown={(e) => e.stopPropagation()}
                                        onClick={() =>
                                            activateRightView("outline")
                                        }
                                        title="Outline panel"
                                        className="no-drag flex items-center justify-center shrink-0 ub-chrome-btn"
                                        data-active={
                                            (!rightPanelCollapsed &&
                                                rightPanelView === "outline") ||
                                            undefined
                                        }
                                        style={getChromeButtonStyle(
                                            !rightPanelCollapsed &&
                                                rightPanelView === "outline",
                                        )}
                                    >
                                        <svg
                                            width="14"
                                            height="14"
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
                                    </button>
                                    <button
                                        onMouseDown={(e) => e.stopPropagation()}
                                        onClick={() =>
                                            activateRightView("links")
                                        }
                                        title="Links panel"
                                        className="no-drag flex items-center justify-center shrink-0 ub-chrome-btn"
                                        data-active={
                                            (!rightPanelCollapsed &&
                                                rightPanelView === "links") ||
                                            undefined
                                        }
                                        style={getChromeButtonStyle(
                                            !rightPanelCollapsed &&
                                                rightPanelView === "links",
                                        )}
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
                                </div>
                            )}
                        </div>
                    </>
                )}
            </div>
            {historyContextMenu &&
                (() => {
                    const { tabs: currentTabs, activeTabId: currentActiveId } =
                        useEditorStore.getState();
                    const currentActiveTab = currentTabs.find(
                        (t) => t.id === currentActiveId,
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

                        if (isReview || tab.kind === "graph") {
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
                                                  {
                                                      clientX: 0,
                                                      clientY: 0,
                                                  },
                                              ),
                                      },
                                  ]
                                : []),
                        ];
                    })()}
                />
            )}
        </div>
    );
}
