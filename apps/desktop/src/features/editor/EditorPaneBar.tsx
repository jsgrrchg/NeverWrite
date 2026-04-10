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
import { createPortal } from "react-dom";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
    type Tab,
    isChatTab,
    isNoteTab,
    selectEditorWorkspaceTabs,
    selectEditorPaneState,
    useEditorStore,
} from "../../app/store/editorStore";
import { moveChatToSidebar } from "../ai/chatPaneMovement";
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
import { useTabDragReorder } from "./useTabDragReorder";
import {
    buildTabFileDragDetail,
    isPointOverAiComposerDropZone,
} from "./tabDragAttachments";
import { getTabStripInsertIndex } from "./tabStrip";

function renderTabLeadingIcon(tab: Tab): ReactNode {
    if (tab.kind === "pdf") {
        return (
            <span
                aria-hidden="true"
                className="inline-flex h-4 w-4 items-center justify-center rounded text-[8px] font-semibold"
                style={{
                    background: "color-mix(in srgb, #e24b3b 12%, transparent)",
                    color: "#e24b3b",
                }}
            >
                PDF
            </span>
        );
    }

    if (tab.kind === "file") {
        return (
            <span
                aria-hidden="true"
                className="inline-flex h-4 w-4 items-center justify-center rounded text-[8px] font-semibold"
                style={{
                    background:
                        "color-mix(in srgb, var(--text-secondary) 12%, transparent)",
                    color: "var(--text-secondary)",
                }}
            >
                F
            </span>
        );
    }

    if (tab.kind === "ai-review") {
        return (
            <span
                aria-hidden="true"
                className="inline-flex h-4 w-4 items-center justify-center rounded text-[8px] font-semibold"
                style={{
                    background:
                        "color-mix(in srgb, var(--accent) 12%, transparent)",
                    color: "var(--accent)",
                }}
            >
                AI
            </span>
        );
    }

    if (tab.kind === "ai-chat") {
        return (
            <span
                aria-hidden="true"
                className="inline-flex h-4 w-4 items-center justify-center rounded text-[8px] font-semibold"
                style={{
                    background:
                        "color-mix(in srgb, var(--accent) 12%, transparent)",
                    color: "var(--accent)",
                }}
            >
                C
            </span>
        );
    }

    if (tab.kind === "map") {
        return (
            <span
                aria-hidden="true"
                className="inline-flex h-4 w-4 items-center justify-center rounded text-[8px] font-semibold"
                style={{
                    background:
                        "color-mix(in srgb, var(--accent) 12%, transparent)",
                    color: "var(--accent)",
                }}
            >
                M
            </span>
        );
    }

    if (tab.kind === "graph") {
        return (
            <span
                aria-hidden="true"
                className="inline-flex h-4 w-4 items-center justify-center rounded text-[8px] font-semibold"
                style={{
                    background:
                        "color-mix(in srgb, var(--accent) 12%, transparent)",
                    color: "var(--accent)",
                }}
            >
                G
            </span>
        );
    }

    return (
        <span
            aria-hidden="true"
            className="inline-flex h-4 w-4 items-center justify-center rounded text-[8px] font-semibold"
            style={{
                background:
                    "color-mix(in srgb, var(--text-secondary) 10%, transparent)",
                color: "var(--text-secondary)",
            }}
        >
            N
        </span>
    );
}

function getTabLabel(tab: Tab, fileTreeShowExtensions: boolean) {
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

interface CrossPaneTabDropPreview {
    sourcePaneId: string;
    targetPaneId: string;
    insertIndex: number;
    tabId: string;
}

const CROSS_PANE_TAB_DROP_PREVIEW_EVENT =
    "neverwrite:cross-pane-tab-drop-preview";

function duplicateTabForNewPane(tab: Tab): Tab | null {
    if (
        tab.kind === "ai-review" ||
        tab.kind === "ai-chat" ||
        tab.kind === "graph"
    ) {
        return null;
    }

    return {
        ...tab,
        id: crypto.randomUUID(),
    };
}

function getAppWindow() {
    return getCurrentWindow();
}

function isPointInsideRect(
    clientX: number,
    clientY: number,
    rect: DOMRect | Pick<DOMRect, "left" | "right" | "top" | "bottom">,
) {
    return (
        clientX >= rect.left &&
        clientX <= rect.right &&
        clientY >= rect.top &&
        clientY <= rect.bottom
    );
}

function getPaneTabStripDropIndex(strip: HTMLElement | null, clientX: number) {
    if (!strip) {
        return 0;
    }

    const tabRects = Array.from(
        strip.querySelectorAll<HTMLElement>("[data-pane-tab-id]"),
    ).map((tab) => {
        const rect = tab.getBoundingClientRect();
        return {
            left: rect.left,
            width: rect.width,
        };
    });

    return getTabStripInsertIndex(clientX, tabRects);
}

function dispatchCrossPaneTabDropPreview(
    detail: CrossPaneTabDropPreview | null,
) {
    window.dispatchEvent(
        new CustomEvent<CrossPaneTabDropPreview | null>(
            CROSS_PANE_TAB_DROP_PREVIEW_EVENT,
            {
                detail,
            },
        ),
    );
}

export function EditorPaneBar({ paneId, isFocused }: EditorPaneBarProps) {
    const pane = useEditorStore((state) =>
        selectEditorPaneState(state, paneId),
    );
    const panes = useEditorStore((state) => state.panes);
    const reorderPaneTabs = useEditorStore((state) => state.reorderPaneTabs);
    const switchTab = useEditorStore((state) => state.switchTab);
    const closeTab = useEditorStore((state) => state.closeTab);
    const closePane = useEditorStore((state) => state.closePane);
    const moveTabToPane = useEditorStore((state) => state.moveTabToPane);
    const insertExternalTabInPane = useEditorStore(
        (state) => state.insertExternalTabInPane,
    );
    const insertExternalTabInNewPane = useEditorStore(
        (state) => state.insertExternalTabInNewPane,
    );
    const fileTreeShowExtensions = useSettingsStore(
        (state) => state.fileTreeShowExtensions,
    );
    const vaultPath = useVaultStore((state) => state.vaultPath);
    const [tabContextMenu, setTabContextMenu] = useState<ContextMenuState<{
        tabId: string;
    }> | null>(null);
    const [paneContextMenu, setPaneContextMenu] = useState<ContextMenuState<{
        paneId: string;
    }> | null>(null);
    const [dragPreviewTabId, setDragPreviewTabId] = useState<string | null>(
        null,
    );
    const [crossPaneDropPreview, setCrossPaneDropPreview] =
        useState<CrossPaneTabDropPreview | null>(null);
    const dragPreviewNodeRef = useRef<HTMLDivElement | null>(null);
    const dragPreviewPosRef = useRef({ clientX: 0, clientY: 0 });
    const dragPreviewFrameRef = useRef<number | null>(null);
    const crossPaneDropPreviewRef = useRef<CrossPaneTabDropPreview | null>(
        null,
    );
    const ghostRef = useRef<WebviewWindow | null>(null);
    const ghostCancelledRef = useRef(false);
    const windowMode = getWindowMode();

    const paneIndex = panes.findIndex((candidate) => candidate.id === paneId);
    const movableTargets = useMemo(
        () =>
            panes
                .map((candidate, index) => ({
                    id: candidate.id,
                    index,
                }))
                .filter((candidate) => candidate.id !== paneId),
        [paneId, panes],
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
    const updateCrossPaneDropPreview = useCallback(
        (detail: CrossPaneTabDropPreview | null) => {
            crossPaneDropPreviewRef.current = detail;
            dispatchCrossPaneTabDropPreview(detail);
        },
        [],
    );
    const resolveCrossPaneDropTarget = useCallback(
        (tabId: string, clientX: number, clientY: number) => {
            const workspacePanes = useEditorStore.getState().panes;
            const paneNodes = document.querySelectorAll<HTMLElement>(
                "[data-editor-pane-id]",
            );

            for (const paneNode of paneNodes) {
                const targetPaneId = paneNode.dataset.editorPaneId;
                if (!targetPaneId || targetPaneId === paneId) {
                    continue;
                }

                const paneRect = paneNode.getBoundingClientRect();
                if (!isPointInsideRect(clientX, clientY, paneRect)) {
                    continue;
                }

                const targetPane =
                    workspacePanes.find((pane) => pane.id === targetPaneId) ??
                    null;
                if (!targetPane) {
                    continue;
                }

                const targetStrip = paneNode.querySelector<HTMLElement>(
                    "[data-pane-tab-strip]",
                );
                const insertIndex =
                    targetStrip &&
                    isPointInsideRect(
                        clientX,
                        clientY,
                        targetStrip.getBoundingClientRect(),
                    )
                        ? getPaneTabStripDropIndex(targetStrip, clientX)
                        : targetPane.tabs.length;

                return {
                    sourcePaneId: paneId,
                    targetPaneId,
                    insertIndex,
                    tabId,
                } satisfies CrossPaneTabDropPreview;
            }

            return null;
        },
        [paneId],
    );
    const handleDetachStart = useCallback(
        async (tabId: string, coords: { screenX: number; screenY: number }) => {
            updateCrossPaneDropPreview(null);
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
        [updateCrossPaneDropPreview],
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
        updateCrossPaneDropPreview(null);
        ghostCancelledRef.current = true;
        if (ghostRef.current) {
            void destroyGhostWindow(ghostRef.current);
            ghostRef.current = null;
        }
    }, [updateCrossPaneDropPreview]);
    const handleDetachEnd = useCallback(
        async (tabId: string, coords: { screenX: number; screenY: number }) => {
            updateCrossPaneDropPreview(null);
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
        [closeTab, updateCrossPaneDropPreview, vaultPath, windowMode],
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
        const handleCrossPaneDropPreview = (event: Event) => {
            const detail = (
                event as CustomEvent<CrossPaneTabDropPreview | null>
            ).detail;
            crossPaneDropPreviewRef.current = detail;
            setCrossPaneDropPreview(detail);
        };

        window.addEventListener(
            CROSS_PANE_TAB_DROP_PREVIEW_EVENT,
            handleCrossPaneDropPreview,
        );

        return () => {
            if (dragPreviewFrameRef.current !== null) {
                window.cancelAnimationFrame(dragPreviewFrameRef.current);
                dragPreviewFrameRef.current = null;
            }
            if (ghostRef.current) {
                void destroyGhostWindow(ghostRef.current);
                ghostRef.current = null;
            }
            window.removeEventListener(
                CROSS_PANE_TAB_DROP_PREVIEW_EVENT,
                handleCrossPaneDropPreview,
            );
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
            const crossPaneTarget = resolveCrossPaneDropTarget(
                tabId,
                coords.clientX,
                coords.clientY,
            );
            if (
                crossPaneTarget ??
                (crossPaneDropPreviewRef.current?.tabId === tabId
                    ? crossPaneDropPreviewRef.current
                    : null)
            ) {
                return false;
            }

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
            updateCrossPaneDropPreview(null);
            emitTabDragDetail(tabId, "start", {
                clientX: coords.clientX,
                clientY: coords.clientY,
            });
        },
        onDragMove: (tabId, coords) => {
            updateTabDragPreview(tabId, coords.clientX, coords.clientY);
            updateCrossPaneDropPreview(
                resolveCrossPaneDropTarget(
                    tabId,
                    coords.clientX,
                    coords.clientY,
                ),
            );
            emitTabDragDetail(tabId, "move", {
                clientX: coords.clientX,
                clientY: coords.clientY,
            });
        },
        onDragEnd: (tabId, coords) => {
            const crossPaneTarget =
                resolveCrossPaneDropTarget(
                    tabId,
                    coords.clientX,
                    coords.clientY,
                ) ??
                (crossPaneDropPreviewRef.current?.tabId === tabId
                    ? crossPaneDropPreviewRef.current
                    : null);
            emitTabDragDetail(tabId, "end", {
                clientX: coords.clientX,
                clientY: coords.clientY,
            });
            if (crossPaneTarget) {
                moveTabToPane(
                    tabId,
                    crossPaneTarget.targetPaneId,
                    crossPaneTarget.insertIndex,
                );
            }
            updateCrossPaneDropPreview(null);
            setDragPreviewTabId(null);
        },
        onDragCancel: (tabId) => {
            emitTabDragDetail(tabId, "cancel");
            updateCrossPaneDropPreview(null);
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
    const externalInsertionIndicatorIndex =
        crossPaneDropPreview?.targetPaneId === paneId
            ? crossPaneDropPreview.insertIndex
            : null;
    const suppressLocalInsertionIndicator =
        crossPaneDropPreview?.sourcePaneId === paneId &&
        crossPaneDropPreview.targetPaneId !== paneId;
    const insertionIndicatorIndex =
        externalInsertionIndicatorIndex ??
        (suppressLocalInsertionIndicator
            ? null
            : draggingOriginalIndex === -1 || projectedDropIndex == null
              ? null
              : projectedDropIndex > draggingOriginalIndex
                ? projectedDropIndex + 1
                : projectedDropIndex);
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
            if (consumeSuppressedClick(tabId)) return;
            switchTab(tabId);
        },
        [consumeSuppressedClick, switchTab],
    );

    return (
        <>
            <div
                ref={tabStripRef}
                data-pane-tab-strip={paneId}
                className="flex items-center gap-1 px-2 py-1 shrink-0 overflow-x-auto scrollbar-hidden"
                style={{
                    minHeight: 38,
                    borderBottom: "1px solid var(--border)",
                    background: isFocused
                        ? "color-mix(in srgb, var(--bg-secondary) 96%, var(--accent) 4%)"
                        : crossPaneDropPreview?.targetPaneId === paneId
                          ? "color-mix(in srgb, var(--bg-secondary) 92%, var(--accent) 8%)"
                          : "var(--bg-secondary)",
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
                    return (
                        <Fragment key={tab.id}>
                            <div
                                ref={(node) => registerTabNode(tab.id, node)}
                                data-pane-tab-id={tab.id}
                                role="tab"
                                tabIndex={0}
                                aria-selected={isActive}
                                className="group inline-flex min-w-0 max-w-55 shrink-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-left"
                                onPointerDownCapture={(event) =>
                                    handleTabPointerDownCapture(tab.id, event)
                                }
                                onPointerDown={(event) =>
                                    handlePointerDown(tab.id, index, event)
                                }
                                onPointerMove={(event) =>
                                    handlePointerMove(tab.id, event)
                                }
                                onPointerUp={(event) =>
                                    handlePointerUp(event.pointerId, {
                                        clientX: event.clientX,
                                        clientY: event.clientY,
                                        screenX: event.screenX,
                                        screenY: event.screenY,
                                    })
                                }
                                onPointerCancel={(event) =>
                                    handlePointerUp(event.pointerId, {
                                        clientX: event.clientX,
                                        clientY: event.clientY,
                                        screenX: event.screenX,
                                        screenY: event.screenY,
                                    })
                                }
                                onLostPointerCapture={(event) =>
                                    handleLostPointerCapture(event.pointerId)
                                }
                                onClick={() => handleTabClick(tab.id)}
                                onContextMenu={(event) => {
                                    event.preventDefault();
                                    setTabContextMenu({
                                        x: event.clientX,
                                        y: event.clientY,
                                        payload: { tabId: tab.id },
                                    });
                                }}
                                style={{
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
                                {renderTabLeadingIcon(tab)}
                                <span className="truncate text-[12px] font-medium">
                                    {getTabLabel(tab, fileTreeShowExtensions)}
                                </span>
                                <button
                                    type="button"
                                    title={`Close ${tab.title}`}
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
                        onClick={() =>
                            insertExternalTabInPane(
                                {
                                    id: crypto.randomUUID(),
                                    kind: "note",
                                    noteId: "",
                                    title: "New Tab",
                                    content: "",
                                },
                                paneId,
                            )
                        }
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
                                label: "Return to AI Panel",
                                action: () =>
                                    moveChatToSidebar(targetTab.sessionId),
                            });
                        }

                        const duplicatedTab = duplicateTabForNewPane(targetTab);
                        entries.push({ type: "separator" });
                        entries.push({
                            label: "Add to New Pane",
                            disabled:
                                duplicatedTab === null || panes.length >= 3,
                            action: () => {
                                if (!duplicatedTab) {
                                    return;
                                }
                                insertExternalTabInNewPane(duplicatedTab);
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

            {paneContextMenu && (
                <ContextMenu
                    menu={paneContextMenu}
                    onClose={() => setPaneContextMenu(null)}
                    entries={[
                        {
                            label: `Close Pane ${paneIndex + 1}`,
                            action: () => closePane(paneId),
                            disabled: panes.length <= 1,
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
                          {renderTabLeadingIcon(draggedPreviewTab)}
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
                              )}
                          </span>
                      </div>,
                      document.body,
                  )
                : null}
        </>
    );
}
