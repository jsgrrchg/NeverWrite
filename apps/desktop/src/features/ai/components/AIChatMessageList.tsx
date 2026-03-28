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
import { useDynamicVirtualList } from "../../../app/hooks/useDynamicVirtualList";
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
const TIMELINE_ROW_GAP = 8;
const VIRTUALIZATION_THRESHOLD = 80;
const PERSISTENT_TAIL_ROWS = 24;
const DETACHED_TIMELINE_SCOPE = "__detached_timeline__";

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

function estimateTextHeight(text: string, fontSize: number, charsPerLine = 56) {
    const lineHeight = Math.max(18, fontSize * 1.35);
    const normalized = text.trim();
    if (!normalized) {
        return lineHeight;
    }

    const explicitLines = normalized.split("\n");
    const estimatedWrappedLines = explicitLines.reduce((count, line) => {
        const wrapped = Math.max(1, Math.ceil(line.length / charsPerLine));
        return count + wrapped;
    }, 0);

    return estimatedWrappedLines * lineHeight;
}

function shouldShowDiffReview(
    message: AIChatMessage,
    visibleWorkCycleId?: string | null,
) {
    if (!message.diffs?.length) {
        return false;
    }

    if (!visibleWorkCycleId || !message.workCycleId) {
        return true;
    }

    return message.workCycleId === visibleWorkCycleId;
}

function estimateTimelineRowHeight(
    row: TimelineRow,
    chatFontSize: number,
    visibleWorkCycleId?: string | null,
) {
    if (row.kind === "run-indicator") {
        return 28;
    }

    const { message } = row;
    const textHeight = estimateTextHeight(message.content, chatFontSize);

    switch (message.kind) {
        case "thinking":
            return message.inProgress || message.content ? 44 : 30;
        case "tool": {
            if (message.diffs?.length) {
                if (shouldShowDiffReview(message, visibleWorkCycleId)) {
                    return message.diffs.length === 1
                        ? 300
                        : 180 + Math.min(message.diffs.length, 6) * 36;
                }
                return 80;
            }
            return 44 + Math.min(textHeight, chatFontSize * 5);
        }
        case "plan":
            return (
                92 +
                (message.planEntries?.length ?? 0) * 28 +
                (message.planDetail ? 48 : 0)
            );
        case "status":
            return message.meta?.status_event === "turn_started"
                ? 36
                : 40 + Math.min(textHeight, chatFontSize * 4);
        case "permission": {
            if (
                message.diffs?.length &&
                shouldShowDiffReview(message, visibleWorkCycleId)
            ) {
                return message.diffs.length === 1
                    ? 320
                    : 210 + Math.min(message.diffs.length, 6) * 38;
            }
            return 128 + Math.min(textHeight, chatFontSize * 6);
        }
        case "user_input_request":
            return 132 + (message.userInputQuestions?.length ?? 0) * 82;
        case "error":
            return 52 + Math.min(textHeight, chatFontSize * 4);
        case "text":
            return message.role === "user"
                ? 44 + Math.min(textHeight, chatFontSize * 10)
                : 28 + Math.min(textHeight, chatFontSize * 12);
        default:
            return 72;
    }
}

function renderTimelineRow(
    row: TimelineRow,
    options: {
        sessionId?: string | null;
        pillMetrics: ReturnType<typeof getChatPillMetrics>;
        visibleWorkCycleId?: string | null;
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
    const [containerWidth, setContainerWidth] = useState(0);
    const viewportAnchorRef = useRef<{
        key: string;
        offsetTop: number;
    } | null>(null);
    const previousMessagesRef = useRef(messages);
    const previousStatusRef = useRef(status);
    const previousHistorySizeRef = useRef(0);
    const previousContainerWidthRef = useRef<number | null>(null);

    const scrollToBottom = useCallback(() => {
        const container = containerRef.current;
        if (!container) return;
        container.scrollTop = container.scrollHeight;
        setShowScrollButton(false);
    }, []);

    const captureViewportAnchor = useCallback(() => {
        const container = containerRef.current;
        if (!container) return;

        const containerRect = container.getBoundingClientRect();
        const rows = Array.from(
            container.querySelectorAll<HTMLElement>("[data-chat-row-key]"),
        );
        const anchor =
            rows.find((row) => {
                const rect = row.getBoundingClientRect();
                return (
                    rect.bottom > containerRect.top &&
                    rect.top < containerRect.bottom
                );
            }) ?? rows[0];

        if (!anchor) {
            viewportAnchorRef.current = null;
            return;
        }

        viewportAnchorRef.current = {
            key: anchor.dataset.chatRowKey ?? "",
            offsetTop: anchor.getBoundingClientRect().top - containerRect.top,
        };
    }, []);

    const restoreViewportAnchor = useCallback(() => {
        const container = containerRef.current;
        const anchor = viewportAnchorRef.current;
        if (!container || !anchor.key) return false;

        const rows = Array.from(
            container.querySelectorAll<HTMLElement>("[data-chat-row-key]"),
        );
        const anchorNode =
            rows.find((row) => row.dataset.chatRowKey === anchor.key) ??
            rows[0] ??
            null;
        if (!anchorNode) return false;

        const containerRect = container.getBoundingClientRect();
        const nextOffset =
            anchorNode.getBoundingClientRect().top - containerRect.top;
        const delta = nextOffset - anchor.offsetTop;
        if (Math.abs(delta) > 0.5) {
            container.scrollTop += delta;
        }
        captureViewportAnchor();
        return true;
    }, [captureViewportAnchor]);

    const handleScroll = useCallback(() => {
        const container = containerRef.current;
        if (!container) return;

        const nearBottom = isNearBottom(container);
        wasNearBottomRef.current = nearBottom;
        if (nearBottom) {
            setShowScrollButton(false);
        } else {
            captureViewportAnchor();
        }

        if (
            container.scrollTop <= LOAD_OLDER_THRESHOLD &&
            hasOlderMessages &&
            !isLoadingOlderMessages &&
            onLoadOlderMessages
        ) {
            pendingPrependAdjustmentRef.current = {
                previousScrollHeight: container.scrollHeight,
                previousScrollTop: container.scrollTop,
            };
            onLoadOlderMessages();
        }
    }, [
        captureViewportAnchor,
        hasOlderMessages,
        isLoadingOlderMessages,
        onLoadOlderMessages,
    ]);

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

    const shouldVirtualize = timelineRows.length > VIRTUALIZATION_THRESHOLD;
    const persistentTailCount = shouldVirtualize
        ? Math.min(PERSISTENT_TAIL_ROWS, timelineRows.length)
        : timelineRows.length;
    const historyRows = shouldVirtualize
        ? timelineRows.slice(0, timelineRows.length - persistentTailCount)
        : [];
    const tailRows = shouldVirtualize
        ? timelineRows.slice(timelineRows.length - persistentTailCount)
        : timelineRows;

    const estimateRowSize = useCallback(
        (row: TimelineRow, _index: number) =>
            estimateTimelineRowHeight(row, chatFontSize, visibleWorkCycleId),
        [chatFontSize, visibleWorkCycleId],
    );

    const historyVirtual = useDynamicVirtualList({
        container: containerRef,
        items: historyRows,
        getItemKey: (row) => row.key,
        estimateSize: estimateRowSize,
        itemGap: TIMELINE_ROW_GAP,
        overscan: 8,
    });

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        const syncMetrics = () => {
            setContainerWidth(container.clientWidth);
        };

        syncMetrics();
        window.addEventListener("resize", syncMetrics);

        if (typeof ResizeObserver === "undefined") {
            return () => {
                window.removeEventListener("resize", syncMetrics);
            };
        }

        const observer = new ResizeObserver(() => {
            syncMetrics();
        });
        observer.observe(container);
        return () => {
            observer.disconnect();
            window.removeEventListener("resize", syncMetrics);
        };
    }, []);

    useLayoutEffect(() => {
        const container = containerRef.current;
        if (!container) {
            previousMessagesRef.current = messages;
            previousStatusRef.current = status;
            previousHistorySizeRef.current = historyVirtual.totalSize;
            previousContainerWidthRef.current = containerWidth;
            return;
        }

        const contentChanged =
            previousMessagesRef.current !== messages ||
            previousStatusRef.current !== status;
        const layoutChanged =
            previousHistorySizeRef.current !== historyVirtual.totalSize ||
            (previousContainerWidthRef.current !== null &&
                previousContainerWidthRef.current !== containerWidth);

        if (pendingPrependAdjustmentRef.current) {
            const { previousScrollHeight, previousScrollTop } =
                pendingPrependAdjustmentRef.current;
            pendingPrependAdjustmentRef.current = null;
            container.scrollTop =
                container.scrollHeight -
                previousScrollHeight +
                previousScrollTop;
            setShowScrollButton(true);
        } else if (
            wasNearBottomRef.current &&
            (contentChanged || layoutChanged)
        ) {
            container.scrollTop = container.scrollHeight;
            setShowScrollButton(false);
        } else if (layoutChanged) {
            restoreViewportAnchor();
            setShowScrollButton(true);
        } else if (contentChanged) {
            const frameId = window.requestAnimationFrame(() => {
                setShowScrollButton(true);
                captureViewportAnchor();
            });

            previousMessagesRef.current = messages;
            previousStatusRef.current = status;
            previousHistorySizeRef.current = historyVirtual.totalSize;
            previousContainerWidthRef.current = containerWidth;

            return () => {
                window.cancelAnimationFrame(frameId);
            };
        } else if (!wasNearBottomRef.current) {
            captureViewportAnchor();
        }

        previousMessagesRef.current = messages;
        previousStatusRef.current = status;
        previousHistorySizeRef.current = historyVirtual.totalSize;
        previousContainerWidthRef.current = containerWidth;
    }, [
        captureViewportAnchor,
        containerWidth,
        historyVirtual.totalSize,
        messages,
        restoreViewportAnchor,
        status,
    ]);

    const rowRenderOptions = useMemo(
        () => ({
            sessionId,
            pillMetrics,
            visibleWorkCycleId,
            onPermissionResponse,
            onUserInputResponse,
        }),
        [
            onPermissionResponse,
            onUserInputResponse,
            pillMetrics,
            sessionId,
            visibleWorkCycleId,
        ],
    );

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
                    className="min-w-0"
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
                    {historyRows.length > 0 && (
                        <div
                            style={{
                                height: historyVirtual.totalSize,
                                position: "relative",
                            }}
                            data-testid="chat-message-list-virtual-canvas"
                        >
                            {historyVirtual.items.map((row) => (
                                <div
                                    key={row.key}
                                    style={{
                                        position: "absolute",
                                        top: row.start,
                                        left: 0,
                                        right: 0,
                                    }}
                                >
                                    <div
                                        ref={historyVirtual.getMeasureRef(
                                            row.key,
                                        )}
                                        data-chat-row="true"
                                        data-chat-row-key={row.key}
                                        style={{
                                            marginBottom: TIMELINE_ROW_GAP,
                                        }}
                                    >
                                        {renderTimelineRow(
                                            row.item,
                                            rowRenderOptions,
                                        )}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                    <div className="flex min-w-0 flex-col gap-2">
                        {tailRows.map((row) => (
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
