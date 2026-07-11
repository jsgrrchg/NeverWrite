import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderComponent } from "../../../test/test-utils";
import { resetChatRowUiStore } from "../store/chatRowUiStore";
import type { AIChatMessage } from "../types";
import {
    buildActivityTimelineRows,
    type ActivityTimelineSegmentRow,
} from "./activityTimelinePresentation";
import { ToolActivitySegment } from "./ToolActivitySegment";

function createTool(
    id: string,
    overrides: Partial<AIChatMessage> = {},
): AIChatMessage {
    return {
        content: id,
        id,
        kind: "tool",
        meta: {
            status: "completed",
            target: `src/${id}.ts`,
            tool: "read",
        },
        role: "assistant",
        timestamp: Number(id.match(/\d+/)?.[0] ?? "0"),
        title: `Read ${id}`,
        ...overrides,
    };
}

function createSegment(messages: AIChatMessage[]): ActivityTimelineSegmentRow {
    const segment = buildActivityTimelineRows(messages).find(
        (row): row is ActivityTimelineSegmentRow =>
            row.kind === "activity-segment",
    );
    if (!segment) {
        throw new Error("Expected an activity segment.");
    }
    return segment;
}

afterEach(() => {
    resetChatRowUiStore();
});

describe("ToolActivitySegment", () => {
    it("keeps entries unmounted until the user expands the rail", () => {
        const renderEntry = vi.fn((message: AIChatMessage) => (
            <div data-child-activity={message.id}>{message.title}</div>
        ));
        const segment = createSegment([
            createTool("tool-1"),
            createTool("tool-2"),
        ]);

        renderComponent(
            <ToolActivitySegment
                renderEntry={renderEntry}
                segment={segment}
                sessionId="session-1"
            />,
        );

        expect(renderEntry).not.toHaveBeenCalled();
        expect(screen.getByRole("button", { name: /show full activity/i })).toHaveAttribute(
            "aria-expanded",
            "false",
        );

        act(() => {
            fireEvent.click(
                screen.getByRole("button", { name: /show full activity/i }),
            );
        });

        expect(renderEntry).toHaveBeenCalledTimes(2);
        expect(
            document.querySelectorAll("[data-tool-activity-id]"),
        ).toHaveLength(2);
        expect(screen.getByRole("button", { name: /hide full activity/i })).toHaveAttribute(
            "aria-expanded",
            "true",
        );
    });

    it("renders reasoning, web, edit, and MCP entries in their original order", () => {
        const reasoning: AIChatMessage = {
            content: "Checking sources",
            id: "thinking-1",
            kind: "thinking",
            role: "assistant",
            timestamp: 1,
            title: "Thinking",
        };
        const webSearch = createTool("tool:web", {
            meta: {
                status: "completed",
                tool: "web_search",
            },
            timestamp: 2,
            title: "Web search",
        });
        const edit = createTool("tool:edit", {
            meta: {
                status: "completed",
                target: "src/note.ts",
                tool: "edit",
            },
            timestamp: 3,
            title: "Edit note",
        });
        const mcp = createTool("tool:mcp", {
            meta: {
                status: "completed",
                tool: "mcp_browser_query",
            },
            timestamp: 4,
            title: "Query browser MCP",
        });
        const renderEntry = vi.fn((message: AIChatMessage) => (
            <div>{message.id}</div>
        ));
        const segment = createSegment([reasoning, webSearch, edit, mcp]);

        renderComponent(
            <ToolActivitySegment
                renderEntry={renderEntry}
                segment={segment}
                sessionId="session-1"
            />,
        );

        renderEntry.mockClear();

        fireEvent.click(
            screen.getByRole("button", { name: /show full activity/i }),
        );

        expect(renderEntry.mock.calls.map(([message]) => message.id)).toEqual([
            "thinking-1",
            "tool:web",
            "tool:edit",
            "tool:mcp",
        ]);
    });

    it("uses current wording only for the active turn tail", () => {
        const segment = createSegment([createTool("tool-1")]);

        const view = renderComponent(
            <ToolActivitySegment
                isCurrentTurnTail
                renderEntry={(message) => <div>{message.title}</div>}
                segment={segment}
                sessionId="session-1"
            />,
        );

        expect(screen.getByText(/working/i)).toBeInTheDocument();
        expect(screen.getByText(/current:/i)).toBeInTheDocument();
        expect(
            view.container.querySelector("[data-tool-activity-segment]"),
        ).toHaveAttribute("aria-busy", "true");
    });

    it("expands when navigation targets one of its hidden tool messages", () => {
        const segment = createSegment([createTool("tool-1")]);

        renderComponent(
            <ToolActivitySegment
                forceExpandedMessageId="tool-1"
                highlightedMessageId="tool-1"
                renderEntry={(message) => <div>{message.title}</div>}
                segment={segment}
                sessionId="session-1"
            />,
        );

        expect(
            document.querySelector('[data-chat-message-id="tool-1"]'),
        ).toHaveAttribute("data-chat-outline-active", "true");
        expect(screen.getByRole("button", { name: /hide full activity/i })).toHaveAttribute(
            "aria-expanded",
            "true",
        );
    });

    it("keeps a large collapsed rail cheap to render", () => {
        const renderEntry = vi.fn((message: AIChatMessage) => (
            <div>{message.title}</div>
        ));
        const segment = createSegment(
            Array.from({ length: 50 }, (_, index) =>
                createTool(`tool-${index}`),
            ),
        );

        renderComponent(
            <ToolActivitySegment
                renderEntry={renderEntry}
                segment={segment}
                sessionId="session-1"
            />,
        );

        expect(renderEntry).not.toHaveBeenCalled();
        expect(
            document.querySelector("[data-activity-count]"),
        ).toHaveAttribute("data-activity-count", "50");
    });

    it("keeps failures and subagent breadcrumbs visible while changes stay collapsed", () => {
        const renderEntry = vi.fn((message: AIChatMessage) => (
            <div data-child-activity={message.id}>{message.title}</div>
        ));
        const segment = createSegment([
            createTool("tool:read"),
            createTool("tool:edit", {
                meta: {
                    status: "completed",
                    target: "src/edited.ts",
                    tool: "edit",
                },
            }),
            createTool("tool:failed", {
                meta: {
                    status: "failed",
                    tool: "command",
                },
            }),
            createTool("tool:subagent", {
                toolAction: {
                    kind: "open_session",
                    session_id: "child-session",
                },
            }),
        ]);

        renderComponent(
            <ToolActivitySegment
                renderEntry={renderEntry}
                segment={segment}
                sessionId="session-1"
            />,
        );

        expect(renderEntry).toHaveBeenCalledTimes(2);
        expect(
            document.querySelector('[data-tool-activity-id="tool:read"]'),
        ).toBeNull();
        expect(
            document.querySelector('[data-tool-activity-id="tool:edit"]'),
        ).toBeNull();
        expect(
            document.querySelectorAll('[data-tool-activity-visibility="always"]'),
        ).toHaveLength(2);
    });

    it("keeps routine MCP status and provider tools collapsed", () => {
        const renderEntry = vi.fn((message: AIChatMessage) => (
            <div data-child-activity={message.id}>{message.title}</div>
        ));
        const segment = createSegment([
            {
                content: "binance_get_futures_usds_mark_price",
                id: "status:mcp",
                kind: "status",
                meta: {
                    emphasis: "neutral",
                    status: "in_progress",
                    status_event: "item_activity",
                },
                role: "system",
                timestamp: 1,
                title: "Calling MCP tool",
            },
            createTool("tool:mcp", {
                meta: { status: "completed", tool: "other" },
                timestamp: 2,
                title: "Tool: codex_apps/binance_get_futures_usds_mark_price",
            }),
        ]);

        renderComponent(
            <ToolActivitySegment
                renderEntry={renderEntry}
                segment={segment}
                sessionId="session-1"
            />,
        );

        expect(renderEntry).not.toHaveBeenCalled();

        fireEvent.click(
            screen.getByRole("button", { name: /show full activity/i }),
        );

        expect(renderEntry.mock.calls.map(([message]) => message.id)).toEqual([
            "status:mcp",
            "tool:mcp",
        ]);
    });
});
