import {
    useEffect,
    useRef,
    useState,
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
    /** Short form ("13m", "2h", "3d") for the card's context line. */
    compactTimestampLabel?: string;
    status?: AgentSidebarStatus;
    statusLabel?: string;
    /** Overrides the hue/glyph when the row's lifecycle outranks its status. */
    tone?: AgentSidebarTone;
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
    reorderScope?: string;
    dropPosition?: "before" | "after" | null;
    isKeyboardGrabbed?: boolean;
    onSortKeyboard?: (action: "toggle" | "up" | "down" | "cancel") => void;
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

// Snoozed rows advertise when they come BACK, not what they were doing, so
// the wake label owns a hue of its own instead of borrowing the status color.
export type AgentSidebarTone = AgentSidebarStatus | "snoozed";

// t3code's rows are anchored by a full-color project favicon. NeverWrite has
// no per-project mark, so the provider is the row's identity — brand hues let
// you pick a runtime out of a long list without reading a word. Scoped to the
// sidebar on purpose: tabs and the model picker keep the monochrome mark.
function providerBrandColor(runtimeId: string) {
    if (runtimeId.includes("claude")) return "#c77f68";
    if (runtimeId.includes("codex") || runtimeId.includes("openai")) {
        return "#3f927d";
    }
    if (runtimeId.includes("opencode")) return "#c18a32";
    if (runtimeId.includes("grok")) return "#64748b";
    if (runtimeId.includes("kilo")) return "#8068bd";
    return "var(--text-secondary)";
}

function statusColor(tone: AgentSidebarTone | undefined) {
    switch (tone) {
        case "review":
            return "var(--agent-status-review)";
        case "approval":
            return "var(--agent-status-approval)";
        case "input":
            return "var(--agent-status-input)";
        case "working":
            return "var(--agent-status-working)";
        case "failed":
            return "var(--agent-status-failed)";
        case "done":
            return "var(--agent-status-done)";
        case "snoozed":
            return "var(--agent-status-snoozed)";
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

function ClockIcon({ size }: { size: number }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <circle cx="8" cy="8" r="6" />
            <path d="M8 5.2v3l2 1.3" />
        </svg>
    );
}

function CheckCircleIcon({ size }: { size: number }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <circle cx="8" cy="8" r="6" />
            <path d="M5.4 8.2 7 9.8l3.6-4" />
        </svg>
    );
}

function WorkingIcon({ size }: { size: number }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
        >
            <circle cx="8" cy="8" r="6" strokeDasharray="2 2.6" />
        </svg>
    );
}

function AlarmIcon({ size }: { size: number }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <circle cx="8" cy="9" r="5" />
            <path d="M8 6.6v2.4l1.6 1M2.6 3.6l1.8-1.6M13.4 3.6l-1.8-1.6" />
        </svg>
    );
}

// A filled dot is the loudest a glyph gets without becoming an icon set:
// the attention states (review/approval/input/failed) all mean "blocked on
// you", so they share one shape and let the hue say which kind of blocked.
function AttentionDot({ size }: { size: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor">
            <circle cx="8" cy="8" r="3.4" />
        </svg>
    );
}

// Every state carries a glyph so the sidebar reads as color + shape rather
// than a column of grey text. Shapes are deliberately few: progress, done,
// rest, wake, and one shared dot for everything blocked on you.
function StatusGlyph({
    tone,
    size,
}: {
    tone: AgentSidebarTone | undefined;
    size: number;
}) {
    switch (tone) {
        case "working":
            return <WorkingIcon size={size} />;
        case "done":
            return <CheckCircleIcon size={size} />;
        case "ready":
            return <ClockIcon size={size} />;
        case "snoozed":
            return <AlarmIcon size={size} />;
        case "review":
        case "approval":
        case "input":
        case "failed":
            return <AttentionDot size={size} />;
        default:
            return null;
    }
}

export function AgentsSidebarItem({
    session,
    title,
    timestampLabel,
    compactTimestampLabel,
    status = "ready",
    statusLabel,
    tone,
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
    reorderScope,
    dropPosition = null,
    isKeyboardGrabbed = false,
    onSortKeyboard,
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
    const [cardActionsVisible, setCardActionsVisible] = useState(false);
    const hasChildren = childCount > 0;
    const statusIconSize = Math.max(9, Math.round(metrics.timestampFontSize + 1));
    const effectiveTone: AgentSidebarTone = tone ?? status;
    const toneColor = statusColor(effectiveTone);
    const brandColor = providerBrandColor(session.runtimeId);

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
        if (event.key === " " && onSortKeyboard) {
            event.preventDefault();
            onSortKeyboard("toggle");
        } else if (isKeyboardGrabbed && event.key === "ArrowUp") {
            event.preventDefault();
            onSortKeyboard?.("up");
        } else if (isKeyboardGrabbed && event.key === "ArrowDown") {
            event.preventDefault();
            onSortKeyboard?.("down");
        } else if (isKeyboardGrabbed && event.key === "Escape") {
            event.preventDefault();
            onSortKeyboard?.("cancel");
        } else if (event.key === "Enter") {
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
        "data-agent-reorder-scope": reorderScope,
        "data-agent-keyboard-grabbed": isKeyboardGrabbed || undefined,
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
        onMouseEnter: () => setCardActionsVisible(true),
        onMouseLeave: (event: React.MouseEvent<HTMLDivElement>) => {
            if (!event.currentTarget.contains(document.activeElement)) {
                setCardActionsVisible(false);
            }
        },
        onFocusCapture: (event: React.FocusEvent<HTMLDivElement>) => {
            if (event.target !== event.currentTarget) {
                setCardActionsVisible(true);
            }
        },
        onBlurCapture: (event: React.FocusEvent<HTMLDivElement>) => {
            const nextTarget = event.relatedTarget;
            if (
                !(nextTarget instanceof Node) ||
                !event.currentTarget.contains(nextTarget)
            ) {
                setCardActionsVisible(false);
            }
        },
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
            className={`min-w-0 flex-1 font-medium ${
                variant === "card" ? "line-clamp-2" : "truncate"
            }`}
            style={{
                color: "var(--text-primary)",
                fontSize: metrics.titleFontSize,
                lineHeight: 1.35,
            }}
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
                    : "opacity-0 group-hover/row:opacity-100 group-focus-visible/row:opacity-100 focus:opacity-100"
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
            className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 font-medium"
            style={{
                // The quick action is the row's one affirmative verb, so it
                // borrows the hue of the state it moves the thread into.
                color:
                    quickActionLabel === "Complete"
                        ? "var(--agent-status-done)"
                        : "var(--agent-status-snoozed)",
                fontSize: metrics.timestampFontSize,
            }}
            onClick={(event) => {
                event.stopPropagation();
                onQuickAction();
            }}
        >
            {quickActionLabel === "Complete" ? (
                <CheckCircleIcon size={statusIconSize} />
            ) : (
                <AlarmIcon size={statusIconSize} />
            )}
            {quickActionLabel}
        </button>
    ) : null;
    const secondaryAction = secondaryActionLabel && onSecondaryAction ? (
        <button
            type="button"
            className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded px-1.5 py-0.5"
            style={{ color: "var(--text-secondary)", fontSize: metrics.timestampFontSize }}
            onClick={(event) => {
                event.stopPropagation();
                onSecondaryAction();
            }}
        >
            {secondaryActionLabel}
        </button>
    ) : null;

    const hasHoverActions = Boolean(quickAction || secondaryAction);

    // Nothing in the row may change size or position on hover. Swapping the
    // status label for the actions inside a shared in-flow slot reflowed every
    // neighbour and made the list wobble under the pointer, so the actions
    // live in an absolutely positioned overlay instead: they fade in over
    // reserved space and the text underneath never moves.
    const statusInline = effectiveTone === "ready" ? null : (
        <span
            data-agent-status={status}
            className="inline-flex shrink-0 items-center gap-1 font-medium"
            style={{
                color: toneColor,
                fontSize: metrics.timestampFontSize,
            }}
        >
            <StatusGlyph tone={effectiveTone} size={statusIconSize} />
            {statusLabel || timestampLabel}
        </span>
    );

    // focus-visible rather than focus-within: a click leaves the button
    // focused, and focus-within would keep the actions pinned open once the
    // pointer moves away instead of fading back out.
    const actionsOverlayClassName =
        "pointer-events-none absolute flex items-center gap-0.5 opacity-0 transition-opacity has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:opacity-100 group-hover/row:pointer-events-auto group-hover/row:opacity-100";

    const cardActionSlot = hasHoverActions ? (
        <span
            className="flex items-center gap-0.5 transition-opacity"
            style={{
                opacity: cardActionsVisible ? 1 : 0,
                pointerEvents: cardActionsVisible ? "auto" : "none",
            }}
        >
            {quickAction}
            {secondaryAction}
        </span>
    ) : null;

    const cardControls = (
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
            {pinButton}
            {cardActionSlot}
        </span>
    );

    if (variant === "slim") {
        return (
            <div
                {...commonProps}
                className={`group/row relative flex w-full cursor-pointer items-center rounded-md outline-none transition-colors duration-100 focus-visible:ring-1 focus-visible:ring-[var(--accent)] ${
                    isActive
                        ? "bg-[color-mix(in_srgb,var(--accent)_16%,transparent)]"
                        : "bg-transparent hover:bg-[color-mix(in_srgb,var(--text-primary)_6%,transparent)]"
                }`}
                style={{
                    gap: metrics.inlineGap,
                    padding: `${metrics.rowPaddingY}px ${metrics.rowPaddingX}px`,
                    paddingLeft: metrics.rowPaddingLeft + depth * 14,
                    borderTop: dropPosition === "before" ? "2px solid var(--accent)" : "2px solid transparent",
                    borderBottom: dropPosition === "after" ? "2px solid var(--accent)" : "2px solid transparent",
                }}
            >
                <span className="flex shrink-0" style={{ color: brandColor }}>
                    <AIProviderIcon
                        runtimeId={session.runtimeId}
                        size={metrics.providerIconSize}
                        className="shrink-0"
                    />
                </span>
                {titleNode}
                {collapseButton}
                {pinButton}
                <span
                    className="ml-auto flex shrink-0 items-center transition-opacity"
                    // The overlay covers this slot, so the label fades rather
                    // than yielding its box — fading costs no layout.
                    style={{ opacity: hasHoverActions ? undefined : 1 }}
                >
                    <span
                        className={
                            hasHoverActions
                                ? "transition-opacity group-hover/row:opacity-0"
                                : undefined
                        }
                    >
                        {statusInline}
                    </span>
                </span>
                {hasHoverActions ? (
                    <span
                        className={`${actionsOverlayClassName} inset-y-0 right-0`}
                        style={{ paddingRight: metrics.rowPaddingX }}
                    >
                        {quickAction}
                        {secondaryAction}
                    </span>
                ) : null}
            </div>
        );
    }

    return (
        <div
            {...commonProps}
            className={`group/row relative flex w-full cursor-pointer flex-col justify-start outline-none transition-colors duration-100 focus-visible:ring-1 focus-visible:ring-[var(--accent)] ${
                isActive
                    ? "bg-[color-mix(in_srgb,var(--accent)_16%,transparent)]"
                    : "bg-transparent hover:bg-[color-mix(in_srgb,var(--text-primary)_6%,transparent)]"
            }`}
            style={{
                minHeight: metrics.cardMinHeight,
                gap: metrics.inlineGap,
                padding: `${metrics.rowPaddingY * 1.5}px ${metrics.rowPaddingX}px`,
                marginLeft: depth * 10,
                width: depth > 0 ? `calc(100% - ${depth * 10}px)` : "100%",
                borderRadius: metrics.cardRadius,
                borderTop: dropPosition === "before" ? "2px solid var(--accent)" : "2px solid transparent",
                borderBottom: dropPosition === "after" ? "2px solid var(--accent)" : "2px solid transparent",
            }}
        >
            {/* Context line: provider identity and how long since it moved. */}
            <div className="flex min-h-4 items-center gap-1.5">
                <span className="flex shrink-0" style={{ color: brandColor }}>
                    <AIProviderIcon
                        runtimeId={session.runtimeId}
                        size={metrics.providerIconSize}
                        className="shrink-0"
                    />
                </span>
                <span className="min-w-0 flex-1" />
                {cardControls}
            </div>
            <div className="flex min-w-0 items-start">{titleNode}</div>
            <div className="flex min-h-4 items-center gap-1.5">
                <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
                    {collapseButton}
                    {statusInline}
                    {hasChildren ? (
                        <span
                            className="shrink-0 rounded px-1"
                            style={{
                                color: "var(--text-secondary)",
                                backgroundColor:
                                    "color-mix(in srgb, var(--text-primary) 8%, transparent)",
                                fontSize: metrics.timestampFontSize,
                            }}
                        >
                            {childCount === 1 ? "1 agent" : `${childCount} agents`}
                        </span>
                    ) : null}
                </span>
                <span
                    className="ml-auto shrink-0 tabular-nums"
                    style={{
                        color: "var(--text-secondary)",
                        fontSize: metrics.timestampFontSize,
                        opacity: 0.85,
                    }}
                >
                    {compactTimestampLabel ?? timestampLabel}
                </span>
            </div>
        </div>
    );
}
