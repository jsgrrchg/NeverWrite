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

    it("keeps changes, failures, and subagent breadcrumbs visible while routine work is collapsed", () => {
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

        expect(renderEntry).toHaveBeenCalledTimes(3);
        expect(
            document.querySelector('[data-tool-activity-id="tool:read"]'),
        ).toBeNull();
        expect(
            document.querySelectorAll('[data-tool-activity-visibility="always"]'),
        ).toHaveLength(3);
    });
});
