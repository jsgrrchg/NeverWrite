import {
    useEffect,
    useRef,
    type MouseEvent as ReactMouseEvent,
} from "react";
import type { AgentSidebarStatus } from "../agentSidebarModel";
import type { AIChatSession } from "../types";
import { AIProviderIcon } from "./AIProviderIcon";

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
    cardMinHeight: number;
    cardRadius: number;
}

export interface AgentsSidebarItemDragCoordinates {
    clientX: number;
    clientY: number;
}

export interface AgentsSidebarItemProps {
    session: AIChatSession;
    title: string;
    timestampLabel: string;
    status?: AgentSidebarStatus;
    statusLabel?: string;
    variant?: "card" | "slim";
    isActive: boolean;
    isPinned: boolean;
    canPin?: boolean;
    canRename?: boolean;
    depth?: number;
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
    quickActionLabel?: string;
    onQuickAction?: () => void;
    secondaryActionLabel?: string;
    onSecondaryAction?: () => void;
    onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void;
    onDragStart?: (coords: AgentsSidebarItemDragCoordinates) => void;
    onDragMove?: (coords: AgentsSidebarItemDragCoordinates) => void;
    onDragEnd?: (coords: AgentsSidebarItemDragCoordinates) => void;
    onDragCancel?: () => void;
    metrics: AgentsSidebarItemMetrics;
}

const AGENT_SIDEBAR_DRAG_THRESHOLD_PX = 5;

function isInteractiveDragTarget(target: EventTarget | null, row: HTMLElement) {
    if (!(target instanceof Element)) return false;
    const interactive = target.closest(
        "button,input,textarea,select,a,[role='button']",
    );
    return Boolean(interactive && interactive !== row);
}

function safelySetPointerCapture(target: HTMLElement, pointerId: number) {
    try {
        target.setPointerCapture?.(pointerId);
    } catch {
        // A native release can race pointer capture during global dragging.
    }
}

function safelyReleasePointerCapture(
    target: HTMLElement | null,
    pointerId: number,
) {
    try {
        target?.releasePointerCapture?.(pointerId);
    } catch {
        // Global listeners still guarantee cleanup when capture is already gone.
    }
}

function statusColor(status: AgentSidebarStatus | undefined) {
    switch (status) {
        case "review":
        case "approval":
        case "input":
            return "var(--diff-warn, #d97706)";
        case "working":
            return "var(--accent)";
        case "failed":
            return "var(--diff-remove, #f43f5e)";
        case "done":
            return "var(--diff-add, #22c55e)";
        default:
            return "var(--text-secondary)";
    }
}

function PinIcon({ filled, size }: { filled: boolean; size: number }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill={filled ? "currentColor" : "none"}
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M9 3h6l-1 6 4 4v2H6v-2l4-4-1-6Z" />
            <path d="M12 15v6" />
        </svg>
    );
}

export function AgentsSidebarItem({
    session,
    title,
    timestampLabel,
    status = "ready",
    statusLabel,
    variant = "card",
    isActive,
    isPinned,
    canPin = true,
    canRename = true,
    depth = 0,
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
    quickActionLabel,
    onQuickAction,
    secondaryActionLabel,
    onSecondaryAction,
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

    useEffect(
        () => () => {
            const state = dragStateRef.current;
            dragStateRef.current = null;
            globalDragCleanupRef.current?.();
            globalDragCleanupRef.current = null;
            if (!state) return;
            safelyReleasePointerCapture(state.captureTarget, state.pointerId);
            if (state.active) dragCallbacksRef.current.onDragCancel?.();
        },
        [],
    );

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

    const suppressNextClick = () => {
        suppressClickRef.current = true;
        window.requestAnimationFrame(() => {
            suppressClickRef.current = false;
        });
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
        if (state.active) dragCallbacksRef.current.onDragCancel?.();
    };

    const processDragMove = (event: PointerEvent) => {
        const state = dragStateRef.current;
        if (!state || state.pointerId !== event.pointerId) return;
        const coords = { clientX: event.clientX, clientY: event.clientY };
        if (event.buttons === 0) {
            if (state.active) completeDrag(event.pointerId, coords);
            else clearDragSession();
            return;
        }
        if (!state.active) {
            if (
                Math.hypot(
                    event.clientX - state.startX,
                    event.clientY - state.startY,
                ) < AGENT_SIDEBAR_DRAG_THRESHOLD_PX
            ) {
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
        const onMove = (event: PointerEvent) => processDragMove(event);
        const onUp = (event: PointerEvent) =>
            completeDrag(event.pointerId, {
                clientX: event.clientX,
                clientY: event.clientY,
            });
        const onCancel = (event: PointerEvent) => cancelDrag(event.pointerId);
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
        window.addEventListener("pointercancel", onCancel);
        globalDragCleanupRef.current = () => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            window.removeEventListener("pointercancel", onCancel);
        };
    };

    const beginPointerDrag = (event: React.PointerEvent<HTMLDivElement>) => {
        if (
            isRenaming ||
            event.button !== 0 ||
            isInteractiveDragTarget(event.target, event.currentTarget)
        ) {
            return;
        }
        const previous = clearDragSession();
        if (previous?.active) dragCallbacksRef.current.onDragCancel?.();
        dragStateRef.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            active: false,
            captureTarget: event.currentTarget,
        };
        safelySetPointerCapture(event.currentTarget, event.pointerId);
        startGlobalDragTracking();
    };

    const handleKeyboardOpen = (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (isRenaming || event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onOpen();
        }
    };

    const commonProps = {
        role: "button",
        tabIndex: 0,
        title,
        "aria-current": isActive ? ("true" as const) : undefined,
        "data-testid": "agent-sidebar-item",
        "data-agent-session-id": session.sessionId,
        onClick: () => {
            if (!suppressClickRef.current && !isRenaming) onOpen();
        },
        onPointerDown: beginPointerDrag,
        onLostPointerCapture: (event: React.PointerEvent<HTMLDivElement>) => {
            const state = dragStateRef.current;
            if (!state || state.pointerId !== event.pointerId || event.buttons !== 0) {
                return;
            }
            const wasActive = state.active;
            clearDragSession();
            if (wasActive) dragCallbacksRef.current.onDragCancel?.();
        },
        onDoubleClick: (event: React.MouseEvent<HTMLDivElement>) => {
            if (isRenaming || !canRename) return;
            event.preventDefault();
            onStartRename();
        },
        onContextMenu,
        onKeyDown: handleKeyboardOpen,
    };

    const titleNode = isRenaming ? (
        <input
            ref={renameInputRef}
            autoFocus
            className="min-w-0 flex-1 rounded px-1 py-0.5 font-medium outline-none"
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
            className="min-w-0 flex-1 truncate font-medium"
            style={{ color: "var(--text-primary)", fontSize: metrics.titleFontSize }}
        >
            {title}
        </span>
    );

    const pinButton = canPin ? (
        <button
            type="button"
            title={isPinned ? "Unpin from sidebar" : "Pin to sidebar"}
            aria-label={isPinned ? "Unpin from sidebar" : "Pin to sidebar"}
            onClick={(event) => {
                event.stopPropagation();
                onTogglePin();
            }}
            className={`flex shrink-0 items-center justify-center rounded transition-opacity ${
                isPinned
                    ? "opacity-100"
                    : "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 focus:opacity-100"
            }`}
            style={{
                width: metrics.pinButtonSize,
                height: metrics.pinButtonSize,
                color: isPinned ? "var(--text-primary)" : "var(--text-secondary)",
            }}
        >
            <PinIcon filled={isPinned} size={metrics.pinIconSize} />
        </button>
    ) : null;

    const collapseButton = hasChildren ? (
        <button
            type="button"
            title={isCollapsed ? "Expand agents" : "Collapse agents"}
            aria-label={isCollapsed ? "Expand agents" : "Collapse agents"}
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
                style={{ transform: isCollapsed ? "rotate(-90deg)" : "none" }}
            >
                <path d="m4 6 4 4 4-4" />
            </svg>
        </button>
    ) : null;

    const quickAction = quickActionLabel && onQuickAction ? (
        <button
            type="button"
            className="rounded px-1.5 py-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 focus:opacity-100"
            style={{ color: "var(--text-secondary)", fontSize: metrics.timestampFontSize }}
            onClick={(event) => {
                event.stopPropagation();
                onQuickAction();
            }}
        >
            {quickActionLabel}
        </button>
    ) : null;
    const secondaryAction = secondaryActionLabel && onSecondaryAction ? (
        <button
            type="button"
            className="rounded px-1.5 py-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 focus:opacity-100"
            style={{ color: "var(--text-secondary)", fontSize: metrics.timestampFontSize }}
            onClick={(event) => {
                event.stopPropagation();
                onSecondaryAction();
            }}
        >
            {secondaryActionLabel}
        </button>
    ) : null;

    if (variant === "slim") {
        return (
            <div
                {...commonProps}
                className="group flex w-full cursor-pointer items-center rounded-md outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]"
                style={{
                    gap: metrics.inlineGap,
                    padding: `${metrics.rowPaddingY}px ${metrics.rowPaddingX}px`,
                    paddingLeft: metrics.rowPaddingLeft + depth * 14,
                    backgroundColor: isActive
                        ? "color-mix(in srgb, var(--accent) 14%, transparent)"
                        : "transparent",
                }}
            >
                <AIProviderIcon
                    runtimeId={session.runtimeId}
                    size={metrics.providerIconSize}
                    className="shrink-0 opacity-70"
                />
                {titleNode}
                {collapseButton}
                {pinButton}
                {quickAction}
                {secondaryAction}
                <span
                    className="shrink-0"
                    style={{
                        color: statusColor(status),
                        fontSize: metrics.timestampFontSize,
                        opacity: 0.82,
                    }}
                >
                    {statusLabel || timestampLabel}
                </span>
            </div>
        );
    }

    return (
        <div
            {...commonProps}
            className="group relative flex w-full cursor-pointer flex-col outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]"
            style={{
                minHeight: metrics.cardMinHeight,
                gap: metrics.inlineGap,
                padding: `${metrics.rowPaddingY * 1.5}px ${metrics.rowPaddingX}px`,
                marginLeft: depth * 10,
                width: depth > 0 ? `calc(100% - ${depth * 10}px)` : "100%",
                borderRadius: metrics.cardRadius,
                backgroundColor: isActive
                    ? "color-mix(in srgb, var(--accent) 24%, var(--bg-secondary))"
                    : "transparent",
                transition: "background-color 100ms ease, box-shadow 100ms ease",
            }}
        >
            <div className="flex min-h-4 items-center justify-end gap-1.5">
                <span
                    data-agent-status={status}
                    className="truncate text-right font-medium"
                    style={{
                        color: statusColor(status),
                        fontSize: metrics.timestampFontSize,
                        opacity: status === "ready" ? 0.72 : 0.95,
                    }}
                >
                    {statusLabel || timestampLabel}
                </span>
                {quickAction}
                {secondaryAction}
            </div>
            <div className="flex min-w-0 flex-1 items-center">{titleNode}</div>
            <div className="flex min-h-4 items-end justify-between gap-1">
                <div className="flex items-center gap-0.5">
                    {collapseButton}
                    {pinButton}
                </div>
                <AIProviderIcon
                    runtimeId={session.runtimeId}
                    size={metrics.providerIconSize}
                    className="shrink-0 opacity-80"
                />
            </div>
        </div>
    );
}
