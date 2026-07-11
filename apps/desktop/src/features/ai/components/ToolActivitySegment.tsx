import {
    memo,
    useCallback,
    useLayoutEffect,
    type CSSProperties,
    type ReactNode,
} from "react";

import { formatDiffStat } from "../diff/reviewDiff";
import type { AIChatMessage } from "../types";
import {
    resolveChatRowUiSessionId,
    useChatRowUiStore,
} from "../store/chatRowUiStore";
import {
    getActivityTimelineLatestLabel,
    getActivityTimelineSegmentHeadline,
    type ActivityTimelineSegmentRow,
} from "./activityTimelinePresentation";

interface ToolActivitySegmentProps {
    readonly forceExpandedMessageId?: string | null;
    readonly forceExpandedForSearch?: boolean;
    readonly highlightedMessageId?: string | null;
    /** True only while this segment is the trailing activity of an active turn. */
    readonly isCurrentTurnTail?: boolean;
    readonly renderEntry: (message: AIChatMessage) => ReactNode;
    readonly segment: ActivityTimelineSegmentRow;
    readonly sessionId?: string | null;
}

function Chevron({ expanded }: { readonly expanded: boolean }) {
    return (
        <svg
            aria-hidden="true"
            fill="none"
            height="11"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.8"
            style={{
                transform: expanded ? "rotate(180deg)" : "rotate(0deg)",
                transition: "transform 150ms ease",
            }}
            viewBox="0 0 16 16"
            width="11"
        >
            <path d="m4 6 4 4 4-4" />
        </svg>
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
        forceExpanded || forceExpandedForSearch || storedExpanded === true;
    const contentId = `${segment.id}:activity`;
    const headline = getActivityTimelineSegmentHeadline(
        segment.summary,
        isCurrentTurnTail,
    );
    const latestLabel = getActivityTimelineLatestLabel(segment);
    const hasChanges = segment.summary.changeCount > 0;
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
                        ? value(current.activitySegmentExpanded === true)
                        : value,
            }));
        },
        [patchRow, rowUiSessionId, segment.id],
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
                className="flex min-h-10 w-full items-center gap-2 rounded-md px-1 py-1 text-left transition-colors hover:bg-bg-elevated focus-visible:bg-bg-elevated focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--accent)]"
                onClick={() => setExpanded((current) => !current)}
                style={{
                    background: "none",
                    border: "none",
                    color: "var(--text-primary)",
                }}
                type="button"
            >
                <span className="min-w-0 flex-1">
                    <span
                        className="block truncate text-[11px] font-medium leading-4"
                        title={headline}
                    >
                        {headline}
                    </span>
                    <span
                        className="block truncate text-[10px] leading-3.5 text-text-secondary"
                        data-activity-rail-current="true"
                        title={latestLabel}
                    >
                        {isCurrentTurnTail ? "Current" : "Latest"}: {latestLabel}
                    </span>
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
                <span className="shrink-0 text-text-secondary">
                    <Chevron expanded={expanded} />
                </span>
            </button>

            {expanded ? (
                <div
                    aria-label="Full tool activity"
                    className="pt-1"
                    id={contentId}
                    role="region"
                >
                    <div
                        className="activity-tree flex min-w-0 flex-col gap-1.5"
                        role="list"
                    >
                        {segment.entries.map((entry) => {
                            const isHighlighted =
                                entry.message.id === highlightedMessageId;
                            return (
                                <div
                                    className="activity-tree-branch min-w-0 pl-10"
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
                                            : "always"
                                    }
                                    key={entry.message.id}
                                    role="listitem"
                                    style={getChatOutlineStyle(isHighlighted)}
                                >
                                    <div className="min-w-0 py-0.5">
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
