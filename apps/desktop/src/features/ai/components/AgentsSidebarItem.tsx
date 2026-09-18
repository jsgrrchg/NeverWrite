import {
    useEffect,
    useRef,
    type MouseEvent as ReactMouseEvent,
} from "react";
import { AIProviderIcon } from "./AIProviderIcon";
import type { AIChatSession } from "../types";
import { getRuntimeDisplayName } from "../utils/runtimeMetadata";

// A conversation card keeps its title separate from provider and activity.

export type AgentsSidebarActivityIndicator = {
    readonly tone: "working" | "danger";
    readonly title: string;
} | null;

export interface AgentsSidebarItemMetrics {
    rowPaddingX: number;
    rowPaddingLeft: number;
    rowPaddingY: number;
    inlineGap: number;
    titleFontSize: number;
    timestampFontSize: number;
    providerIconSize: number;
    pinButtonSize: number;
    pinIconSize: number;
}

export interface AgentsSidebarItemDragCoordinates {
    clientX: number;
    clientY: number;
}

export interface AgentsSidebarItemProps {
    session: AIChatSession;
    title: string;
    timestampLabel: string;
    isActive: boolean;
    isPinned: boolean;
    isArchived?: boolean;
    compact?: boolean;
    isUnread?: boolean;
    onToggleArchive?: () => void;
    canPin?: boolean;
    canRename?: boolean;
    depth?: number;
    indicator: AgentsSidebarActivityIndicator;
    childCount?: number;
    isCollapsed?: boolean;
    isRenaming: boolean;
    renameValue: string;
    onRenameChange: (value: string) => void;
    onRenameCommit: () => void;
    onRenameCancel: () => void;
    renameInputRef: React.RefObject<HTMLInputElement | null>;
    onOpen: () => void;
    onStartRename: () => void;
    onTogglePin: () => void;
    onToggleCollapse?: () => void;
    onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void;
    onDragStart?: (coords: AgentsSidebarItemDragCoordinates) => void;
    onDragMove?: (coords: AgentsSidebarItemDragCoordinates) => void;
    onDragEnd?: (coords: AgentsSidebarItemDragCoordinates) => void;
    onDragCancel?: () => void;
    metrics: AgentsSidebarItemMetrics;
}

function isInteractiveDragTarget(
    target: EventTarget | null,
    row: HTMLElement,
) {
    if (!(target instanceof Element)) return false;
    const interactive = target.closest(
        "button,input,textarea,select,a,[role='button']",
    );
    return Boolean(interactive && interactive !== row);
}

const AGENT_SIDEBAR_DRAG_THRESHOLD_PX = 5;

function toDragCoordinates(event: PointerEvent) {
    return {
        clientX: event.clientX,
        clientY: event.clientY,
    };
}

function safelySetPointerCapture(target: HTMLElement, pointerId: number) {
    try {
        target.setPointerCapture?.(pointerId);
    } catch {
        // Pointer capture can fail if the pointer was already released.
    }
}

function safelyReleasePointerCapture(
    target: HTMLElement | null,
    pointerId: number,
) {
    try {
        target?.releasePointerCapture?.(pointerId);
    } catch {
        // The pointer may no longer be captured; global listeners still clean up.
    }
}

export function AgentsSidebarItem({
    session,
    title,
    timestampLabel,
    isActive,
    isPinned,
    isArchived = false,
    compact = false,
    onToggleArchive,
    canPin = true,
    canRename = true,
    depth = 0,
    indicator,
    isUnread = false,
    childCount = 0,
    isCollapsed = false,
    isRenaming,
    renameValue,
    onRenameChange,
    onRenameCommit,
    onRenameCancel,
    renameInputRef,
    onOpen,
    onStartRename,
    onTogglePin,
    onToggleCollapse,
    onContextMenu,
    onDragStart,
    onDragMove,
    onDragEnd,
    onDragCancel,
    metrics,
}: AgentsSidebarItemProps) {
    const dragStateRef = useRef<{
        pointerId: number;
        startX: number;
        startY: number;
        active: boolean;
        captureTarget: HTMLElement | null;
    } | null>(null);
    const dragCallbacksRef = useRef({
        onDragStart,
        onDragMove,
        onDragEnd,
        onDragCancel,
    });
    const globalDragCleanupRef = useRef<(() => void) | null>(null);
    const suppressClickRef = useRef(false);
    const hasChildren = childCount > 0;
    useEffect(() => {
        dragCallbacksRef.current = {
            onDragStart,
            onDragMove,
            onDragEnd,
            onDragCancel,
        };
    }, [onDragStart, onDragMove, onDragEnd, onDragCancel]);

    useEffect(() => {
        return () => {
            const state = dragStateRef.current;
            dragStateRef.current = null;
            globalDragCleanupRef.current?.();
            globalDragCleanupRef.current = null;
            if (!state) return;

            safelyReleasePointerCapture(state.captureTarget, state.pointerId);
            if (state.active) {
                dragCallbacksRef.current.onDragCancel?.();
            }
        };
    }, []);

    const suppressNextClick = () => {
        suppressClickRef.current = true;
        window.requestAnimationFrame(() => {
            suppressClickRef.current = false;
        });
    };

    const clearDragSession = () => {
        const state = dragStateRef.current;
        dragStateRef.current = null;
        globalDragCleanupRef.current?.();
        globalDragCleanupRef.current = null;
        if (state) {
            safelyReleasePointerCapture(state.captureTarget, state.pointerId);
        }
        return state;
    };

    const completeDrag = (
        pointerId: number,
        coords: AgentsSidebarItemDragCoordinates,
    ) => {
        const state = dragStateRef.current;
        if (!state || state.pointerId !== pointerId) return;

        clearDragSession();
        if (!state.active) return;

        suppressNextClick();
        dragCallbacksRef.current.onDragEnd?.(coords);
    };

    const cancelDrag = (pointerId: number) => {
        const state = dragStateRef.current;
        if (!state || state.pointerId !== pointerId) return;

        clearDragSession();
        if (state.active) {
            dragCallbacksRef.current.onDragCancel?.();
        }
    };

    const processDragMove = (event: PointerEvent) => {
        const state = dragStateRef.current;
        if (!state || state.pointerId !== event.pointerId) return;

        const coords = toDragCoordinates(event);

        if (event.buttons === 0) {
            if (state.active) {
                completeDrag(event.pointerId, coords);
            } else {
                clearDragSession();
            }
            return;
        }

        if (!state.active) {
            const dx = event.clientX - state.startX;
            const dy = event.clientY - state.startY;
            if (Math.hypot(dx, dy) < AGENT_SIDEBAR_DRAG_THRESHOLD_PX) {
                return;
            }

            state.active = true;
            dragCallbacksRef.current.onDragStart?.(coords);
        }

        event.preventDefault();
        dragCallbacksRef.current.onDragMove?.(coords);
    };

    const startGlobalDragTracking = () => {
        globalDragCleanupRef.current?.();

        const handlePointerMove = (event: PointerEvent) => {
            processDragMove(event);
        };
        const handlePointerUp = (event: PointerEvent) => {
            completeDrag(event.pointerId, toDragCoordinates(event));
        };
        const handlePointerCancel = (event: PointerEvent) => {
            cancelDrag(event.pointerId);
        };

        window.addEventListener("pointermove", handlePointerMove);
        window.addEventListener("pointerup", handlePointerUp);
        window.addEventListener("pointercancel", handlePointerCancel);
        globalDragCleanupRef.current = () => {
            window.removeEventListener("pointermove", handlePointerMove);
            window.removeEventListener("pointerup", handlePointerUp);
            window.removeEventListener("pointercancel", handlePointerCancel);
        };
    };

    const isCompact = compact || isArchived;

    return (
        <div
            role="button"
            aria-current={isActive ? "true" : undefined}
            tabIndex={0}
            data-testid="agent-sidebar-item"
            title={title}
            aria-label={title}
            className={`group flex w-full cursor-pointer items-center focus-visible:outline-2 focus-visible:outline-(--accent) ${
                isCompact ? "flex-nowrap rounded-md" : "flex-wrap rounded-lg"
            }`}
            style={{
                columnGap: metrics.inlineGap,
                rowGap: isCompact ? 0 : 4,
                minHeight: isCompact ? metrics.titleFontSize * 3 : undefined,
                border: isCompact ? "1px solid transparent" : "1px solid var(--border)",
                padding: `${isCompact ? 4 : metrics.rowPaddingY}px ${metrics.rowPaddingX}px`,
                paddingLeft: metrics.rowPaddingLeft + depth * 24,
                backgroundColor: isActive
                    ? "color-mix(in srgb, var(--accent) 14%, transparent)"
                    : "transparent",
                transition:
                    "background-color 100ms ease, color 100ms ease",
            }}
            onClick={() => {
                if (suppressClickRef.current) return;
                if (isRenaming) return;
                onOpen();
            }}
            onPointerDown={(event) => {
                if (
                    isRenaming ||
                    (event.button ?? 0) !== 0 ||
                    isInteractiveDragTarget(event.target, event.currentTarget)
                ) {
                    return;
                }

                const previousState = clearDragSession();
                if (previousState?.active) {
                    dragCallbacksRef.current.onDragCancel?.();
                }

                dragStateRef.current = {
                    pointerId: event.pointerId,
                    startX: event.clientX,
                    startY: event.clientY,
                    active: false,
                    captureTarget: event.currentTarget,
                };
                safelySetPointerCapture(event.currentTarget, event.pointerId);
                startGlobalDragTracking();
            }}
            onLostPointerCapture={(event) => {
                const state = dragStateRef.current;
                if (!state || state.pointerId !== event.pointerId) {
                    return;
                }

                if (event.buttons !== 0) {
                    return;
                }

                const wasActive = state.active;
                clearDragSession();
                if (wasActive) {
                    dragCallbacksRef.current.onDragCancel?.();
                }
            }}
            onDoubleClick={(event) => {
                if (isRenaming || !canRename) return;
                event.preventDefault();
                onStartRename();
            }}
            onContextMenu={onContextMenu}
            onKeyDown={(event) => {
                if (isRenaming || event.target !== event.currentTarget) return;
                if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onOpen();
                }
            }}
            onMouseEnter={(event) => {
                if (isActive) return;
                event.currentTarget.style.backgroundColor =
                    "color-mix(in srgb, var(--bg-tertiary) 65%, transparent)";
            }}
            onMouseLeave={(event) => {
                if (isActive) return;
                event.currentTarget.style.backgroundColor = "transparent";
            }}
        >
            {isCompact && (
                <span
                    className={`shrink-0 transition-opacity ${isActive ? "opacity-100" : "opacity-40 group-hover:opacity-100 group-focus-within:opacity-100"}`}
                    title={getRuntimeDisplayName(session.runtimeId)}
                >
                    <AIProviderIcon runtimeId={session.runtimeId} size={metrics.providerIconSize} />
                </span>
            )}
            {isRenaming ? (
                    <input
                        ref={renameInputRef}
                        autoFocus
                        className="min-w-0 flex-1 rounded px-1 py-0.5 text-[11.5px] font-medium outline-none"
                        style={{
                            background: "var(--bg-primary)",
                            color: "var(--text-primary)",
                            border: "1px solid var(--accent)",
                            fontSize: metrics.titleFontSize,
                        }}
                        value={renameValue}
                        onClick={(event) => event.stopPropagation()}
                        onChange={(event) => onRenameChange(event.target.value)}
                        onBlur={onRenameCommit}
                        onKeyDown={(event) => {
                            event.stopPropagation();
                            if (event.key === "Enter") {
                                event.preventDefault();
                                onRenameCommit();
                            } else if (event.key === "Escape") {
                                event.preventDefault();
                                onRenameCancel();
                            }
                        }}
                    />
                ) : (
                    <span
                        className={`min-w-0 flex-1 truncate text-[11.5px] font-medium ${isArchived && !isActive ? "opacity-60 group-hover:opacity-100 group-focus-within:opacity-100" : ""}`}
                        style={{
                            color: "var(--text-primary)",
                            fontSize: metrics.titleFontSize,
                        }}
                    >
                        {title}
                    </span>
                )}

            {isUnread && (
                <span
                    role="img"
                    aria-label="Turn completed, unread"
                    title="Turn completed, unread"
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: "var(--accent)" }}
                />
            )}

            {/* Keep provider marks aligned; expansion is a row action, not a
                leading tree gutter. */}
            {hasChildren ? (
                <button
                    type="button"
                    title={isCollapsed ? "Expand agents" : "Collapse agents"}
                    aria-label={
                        isCollapsed ? "Expand agents" : "Collapse agents"
                    }
                    onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        onToggleCollapse?.();
                    }}
                    className="flex shrink-0 items-center justify-center rounded"
                    style={{
                        width: metrics.pinButtonSize,
                        height: metrics.pinButtonSize,
                        color: "var(--text-secondary)",
                        background: "transparent",
                    }}
                >
                    <svg
                        width={metrics.pinIconSize}
                        height={metrics.pinIconSize}
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        style={{
                            transform: isCollapsed
                                ? "rotate(-90deg)"
                                : "rotate(0)",
                            transition: "transform 120ms ease",
                        }}
                    >
                        <path d="m4 6 4 4 4-4" />
                    </svg>
                </button>
            ) : canPin ? (
                <span
                    aria-hidden
                    className="shrink-0"
                    style={{
                        width: metrics.pinButtonSize,
                        height: metrics.pinButtonSize,
                    }}
                />
            ) : null}

            {onToggleArchive && !isArchived && <button type="button" aria-label={isArchived ? "Unarchive chat" : "Archive chat"} title={isArchived ? "Unarchive chat" : "Archive chat"} className="shrink-0 rounded opacity-0 group-hover:opacity-100 focus:opacity-100" onClick={event => { event.stopPropagation(); onToggleArchive(); }}>
                <svg width={metrics.pinIconSize} height={metrics.pinIconSize} viewBox="0 0 16 16" fill="none" stroke="currentColor"><path d="M2 3h12v3H2zM3 6v7h10V6M6 9h4" /></svg>
            </button>}
            {canPin ? (
                    <button
                        type="button"
                        title={
                            isPinned ? "Unpin from sidebar" : "Pin to sidebar"
                        }
                        aria-label={
                            isPinned ? "Unpin from sidebar" : "Pin to sidebar"
                        }
                        onClick={(event) => {
                            event.stopPropagation();
                            onTogglePin();
                        }}
                        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded transition-opacity ${
                            isPinned
                                ? "opacity-100"
                                : "opacity-0 group-hover:opacity-100 focus:opacity-100"
                        }`}
                        style={{
                            width: metrics.pinButtonSize,
                            height: metrics.pinButtonSize,
                            color: isPinned
                                ? "var(--text-primary)"
                                : "var(--text-secondary)",
                        }}
                    >
                        <svg
                            width={metrics.pinIconSize}
                            height={metrics.pinIconSize}
                            viewBox="0 0 24 24"
                            fill={isPinned ? "currentColor" : "none"}
                            stroke="currentColor"
                            strokeWidth="1.7"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        >
                            <path d="M9 3h6l-1 6 4 4v2H6v-2l4-4-1-6Z" />
                            <path d="M12 15v6" />
                        </svg>
                    </button>
                ) : null}

            {isCompact && !isArchived ? (
                <span
                    className="shrink-0"
                    title={indicator?.title}
                    style={{
                        fontSize: metrics.timestampFontSize,
                        color: indicator?.tone === "danger"
                            ? "var(--diff-remove)"
                            : indicator?.tone === "working"
                              ? "var(--diff-warn)"
                              : "var(--text-secondary)",
                    }}
                >
                    {indicator?.tone === "working" ? "Working…" : indicator?.tone === "danger" ? "Error" : timestampLabel}
                </span>
            ) : isArchived ? (
                <span className="grid shrink-0 items-center" style={{ fontSize: metrics.timestampFontSize }}>
                    <span
                        className={`col-start-1 row-start-1 text-right ${onToggleArchive ? "group-hover:opacity-0 group-focus-within:opacity-0" : ""}`}
                        style={{ color: "var(--text-secondary)" }}
                    >
                        {timestampLabel}
                    </span>
                    {onToggleArchive && (
                        <button
                            type="button"
                            aria-label="Unarchive chat"
                            title="Unarchive chat"
                            className="pointer-events-none col-start-1 row-start-1 flex items-center gap-1 rounded px-1 py-0.5 opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100"
                            style={{ background: "var(--bg-tertiary)", color: "var(--text-secondary)" }}
                            onClick={(event) => {
                                event.stopPropagation();
                                onToggleArchive();
                            }}
                        >
                            <svg width={metrics.pinIconSize} height={metrics.pinIconSize} viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true">
                                <path d="M2 3h12v3H2zM3 6v7h10V6M8 11V7m-2 2 2-2 2 2" />
                            </svg>
                            Unarchive
                        </button>
                    )}
                </span>
            ) : (
            <div className="flex w-full min-w-0 items-center gap-1.5" style={{ color: "var(--text-secondary)", fontSize: metrics.timestampFontSize }}>
                <AIProviderIcon runtimeId={session.runtimeId} size={metrics.providerIconSize} />
                <span className="min-w-0 flex-1 truncate">{getRuntimeDisplayName(session.runtimeId)}</span>
            <span
                className="shrink-0 text-[10px]"
                title={indicator?.title}
                style={{
                    color:
                        indicator?.tone === "danger"
                            ? "var(--diff-remove, #f43f5e)"
                            : indicator?.tone === "working"
                              ? "var(--diff-warn, #d97706)"
                              : "var(--text-secondary)",
                    fontSize: metrics.timestampFontSize,
                    opacity: 0.8,
                }}
            >
                {indicator?.tone === "working"
                    ? "Working…"
                    : indicator?.tone === "danger"
                      ? "Error"
                      : timestampLabel}
            </span>
            </div>
            )}
        </div>
    );
}
