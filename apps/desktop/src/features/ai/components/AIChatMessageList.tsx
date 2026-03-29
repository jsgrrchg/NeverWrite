import {
    memo,
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from "react";
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
    sessionId?: string | null;
    messages: AIChatMessage[];
    status: AIChatSessionStatus;
    hasOlderMessages?: boolean;
    isLoadingOlderMessages?: boolean;
    visibleWorkCycleId?: string | null;
    chatFontSize?: number;
    chatFontFamily?: EditorFontFamily;
    onLoadOlderMessages?: () => void;
    onPermissionResponse?: (requestId: string, optionId?: string) => void;
    onUserInputResponse?: (
        requestId: string,
        answers: Record<string, string[]>,
    ) => void;
}

type TimelineRow =
    | {
          key: string;
          kind: "message";
          message: AIChatMessage;
      }
    | {
          key: string;
          kind: "run-indicator";
          timestamp: number;
          active: boolean;
      };

const NEAR_BOTTOM_THRESHOLD = 80;
const LOAD_OLDER_THRESHOLD = 120;
const DETACHED_TIMELINE_SCOPE = "__detached_timeline__";
const RECENT_HISTORICAL_DIFF_WORK_CYCLE_LIMIT = 2;

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

function scopeTimelineRowKey(
    sessionId: string | null | undefined,
    rowKey: string,
) {
    return `${sessionId ?? DETACHED_TIMELINE_SCOPE}:${rowKey}`;
}

function deriveRecentHistoricalDiffWorkCycleIds(
    messages: AIChatMessage[],
    visibleWorkCycleId: string | null | undefined,
) {
    if (!visibleWorkCycleId) {
        return [];
    }

    const recentWorkCycleIds: string[] = [];
    const seen = new Set<string>([visibleWorkCycleId]);

    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i];
        const workCycleId = message.workCycleId;
        if (!workCycleId || !message.diffs?.length || seen.has(workCycleId)) {
            continue;
        }

        seen.add(workCycleId);
        recentWorkCycleIds.push(workCycleId);
        if (
            recentWorkCycleIds.length >=
            RECENT_HISTORICAL_DIFF_WORK_CYCLE_LIMIT
        ) {
            break;
        }
    }

    return recentWorkCycleIds;
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
                <span className="inline-flex items-baseline gap-0.75">
                    {[0, 1, 2].map((i) => (
                        <span
                            key={i}
                            className="inline-block h-1.25 w-1.25 rounded-full"
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

function deriveMessageListDecorations(
    messages: AIChatMessage[],
    active: boolean,
) {
    let pinnedPlan: AIChatMessage | null = null;
    let latestTurnStarted: AIChatMessage | null = null;
    let latestUserMessage: AIChatMessage | null = null;

    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i];

        if (!pinnedPlan && message.kind === "plan") {
            const entries = message.planEntries ?? [];
            const allDone =
                entries.length > 0 &&
                entries.every((entry) => entry.status === "completed");
            if (!allDone) {
                pinnedPlan = message;
            }
        }

        if (!active) {
            if (pinnedPlan) break;
            continue;
        }

        if (
            !latestTurnStarted &&
            message.kind === "status" &&
            message.meta?.status_event === "turn_started"
        ) {
            latestTurnStarted = message;
        }

        if (
            !latestUserMessage &&
            message.kind === "text" &&
            message.role === "user"
        ) {
            latestUserMessage = message;
        }

        if (pinnedPlan && (latestTurnStarted || latestUserMessage)) {
            break;
        }
    }

    const anchorMessage = active
        ? (latestTurnStarted ?? latestUserMessage)
        : null;
    const runIndicatorAnchor = anchorMessage
        ? {
              id: anchorMessage.id,
              timestamp: anchorMessage.timestamp,
          }
        : null;

    return {
        pinnedPlan,
        runIndicatorAnchor,
    };
}

function renderTimelineRow(
    row: TimelineRow,
    options: {
        sessionId?: string | null;
        pillMetrics: ReturnType<typeof getChatPillMetrics>;
        visibleWorkCycleId?: string | null;
        recentDiffWorkCycleIds?: string[];
        onPermissionResponse?: (requestId: string, optionId?: string) => void;
        onUserInputResponse?: (
            requestId: string,
            answers: Record<string, string[]>,
        ) => void;
    },
) {
    if (row.kind === "run-indicator") {
        return (
            <StreamingRunIndicator
                timestamp={row.timestamp}
                active={row.active}
            />
        );
    }

    return (
        <AIChatMessageItem
            sessionId={options.sessionId}
            message={row.message}
            pillMetrics={options.pillMetrics}
            visibleWorkCycleId={options.visibleWorkCycleId}
            recentDiffWorkCycleIds={options.recentDiffWorkCycleIds}
            onPermissionResponse={options.onPermissionResponse}
            onUserInputResponse={options.onUserInputResponse}
        />
    );
}

export const AIChatMessageList = memo(function AIChatMessageList({
    sessionId = null,
    messages,
    status,
    hasOlderMessages = false,
    isLoadingOlderMessages = false,
    visibleWorkCycleId = null,
    chatFontSize = 20,
    chatFontFamily = "system",
    onLoadOlderMessages,
    onPermissionResponse,
    onUserInputResponse,
}: AIChatMessageListProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const wasNearBottomRef = useRef(true);
    const pendingPrependAdjustmentRef = useRef<{
        previousScrollHeight: number;
        previousScrollTop: number;
    } | null>(null);
    const [showScrollButton, setShowScrollButton] = useState(false);
    const [contextMenu, setContextMenu] = useState<ContextMenuState<{
        hasSelection: boolean;
    }> | null>(null);
    const previousMessagesRef = useRef(messages);
    const previousStatusRef = useRef(status);

    const scrollToBottom = useCallback(() => {
        const container = containerRef.current;
        if (!container) return;
        container.scrollTop = container.scrollHeight;
        setShowScrollButton(false);
    }, []);

    const handleScroll = useCallback(() => {
        const container = containerRef.current;
        if (!container) return;

        const nearBottom = isNearBottom(container);
        wasNearBottomRef.current = nearBottom;
        if (nearBottom) {
            setShowScrollButton(false);
        } else {
            setShowScrollButton(true);
        }

        if (
            container.scrollTop <= LOAD_OLDER_THRESHOLD &&
            hasOlderMessages &&
            !isLoadingOlderMessages &&
            onLoadOlderMessages &&
            !pendingPrependAdjustmentRef.current
        ) {
            pendingPrependAdjustmentRef.current = {
                previousScrollHeight: container.scrollHeight,
                previousScrollTop: container.scrollTop,
            };
            onLoadOlderMessages();
        }
    }, [hasOlderMessages, isLoadingOlderMessages, onLoadOlderMessages]);

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
    const { pinnedPlan, runIndicatorAnchor } = useMemo(
        () => deriveMessageListDecorations(messages, status === "streaming"),
        [messages, status],
    );
    const recentDiffWorkCycleIds = useMemo(
        () =>
            deriveRecentHistoricalDiffWorkCycleIds(
                messages,
                visibleWorkCycleId,
            ),
        [messages, visibleWorkCycleId],
    );

    useLayoutEffect(() => {
        const container = containerRef.current;
        if (!container) return;
        const contentChanged =
            previousMessagesRef.current !== messages ||
            previousStatusRef.current !== status;
        if (!contentChanged) {
            return;
        }

        if (pendingPrependAdjustmentRef.current) {
            const { previousScrollHeight, previousScrollTop } =
                pendingPrependAdjustmentRef.current;
            pendingPrependAdjustmentRef.current = null;
            container.scrollTop =
                container.scrollHeight -
                previousScrollHeight +
                previousScrollTop;
            queueMicrotask(() => setShowScrollButton(true));
        } else if (wasNearBottomRef.current) {
            container.scrollTop = container.scrollHeight;
            queueMicrotask(() => setShowScrollButton(false));
        } else {
            const frameId = window.requestAnimationFrame(() => {
                setShowScrollButton(true);
            });

            previousMessagesRef.current = messages;
            previousStatusRef.current = status;

            return () => {
                window.cancelAnimationFrame(frameId);
            };
        }

        previousMessagesRef.current = messages;
        previousStatusRef.current = status;
    }, [messages, status]);

    useEffect(() => {
        if (isLoadingOlderMessages || !pendingPrependAdjustmentRef.current) {
            return;
        }

        const container = containerRef.current;
        if (!container) {
            pendingPrependAdjustmentRef.current = null;
            return;
        }

        if (
            container.scrollHeight <=
            pendingPrependAdjustmentRef.current.previousScrollHeight
        ) {
            pendingPrependAdjustmentRef.current = null;
        }
    }, [isLoadingOlderMessages, messages.length]);

    const timelineRows = useMemo(() => {
        const rows: TimelineRow[] = [];

        for (const message of messages) {
            if (message.kind === "plan" && message.id === pinnedPlan?.id) {
                continue;
            }

            rows.push({
                key: scopeTimelineRowKey(sessionId, message.id),
                kind: "message",
                message,
            });
        }

        if (runIndicatorAnchor) {
            rows.push({
                key: scopeTimelineRowKey(
                    sessionId,
                    `run-indicator:${runIndicatorAnchor.id}`,
                ),
                kind: "run-indicator",
                timestamp: runIndicatorAnchor.timestamp,
                active: status === "streaming",
            });
        }

        return rows;
    }, [messages, pinnedPlan?.id, runIndicatorAnchor, sessionId, status]);

    const rowRenderOptions = useMemo(
        () => ({
            sessionId,
            pillMetrics,
            visibleWorkCycleId,
            recentDiffWorkCycleIds,
            onPermissionResponse,
            onUserInputResponse,
        }),
        [
            onPermissionResponse,
            onUserInputResponse,
            pillMetrics,
            recentDiffWorkCycleIds,
            sessionId,
            visibleWorkCycleId,
        ],
    );

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
                        sessionId={sessionId}
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
                    {(hasOlderMessages || isLoadingOlderMessages) && (
                        <div
                            className="pb-2 text-center text-[11px]"
                            style={{
                                color: "var(--text-secondary)",
                                opacity: 0.78,
                            }}
                        >
                            {isLoadingOlderMessages
                                ? "Loading earlier messages..."
                                : "Scroll up to load earlier messages"}
                        </div>
                    )}
                    {timelineRows.map((row) => (
                        <div
                            key={row.key}
                            data-chat-row="true"
                            data-chat-row-key={row.key}
                        >
                            {renderTimelineRow(row, rowRenderOptions)}
                        </div>
                    ))}
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
