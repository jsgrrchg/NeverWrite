import {
    memo,
    useCallback,
    useLayoutEffect,
    type CSSProperties,
    type ReactNode,
} from "react";

import { formatDiffStat } from "../diff/reviewDiff";
import type { ActivityDisplayMode } from "../activityDisplayMode";
import type { AIChatMessage } from "../types";
import {
    resolveChatRowUiSessionId,
    useChatRowUiStore,
} from "../store/chatRowUiStore";
import {
    getActivityTimelineSegmentHeadline,
    type ActivityTimelineSegmentRow,
} from "./activityTimelinePresentation";

interface ToolActivitySegmentProps {
    readonly activityDisplayMode?: ActivityDisplayMode;
    readonly forceExpandedMessageId?: string | null;
    readonly forceExpandedForSearch?: boolean;
    readonly highlightedMessageId?: string | null;
    /** True only while this segment is the trailing activity of an active turn. */
    readonly isCurrentTurnTail?: boolean;
    readonly renderEntry: (message: AIChatMessage) => ReactNode;
    readonly segment: ActivityTimelineSegmentRow;
    readonly sessionId?: string | null;
}

function ActivityIndicator({
    active,
    expanded,
}: {
    readonly active: boolean;
    readonly expanded: boolean;
}) {
    return (
        <span
            aria-hidden="true"
            className="activity-rail-indicator"
            data-activity-rail-worked-indicator={active ? undefined : "true"}
            data-activity-rail-working-indicator={active ? "true" : undefined}
        >
            <svg
                className="activity-rail-chevron"
                fill="none"
                height="14"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1"
                style={{ transform: expanded ? "rotate(0deg)" : "rotate(-90deg)" }}
                viewBox="0 0 16 16"
                width="14"
            >
                <path d="m4 6 4 4 4-4" />
            </svg>
        </span>
    );
}

function getChatOutlineStyle(isActive: boolean): CSSProperties | undefined {
    return isActive
        ? {
              background: "color-mix(in srgb, var(--accent) 8%, transparent)",
              borderRadius: 8,
              outline: "1px solid color-mix(in srgb, var(--accent) 20%, transparent)",
              transition: "background 160ms ease, outline-color 160ms ease",
          }
        : undefined;
}

export const ToolActivitySegment = memo(function ToolActivitySegment({
    activityDisplayMode = "collapsed",
    forceExpandedMessageId = null,
    forceExpandedForSearch = false,
    highlightedMessageId = null,
    isCurrentTurnTail = false,
    renderEntry,
    segment,
    sessionId = null,
}: ToolActivitySegmentProps) {
    const rowUiSessionId = resolveChatRowUiSessionId(sessionId);
    const storedExpanded = useChatRowUiStore(
        (state) =>
            state.rowsBySessionId[rowUiSessionId]?.[segment.id]
                ?.activitySegmentExpanded,
    );
    const patchRow = useChatRowUiStore((state) => state.patchRow);
    const forceExpanded = segment.entries.some(
        (entry) => entry.message.id === forceExpandedMessageId,
    );
    const expanded =
        forceExpanded ||
        forceExpandedForSearch ||
        activityDisplayMode === "hidden" ||
        (storedExpanded ?? activityDisplayMode === "expanded");
    const contentId = `${segment.id}:activity`;
    const headline = getActivityTimelineSegmentHeadline(
        segment.summary,
        isCurrentTurnTail,
    );
    const hasChanges = segment.summary.changeCount > 0;
    const visibleEntries = expanded
        ? segment.entries
        : segment.entries.filter(
              (entry) => entry.policy === "standalone-attention",
          );
    const activityState = isCurrentTurnTail ? "In progress" : "Completed";
    const accessibleChangeSummary = hasChanges
        ? ` ${segment.summary.changeStats.additions} additions, ${segment.summary.changeStats.deletions} deletions. Changed.`
        : "";
    const accessibleLabel = `${expanded ? "Hide" : "Show"} full activity: ${headline}.${accessibleChangeSummary} ${activityState}.`;

    const setExpanded = useCallback(
        (value: boolean | ((current: boolean) => boolean)) => {
            patchRow(rowUiSessionId, segment.id, (current) => ({
                activitySegmentExpanded:
                    typeof value === "function"
                        ? value(
                              current.activitySegmentExpanded ??
                                  activityDisplayMode === "expanded",
                          )
                        : value,
            }));
        },
        [activityDisplayMode, patchRow, rowUiSessionId, segment.id],
    );

    useLayoutEffect(() => {
        if (forceExpanded && storedExpanded !== true) {
            setExpanded(true);
        }
    }, [forceExpanded, setExpanded, storedExpanded]);

    return (
        <div
            aria-busy={isCurrentTurnTail}
            className="activity-rail min-w-0"
            data-activity-count={segment.summary.actionCount}
            data-activity-rail="true"
            data-tool-activity-segment={segment.id}
        >
            <button
                aria-controls={contentId}
                aria-expanded={expanded}
                aria-label={accessibleLabel}
                className="activity-rail-header"
                onClick={() => setExpanded((current) => !current)}
                type="button"
            >
                <ActivityIndicator active={isCurrentTurnTail} expanded={expanded} />
                <span
                    className="activity-rail-summary min-w-0 truncate"
                    title={headline}
                >
                    {headline}
                </span>
                {hasChanges ? (
                    <span
                        className="flex shrink-0 items-center gap-1.5 text-[10px] font-medium"
                        data-activity-change-summary="true"
                    >
                        {segment.summary.changeStats.additions > 0 ? (
                            <span style={{ color: "var(--diff-add)" }}>
                                +
                                {formatDiffStat(
                                    segment.summary.changeStats.additions,
                                    segment.summary.changeStats.approximate,
                                )}
                            </span>
                        ) : null}
                        {segment.summary.changeStats.deletions > 0 ? (
                            <span style={{ color: "var(--diff-remove)" }}>
                                -
                                {formatDiffStat(
                                    segment.summary.changeStats.deletions,
                                    segment.summary.changeStats.approximate,
                                )}
                            </span>
                        ) : null}
                        <span className="text-text-secondary">Changed</span>
                    </span>
                ) : null}
            </button>

            {visibleEntries.length > 0 ? (
                <div
                    aria-label={
                        expanded ? "Full tool activity" : "Important tool activity"
                    }
                    className="pt-0.5"
                    id={contentId}
                    role="region"
                >
                    <div
                        className="activity-tree flex min-w-0 flex-col"
                        role="list"
                    >
                        {visibleEntries.map((entry) => {
                            const isHighlighted =
                                entry.message.id === highlightedMessageId;
                            return (
                                <div
                                    className="activity-tree-branch min-w-0"
                                    data-activity-rail-decoration="branch"
                                    data-activity-rail-indent="child"
                                    data-chat-message-id={entry.message.id}
                                    data-chat-outline-active={
                                        isHighlighted ? "true" : undefined
                                    }
                                    data-tool-activity-id={entry.message.id}
                                    data-tool-activity-visibility={
                                        entry.policy === "groupable"
                                            ? "expanded-only"
                                            : entry.policy === "standalone-attention"
                                              ? "always"
                                              : "expanded-only"
                                    }
                                    key={entry.message.id}
                                    role="listitem"
                                    style={getChatOutlineStyle(isHighlighted)}
                                >
                                    <div className="min-w-0">
                                        {renderEntry(entry.message)}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            ) : null}
        </div>
    );
});

ToolActivitySegment.displayName = "ToolActivitySegment";
