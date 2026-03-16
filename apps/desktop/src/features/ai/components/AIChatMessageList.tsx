import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AIChatMessageItem, PlanMessage } from "./AIChatMessageItem";
import {
    ContextMenu,
    type ContextMenuState,
} from "../../../components/context-menu/ContextMenu";
import type { EditorFontFamily } from "../../../app/store/settingsStore";
import type { AIChatMessage, AIChatSessionStatus } from "../types";
import { getChatPillMetrics } from "./chatPillMetrics";
import { getEditorFontFamily } from "../../editor/editorExtensions";

interface AIChatMessageListProps {
    messages: AIChatMessage[];
    status: AIChatSessionStatus;
    visibleWorkCycleId?: string | null;
    chatFontSize?: number;
    chatFontFamily?: EditorFontFamily;
    onPermissionResponse?: (requestId: string, optionId?: string) => void;
    onUserInputResponse?: (
        requestId: string,
        answers: Record<string, string[]>,
    ) => void;
}

const NEAR_BOTTOM_THRESHOLD = 80;

function isNearBottom(el: HTMLElement) {
    return (
        el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_THRESHOLD
    );
}

function formatElapsedRunTime(durationMs: number) {
    const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {
        return `${hours}h ${String(minutes).padStart(2, "0")}m`;
    }

    if (minutes > 0) {
        return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
    }

    return `${seconds}s`;
}

function StreamingRunIndicator({
    timestamp,
    active,
}: {
    timestamp: number;
    active: boolean;
}) {
    const [now, setNow] = useState(() => Date.now());
    const [frozenNow, setFrozenNow] = useState<number | null>(null);

    useEffect(() => {
        if (active) {
            const syncId = window.setTimeout(() => {
                setFrozenNow(null);
                setNow(Date.now());
            }, 0);
            const intervalId = window.setInterval(() => {
                setNow(Date.now());
            }, 1000);

            return () => {
                window.clearTimeout(syncId);
                window.clearInterval(intervalId);
            };
        }

        const syncId = window.setTimeout(() => {
            const stoppedAt = Date.now();
            setNow(stoppedAt);
            setFrozenNow(stoppedAt);
        }, 0);

        return () => {
            window.clearTimeout(syncId);
        };
    }, [active]);

    const endTime = active ? now : (frozenNow ?? now);

    return (
        <div
            className="inline-flex items-center gap-2 py-1"
            style={{
                color: "var(--text-secondary)",
                fontSize: "0.74em",
                lineHeight: 1.2,
                opacity: 0.78,
            }}
            data-testid="streaming-run-indicator"
        >
            {active ? (
                <span className="inline-flex items-baseline gap-[3px]">
                    {[0, 1, 2].map((i) => (
                        <span
                            key={i}
                            className="inline-block h-[5px] w-[5px] rounded-full"
                            style={{
                                backgroundColor: "var(--accent)",
                                opacity: 0.6,
                                animation: `ai-bounce 1.2s ease-in-out ${i * 0.15}s infinite`,
                            }}
                        />
                    ))}
                </span>
            ) : null}
            <span>{formatElapsedRunTime(endTime - timestamp)}</span>
        </div>
    );
}

function findLatestRunIndicatorAnchor(
    messages: AIChatMessage[],
    active: boolean,
) {
    // Only show the live indicator while actively streaming.
    // Elapsed time is stamped on the turn_started message when the turn ends.
    if (!active) {
        return null;
    }

    const latestTurnStarted = [...messages]
        .reverse()
        .find(
            (message) =>
                message.kind === "status" &&
                message.meta?.status_event === "turn_started",
        );

    if (latestTurnStarted) {
        return {
            id: latestTurnStarted.id,
            timestamp: latestTurnStarted.timestamp,
        };
    }

    const latestUserMessage = [...messages]
        .reverse()
        .find((message) => message.kind === "text" && message.role === "user");

    if (latestUserMessage) {
        return {
            id: latestUserMessage.id,
            timestamp: latestUserMessage.timestamp,
        };
    }

    return null;
}

export const AIChatMessageList = memo(function AIChatMessageList({
    messages,
    status,
    visibleWorkCycleId = null,
    chatFontSize = 20,
    chatFontFamily = "system",
    onPermissionResponse,
    onUserInputResponse,
}: AIChatMessageListProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const wasNearBottomRef = useRef(true);
    const [showScrollButton, setShowScrollButton] = useState(false);
    const [contextMenu, setContextMenu] = useState<ContextMenuState<{
        hasSelection: boolean;
    }> | null>(null);

    const scrollToBottom = useCallback(() => {
        const container = containerRef.current;
        if (!container) return;
        container.scrollTop = container.scrollHeight;
        setShowScrollButton(false);
    }, []);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        if (wasNearBottomRef.current) {
            container.scrollTop = container.scrollHeight;
            return;
        }

        const frameId = window.requestAnimationFrame(() => {
            setShowScrollButton(true);
        });

        return () => {
            window.cancelAnimationFrame(frameId);
        };
    }, [messages, status]);

    const handleScroll = useCallback(() => {
        const container = containerRef.current;
        if (!container) return;

        const nearBottom = isNearBottom(container);
        wasNearBottomRef.current = nearBottom;
        if (nearBottom) setShowScrollButton(false);
    }, []);

    const handleContextMenu = useCallback((event: React.MouseEvent) => {
        event.preventDefault();
        const selection = window.getSelection();
        const hasSelection = !!selection && !selection.isCollapsed;
        setContextMenu({
            x: event.clientX,
            y: event.clientY,
            payload: { hasSelection },
        });
    }, []);
    const pillMetrics = useMemo(
        () => getChatPillMetrics(chatFontSize),
        [chatFontSize],
    );
    const runIndicatorAnchor = useMemo(
        () => findLatestRunIndicatorAnchor(messages, status === "streaming"),
        [messages, status],
    );

    // Find the latest active plan message to pin above the scroll area.
    const pinnedPlan = useMemo(() => {
        for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i];
            if (m.kind !== "plan") continue;
            const entries = m.planEntries ?? [];
            const allDone =
                entries.length > 0 &&
                entries.every((e) => e.status === "completed");
            if (!allDone) return m;
        }
        return null;
    }, [messages]);

    return (
        <div className="relative min-h-0 min-w-0 flex-1 flex flex-col">
            {pinnedPlan && (
                <div
                    className="shrink-0 px-3 pt-2 pb-1"
                    style={{
                        borderBottom:
                            "1px solid color-mix(in srgb, var(--border) 60%, transparent)",
                    }}
                >
                    <PlanMessage
                        message={pinnedPlan}
                        pillMetrics={pillMetrics}
                    />
                </div>
            )}
            <div
                ref={containerRef}
                onScroll={handleScroll}
                onContextMenu={handleContextMenu}
                className="min-h-0 min-w-0 flex-1 overflow-y-auto px-3 py-3"
                data-scrollbar-active="true"
            >
                <div
                    className="flex min-w-0 flex-col gap-2"
                    data-selectable="true"
                    style={{
                        fontSize: chatFontSize,
                        fontFamily: getEditorFontFamily(chatFontFamily),
                    }}
                >
                    {messages.map((message) =>
                        message.kind === "plan" &&
                        message.id === pinnedPlan?.id ? null : (
                            <AIChatMessageItem
                                key={message.id}
                                message={message}
                                pillMetrics={pillMetrics}
                                visibleWorkCycleId={visibleWorkCycleId}
                                onPermissionResponse={onPermissionResponse}
                                onUserInputResponse={onUserInputResponse}
                            />
                        ),
                    )}
                    {runIndicatorAnchor ? (
                        <StreamingRunIndicator
                            key={runIndicatorAnchor.id}
                            timestamp={runIndicatorAnchor.timestamp}
                            active={status === "streaming"}
                        />
                    ) : null}
                </div>
            </div>
            {showScrollButton && (
                <button
                    type="button"
                    onClick={scrollToBottom}
                    className="absolute bottom-3 left-1/2 flex h-7 w-7 -translate-x-1/2 items-center justify-center rounded-full"
                    style={{
                        backgroundColor: "var(--bg-tertiary)",
                        border: "1px solid var(--border)",
                        color: "var(--text-secondary)",
                        boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
                    }}
                    aria-label="Scroll to bottom"
                >
                    <svg
                        width="14"
                        height="14"
                        viewBox="0 0 14 14"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    >
                        <path d="M7 3v8M3.5 7.5L7 11l3.5-3.5" />
                    </svg>
                </button>
            )}
            {contextMenu && (
                <ContextMenu
                    menu={contextMenu}
                    onClose={() => setContextMenu(null)}
                    entries={[
                        {
                            label: "Copy",
                            disabled: !contextMenu.payload.hasSelection,
                            action: () => {
                                const selection = window.getSelection();
                                if (selection && !selection.isCollapsed) {
                                    navigator.clipboard.writeText(
                                        selection.toString(),
                                    );
                                }
                            },
                        },
                    ]}
                />
            )}
        </div>
    );
});
