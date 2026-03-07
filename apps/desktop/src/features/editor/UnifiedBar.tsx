import { useCallback, type MouseEvent as ReactMouseEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
    ATTACH_EXTERNAL_TAB_EVENT,
    type AttachExternalTabPayload,
    createDetachedWindowPayload,
    findWindowTabDropTarget,
    getCurrentWindowLabel,
    isPointerOutsideCurrentWindow,
    openDetachedNoteWindow,
} from "../../app/detachedWindows";
import { useEditorStore } from "../../app/store/editorStore";
import { useLayoutStore } from "../../app/store/layoutStore";
import { useTabDragReorder } from "./useTabDragReorder";

const appWindow = getCurrentWindow();

function startWindowDrag(event: ReactMouseEvent<HTMLElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    void appWindow.startDragging().catch(() => {
        // Ignore denied / unsupported drag attempts and keep the bar interactive.
    });
}

interface UnifiedBarProps {
    windowMode: "main" | "note";
}

export function UnifiedBar({ windowMode }: UnifiedBarProps) {
    const { tabs, activeTabId, switchTab, closeTab, reorderTabs } =
        useEditorStore();
    const { sidebarCollapsed, toggleSidebar } = useLayoutStore();

    const handleDetachTab = useCallback(
        async (tabId: string, coords: { screenX: number; screenY: number }) => {
            const tab = tabs.find((item) => item.id === tabId);
            if (!tab) return;

            const targetWindowLabel = await findWindowTabDropTarget(
                coords.screenX,
                coords.screenY,
                getCurrentWindowLabel(),
            );

            if (targetWindowLabel) {
                await appWindow.emitTo(
                    targetWindowLabel,
                    ATTACH_EXTERNAL_TAB_EVENT,
                    { tab } satisfies AttachExternalTabPayload,
                );

                if (windowMode === "note" && tabs.length === 1) {
                    await appWindow.close();
                    return;
                }

                closeTab(tabId);
                return;
            }

            await openDetachedNoteWindow(createDetachedWindowPayload(tab), {
                title: tab.title,
            });

            if (windowMode === "note" && tabs.length === 1) {
                await appWindow.close();
                return;
            }

            closeTab(tabId);
        },
        [closeTab, tabs, windowMode],
    );

    const {
        dragOffsetX,
        draggingTabId,
        dragSession,
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
        onDetach: handleDetachTab,
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
            if (windowMode === "note" && tabs.length === 1) {
                await appWindow.close().catch((error) => {
                    console.error("No se pudo cerrar la ventana:", error);
                });
                return;
            }

            closeTab(tabId);
        },
        [closeTab, tabs.length, windowMode],
    );

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
                backgroundColor: "var(--bg-tertiary)",
                borderBottom: "1px solid var(--border)",
            }}
        >
            <div
                className="flex items-stretch select-none"
                style={{ height: 40, cursor: "default" }}
            >
                <div
                    onMouseDown={startWindowDrag}
                    style={{ width: 72, flexShrink: 0 }}
                />

                {windowMode === "main" && (
                    <button
                        onClick={toggleSidebar}
                        title={
                            sidebarCollapsed ? "Show sidebar" : "Hide sidebar"
                        }
                        className="no-drag flex items-center justify-center text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-gray-500/10 active:bg-gray-500/20 transition-all rounded-md flex-shrink-0"
                        style={{
                            width: 28,
                            height: 28,
                            alignSelf: "center",
                            marginLeft: 4,
                            marginRight: 4,
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
                )}

                {hasTabs ? (
                    <>
                        <div
                            onMouseDown={startWindowDrag}
                            style={{ width: 12, flexShrink: 0 }}
                        />

                        <div className="no-drag flex min-w-0 flex-1 overflow-hidden">
                            <div className="no-drag flex min-w-0 flex-1 overflow-hidden">
                                <div
                                    ref={tabStripRef}
                                    className="no-drag flex min-w-0 flex-shrink overflow-x-auto scrollbar-hidden"
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
                                                ref={(node) =>
                                                    registerTabNode(
                                                        tab.id,
                                                        node,
                                                    )
                                                }
                                                onClick={() =>
                                                    handleTabClick(tab.id)
                                                }
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
                                                    )
                                                }
                                                onPointerCancel={(event) =>
                                                    handlePointerUp(
                                                        event.pointerId,
                                                    )
                                                }
                                                onLostPointerCapture={(event) =>
                                                    handleLostPointerCapture(
                                                        event.pointerId,
                                                    )
                                                }
                                                className={`group no-drag flex items-center gap-2 px-3 py-1 cursor-pointer border-r transition-colors ${
                                                    !isActive && !isDragging
                                                        ? "hover:bg-gray-500/10"
                                                        : ""
                                                }`}
                                                style={{
                                                    minWidth: "120px",
                                                    maxWidth: "200px",
                                                    flexShrink:
                                                        isActive &&
                                                        visualTabs.length > 5
                                                            ? 0
                                                            : 1,
                                                    backgroundColor: isActive
                                                        ? "var(--bg-primary)"
                                                        : "transparent",
                                                    color: isActive
                                                        ? "var(--text-primary)"
                                                        : "var(--text-secondary)",
                                                    borderColor:
                                                        "var(--border)",
                                                    borderBottom: isActive
                                                        ? "2px solid var(--accent)"
                                                        : "2px solid transparent",
                                                    opacity: isDragging
                                                        ? 0.95
                                                        : 1,
                                                    zIndex: isDragging ? 20 : 0,
                                                    transform: isDragging
                                                        ? `translateX(${dragOffsetX}px) scale(1.02)`
                                                        : undefined,
                                                    transition: isDragging
                                                        ? "none"
                                                        : "transform 250ms cubic-bezier(0.2, 0.8, 0.2, 1), background-color 150ms ease, color 150ms ease, border-color 150ms ease",
                                                    boxShadow: isDragging
                                                        ? "0 10px 28px rgba(0, 0, 0, 0.2)"
                                                        : "none",
                                                    willChange: isDragging
                                                        ? "transform"
                                                        : undefined,
                                                }}
                                            >
                                                {tab.isDirty && (
                                                    <span
                                                        className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                                                        style={{
                                                            backgroundColor:
                                                                "var(--accent)",
                                                        }}
                                                    />
                                                )}
                                                <span className="flex-1 truncate text-[13px]">
                                                    {tab.title}
                                                </span>
                                                <button
                                                    onClick={(event) => {
                                                        event.stopPropagation();
                                                        void handleCloseTab(
                                                            tab.id,
                                                        );
                                                    }}
                                                    className={`no-drag flex-shrink-0 rounded-md w-5 h-5 flex items-center justify-center transition-all ${
                                                        isActive
                                                            ? "opacity-60 hover:opacity-100 hover:bg-gray-500/20 active:bg-gray-500/40"
                                                            : "opacity-0 group-hover:opacity-60 hover:!opacity-100 hover:bg-gray-500/20 active:bg-gray-500/40"
                                                    }`}
                                                >
                                                    <svg
                                                        width="12"
                                                        height="12"
                                                        viewBox="0 0 16 16"
                                                        fill="none"
                                                        stroke="currentColor"
                                                        strokeWidth="1.5"
                                                        strokeLinecap="round"
                                                        strokeLinejoin="round"
                                                    >
                                                        <path d="M4 4l8 8M4 12l8-8" />
                                                    </svg>
                                                </button>
                                            </div>
                                        );
                                    })}
                                </div>

                                <div
                                    onMouseDown={startWindowDrag}
                                    className="min-w-[24px] flex-1"
                                />
                            </div>
                        </div>

                        <div
                            onMouseDown={startWindowDrag}
                            className="flex-shrink-0"
                            style={{ width: 72 }}
                        />
                    </>
                ) : (
                    <div onMouseDown={startWindowDrag} className="flex-1" />
                )}
            </div>
        </div>
    );
}
