import { fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { renderComponent } from "../../../test/test-utils";
import { resetChatStore } from "../store/chatStore";
import { resetChatRowUiStore } from "../store/chatRowUiStore";
import type { AIChatMessage } from "../types";
import { ToolActivityItem } from "./ToolActivityItem";

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
            tool: "read",
        },
        role: "assistant",
        timestamp: Date.now(),
        title: "Read file",
        ...overrides,
    };
}

afterEach(() => {
    resetChatStore();
    resetChatRowUiStore();
});

describe("ToolActivityItem", () => {
    it("renders read and search targets as compact routine rows", () => {
        const view = renderComponent(
            <div>
                <ToolActivityItem
                    message={createTool("tool:read", {
                        meta: {
                            status: "completed",
                            target: "/vault/src/reader.ts",
                            tool: "read",
                        },
                    })}
                    sessionId="session-1"
                />
                <ToolActivityItem
                    message={createTool("tool:search", {
                        meta: {
                            status: "completed",
                            target: "/vault/src/search.ts",
                            tool: "search",
                        },
                        title: "Search source",
                    })}
                    sessionId="session-1"
                />
            </div>,
        );

        expect(screen.getByText("reader.ts")).toBeInTheDocument();
        expect(screen.getByText("search.ts")).toBeInTheDocument();
        expect(screen.getByText("Read")).toBeInTheDocument();
        expect(screen.getByText("Searched")).toBeInTheDocument();
        expect(
            view.container.querySelectorAll(
                '[data-tool-activity-operation-icon="true"]',
            ),
        ).toHaveLength(2);
        expect(
            view.container.querySelectorAll(
                '[data-tool-activity-file-icon="true"]',
            ),
        ).toHaveLength(2);
        expect(
            view.container.querySelectorAll('[data-tool-activity-row="routine"]'),
        ).toHaveLength(2);
    });

    it("gives web and MCP tools their own semantic activity treatment", () => {
        const view = renderComponent(
            <div>
                <ToolActivityItem
                    message={createTool("tool:web", {
                        meta: {
                            status: "completed",
                            target: "https://example.com/search?q=markets",
                            tool: "web_search",
                        },
                        title: "Web search",
                    })}
                    sessionId="session-1"
                />
                <ToolActivityItem
                    message={createTool("tool:mcp", {
                        meta: {
                            status: "completed",
                            tool: "mcp_browser_query",
                        },
                        title: "Query browser MCP",
                    })}
                    sessionId="session-1"
                />
            </div>,
        );

        expect(screen.getByText("Searched")).toBeInTheDocument();
        expect(screen.getByText("Query browser MCP")).toBeInTheDocument();
        expect(
            view.container.querySelector('[data-tool-activity-source="web"]'),
        ).toBeInTheDocument();
        expect(
            view.container.querySelector('[data-tool-activity-source="mcp"]'),
        ).toBeInTheDocument();
    });

    it("recognizes MCP activity when ACP reports it as an other tool", () => {
        const view = renderComponent(
            <ToolActivityItem
                message={createTool("tool:mcp-other", {
                    meta: { status: "completed", tool: "other" },
                    title: "Tool: codex_apps/binance_get_futures_usds_mark_price",
                })}
                sessionId="session-1"
            />,
        );

        expect(
            view.container.querySelector('[data-tool-activity-source="mcp"]'),
        ).toBeInTheDocument();
    });

    it("discloses command detail without changing the row identity", () => {
        const view = renderComponent(
            <ToolActivityItem
                message={createTool("tool:command", {
                    content: "pnpm --dir apps/desktop test",
                    meta: {
                        status: "completed",
                        tool: "command",
                    },
                    title: "Run desktop tests",
                })}
                sessionId="session-1"
            />,
        );

        const row = view.container.querySelector('[data-tool-activity-row]');
        expect(row).toHaveAttribute("role", "button");
        expect(screen.queryByText("pnpm --dir apps/desktop test")).toBeNull();

        fireEvent.click(row!);

        expect(
            screen.getByText("pnpm --dir apps/desktop test"),
        ).toBeInTheDocument();
        expect(row).toHaveAttribute("aria-expanded", "true");
    });

    it("keeps edits without diffs and failed tools visibly distinct", () => {
        const view = renderComponent(
            <div>
                <ToolActivityItem
                    message={createTool("tool:edit", {
                        meta: {
                            status: "completed",
                            target: "/vault/src/write.ts",
                            tool: "edit",
                        },
                        title: "Edit write",
                    })}
                    sessionId="session-1"
                />
                <ToolActivityItem
                    message={createTool("tool:failed", {
                        content: "Command exited with status 1",
                        meta: {
                            status: "failed",
                            tool: "command",
                        },
                        title: "Run validation",
                    })}
                    sessionId="session-1"
                />
            </div>,
        );

        expect(screen.getByText("write.ts")).toBeInTheDocument();
        expect(screen.getByText("Updated")).toBeInTheDocument();
        expect(screen.getByText("Failed")).toBeInTheDocument();
        expect(
            view.container.querySelector('[data-tool-activity-row="attention"]'),
        ).toHaveAttribute("data-tool-activity-status", "failed");
    });

    it("preserves the open-session breadcrumb for subagent activity", () => {
        renderComponent(
            <ToolActivityItem
                message={createTool("tool:subagent", {
                    content: "Spawned Worker",
                    meta: {
                        status: "completed",
                        tool: "other",
                    },
                    title: "Spawned Worker",
                    toolAction: {
                        kind: "open_session",
                        session_id: "missing-child",
                    },
                })}
                sessionId="session-1"
            />,
        );

        expect(screen.getByRole("button", { name: "Open Worker" })).toBeDisabled();
    });
});
