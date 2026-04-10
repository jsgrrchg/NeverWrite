import {
    Fragment,
    useEffect,
    useLayoutEffect,
    useCallback,
    useMemo,
    useRef,
    useState,
    type ReactNode,
} from "react";
import { useShallow } from "zustand/react/shallow";
import { createPortal } from "react-dom";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
    type Tab,
    isChatTab,
    isNoteTab,
    selectEditorPaneState,
    selectEditorWorkspaceTabs,
    selectLeafPaneIds,
    selectPaneCount,
    selectPaneNeighbor,
    useEditorStore,
} from "../../app/store/editorStore";
import { MAX_EDITOR_PANES } from "../../app/store/workspaceLayoutTree";
import { moveChatToSidebar } from "../ai/chatPaneMovement";
import { getSessionTitle } from "../ai/sessionPresentation";
import { useChatStore } from "../ai/store/chatStore";
import { useInlineRename } from "../ai/components/useInlineRename";
import { useSettingsStore } from "../../app/store/settingsStore";
import { useVaultStore } from "../../app/store/vaultStore";
import {
    ContextMenu,
    type ContextMenuEntry,
    type ContextMenuState,
} from "../../components/context-menu/ContextMenu";
import {
    ATTACH_EXTERNAL_TAB_EVENT,
    type AttachExternalTabPayload,
    createDetachedWindowPayload,
    createGhostWindow,
    destroyGhostWindow,
    findWindowTabDropTarget,
    getCurrentWindowLabel,
    getDetachedWindowPosition,
    getWindowMode,
    isPointerOutsideCurrentWindow,
    moveGhostWindow,
    openDetachedNoteWindow,
} from "../../app/detachedWindows";
import { emitFileTreeNoteDrag } from "../ai/dragEvents";
import {
    buildNewTabContextMenuEntries,
    openBlankDraftTabFromPlusButton,
} from "./newTabMenuActions";
import { useTabDragReorder } from "./useTabDragReorder";
import {
    buildTabFileDragDetail,
    isPointOverAiComposerDropZone,
} from "./tabDragAttachments";
import { renderEditorTabLeadingIcon } from "./editorTabIcons";

function getTabLabel(
    tab: Tab,
    fileTreeShowExtensions: boolean,
    chatSessionsById: ReturnType<typeof useChatStore.getState>["sessionsById"],
) {
    if (isChatTab(tab)) {
        const session = chatSessionsById[tab.sessionId];
        return session ? getSessionTitle(session) : tab.title;
    }

    if (fileTreeShowExtensions && isNoteTab(tab)) {
        const baseName = tab.noteId.split("/").pop() || tab.title;
        return tab.noteId ? `${baseName}.md` : baseName;
    }
    return tab.title;
}

interface EditorPaneBarProps {
    paneId: string;
    isFocused: boolean;
}

function getAppWindow() {
    return getCurrentWindow();
}

export function EditorPaneBar({ paneId, isFocused }: EditorPaneBarProps) {
    const pane = useEditorStore((state) =>
        selectEditorPaneState(state, paneId),
    );
    const chatSessionsById = useChatStore((state) => state.sessionsById);
    const renameChatSession = useChatStore((state) => state.renameSession);
    const paneIds = useEditorStore(useShallow(selectLeafPaneIds));
    const paneCount = useEditorStore(selectPaneCount);
    const reorderPaneTabs = useEditorStore((state) => state.reorderPaneTabs);
    const switchTab = useEditorStore((state) => state.switchTab);
    const closeTab = useEditorStore((state) => state.closeTab);
    const closePane = useEditorStore((state) => state.closePane);
    const splitEditorPane = useEditorStore((state) => state.splitEditorPane);
    const balancePaneLayout = useEditorStore(
        (state) => state.balancePaneLayout,
    );
    const unifyAllPanesInto = useEditorStore(
        (state) => state.unifyAllPanesInto,
    );
    const focusPaneNeighbor = useEditorStore(
        (state) => state.focusPaneNeighbor,
    );
    const moveTabToNewSplit = useEditorStore(
        (state) => state.moveTabToNewSplit,
    );
    const moveTabToPane = useEditorStore((state) => state.moveTabToPane);
    const fileTreeShowExtensions = useSettingsStore(
        (state) => state.fileTreeShowExtensions,
    );
    const developerModeEnabled = useSettingsStore(
        (state) => state.developerModeEnabled,
    );
    const vaultPath = useVaultStore((state) => state.vaultPath);
    const [tabContextMenu, setTabContextMenu] = useState<ContextMenuState<{
        tabId: string;
    }> | null>(null);
    const [paneContextMenu, setPaneContextMenu] = useState<ContextMenuState<{
        paneId: string;
    }> | null>(null);
    const [newTabContextMenu, setNewTabContextMenu] =
        useState<ContextMenuState<void> | null>(null);
    const [dragPreviewTabId, setDragPreviewTabId] = useState<string | null>(
        null,
    );
    const dragPreviewNodeRef = useRef<HTMLDivElement | null>(null);
    const dragPreviewPosRef = useRef({ clientX: 0, clientY: 0 });
    const dragPreviewFrameRef = useRef<number | null>(null);
    const ghostRef = useRef<WebviewWindow | null>(null);
    const ghostCancelledRef = useRef(false);
    const windowMode = getWindowMode();
    const {
        editingKey,
        editValue,
        inputRef,
        setEditValue,
        startEditing,
        cancelEditing,
        commitEditing,
    } = useInlineRename<string>();

    const paneIndex = paneIds.indexOf(paneId);
    const canCreateSplit = paneCount < MAX_EDITOR_PANES;
    const leftNeighborPaneId = useEditorStore((state) =>
        selectPaneNeighbor(state, paneId, "left"),
    );
    const rightNeighborPaneId = useEditorStore((state) =>
        selectPaneNeighbor(state, paneId, "right"),
    );
    const upNeighborPaneId = useEditorStore((state) =>
        selectPaneNeighbor(state, paneId, "up"),
    );
    const downNeighborPaneId = useEditorStore((state) =>
        selectPaneNeighbor(state, paneId, "down"),
    );
    const movableTargets = useMemo(
        () =>
            paneIds
                .map((candidate, index) => ({
                    id: candidate,
                    index,
                }))
                .filter((candidate) => candidate.id !== paneId),
        [paneId, paneIds],
    );
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

            if (!coords) {
                return;
            }

            const tab =
                pane.tabs.find((candidate) => candidate.id === tabId) ?? null;
            if (!tab) {
                return;
            }

            const detail = buildTabFileDragDetail(tab, phase, coords, {
                resolveNotePath: (noteId) =>
                    useVaultStore
                        .getState()
                        .notes.find((note) => note.id === noteId)?.path ?? null,
            });
            if (!detail) {
                return;
            }

            emitFileTreeNoteDrag({
                ...detail,
                origin: {
                    kind: "unified-bar-tab",
                    tabId,
                },
            });
        },
        [pane.tabs],
    );
    const handleDetachStart = useCallback(
        async (tabId: string, coords: { screenX: number; screenY: number }) => {
            const currentTabs = selectEditorWorkspaceTabs(
                useEditorStore.getState(),
            );
            const tab = currentTabs.find((candidate) => candidate.id === tabId);
            if (!tab) {
                return;
            }

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
            if (!ghost) {
                return;
            }

            void moveGhostWindow(ghost, coords.screenX, coords.screenY);
        },
        [],
    );
    const handleDetachCancel = useCallback(() => {
        ghostCancelledRef.current = true;
        if (ghostRef.current) {
            void destroyGhostWindow(ghostRef.current);
            ghostRef.current = null;
        }
    }, []);
    const handleDetachEnd = useCallback(
        async (tabId: string, coords: { screenX: number; screenY: number }) => {
            ghostCancelledRef.current = true;
            if (ghostRef.current) {
                await destroyGhostWindow(ghostRef.current);
                ghostRef.current = null;
            }

            const state = useEditorStore.getState();
            const currentTabs = selectEditorWorkspaceTabs(state);
            const tab = currentTabs.find((candidate) => candidate.id === tabId);
            if (!tab) {
                return;
            }

            const targetWindowLabel = await findWindowTabDropTarget(
                coords.screenX,
                coords.screenY,
                getCurrentWindowLabel(),
                vaultPath,
            );

            if (targetWindowLabel) {
                const appWindow = getAppWindow();
                await appWindow.emitTo(
                    targetWindowLabel,
                    ATTACH_EXTERNAL_TAB_EVENT,
                    { tab } satisfies AttachExternalTabPayload,
                );

                if (windowMode === "note" && currentTabs.length === 1) {
                    await appWindow.close();
                    return;
                }

                closeTab(tabId, { reason: "detach" });
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
                const appWindow = getAppWindow();
                await appWindow.close();
                return;
            }

            closeTab(tabId, { reason: "detach" });
        },
        [closeTab, vaultPath, windowMode],
    );
    const applyDragPreviewPosition = useCallback(() => {
        dragPreviewFrameRef.current = null;
        const node = dragPreviewNodeRef.current;
        if (!node) {
            return;
        }

        const { clientX, clientY } = dragPreviewPosRef.current;
        node.style.transform = `translate3d(${clientX + 12}px, ${clientY + 12}px, 0) scale(1.02)`;
    }, []);
    const scheduleDragPreviewPosition = useCallback(() => {
        if (dragPreviewFrameRef.current !== null) {
            return;
        }

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
        draggingTabId,
        projectedDropIndex,
        tabStripRef,
        visualTabs,
        registerTabNode,
        handlePointerDown,
        handlePointerMove,
        handlePointerUp,
        handleLostPointerCapture,
        consumeSuppressedClick,
    } = useTabDragReorder({
        tabs: pane.tabs,
        onCommitReorder: (fromIndex, toIndex) =>
            reorderPaneTabs(paneId, fromIndex, toIndex),
        onActivate: switchTab,
        liveReorder: false,
        shouldDetach: isPointerOutsideCurrentWindow,
        shouldCommitDrag: (tabId, coords) => {
            const tab =
                pane.tabs.find((candidate) => candidate.id === tabId) ?? null;
            if (!tab) {
                return true;
            }

            const canAttachToComposer =
                buildTabFileDragDetail(
                    tab,
                    "end",
                    {
                        clientX: coords.clientX,
                        clientY: coords.clientY,
                    },
                    {
                        resolveNotePath: (noteId) =>
                            useVaultStore
                                .getState()
                                .notes.find((note) => note.id === noteId)
                                ?.path ?? null,
                    },
                ) !== null;

            if (!canAttachToComposer) {
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
    const draggedPreviewTab =
        dragPreviewTabId === null
            ? null
            : (pane.tabs.find((tab) => tab.id === dragPreviewTabId) ?? null);
    const draggingOriginalIndex = draggingTabId
        ? pane.tabs.findIndex((tab) => tab.id === draggingTabId)
        : -1;
    const insertionIndicatorIndex =
        draggingOriginalIndex === -1 || projectedDropIndex == null
            ? null
            : projectedDropIndex > draggingOriginalIndex
              ? projectedDropIndex + 1
              : projectedDropIndex;
    const handleTabPointerDownCapture = useCallback(
        (tabId: string, event: React.PointerEvent<HTMLDivElement>) => {
            if (event.button !== 0) return;
            if ((event.target as HTMLElement).closest("button")) return;
            switchTab(tabId);
        },
        [switchTab],
    );
    const handleTabClick = useCallback(
        (tabId: string) => {
            if (editingKey === tabId) return;
            if (consumeSuppressedClick(tabId)) return;
            switchTab(tabId);
        },
        [consumeSuppressedClick, editingKey, switchTab],
    );
    const beginChatRename = useCallback(
        (tab: Tab) => {
            if (!isChatTab(tab)) return;
            const session = chatSessionsById[tab.sessionId];
            if (!session) return;
            switchTab(tab.id);
            startEditing(tab.id, getSessionTitle(session));
        },
        [chatSessionsById, startEditing, switchTab],
    );
    const commitChatRename = useCallback(
        (tabId: string, value: string | null) => {
            const tab = selectEditorWorkspaceTabs(
                useEditorStore.getState(),
            ).find((candidate) => candidate.id === tabId);
            if (!tab || !isChatTab(tab)) return;
            renameChatSession(tab.sessionId, value);
        },
        [renameChatSession],
    );

    return (
        <>
            <div
                ref={tabStripRef}
                data-pane-tab-strip={paneId}
                className="flex items-center gap-1 px-2 py-0.5 shrink-0 overflow-x-auto scrollbar-hidden"
                style={{
                    height: 38,
                    minHeight: 38,
                    boxSizing: "border-box",
                    borderBottom: "1px solid var(--border)",
                    background: isFocused
                        ? "color-mix(in srgb, var(--bg-secondary) 96%, var(--accent) 4%)"
                        : "var(--bg-secondary)",
                }}
                onWheel={(event) => {
                    if (event.deltaY !== 0) {
                        event.currentTarget.scrollLeft += event.deltaY;
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
                            height: 20,
                            marginRight: 4,
                            backgroundColor: "var(--accent)",
                            boxShadow:
                                "0 0 0 1px color-mix(in srgb, var(--accent) 22%, transparent)",
                        }}
                    />
                )}
                {visualTabs.map((tab, index) => {
                    const isActive = tab.id === pane.activeTabId;
                    const isDragging = tab.id === draggingTabId;
                    const isEditing = editingKey === tab.id;
                    const canRename = isChatTab(tab);
                    const tabLabel = getTabLabel(
                        tab,
                        fileTreeShowExtensions,
                        chatSessionsById,
                    );
                    return (
                        <Fragment key={tab.id}>
                            <div
                                ref={(node) => registerTabNode(tab.id, node)}
                                data-pane-tab-id={tab.id}
                                role="tab"
                                tabIndex={0}
                                aria-selected={isActive}
                                className="group inline-flex h-8 min-w-0 max-w-55 shrink-0 items-center gap-2 rounded-lg px-2.5 text-left"
                                onPointerDownCapture={(event) =>
                                    isEditing
                                        ? undefined
                                        : handleTabPointerDownCapture(
                                              tab.id,
                                              event,
                                          )
                                }
                                onPointerDown={(event) =>
                                    isEditing
                                        ? undefined
                                        : handlePointerDown(
                                              tab.id,
                                              index,
                                              event,
                                          )
                                }
                                onPointerMove={(event) =>
                                    isEditing
                                        ? undefined
                                        : handlePointerMove(tab.id, event)
                                }
                                onPointerUp={(event) =>
                                    isEditing
                                        ? undefined
                                        : handlePointerUp(event.pointerId, {
                                              clientX: event.clientX,
                                              clientY: event.clientY,
                                              screenX: event.screenX,
                                              screenY: event.screenY,
                                          })
                                }
                                onPointerCancel={(event) =>
                                    isEditing
                                        ? undefined
                                        : handlePointerUp(event.pointerId, {
                                              clientX: event.clientX,
                                              clientY: event.clientY,
                                              screenX: event.screenX,
                                              screenY: event.screenY,
                                          })
                                }
                                onLostPointerCapture={(event) =>
                                    isEditing
                                        ? undefined
                                        : handleLostPointerCapture(
                                              event.pointerId,
                                          )
                                }
                                onClick={() => handleTabClick(tab.id)}
                                onContextMenu={(event) => {
                                    if (isEditing) return;
                                    event.preventDefault();
                                    setTabContextMenu({
                                        x: event.clientX,
                                        y: event.clientY,
                                        payload: { tabId: tab.id },
                                    });
                                }}
                                style={{
                                    boxSizing: "border-box",
                                    border: isActive
                                        ? "1px solid color-mix(in srgb, var(--accent) 18%, var(--border))"
                                        : "1px solid color-mix(in srgb, var(--border) 46%, transparent)",
                                    background: isActive
                                        ? "var(--bg-primary)"
                                        : "color-mix(in srgb, var(--bg-primary) 38%, transparent)",
                                    color: isActive
                                        ? "var(--text-primary)"
                                        : "var(--text-secondary)",
                                    boxShadow: isActive
                                        ? "0 10px 24px rgba(15, 23, 42, 0.08)"
                                        : "none",
                                    opacity: isDragging ? 0.72 : 1,
                                    cursor: isDragging ? "grabbing" : "pointer",
                                }}
                            >
                                {renderEditorTabLeadingIcon(tab)}
                                {isEditing ? (
                                    <input
                                        ref={inputRef}
                                        value={editValue}
                                        onChange={(event) =>
                                            setEditValue(event.target.value)
                                        }
                                        onKeyDown={(event) => {
                                            if (event.key === "Enter") {
                                                commitEditing(commitChatRename);
                                            } else if (event.key === "Escape") {
                                                cancelEditing();
                                            }
                                        }}
                                        onBlur={() =>
                                            commitEditing(commitChatRename)
                                        }
                                        onPointerDown={(event) =>
                                            event.stopPropagation()
                                        }
                                        onClick={(event) =>
                                            event.stopPropagation()
                                        }
                                        className="min-w-0 flex-1 truncate bg-transparent text-[12px] font-medium outline-none"
                                        style={{
                                            color: "var(--text-primary)",
                                            border: "none",
                                            padding: 0,
                                            minHeight: 0,
                                            boxSizing: "border-box",
                                            boxShadow:
                                                "inset 0 -1px 0 var(--accent)",
                                        }}
                                    />
                                ) : (
                                    <span
                                        className="truncate text-[12px] font-medium"
                                        onDoubleClick={() => {
                                            if (!canRename) return;
                                            beginChatRename(tab);
                                        }}
                                        title={
                                            canRename
                                                ? "Double-click to rename"
                                                : undefined
                                        }
                                    >
                                        {tabLabel}
                                    </span>
                                )}
                                <button
                                    type="button"
                                    title={`Close ${tabLabel}`}
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        if (isChatTab(tab)) {
                                            moveChatToSidebar(tab.sessionId);
                                        } else {
                                            closeTab(tab.id);
                                        }
                                    }}
                                    className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded opacity-45 transition group-hover:opacity-100"
                                    style={{ color: "inherit" }}
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
                            {insertionIndicatorIndex === index + 1 && (
                                <div
                                    aria-hidden="true"
                                    className="shrink-0 rounded-full"
                                    style={{
                                        width: 3,
                                        height: 20,
                                        marginLeft: 4,
                                        backgroundColor: "var(--accent)",
                                        boxShadow:
                                            "0 0 0 1px color-mix(in srgb, var(--accent) 22%, transparent)",
                                    }}
                                />
                            )}
                        </Fragment>
                    );
                })}

                {vaultPath && (
                    <button
                        type="button"
                        data-new-tab-button="true"
                        onClick={() => openBlankDraftTabFromPlusButton(paneId)}
                        onContextMenu={(event) => {
                            event.preventDefault();
                            setNewTabContextMenu({
                                x: event.clientX,
                                y: event.clientY,
                                payload: undefined,
                            });
                        }}
                        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
                        aria-label="New tab"
                        title="New tab"
                        style={{
                            border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)",
                            color: "var(--text-secondary)",
                            background: "transparent",
                        }}
                    >
                        <svg
                            width="12"
                            height="12"
                            viewBox="0 0 16 16"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        >
                            <path d="M8 3.5v9M3.5 8h9" />
                        </svg>
                    </button>
                )}

                <button
                    type="button"
                    onClick={(event) =>
                        setPaneContextMenu({
                            x: event.clientX,
                            y: event.clientY,
                            payload: { paneId },
                        })
                    }
                    className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
                    aria-label={`Pane ${paneIndex + 1} actions`}
                    title={`Pane ${paneIndex + 1} actions`}
                    style={{
                        border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)",
                        color: "var(--text-secondary)",
                        background: "transparent",
                    }}
                >
                    <svg
                        width="12"
                        height="12"
                        viewBox="0 0 16 16"
                        fill="currentColor"
                    >
                        <circle cx="8" cy="3.5" r="1.25" />
                        <circle cx="8" cy="8" r="1.25" />
                        <circle cx="8" cy="12.5" r="1.25" />
                    </svg>
                </button>
            </div>

            {tabContextMenu && (
                <ContextMenu
                    menu={tabContextMenu}
                    onClose={() => setTabContextMenu(null)}
                    entries={(() => {
                        const targetTab =
                            pane.tabs.find(
                                (candidate) =>
                                    candidate.id ===
                                    tabContextMenu.payload.tabId,
                            ) ?? null;
                        if (!targetTab) {
                            return [];
                        }

                        const entries: ContextMenuEntry[] = [
                            {
                                label: "Close",
                                action: () => {
                                    if (isChatTab(targetTab)) {
                                        moveChatToSidebar(targetTab.sessionId);
                                    } else {
                                        closeTab(targetTab.id);
                                    }
                                },
                            },
                        ];

                        if (isChatTab(targetTab)) {
                            entries.push({
                                label: "Rename chat",
                                action: () => beginChatRename(targetTab),
                            });
                            entries.push({
                                label: "Return to AI Panel",
                                action: () =>
                                    moveChatToSidebar(targetTab.sessionId),
                            });
                        }

                        entries.push({ type: "separator" });
                        entries.push({
                            label: "Move to New Right Split",
                            disabled: !canCreateSplit,
                            action: () => {
                                moveTabToNewSplit(targetTab.id, "row");
                            },
                        });
                        entries.push({
                            label: "Move to New Down Split",
                            disabled: !canCreateSplit,
                            action: () => {
                                moveTabToNewSplit(targetTab.id, "column");
                            },
                        });

                        if (movableTargets.length > 0) {
                            entries.push(
                                ...movableTargets.map((target) => ({
                                    label: `Move to Pane ${target.index + 1}`,
                                    action: () =>
                                        moveTabToPane(targetTab.id, target.id),
                                })),
                            );
                        }

                        return entries;
                    })()}
                />
            )}

            {newTabContextMenu && (
                <ContextMenu
                    menu={newTabContextMenu}
                    onClose={() => setNewTabContextMenu(null)}
                    entries={buildNewTabContextMenuEntries({
                        paneId,
                        developerModeEnabled,
                    })}
                />
            )}

            {paneContextMenu && (
                <ContextMenu
                    menu={paneContextMenu}
                    onClose={() => setPaneContextMenu(null)}
                    entries={[
                        {
                            label: "Split Right",
                            action: () => splitEditorPane("row", paneId),
                            disabled: !canCreateSplit,
                        },
                        {
                            label: "Split Down",
                            action: () => splitEditorPane("column", paneId),
                            disabled: !canCreateSplit,
                        },
                        { type: "separator" },
                        {
                            label: "Focus Pane Left",
                            action: () => focusPaneNeighbor("left", paneId),
                            disabled: !leftNeighborPaneId,
                        },
                        {
                            label: "Focus Pane Right",
                            action: () => focusPaneNeighbor("right", paneId),
                            disabled: !rightNeighborPaneId,
                        },
                        {
                            label: "Focus Pane Up",
                            action: () => focusPaneNeighbor("up", paneId),
                            disabled: !upNeighborPaneId,
                        },
                        {
                            label: "Focus Pane Down",
                            action: () => focusPaneNeighbor("down", paneId),
                            disabled: !downNeighborPaneId,
                        },
                        { type: "separator" },
                        {
                            label: "Balance Layout",
                            action: () => balancePaneLayout(),
                            disabled: paneCount <= 1,
                        },
                        {
                            label: "Unify All Tabs",
                            action: () => unifyAllPanesInto(paneId),
                            disabled: paneCount <= 1,
                        },
                        { type: "separator" },
                        {
                            label: `Close Pane ${paneIndex + 1}`,
                            action: () => closePane(paneId),
                            disabled: paneCount <= 1,
                        },
                    ]}
                />
            )}

            {draggedPreviewTab
                ? createPortal(
                      <div
                          ref={dragPreviewNodeRef}
                          data-pane-tab-drag-preview="true"
                          style={{
                              position: "fixed",
                              left: 0,
                              top: 0,
                              display: "flex",
                              alignItems: "center",
                              gap: 8,
                              minWidth: 140,
                              maxWidth: 220,
                              height: 34,
                              padding: "0 12px",
                              borderRadius: 10,
                              border: "1px solid color-mix(in srgb, var(--accent) 16%, var(--border))",
                              background:
                                  "color-mix(in srgb, var(--bg-primary) 94%, white 6%)",
                              color: "var(--text-primary)",
                              boxShadow: "0 14px 32px rgba(15, 23, 42, 0.18)",
                              pointerEvents: "none",
                              zIndex: 9999,
                              willChange: "transform",
                          }}
                      >
                          {renderEditorTabLeadingIcon(draggedPreviewTab)}
                          <span
                              style={{
                                  minWidth: 0,
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                  fontSize: 12,
                                  fontWeight: 600,
                              }}
                          >
                              {getTabLabel(
                                  draggedPreviewTab,
                                  fileTreeShowExtensions,
                                  chatSessionsById,
                              )}
                          </span>
                      </div>,
                      document.body,
                  )
                : null}
        </>
    );
}
