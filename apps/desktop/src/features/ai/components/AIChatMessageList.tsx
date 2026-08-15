import {
    memo,
    useCallback,
    useEffect,
    useId,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import { AIChatMessageItem, PlanMessage } from "./AIChatMessageItem";
import { ToolActivitySegment } from "./ToolActivitySegment";
import {
    ContextMenu,
    type ContextMenuState,
} from "../../../components/context-menu/ContextMenu";
import {
    useSettingsStore,
    type EditorFontFamily,
} from "../../../app/store/settingsStore";
import type {
    AIChatMessage,
    AIChatSessionStatus,
    AIUrlElicitationAction,
    AIUserInputAction,
} from "../types";
import { getChatPillMetrics } from "./chatPillMetrics";
import { getEditorFontFamily } from "../../editor/editorExtensions";
import {
    captureVisibleChatAnchor,
    findChatRowByKey,
    persistChatMessageListViewState,
    readPersistedChatMessageListViewState,
    resolveChatMessageListViewStateScope,
    restoreChatMessageListViewState,
    type PersistedChatViewState,
} from "./chatMessageListViewState";
import {
    resolveChatRowUiSessionId,
    useChatRowUiStore,
} from "../store/chatRowUiStore";
import { useChatStore } from "../store/chatStore";
import type { ActivityDisplayMode } from "../activityDisplayMode";
import { isTurnStartedStatusMessage } from "../transcriptModel";
import { getAiChatContentColumnStyle } from "./chatContentLayout";
import { ChatFindBar } from "./find/ChatFindBar";
import { useChatFind } from "./find/useChatFind";
import {
    buildActivityTimelineRows,
    getActivityTimelineRowKey,
    type ActivityTimelineSegmentRow,
} from "./activityTimelinePresentation";
import { ChatPromptRing } from "./ChatPromptRing";
import {
    buildChatPromptRingItems,
    resolveChatPromptRingLayout,
} from "./ChatPromptRing.logic";

interface AIChatMessageListProps {
    sessionId?: string | null;
    messages: AIChatMessage[];
    status: AIChatSessionStatus;
    bottomInset?: number;
    readOnly?: boolean;
    hasOlderMessages?: boolean;
    isLoadingOlderMessages?: boolean;
    visibleWorkCycleId?: string | null;
    findOpen?: boolean;
    scrollToMessageId?: string | null;
    onScrollToMessageComplete?: () => void;
    onCloseFind?: () => void;
    chatFontSize?: number;
    chatFontFamily?: EditorFontFamily;
    onLoadOlderMessages?: () => void;
    onPermissionResponse?: (requestId: string, optionId?: string) => void;
    onUserInputResponse?: (
        requestId: string,
        answers: Record<string, string[]>,
        action?: AIUserInputAction,
    ) => void;
    onUrlElicitationOpen?: (requestId: string) => void;
    onUrlElicitationResponse?: (
        requestId: string,
        action: AIUrlElicitationAction,
    ) => void;
}

type TimelineRow =
    | {
          key: string;
          kind: "message";
          message: AIChatMessage;
      }
    | {
          isCurrentTurnTail: boolean;
          key: string;
          kind: "activity-segment";
          segment: ActivityTimelineSegmentRow;
      }
    | {
          key: string;
          kind: "run-indicator";
          timestamp: number;
          active: boolean;
      };

const NEAR_BOTTOM_THRESHOLD = 80;
const LOAD_OLDER_THRESHOLD = 120;
// Keep a small visual gap without raising the button above the dock's stacking
// context, where it could cover non-portaled composer dropdowns.
const SCROLL_TO_BOTTOM_DOCK_GAP_PX = 12;
const DETACHED_TIMELINE_SCOPE = "__detached_timeline__";

function getRemainingScrollDistance(el: HTMLElement) {
    return Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight);
}

function isNearBottom(el: HTMLElement) {
    return getRemainingScrollDistance(el) < NEAR_BOTTOM_THRESHOLD;
}

function shouldShowScrollToBottomButton(el: HTMLElement) {
    return (
        el.scrollHeight > el.clientHeight &&
        getRemainingScrollDistance(el) >= NEAR_BOTTOM_THRESHOLD
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
        readOnly?: boolean;
        pillMetrics: ReturnType<typeof getChatPillMetrics>;
        chatFontSize: number;
        visibleWorkCycleId?: string | null;
        onPermissionResponse?: (requestId: string, optionId?: string) => void;
        onUserInputResponse?: (
            requestId: string,
            answers: Record<string, string[]>,
            action?: AIUserInputAction,
        ) => void;
        onUrlElicitationOpen?: (requestId: string) => void;
        onUrlElicitationResponse?: (
            requestId: string,
            action: AIUrlElicitationAction,
        ) => void;
        onDismissMessage?: (messageId: string) => void;
        highlightedMessageId?: string | null;
        forceExpandedMessageId?: string | null;
        forceExpandedForSearch?: boolean;
        activityDisplayMode: ActivityDisplayMode;
    },
) {
    if (row.kind === "run-indicator") {
        if (options.readOnly) return null;
        return (
            <StreamingRunIndicator
                timestamp={row.timestamp}
                active={row.active}
            />
        );
    }

    if (row.kind === "activity-segment") {
        return (
            <ToolActivitySegment
                activityDisplayMode={options.activityDisplayMode}
                forceExpandedMessageId={options.forceExpandedMessageId}
                forceExpandedForSearch={options.forceExpandedForSearch}
                highlightedMessageId={options.highlightedMessageId}
                isCurrentTurnTail={row.isCurrentTurnTail}
                renderEntry={(message) =>
                    renderTimelineMessage(message, options)
                }
                segment={row.segment}
                sessionId={options.sessionId}
            />
        );
    }

    return renderTimelineMessage(row.message, options);
}

function renderTimelineMessage(
    message: AIChatMessage,
    options: {
        sessionId?: string | null;
        readOnly?: boolean;
        pillMetrics: ReturnType<typeof getChatPillMetrics>;
        chatFontSize: number;
        visibleWorkCycleId?: string | null;
        onPermissionResponse?: (requestId: string, optionId?: string) => void;
        onUserInputResponse?: (
            requestId: string,
            answers: Record<string, string[]>,
            action?: AIUserInputAction,
        ) => void;
        onUrlElicitationOpen?: (requestId: string) => void;
        onUrlElicitationResponse?: (
            requestId: string,
            action: AIUrlElicitationAction,
        ) => void;
        onDismissMessage?: (messageId: string) => void;
    },
) {
    return (
        <AIChatMessageItem
            sessionId={options.sessionId}
            readOnly={options.readOnly}
            message={message}
            pillMetrics={options.pillMetrics}
            chatFontSize={options.chatFontSize}
            visibleWorkCycleId={options.visibleWorkCycleId}
            onPermissionResponse={
                options.readOnly ? undefined : options.onPermissionResponse
            }
            onUserInputResponse={
                options.readOnly ? undefined : options.onUserInputResponse
            }
            onUrlElicitationOpen={
                options.readOnly ? undefined : options.onUrlElicitationOpen
            }
            onUrlElicitationResponse={
                options.readOnly
                    ? undefined
                    : options.onUrlElicitationResponse
            }
            onDismissMessage={
                options.readOnly ? undefined : options.onDismissMessage
            }
        />
    );
}

export const AIChatMessageList = memo(function AIChatMessageList({
    sessionId = null,
    messages,
    status,
    bottomInset = 0,
    readOnly = false,
    hasOlderMessages = false,
    isLoadingOlderMessages = false,
    visibleWorkCycleId = null,
    findOpen = false,
    scrollToMessageId = null,
    onScrollToMessageComplete,
    onCloseFind,
    chatFontSize = 14,
    chatFontFamily = "system",
    onLoadOlderMessages,
    onPermissionResponse,
    onUserInputResponse,
    onUrlElicitationOpen,
    onUrlElicitationResponse,
}: AIChatMessageListProps) {
    const aiChatContentWidth = useSettingsStore((s) => s.aiChatContentWidth);
    const containerRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    const [promptRingStripMap] = useState(
        () => new Map<string, HTMLSpanElement>(),
    );
    const [promptRingLayout, setPromptRingLayout] = useState({
        hasPersistentGutter: false,
        hitStripWidth: 0,
    });
    const findHighlightOwnerId = useId();
    const [findQuery, setFindQuery] = useState("");
    const [findCaseSensitive, setFindCaseSensitive] = useState(false);
    const {
        total: findTotal,
        activeIndex: findActiveIndex,
        goNext: findGoNext,
        goPrev: findGoPrev,
    } = useChatFind({
        ownerId: findHighlightOwnerId,
        containerRef,
        query: findQuery,
        caseSensitive: findCaseSensitive,
        enabled: findOpen,
    });
    const wasNearBottomRef = useRef(true);
    // Do not shrink the spacer while someone is reading above the bottom.
    // Chromium would clamp scrollTop immediately and move the visible rows.
    const [reservedBottomInset, setReservedBottomInset] =
        useState(bottomInset);
    const previousReservedBottomInsetRef = useRef(reservedBottomInset);
    const pendingPrependAdjustmentRef = useRef<{
        previousScrollHeight: number;
        previousScrollTop: number;
    } | null>(null);
    const [showScrollButton, setShowScrollButton] = useState(false);
    const [outlineHighlightedMessageId, setOutlineHighlightedMessageId] =
        useState<string | null>(null);
    const [contextMenu, setContextMenu] = useState<ContextMenuState<{
        hasSelection: boolean;
    }> | null>(null);
    const previousMessagesRef = useRef(messages);
    const previousStatusRef = useRef(status);
    const restoredScopeRef = useRef<string | null>(null);
    const viewStateScope = resolveChatMessageListViewStateScope(sessionId);
    const pendingRestoreRef = useRef<PersistedChatViewState | null>(
        readPersistedChatMessageListViewState(viewStateScope),
    );
    const rowUiSessionId = resolveChatRowUiSessionId(sessionId);
    const dismissMessage = useChatStore((state) => state.dismissMessage);
    const activityDisplayMode = useChatStore(
        (state) => state.toolActivityDisplayMode,
    );
    const handleDismissMessage = useCallback(
        (messageId: string) => {
            if (!sessionId) return;
            dismissMessage(sessionId, messageId);
        },
        [dismissMessage, sessionId],
    );

    const scrollToBottom = useCallback(() => {
        const container = containerRef.current;
        if (!container) return;
        wasNearBottomRef.current = true;
        setReservedBottomInset(bottomInset);
        container.scrollTop = container.scrollHeight;
        setShowScrollButton(false);
    }, [bottomInset]);

    const syncScrollButton = useCallback(() => {
        const container = containerRef.current;
        if (!container) {
            setShowScrollButton(false);
            return;
        }

        setShowScrollButton(shouldShowScrollToBottomButton(container));
    }, []);

    const handleScroll = useCallback(() => {
        const container = containerRef.current;
        if (!container) return;

        const nearBottom = isNearBottom(container);
        wasNearBottomRef.current = nearBottom;
        if (nearBottom && reservedBottomInset !== bottomInset) {
            setReservedBottomInset(bottomInset);
        }
        setShowScrollButton(shouldShowScrollToBottomButton(container));

        persistChatMessageListViewState(
            viewStateScope,
            container,
            isNearBottom,
        );

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
    }, [
        hasOlderMessages,
        isLoadingOlderMessages,
        onLoadOlderMessages,
        bottomInset,
        reservedBottomInset,
        viewStateScope,
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
        () =>
            readOnly
                ? { pinnedPlan: null, runIndicatorAnchor: null }
                : deriveMessageListDecorations(
                      messages,
                      status === "streaming",
                  ),
        [messages, readOnly, status],
    );
    const pinnedPlanDismissed = useChatRowUiStore(
        useCallback(
            (state) =>
                pinnedPlan
                    ? !!state.rowsBySessionId[rowUiSessionId]?.[pinnedPlan.id]
                          ?.pinnedPlanDismissed
                    : false,
            [pinnedPlan, rowUiSessionId],
        ),
    );
    const dismissPinnedPlan = useChatRowUiStore((state) => state.patchRow);
    const visiblePinnedPlan = pinnedPlanDismissed ? null : pinnedPlan;
    const visiblePinnedPlanId = visiblePinnedPlan?.id ?? null;
    const shouldRevealHiddenActivity =
        scrollToMessageId !== null ||
        (findOpen && findQuery.trim().length > 0);
    const timelineActivityDisplayMode =
        activityDisplayMode === "hidden" && shouldRevealHiddenActivity
            ? "collapsed"
            : activityDisplayMode;
    const timelineRows = useMemo(() => {
        const rows: TimelineRow[] = [];
        const timelineMessages = messages.filter(
            (message) =>
                !isTurnStartedStatusMessage(message) &&
                !(
                    message.kind === "plan" &&
                    message.id === visiblePinnedPlanId
                ),
        );
        const presentationRows = buildActivityTimelineRows(
            timelineMessages,
            timelineActivityDisplayMode,
        );
        const trailingPresentationRow = presentationRows.at(-1);
        const lastTimelineMessageId = timelineMessages.at(-1)?.id;

        for (const presentationRow of presentationRows) {
            if (presentationRow.kind === "message") {
                rows.push({
                    key: scopeTimelineRowKey(sessionId, presentationRow.id),
                    kind: "message",
                    message: presentationRow.message,
                });
                continue;
            }

            rows.push({
                isCurrentTurnTail:
                    status === "streaming" &&
                    trailingPresentationRow?.id === presentationRow.id &&
                    presentationRow.entries.at(-1)?.message.id ===
                        lastTimelineMessageId,
                key: getActivityTimelineRowKey(sessionId, presentationRow.id),
                kind: "activity-segment",
                segment: presentationRow,
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
    }, [
        messages,
        runIndicatorAnchor,
        sessionId,
        status,
        timelineActivityDisplayMode,
        visiblePinnedPlanId,
    ]);
    const promptRingItems = useMemo(
        () => buildChatPromptRingItems(messages),
        [messages],
    );
    const navigateToPrompt = useCallback((messageId: string) => {
        const container = containerRef.current;
        if (!container) return;

        const target = Array.from(
            container.querySelectorAll<HTMLElement>("[data-chat-message-id]"),
        ).find((node) => node.dataset.chatMessageId === messageId);
        if (!target) return;

        const containerRect = container.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        const top = Math.max(
            0,
            container.scrollTop + targetRect.top - containerRect.top - 24,
        );

        wasNearBottomRef.current = false;
        setOutlineHighlightedMessageId(messageId);
        if (typeof container.scrollTo === "function") {
            container.scrollTo({ top, behavior: "smooth" });
        } else {
            container.scrollTop = top;
        }
        syncScrollButton();
    }, [syncScrollButton]);
    const rowRenderOptions = useMemo(
        () => ({
            sessionId,
            readOnly,
            pillMetrics,
            chatFontSize,
            visibleWorkCycleId,
            onPermissionResponse,
            onUserInputResponse,
            onUrlElicitationOpen,
            onUrlElicitationResponse,
            onDismissMessage: handleDismissMessage,
            forceExpandedMessageId: scrollToMessageId,
            forceExpandedForSearch: findOpen && findQuery.trim().length > 0,
            highlightedMessageId: outlineHighlightedMessageId,
            activityDisplayMode,
        }),
        [
            activityDisplayMode,
            chatFontSize,
            findOpen,
            scrollToMessageId,
            findQuery,
            handleDismissMessage,
            outlineHighlightedMessageId,
            onPermissionResponse,
            onUserInputResponse,
            onUrlElicitationOpen,
            onUrlElicitationResponse,
            pillMetrics,
            readOnly,
            sessionId,
            visibleWorkCycleId,
        ],
    );
    useLayoutEffect(() => {
        if (restoredScopeRef.current === viewStateScope) {
            return;
        }

        restoredScopeRef.current = viewStateScope;
        setReservedBottomInset(bottomInset);
        pendingRestoreRef.current =
            readPersistedChatMessageListViewState(viewStateScope);
        wasNearBottomRef.current =
            pendingRestoreRef.current?.nearBottom ?? true;
        previousMessagesRef.current = messages;
        previousStatusRef.current = status;
        pendingPrependAdjustmentRef.current = null;
        setShowScrollButton(false);

        if (!pendingRestoreRef.current) {
            const container = containerRef.current;
            if (container) {
                container.scrollTop = container.scrollHeight;
                queueMicrotask(syncScrollButton);
            }
        }
    }, [bottomInset, messages, status, syncScrollButton, viewStateScope]);

    useLayoutEffect(() => {
        const container = containerRef.current;
        const pendingState = pendingRestoreRef.current;
        if (!container || !pendingState) {
            return;
        }

        const restored = restoreChatMessageListViewState(
            container,
            pendingState,
        );
        if (
            !restored &&
            !pendingState.nearBottom &&
            timelineRows.length === 0
        ) {
            return;
        }

        pendingRestoreRef.current = null;
        wasNearBottomRef.current = pendingState.nearBottom;
        syncScrollButton();
    }, [syncScrollButton, timelineRows, viewStateScope]);

    useLayoutEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        const syncInViewStrips = () => {
            const containerRect = container.getBoundingClientRect();
            const rows = Array.from(
                container.querySelectorAll<HTMLElement>(
                    "[data-chat-message-id]",
                ),
            );

            for (const item of promptRingItems) {
                const strip = promptRingStripMap.get(item.id);
                if (!strip) continue;
                const row = rows.find(
                    (candidate) => candidate.dataset.chatMessageId === item.id,
                );
                if (!row) {
                    strip.dataset.inView = "false";
                    continue;
                }
                const rowRect = row.getBoundingClientRect();
                strip.dataset.inView =
                    rowRect.top < containerRect.bottom &&
                    rowRect.bottom > containerRect.top
                        ? "true"
                        : "false";
            }
        };

        const frame = window.requestAnimationFrame(syncInViewStrips);
        container.addEventListener("scroll", syncInViewStrips, {
            passive: true,
        });
        return () => {
            window.cancelAnimationFrame(frame);
            container.removeEventListener("scroll", syncInViewStrips);
        };
    }, [promptRingItems, promptRingStripMap, timelineRows]);

    useLayoutEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        const measure = () => {
            const width =
                container.getBoundingClientRect().width ||
                container.clientWidth;
            const next = resolveChatPromptRingLayout(
                width,
                aiChatContentWidth,
            );
            setPromptRingLayout((current) =>
                current.hasPersistentGutter === next.hasPersistentGutter &&
                current.hitStripWidth === next.hitStripWidth
                    ? current
                    : next,
            );
        };

        const frame = window.requestAnimationFrame(measure);
        const observer = new ResizeObserver(measure);
        observer.observe(container);
        return () => {
            window.cancelAnimationFrame(frame);
            observer.disconnect();
        };
    }, [aiChatContentWidth, promptRingItems.length]);

    useLayoutEffect(() => {
        const container = containerRef.current;
        return () => {
            const persistedState = persistChatMessageListViewState(
                viewStateScope,
                container,
                isNearBottom,
            );
            wasNearBottomRef.current = persistedState?.nearBottom ?? true;
        };
    }, [viewStateScope]);

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
            queueMicrotask(syncScrollButton);
        } else if (wasNearBottomRef.current) {
            container.scrollTop = container.scrollHeight;
            queueMicrotask(syncScrollButton);
        } else {
            const frameId = window.requestAnimationFrame(() => {
                syncScrollButton();
            });

            previousMessagesRef.current = messages;
            previousStatusRef.current = status;

            return () => {
                window.cancelAnimationFrame(frameId);
            };
        }

        previousMessagesRef.current = messages;
        previousStatusRef.current = status;
    }, [messages, status, syncScrollButton]);

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

    useLayoutEffect(() => {
        if (
            bottomInset > reservedBottomInset ||
            (wasNearBottomRef.current && bottomInset !== reservedBottomInset)
        ) {
            setReservedBottomInset(bottomInset);
        }
    }, [bottomInset, reservedBottomInset]);

    useLayoutEffect(() => {
        if (
            previousReservedBottomInsetRef.current === reservedBottomInset
        ) {
            return;
        }

        previousReservedBottomInsetRef.current = reservedBottomInset;
        const container = containerRef.current;
        if (!container) return;

        if (wasNearBottomRef.current) {
            container.scrollTop = container.scrollHeight;
        }
        queueMicrotask(syncScrollButton);
    }, [reservedBottomInset, syncScrollButton]);

    // Anchor scroll position when container width changes (e.g. sidebar resize).
    // Tracks the topmost visible chat row and its viewport offset on every scroll,
    // then corrects scrollTop after text reflow so content stays visually stable.
    useLayoutEffect(() => {
        const container = containerRef.current;
        if (!container) return;
        const scrollContainer: HTMLElement = container;

        let prevWidth = scrollContainer.clientWidth;
        let anchorSnapshot = captureVisibleChatAnchor(
            scrollContainer,
            isNearBottom,
        );

        function captureAnchor() {
            anchorSnapshot = captureVisibleChatAnchor(
                scrollContainer,
                isNearBottom,
            );
        }

        scrollContainer.addEventListener("scroll", captureAnchor, {
            passive: true,
        });
        captureAnchor();

        const ro = new ResizeObserver(() => {
            const newWidth = scrollContainer.clientWidth;
            if (newWidth !== prevWidth) {
                prevWidth = newWidth;

                if (anchorSnapshot.nearBottom) {
                    scrollContainer.scrollTop = scrollContainer.scrollHeight;
                } else if (anchorSnapshot.rowKey) {
                    const anchorNode = findChatRowByKey(
                        scrollContainer,
                        anchorSnapshot.rowKey,
                    );
                    if (!anchorNode) {
                        syncScrollButton();
                        return;
                    }
                    const containerRect =
                        scrollContainer.getBoundingClientRect();
                    const rect = anchorNode.getBoundingClientRect();
                    scrollContainer.scrollTop +=
                        rect.top - containerRect.top - anchorSnapshot.offset;
                }
            }

            syncScrollButton();
        });

        ro.observe(scrollContainer);
        if (contentRef.current) {
            ro.observe(contentRef.current);
        }
        return () => {
            scrollContainer.removeEventListener("scroll", captureAnchor);
            ro.disconnect();
        };
    }, [syncScrollButton]);

    useLayoutEffect(() => {
        if (!scrollToMessageId) return;

        const container = containerRef.current;
        if (!container) {
            onScrollToMessageComplete?.();
            return;
        }

        const target = Array.from(
            container.querySelectorAll<HTMLElement>("[data-chat-message-id]"),
        ).find(
            (node) => node.dataset.chatMessageId === scrollToMessageId,
        );

        if (!target) {
            onScrollToMessageComplete?.();
            return;
        }

        target.scrollIntoView({ block: "center", behavior: "smooth" });
        setOutlineHighlightedMessageId(scrollToMessageId);
        onScrollToMessageComplete?.();
    }, [onScrollToMessageComplete, scrollToMessageId, timelineRows]);

    useEffect(() => {
        if (!outlineHighlightedMessageId) return;

        const timeoutId = window.setTimeout(() => {
            setOutlineHighlightedMessageId(null);
        }, 1200);

        return () => window.clearTimeout(timeoutId);
    }, [outlineHighlightedMessageId]);

    return (
        <div className="relative min-h-0 min-w-0 flex-1 flex flex-col">
            {findOpen && (
                <ChatFindBar
                    query={findQuery}
                    caseSensitive={findCaseSensitive}
                    total={findTotal}
                    activeIndex={findActiveIndex}
                    onQueryChange={setFindQuery}
                    onToggleCaseSensitive={() =>
                        setFindCaseSensitive((value) => !value)
                    }
                    onNext={findGoNext}
                    onPrev={findGoPrev}
                    onClose={() => onCloseFind?.()}
                />
            )}
            <div className="contents">
                {visiblePinnedPlan && (
                    <div
                        className="absolute inset-x-0 top-0 z-[5] px-3 pt-2"
                        data-testid="chat-pinned-plan-overlay"
                    >
                        <div
                            className="min-w-0"
                            data-testid="chat-pinned-plan-column"
                            style={getAiChatContentColumnStyle(
                                aiChatContentWidth,
                            )}
                        >
                            <PlanMessage
                                sessionId={sessionId}
                                message={visiblePinnedPlan}
                                pillMetrics={pillMetrics}
                                onDismiss={() =>
                                    dismissPinnedPlan(
                                        rowUiSessionId,
                                        visiblePinnedPlan.id,
                                        {
                                            pinnedPlanDismissed: true,
                                        },
                                    )
                                }
                            />
                        </div>
                    </div>
                )}
                <div
                    ref={containerRef}
                    onScroll={handleScroll}
                    onContextMenu={handleContextMenu}
                    className="min-h-0 min-w-0 flex-1 flex flex-col overflow-y-auto px-3 py-3"
                    data-scrollbar-active="true"
                    style={{
                        paddingBottom: Math.max(0, reservedBottomInset) + 12,
                        scrollPaddingBottom:
                            Math.max(0, reservedBottomInset) + 12,
                    }}
                >
                    <div
                        ref={contentRef}
                        className="min-w-0"
                        data-selectable="true"
                        style={{
                            ...getAiChatContentColumnStyle(aiChatContentWidth),
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
                        <div className="min-w-0 space-y-2">
                            {timelineRows.map((row) => (
                                <div
                                    key={row.key}
                                    data-chat-row="true"
                                    data-chat-row-key={row.key}
                                    data-chat-message-id={
                                        row.kind === "message"
                                            ? row.message.id
                                            : undefined
                                    }
                                    data-chat-outline-active={
                                        row.kind === "message" &&
                                        row.message.id ===
                                            outlineHighlightedMessageId
                                            ? "true"
                                            : undefined
                                    }
                                    style={
                                        row.kind === "message" &&
                                        row.message.id ===
                                            outlineHighlightedMessageId
                                            ? {
                                                  borderRadius: 8,
                                                  outline:
                                                      "1px solid color-mix(in srgb, var(--accent) 20%, transparent)",
                                                  background:
                                                      "color-mix(in srgb, var(--accent) 8%, transparent)",
                                                  transition:
                                                      "background 160ms ease, outline-color 160ms ease",
                                              }
                                            : undefined
                                    }
                                >
                                    {renderTimelineRow(row, rowRenderOptions)}
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
                <ChatPromptRing
                    hasPersistentGutter={
                        promptRingLayout.hasPersistentGutter
                    }
                    hitStripWidth={promptRingLayout.hitStripWidth}
                    items={promptRingItems}
                    stripMap={promptRingStripMap}
                    onSelect={(item) => navigateToPrompt(item.id)}
                />
                {showScrollButton && (
                    <button
                        type="button"
                        onClick={scrollToBottom}
                        className="nw-chat-translucent-surface absolute left-1/2 flex h-7 w-7 -translate-x-1/2 items-center justify-center rounded-full"
                        style={{
                            bottom:
                                Math.max(0, bottomInset) +
                                SCROLL_TO_BOTTOM_DOCK_GAP_PX,
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
            </div>
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
