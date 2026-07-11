import { describe, expect, it } from "vitest";

import type { AIChatMessage, AIFileDiff } from "../types";
import {
    buildActivityTimelineRows,
    deriveActivityTimelineChangeStats,
    getActivityTimelineRowKey,
    getActivityTimelineSegmentHeadline,
    getActivityTimelineToolPolicy,
    type ActivityTimelineSegmentRow,
    type ActivityTimelineToolEntry,
} from "./activityTimelinePresentation";

function createMessage(
    id: string,
    overrides: Partial<AIChatMessage> = {},
): AIChatMessage {
    return {
        content: id,
        id,
        kind: "text",
        role: "assistant",
        timestamp: Number(id.match(/\d+/)?.[0] ?? "0"),
        ...overrides,
    };
}

function createTool(
    id: string,
    overrides: Partial<AIChatMessage> = {},
): AIChatMessage {
    return createMessage(id, {
        kind: "tool",
        meta: {
            status: "completed",
            tool: "read",
        },
        title: `Read ${id}`,
        ...overrides,
    });
}

function getOnlySegment(rows: ReturnType<typeof buildActivityTimelineRows>) {
    const segment = rows.find(
        (row): row is ActivityTimelineSegmentRow =>
            row.kind === "activity-segment",
    );
    if (!segment) {
        throw new Error("Expected an activity segment.");
    }
    return segment;
}

function createEntry(diff: AIFileDiff): ActivityTimelineToolEntry {
    return {
        message: createTool(`tool-${diff.path}`, {
            diffs: [diff],
            meta: {
                status: "completed",
                tool: "edit",
            },
        }),
        policy: "standalone-change",
    };
}

describe("buildActivityTimelineRows", () => {
    it("inserts one activity segment between surrounding text messages", () => {
        const before = createMessage("assistant-before");
        const firstTool = createTool("tool-1");
        const secondTool = createTool("tool-2", {
            meta: { status: "completed", tool: "grep" },
        });
        const after = createMessage("assistant-after");

        const rows = buildActivityTimelineRows([
            before,
            firstTool,
            secondTool,
            after,
        ]);

        expect(rows.map((row) => row.kind)).toEqual([
            "message",
            "activity-segment",
            "message",
        ]);
        const segment = getOnlySegment(rows);
        expect(segment.id).toBe("activity-segment:tool-1");
        expect(segment.entries.map((entry) => entry.message)).toEqual([
            firstTool,
            secondTool,
        ]);
        expect(segment.entries.map((entry) => entry.policy)).toEqual([
            "groupable",
            "groupable",
        ]);
    });

    it("keeps reasoning and tools in one chronological rail", () => {
        const reasoning = createMessage("thinking-1", {
            content: "Inspecting sources",
            kind: "thinking",
            title: "Thinking",
        });
        const webSearch = createTool("tool:web-search", {
            meta: { status: "completed", tool: "web_search" },
            title: "Web search",
        });
        const edit = createTool("tool:edit", {
            diffs: [
                {
                    kind: "update",
                    new_text: "after",
                    old_text: "before",
                    path: "/vault/note.md",
                },
            ],
            meta: { status: "completed", tool: "edit" },
            title: "Edit note",
        });
        const mcp = createTool("tool:mcp", {
            meta: { status: "completed", tool: "mcp_browser_query" },
            title: "Query browser MCP",
        });

        const rows = buildActivityTimelineRows([
            reasoning,
            webSearch,
            createMessage("thinking-2", {
                kind: "thinking",
                title: "Thinking",
            }),
            edit,
            mcp,
        ]);

        const segment = getOnlySegment(rows);
        expect(rows).toHaveLength(1);
        expect(segment.entries.map((entry) => entry.message)).toEqual([
            reasoning,
            webSearch,
            expect.objectContaining({ id: "thinking-2" }),
            edit,
            mcp,
        ]);
        expect(segment.entries.map((entry) => entry.policy)).toEqual([
            "groupable",
            "groupable",
            "groupable",
            "standalone-change",
            "standalone-unknown",
        ]);
        expect(segment.summary).toMatchObject({
            actionCount: 3,
            latestMessageId: "tool:mcp",
            reasoningCount: 2,
        });
    });

    it.each([
        "status",
        "permission",
        "error",
    ] as const)("uses %s messages as a segment boundary", (kind) => {
        const boundary = createMessage(`boundary-${kind}`, {
            kind,
            role: kind === "error" ? "system" : "assistant",
        });
        const rows = buildActivityTimelineRows([
            createTool("tool-1"),
            boundary,
            createTool("tool-2"),
        ]);

        expect(rows.map((row) => row.kind)).toEqual([
            "activity-segment",
            "message",
            "activity-segment",
        ]);
    });

    it("keeps a diff-bearing tool in the segment with its original message", () => {
        const tool = createTool("tool-edit", {
            diffs: [
                {
                    kind: "update",
                    new_text: "after",
                    old_text: "before",
                    path: "/vault/note.md",
                },
            ],
            meta: { status: "completed", tool: "edit" },
        });

        const segment = getOnlySegment(buildActivityTimelineRows([tool]));

        expect(segment.entries[0]?.message).toBe(tool);
        expect(segment.entries[0]?.policy).toBe("standalone-change");
        expect(segment.summary.changeStats).toEqual({
            additions: 1,
            approximate: false,
            deletions: 1,
        });
    });

    it("keeps mutating, failed, subagent, and unknown tools visible", () => {
        const messages = [
            createTool("tool-edit", {
                meta: { status: "in_progress", tool: "edit" },
            }),
            createTool("tool-failed", {
                meta: { status: "failed", tool: "shell" },
            }),
            createTool("tool-subagent", {
                meta: { status: "completed", tool: "other" },
                toolAction: {
                    kind: "open_session",
                    session_id: "child-session",
                },
            }),
            createTool("tool-unknown", {
                meta: { status: "completed", tool: "future_provider_tool" },
            }),
        ];

        const segment = getOnlySegment(buildActivityTimelineRows(messages));

        expect(segment.entries.map((entry) => entry.policy)).toEqual([
            "standalone-change",
            "standalone-attention",
            "standalone-attention",
            "standalone-unknown",
        ]);
        expect(segment.summary.isInProgress).toBe(true);
        expect(segment.summary.failureCount).toBe(1);
    });

    it("keeps segment identity stable when its trailing tool is updated", () => {
        const initialRows = buildActivityTimelineRows([
            createTool("tool-1"),
            createTool("tool-2", {
                meta: { status: "in_progress", tool: "shell" },
            }),
        ]);
        const completedRows = buildActivityTimelineRows([
            createTool("tool-1"),
            createTool("tool-2", {
                content: "Command completed",
                meta: { status: "completed", tool: "shell" },
            }),
        ]);

        const initialSegment = getOnlySegment(initialRows);
        const completedSegment = getOnlySegment(completedRows);

        expect(completedSegment.id).toBe(initialSegment.id);
        expect(completedSegment.id).toBe("activity-segment:tool-1");
        expect(getActivityTimelineRowKey("session-a", initialSegment.id)).not.toBe(
            getActivityTimelineRowKey("session-b", completedSegment.id),
        );
    });

    it("does not mutate the transcript input", () => {
        const messages = [
            createMessage("assistant-before"),
            createTool("tool-1", {
                diffs: [
                    {
                        kind: "update",
                        new_text: "after",
                        old_text: "before",
                        path: "/vault/note.md",
                    },
                ],
            }),
        ];
        const snapshot = structuredClone(messages);

        buildActivityTimelineRows(messages);

        expect(messages).toEqual(snapshot);
    });
});

describe("activity timeline summaries", () => {
    it("uses an exploration headline for read and search activity", () => {
        const segment = getOnlySegment(
            buildActivityTimelineRows([
                createTool("tool-read", {
                    meta: {
                        status: "completed",
                        target: "/vault/notes/context.md",
                        tool: "read",
                    },
                }),
                createTool("tool-search", {
                    meta: { status: "completed", tool: "search" },
                }),
            ]),
        );

        expect(getActivityTimelineSegmentHeadline(segment.summary)).toBe(
            "Explored 1 file · 1 search",
        );
    });

    it("calculates the net diff for compatible repeated file snapshots", () => {
        const stats = deriveActivityTimelineChangeStats([
            createEntry({
                kind: "update",
                new_text: "base\nfirst",
                old_text: "base",
                path: "/vault/note.md",
            }),
            createEntry({
                kind: "update",
                new_text: "base\nfirst\nsecond",
                old_text: "base",
                path: "/vault/note.md",
            }),
        ]);

        expect(stats).toEqual({
            additions: 2,
            approximate: false,
            deletions: 0,
        });
    });

    it("marks incomplete snapshots approximate instead of merging them", () => {
        const stats = deriveActivityTimelineChangeStats([
            createEntry({
                kind: "update",
                new_text: "after",
                path: "/vault/note.md",
            }),
        ]);

        expect(stats).toEqual({
            additions: 1,
            approximate: true,
            deletions: 0,
        });
    });
});

describe("getActivityTimelineToolPolicy", () => {
    it("treats successful commands as routine activity", () => {
        expect(
            getActivityTimelineToolPolicy(
                createTool("tool-command", {
                    meta: { status: "completed", tool: "shell" },
                }),
            ),
        ).toBe("groupable");
    });
});
