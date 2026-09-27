import {
    memo,
    useCallback,
    useEffect,
    useId,
    useLayoutEffect,
    useMemo,
    useState,
} from "react";
import {
    AIChatMessageItem,
    PlanMessage,
    type AssistantMessageMetadataMode,
} from "./AIChatMessageItem";
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
import { useChatTranscriptScroll } from "./useChatTranscriptScroll";
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
import { deriveAssistantMessageMetadataModes } from "./assistantMessageMetadata";

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

// Keep the control clear of the floating composer.
const SCROLL_TO_BOTTOM_DOCK_GAP_PX = 12;
const DETACHED_TIMELINE_SCOPE = "__detached_timeline__";

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
        assistantMetadataModes: ReadonlyMap<
            string,
            AssistantMessageMetadataMode
        >;
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
        assistantMetadataModes: ReadonlyMap<
            string,
            AssistantMessageMetadataMode
        >;
    },
) {
    return (
        <AIChatMessageItem
            assistantMetadataMode={
                options.assistantMetadataModes.get(message.id) ?? "hidden"
            }
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
    const {
        containerRef, contentRef, rowsRef, runwayRef,
        reservedBottomInset, showScrollButton, handleScroll, scrollToBottom,
        releaseForNavigation, syncScrollButton,
    } = useChatTranscriptScroll({
        sessionId, messages, status, bottomInset, readOnly,
        hasOlderMessages, isLoadingOlderMessages, onLoadOlderMessages,
    });
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
    useLayoutEffect(() => {
        if (findOpen) releaseForNavigation();
    }, [findOpen, releaseForNavigation]);
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
        onNavigate: releaseForNavigation,
    });
    const [outlineHighlightedMessageId, setOutlineHighlightedMessageId] =
        useState<string | null>(null);
    const [contextMenu, setContextMenu] = useState<ContextMenuState<{
        hasSelection: boolean;
    }> | null>(null);
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
                // Keep saved-chat reconnection silent without changing recovery state.
                !(
                    message.kind === "status" &&
                    message.id ===
                        "status:neverwrite:recovery:reconnecting-saved-chat"
                ) &&
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
    const assistantMetadataModes = useMemo(
        () => deriveAssistantMessageMetadataModes(messages, status),
        [messages, status],
    );
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

        releaseForNavigation();
        setOutlineHighlightedMessageId(messageId);
        if (typeof container.scrollTo === "function") {
            container.scrollTo({ top, behavior: "smooth" });
        } else {
            container.scrollTop = top;
        }
        syncScrollButton();
    }, [containerRef, releaseForNavigation, syncScrollButton]);
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
            assistantMetadataModes,
        }),
        [
            activityDisplayMode,
            assistantMetadataModes,
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
    }, [containerRef, promptRingItems, promptRingStripMap, timelineRows]);

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
    }, [aiChatContentWidth, containerRef, promptRingItems.length]);

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

        releaseForNavigation();
        target.scrollIntoView({ block: "center", behavior: "smooth" });
        setOutlineHighlightedMessageId(scrollToMessageId);
        onScrollToMessageComplete?.();
    }, [containerRef, onScrollToMessageComplete, releaseForNavigation, scrollToMessageId, timelineRows]);

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
                        overflowAnchor: "none",
                        paddingBottom: Math.max(0, reservedBottomInset) + 12,
                        scrollPaddingBottom:
                            Math.max(0, reservedBottomInset) + 12,
                    }}
                >
                    <div
                        ref={contentRef}
                        className="min-w-0 shrink-0"
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
                        <div ref={rowsRef} className="min-w-0 space-y-2">
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
                        <div ref={runwayRef} aria-hidden="true" data-chat-runway="true" />
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
