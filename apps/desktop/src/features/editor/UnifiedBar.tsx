import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
    type CSSProperties,
    type MouseEvent as ReactMouseEvent,
} from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { WebviewWindow } from "@tauri-apps/api/webviewWindow";
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
import { useEditorStore } from "../../app/store/editorStore";
import { useLayoutStore } from "../../app/store/layoutStore";
import { useVaultStore } from "../../app/store/vaultStore";
import {
    ContextMenu,
    type ContextMenuState,
} from "../../components/context-menu/ContextMenu";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { revealNoteInTree } from "../../app/utils/navigation";
import { emitFileTreeNoteDrag } from "../ai/dragEvents";
import { useTabDragReorder } from "./useTabDragReorder";
import { getTabStripScrollTarget } from "./tabStrip";

const appWindow = getCurrentWindow();

function startWindowDrag(event: ReactMouseEvent<HTMLElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    void appWindow.startDragging().catch(() => {
        // Ignore denied / unsupported drag attempts and keep the bar interactive.
    });
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
        transition:
            "background-color 140ms ease, color 140ms ease, border-color 140ms ease, opacity 140ms ease, box-shadow 140ms ease",
    };
}

const controlsGroupStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 4,
    padding: "4px",
    borderRadius: 12,
    border: "1px solid color-mix(in srgb, var(--border) 78%, transparent)",
    background: "color-mix(in srgb, var(--bg-primary) 52%, var(--bg-tertiary))",
    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.05)",
};

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
    // Primitive selectors — stable when values don't change
    const canGoBack = useEditorStore((s) => {
        const tab = s.tabs.find((t) => t.id === s.activeTabId);
        return tab && tab.kind !== "pdf" ? tab.historyIndex > 0 : false;
    });
    const canGoForward = useEditorStore((s) => {
        const tab = s.tabs.find((t) => t.id === s.activeTabId);
        return tab && tab.kind !== "pdf"
            ? tab.historyIndex < tab.history.length - 1
            : false;
    });
    const sidebarCollapsed = useLayoutStore((s) => s.sidebarCollapsed);
    const toggleSidebar = useLayoutStore((s) => s.toggleSidebar);
    const rightPanelCollapsed = useLayoutStore((s) => s.rightPanelCollapsed);
    const rightPanelView = useLayoutStore((s) => s.rightPanelView);
    const activateRightView = useLayoutStore((s) => s.activateRightView);
    const vaultPath = useVaultStore((s) => s.vaultPath);
    const [tabContextMenu, setTabContextMenu] = useState<ContextMenuState<{
        tabId: string;
    }> | null>(null);
    const [historyContextMenu, setHistoryContextMenu] =
        useState<ContextMenuState<void> | null>(null);

    const ghostRef = useRef<WebviewWindow | null>(null);
    const ghostCancelledRef = useRef(false);

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

    useEffect(() => {
        return () => {
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
        shouldDetach: isPointerOutsideCurrentWindow,
        onDetachStart: handleDetachStart,
        onDetachMove: handleDetachMove,
        onDetachEnd: handleDetachEnd,
        onDetachCancel: handleDetachCancel,
    });

    const handleTabClick = useCallback(
        (tabId: string) => {
            if (consumeSuppressedClick(tabId)) return;
            switchTab(tabId);
        },
        [consumeSuppressedClick, switchTab],
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

    useLayoutEffect(() => {
        const label = getCurrentWindowLabel();
        let disposed = false;
        let frame: number | null = null;
        let resizeObserver: ResizeObserver | null = null;
        const cleanupListeners: Array<() => void> = [];

        const schedulePublish = () => {
            if (disposed) return;
            if (frame !== null) {
                window.cancelAnimationFrame(frame);
            }

            frame = window.requestAnimationFrame(() => {
                frame = null;
                const strip = tabStripRef.current;
                if (!strip) {
                    publishWindowTabDropZone(label, null);
                    return;
                }

                const rect = strip.getBoundingClientRect();
                if (rect.width <= 0 || rect.height <= 0) {
                    publishWindowTabDropZone(label, null);
                    return;
                }

                const left = window.screenX + rect.left;
                const top = window.screenY + rect.top;
                publishWindowTabDropZone(label, {
                    left: Math.round(left),
                    top: Math.round(top),
                    right: Math.round(left + rect.width),
                    bottom: Math.round(top + rect.height),
                    vaultPath,
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

        void appWindow
            .onMoved(() => {
                schedulePublish();
            })
            .then((unlisten) => {
                if (disposed) {
                    void unlisten();
                    return;
                }
                cleanupListeners.push(unlisten);
            });

        void appWindow
            .onResized(() => {
                schedulePublish();
            })
            .then((unlisten) => {
                if (disposed) {
                    void unlisten();
                    return;
                }
                cleanupListeners.push(unlisten);
            });

        void appWindow
            .onScaleChanged(() => {
                schedulePublish();
            })
            .then((unlisten) => {
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

    const hasTabs = visualTabs.length > 0;

    return (
        <div
            onMouseDown={(event) => {
                if (event.target === event.currentTarget) {
                    startWindowDrag(event);
                }
            }}
            style={{
                paddingTop: "env(safe-area-inset-top, 28px)",
                background:
                    "color-mix(in srgb, var(--bg-tertiary) 92%, transparent)",
                borderBottom: "1px solid var(--border)",
                backdropFilter: "blur(18px)",
                boxShadow: "0 1px 0 rgba(255,255,255,0.04)",
            }}
        >
            <div
                className="flex items-stretch select-none"
                style={{ height: 44, cursor: "default", padding: "0 6px" }}
            >
                <div
                    onMouseDown={startWindowDrag}
                    style={{ width: 68, flexShrink: 0 }}
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
                            className="no-drag flex items-center justify-center flex-shrink-0"
                            style={{
                                alignSelf: "center",
                                marginLeft: 4,
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
                                transition: "opacity 140ms ease",
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
                            className="no-drag flex items-center justify-center flex-shrink-0"
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
                                transition: "opacity 140ms ease",
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
                            className="no-drag flex items-center justify-center flex-shrink-0"
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
                                transition: "opacity 140ms ease",
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

                        <div className="no-drag flex min-w-0 flex-1 overflow-hidden items-center">
                            <div className="no-drag flex min-w-0 flex-1 overflow-hidden">
                                <div
                                    ref={tabStripRef}
                                    className="no-drag flex min-w-0 flex-shrink overflow-x-auto scrollbar-hidden items-center"
                                    style={{
                                        gap: 4,
                                        padding: "0 4px",
                                        borderRadius: 12,
                                        background: detachPreviewActive
                                            ? "color-mix(in srgb, var(--accent) 8%, transparent)"
                                            : draggingTabId
                                              ? "color-mix(in srgb, var(--bg-primary) 42%, transparent)"
                                              : "transparent",
                                        boxShadow: detachPreviewActive
                                            ? "inset 0 0 0 1px color-mix(in srgb, var(--accent) 24%, transparent)"
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
                                                title={tab.kind === "pdf" ? tab.title : tab.noteId}
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
                                                className={`group no-drag flex items-center gap-2 px-3 cursor-pointer ${
                                                    !isActive && !isDragging
                                                        ? "hover:bg-gray-500/10"
                                                        : ""
                                                }`}
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
                                                    opacity: isDragging
                                                        ? 0.95
                                                        : 1,
                                                    zIndex: isDragging ? 20 : 0,
                                                    transform: isDragging
                                                        ? `translateX(${dragOffsetX}px) scale(1.02)`
                                                        : undefined,
                                                    transition: isDragging
                                                        ? "none"
                                                        : "transform 250ms cubic-bezier(0.2, 0.8, 0.2, 1), background-color 150ms ease, color 150ms ease, border-color 150ms ease, box-shadow 150ms ease",
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
                                                {tab.kind === "pdf" && (
                                                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0 opacity-60">
                                                        <path d="M4 2h5l4 4v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z" />
                                                        <path d="M9 2v4h4" />
                                                    </svg>
                                                )}
                                                <span className="flex-1 truncate text-[12.5px] font-medium">
                                                    {tab.title}
                                                </span>
                                                <button
                                                    onClick={(event) => {
                                                        event.stopPropagation();
                                                        void handleCloseTab(
                                                            tab.id,
                                                        );
                                                    }}
                                                    className={`no-drag flex-shrink-0 rounded w-4 h-4 flex items-center justify-center transition-all ${
                                                        isActive
                                                            ? "opacity-60 hover:opacity-100 hover:bg-gray-500/18 active:bg-gray-500/28"
                                                            : "opacity-0 group-hover:opacity-55 hover:!opacity-100 hover:bg-gray-500/18 active:bg-gray-500/28"
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
                                        className="no-drag flex items-center justify-center hover:bg-gray-500/10 active:bg-gray-500/20 flex-shrink-0"
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
                                    className="min-w-[8px] flex-1"
                                />
                            </div>
                        </div>

                        <div
                            onMouseDown={startWindowDrag}
                            className="flex items-center justify-end flex-shrink-0"
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
                                            className="no-drag flex items-center justify-center hover:bg-gray-500/10 active:bg-gray-500/20 flex-shrink-0"
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
                                            className="no-drag flex items-center justify-center hover:bg-gray-500/10 active:bg-gray-500/20 flex-shrink-0"
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
                                            className="no-drag flex items-center justify-center hover:bg-gray-500/10 active:bg-gray-500/20 flex-shrink-0"
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
                        <div onMouseDown={startWindowDrag} className="flex-1" />
                        <div
                            onMouseDown={startWindowDrag}
                            className="flex items-center justify-end flex-shrink-0"
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
                                        className="no-drag flex items-center justify-center hover:bg-gray-500/10 active:bg-gray-500/20 flex-shrink-0"
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
                                        className="no-drag flex items-center justify-center hover:bg-gray-500/10 active:bg-gray-500/20 flex-shrink-0"
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
                                        className="no-drag flex items-center justify-center hover:bg-gray-500/10 active:bg-gray-500/20 flex-shrink-0"
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
                    if (!currentActiveTab) return null;
                    return (
                        <ContextMenu
                            menu={historyContextMenu}
                            onClose={() => setHistoryContextMenu(null)}
                            minWidth={160}
                            maxHeight={290}
                            entries={currentActiveTab.history
                                .slice(0, currentActiveTab.historyIndex)
                                .map((entry, idx) => ({
                                    label: entry.title || entry.noteId,
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
                        const filePath = isPdf
                            ? tab.path
                            : (useVaultStore
                                  .getState()
                                  .notes.find((note) => note.id === tab.noteId)
                                  ?.path ?? null);

                        const tabIndex = tabs.findIndex(
                            (entry) => entry.id === tab.id,
                        );

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
                            ...(!isPdf
                                ? [
                                      {
                                          label: "Reveal in Tree",
                                          action: () =>
                                              revealNoteInTree(tab.noteId),
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
                                        isPdf ? tab.path : tab.noteId,
                                    ),
                            },
                            ...(isPdf
                                ? [
                                      { type: "separator" as const },
                                      {
                                          label: "Add to Chat",
                                          action: () =>
                                              emitFileTreeNoteDrag({
                                                  phase: "attach",
                                                  x: 0,
                                                  y: 0,
                                                  notes: [],
                                                  files: [{
                                                      filePath: tab.path,
                                                      fileName: tab.title,
                                                      mimeType: "application/pdf",
                                                  }],
                                              }),
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
