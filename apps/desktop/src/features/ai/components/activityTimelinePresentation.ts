import { computeDiffStats, type DiffStats } from "../diff/reviewDiff";
import type { ActivityDisplayMode } from "../activityDisplayMode";
import type { AIChatMessage, AIFileDiff } from "../types";

const COMMAND_TOOL_KINDS = new Set([
    "bash",
    "command",
    "execute",
    "shell",
    "terminal",
]);

const GROUPABLE_TOOL_KINDS = new Set([
    "browse",
    "fetch",
    "find",
    "glob",
    "grep",
    "list",
    "read",
    "read_file",
    "search",
    "web_fetch",
    "web_search",
]);

const MUTATING_FILE_TOOL_KINDS = new Set([
    "apply_patch",
    "create",
    "delete",
    "edit",
    "move",
    "remove",
    "rename",
    "update",
    "write",
]);

const FILE_TOOL_KINDS = new Set([
    ...GROUPABLE_TOOL_KINDS,
    ...MUTATING_FILE_TOOL_KINDS,
]);

const SEARCH_TOOL_KINDS = new Set(["find", "glob", "grep", "search"]);
const DETACHED_ACTIVITY_TIMELINE_SCOPE = "__detached_activity_timeline__";

export type ActivityTimelineToolPolicy =
    | "groupable"
    | "standalone-change"
    | "standalone-attention";

/** A rail entry may be reasoning, routine status, or a runtime tool activity. */
export interface ActivityTimelineToolEntry {
    readonly message: AIChatMessage;
    readonly policy: ActivityTimelineToolPolicy;
}

export interface ActivityTimelineChangeStats {
    readonly additions: number;
    readonly approximate: boolean;
    readonly deletions: number;
}

export interface ActivityTimelineSegmentSummary {
    readonly actionCount: number;
    readonly changeCount: number;
    readonly changeStats: ActivityTimelineChangeStats;
    readonly changedFileCount: number;
    readonly commandCount: number;
    readonly failureCount: number;
    readonly fileCount: number;
    readonly isInProgress: boolean;
    readonly latestMessageId: string;
    readonly latestTitle: string;
    readonly reasoningCount: number;
    readonly searchCount: number;
    readonly statusCount: number;
    readonly startedAt: number;
    readonly updatedAt: number;
}

export interface ActivityTimelineMessageRow {
    readonly id: string;
    readonly kind: "message";
    readonly message: AIChatMessage;
}

export interface ActivityTimelineSegmentRow {
    readonly entries: readonly ActivityTimelineToolEntry[];
    readonly id: string;
    readonly kind: "activity-segment";
    readonly summary: ActivityTimelineSegmentSummary;
}

export type ActivityTimelineRow =
    | ActivityTimelineMessageRow
    | ActivityTimelineSegmentRow;

interface SegmentFileState {
    readonly finalPath: string;
    readonly initialPath: string;
    readonly initialText: string | null;
    readonly isText: boolean;
    readonly reversible: boolean;
    readonly finalText: string | null;
}

function getMessageMetaString(message: AIChatMessage, key: string): string | null {
    const value = message.meta?.[key];
    return typeof value === "string" && value.trim() ? value : null;
}

function getToolKind(message: AIChatMessage): string {
    return getMessageMetaString(message, "tool")?.toLowerCase() ?? "";
}

function getToolTarget(message: AIChatMessage): string | null {
    return getMessageMetaString(message, "target");
}

function getToolStatus(message: AIChatMessage): string {
    return getMessageMetaString(message, "status")?.toLowerCase() ?? "";
}

function getToolDiffs(message: AIChatMessage): readonly AIFileDiff[] {
    return message.reviewDiffs ?? message.diffs ?? [];
}

function isFailedTool(message: AIChatMessage): boolean {
    const status = getToolStatus(message);
    return status === "cancelled" || status === "error" || status === "failed";
}

function getStatusEventKind(message: AIChatMessage): string {
    return getMessageMetaString(message, "status_event")?.toLowerCase() ?? "";
}

function isRoutineStatusActivity(message: AIChatMessage): boolean {
    if (message.kind !== "status") {
        return false;
    }

    // These events describe work already represented by the conversation's
    // activity stream. State changes and recovery notices remain boundaries.
    return (
        getStatusEventKind(message) === "item_activity" ||
        getStatusEventKind(message) === "subagent_lifecycle"
    );
}

function isSubagentLifecycleActivity(message: AIChatMessage): boolean {
    return (
        message.kind === "status" &&
        getStatusEventKind(message) === "subagent_lifecycle"
    );
}

function isInProgressTool(message: AIChatMessage): boolean {
    const status = getToolStatus(message);
    return (
        message.inProgress === true ||
        status === "in_progress" ||
        status === "pending"
    );
}

function isMutatingFileTool(message: AIChatMessage): boolean {
    return MUTATING_FILE_TOOL_KINDS.has(getToolKind(message));
}

function hasChangeData(message: AIChatMessage): boolean {
    return getToolDiffs(message).length > 0 || isMutatingFileTool(message);
}

function getEntryTitle(message: AIChatMessage): string {
    return (
        message.title?.trim() ||
        message.content.trim() ||
        (message.kind === "thinking" ? "Thinking" : "Tool activity")
    );
}

export function isActivityTimelineEntry(message: AIChatMessage) {
    return (
        message.kind === "thinking" ||
        message.kind === "tool" ||
        isRoutineStatusActivity(message)
    );
}

function getLatestToolEntry(
    entries: readonly ActivityTimelineToolEntry[],
) {
    return entries.findLast((entry) => entry.message.kind === "tool") ?? null;
}

function addPath(paths: Set<string>, path: string | null | undefined) {
    const normalized = path?.trim();
    if (normalized) {
        paths.add(normalized);
    }
}

function hasCompleteSnapshot(diff: AIFileDiff): boolean {
    if (diff.is_text === false) {
        return false;
    }

    if (diff.kind === "add") {
        return diff.new_text !== undefined;
    }

    if (diff.kind === "delete") {
        return diff.old_text !== undefined;
    }

    return diff.old_text !== undefined && diff.new_text !== undefined;
}

function createSegmentFileState(diff: AIFileDiff): SegmentFileState {
    const initialPath = diff.previous_path ?? diff.path;
    const initialText = diff.kind === "add" ? null : (diff.old_text ?? null);
    const finalText = diff.kind === "delete" ? null : (diff.new_text ?? null);

    return {
        finalPath: diff.path,
        finalText,
        initialPath,
        initialText,
        isText: diff.is_text !== false,
        reversible: diff.reversible !== false,
    };
}

function toNetDiff(state: SegmentFileState): AIFileDiff | null {
    const samePath = state.initialPath === state.finalPath;
    if (samePath && state.initialText === state.finalText) {
        return null;
    }

    const kind: AIFileDiff["kind"] =
        state.initialText === null
            ? "add"
            : state.finalText === null
              ? "delete"
              : samePath
                ? "update"
                : "move";

    return {
        is_text: state.isText,
        kind,
        new_text: state.finalText,
        old_text: state.initialText,
        path: state.finalPath,
        previous_path: samePath ? null : state.initialPath,
        reversible: state.reversible,
    };
}

function sumDiffStats(diffs: readonly AIFileDiff[]): DiffStats {
    return computeDiffStats([...diffs]);
}

function combineDiffStats(
    netDiffs: readonly AIFileDiff[],
    fallbackDiffs: readonly AIFileDiff[],
): ActivityTimelineChangeStats {
    const net = sumDiffStats(netDiffs);
    const fallback = sumDiffStats(fallbackDiffs);

    return {
        additions: net.additions + fallback.additions,
        approximate:
            net.approximate === true ||
            fallback.approximate === true ||
            fallbackDiffs.length > 0,
        deletions: net.deletions + fallback.deletions,
    };
}

/**
 * A segment can merge only unambiguous snapshots. Incomplete or ambiguous
 * diffs stay as approximate totals instead of inventing a combined history.
 */
export function deriveActivityTimelineChangeStats(
    entries: readonly ActivityTimelineToolEntry[],
): ActivityTimelineChangeStats {
    const states: SegmentFileState[] = [];
    const fallbackDiffs: AIFileDiff[] = [];

    for (const entry of entries) {
        for (const diff of getToolDiffs(entry.message)) {
            if (!hasCompleteSnapshot(diff)) {
                fallbackDiffs.push(diff);
                continue;
            }

            const previousPath = diff.previous_path ?? diff.path;
            const matches = states.filter(
                (state) => state.finalPath === previousPath,
            );

            if (matches.length > 1) {
                fallbackDiffs.push(diff);
                continue;
            }

            const existing = matches[0];
            if (!existing) {
                states.push(createSegmentFileState(diff));
                continue;
            }

            const next = createSegmentFileState(diff);
            const replacementIndex = states.indexOf(existing);
            states[replacementIndex] = {
                ...existing,
                finalPath: next.finalPath,
                finalText: next.finalText,
                isText: existing.isText && next.isText,
                reversible: existing.reversible && next.reversible,
            };
        }
    }

    const netDiffs = states
        .map(toNetDiff)
        .filter((diff): diff is AIFileDiff => diff !== null);
    return combineDiffStats(netDiffs, fallbackDiffs);
}

export function getActivityTimelineToolPolicy(
    message: AIChatMessage,
): ActivityTimelineToolPolicy {
    if (message.kind === "thinking") {
        return "groupable";
    }

    if (isFailedTool(message) || message.toolAction != null) {
        return "standalone-attention";
    }

    if (isSubagentLifecycleActivity(message)) {
        return "standalone-attention";
    }

    if (isRoutineStatusActivity(message)) {
        return "groupable";
    }

    if (hasChangeData(message)) {
        // Changes keep their own review surface instead of becoming a routine row.
        return "standalone-change";
    }

    // ACP providers use ToolKind::Other for MCP and extension tools. A
    // successful unknown tool is still routine work; only failures and
    // user-facing actions need to remain visible in a collapsed rail.
    return "groupable";
}

export function buildActivityTimelineSegmentSummary(
    entries: readonly ActivityTimelineToolEntry[],
): ActivityTimelineSegmentSummary {
    const latestEntry = entries.at(-1);
    const latestToolEntry = getLatestToolEntry(entries);
    const firstEntry = entries[0];
    if (!firstEntry || !latestEntry) {
        throw new Error("An activity segment requires at least one tool entry.");
    }

    const changedFiles = new Set<string>();
    const fileTargets = new Set<string>();
    let changeCount = 0;
    let commandCount = 0;
    let failureCount = 0;
    let reasoningCount = 0;
    let searchCount = 0;
    let statusCount = 0;
    let isInProgress = false;
    let updatedAt = firstEntry.message.timestamp;

    for (const entry of entries) {
        const { message, policy } = entry;
        if (message.kind === "thinking") {
            reasoningCount += 1;
        }
        if (message.kind === "status") {
            statusCount += 1;
        }
        const kind = getToolKind(message);
        const target = getToolTarget(message);
        const diffs = getToolDiffs(message);

        if (COMMAND_TOOL_KINDS.has(kind)) {
            commandCount += 1;
        }
        if (SEARCH_TOOL_KINDS.has(kind)) {
            searchCount += 1;
        }
        if (FILE_TOOL_KINDS.has(kind)) {
            addPath(fileTargets, target);
        }
        if (policy === "standalone-change") {
            changeCount += 1;
            addPath(changedFiles, target);
        }
        if (isFailedTool(message)) {
            failureCount += 1;
        }
        if (isInProgressTool(message)) {
            isInProgress = true;
        }
        if (message.timestamp > updatedAt) {
            updatedAt = message.timestamp;
        }

        for (const diff of diffs) {
            addPath(fileTargets, diff.path);
            addPath(fileTargets, diff.previous_path);
            if (policy === "standalone-change") {
                addPath(changedFiles, diff.path);
            }
        }
    }

    return {
        actionCount: entries.filter((entry) => entry.message.kind === "tool")
            .length,
        changeCount,
        changeStats: deriveActivityTimelineChangeStats(entries),
        changedFileCount: changedFiles.size,
        commandCount,
        failureCount,
        fileCount: fileTargets.size,
        isInProgress,
        latestMessageId: (latestToolEntry ?? latestEntry).message.id,
        latestTitle: getEntryTitle((latestToolEntry ?? latestEntry).message),
        reasoningCount,
        searchCount,
        statusCount,
        startedAt: firstEntry.message.timestamp,
        updatedAt,
    };
}

export function getActivityTimelineSegmentHeadline(
    summary: ActivityTimelineSegmentSummary,
    isCurrentTurnTail = false,
): string {
    if (summary.actionCount === 0 && summary.reasoningCount === 0) {
        return isCurrentTurnTail ? "Working" : "Worked";
    }

    const details = [
        pluralize(summary.actionCount, "action"),
        summary.changedFileCount > 0
            ? pluralize(
                  summary.changedFileCount,
                  "file changed",
                  "files changed",
              )
            : null,
        summary.failureCount > 0
            ? pluralize(summary.failureCount, "failure")
            : null,
    ].filter((detail): detail is string => detail !== null);

    if (isCurrentTurnTail) {
        if (summary.actionCount === 0 && summary.reasoningCount > 0) {
            return "Thinking";
        }
        return `Working · ${details.join(" · ")}`;
    }

    if (summary.actionCount === 0 && summary.reasoningCount > 0) {
        return "Reasoned";
    }

    if (
        summary.changeCount === 0 &&
        summary.commandCount === 0 &&
        summary.failureCount === 0 &&
        (summary.fileCount > 0 || summary.searchCount > 0)
    ) {
        const explorationDetails = [
            summary.fileCount > 0
                ? pluralize(summary.fileCount, "file")
                : null,
            summary.searchCount > 0
                ? pluralize(summary.searchCount, "search", "searches")
                : null,
        ].filter((detail): detail is string => detail !== null);
        return `Explored ${explorationDetails.join(" · ")}`;
    }

    return `Worked · ${details.join(" · ")}`;
}

export function getActivityTimelineLatestLabel(
    segment: ActivityTimelineSegmentRow,
): string {
    const latestMessage = getLatestToolEntry(segment.entries)?.message;
    return latestMessage
        ? (getToolTarget(latestMessage) ?? getEntryTitle(latestMessage))
        : segment.summary.latestTitle;
}

export function getActivityTimelineRowKey(
    sessionId: string | null | undefined,
    rowId: string,
): string {
    return `${sessionId ?? DETACHED_ACTIVITY_TIMELINE_SCOPE}:${rowId}`;
}

export function buildActivityTimelineRows(
    messages: readonly AIChatMessage[],
    displayMode: ActivityDisplayMode = "collapsed",
): ActivityTimelineRow[] {
    const rows: ActivityTimelineRow[] = [];
    let segmentEntries: ActivityTimelineToolEntry[] = [];

    const flushSegment = () => {
        const firstEntry = segmentEntries[0];
        if (!firstEntry) {
            return;
        }

        rows.push({
            entries: segmentEntries,
            id: `activity-segment:${firstEntry.message.id}`,
            kind: "activity-segment",
            summary: buildActivityTimelineSegmentSummary(segmentEntries),
        });
        segmentEntries = [];
    };

    for (const message of messages) {
        if (isActivityTimelineEntry(message)) {
            const entry = {
                message,
                policy: getActivityTimelineToolPolicy(message),
            };

            if (displayMode === "hidden" && entry.policy === "groupable") {
                continue;
            }

            segmentEntries.push(entry);
            continue;
        }

        flushSegment();
        rows.push({
            id: message.id,
            kind: "message",
            message,
        });
    }

    flushSegment();
    return rows;
}

function pluralize(count: number, singular: string, plural = `${singular}s`) {
    return `${count} ${count === 1 ? singular : plural}`;
}
