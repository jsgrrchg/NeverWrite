import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderComponent } from "../../../test/test-utils";
import type { AIChatMessage } from "../types";
import { AIChatMessageList } from "./AIChatMessageList";
import { resetChatMessageListViewState } from "./chatMessageListViewState";
import { resetChatRowUiStore } from "../store/chatRowUiStore";
import { useChatStore } from "../store/chatStore";
import { AI_CHAT_CONTENT_MAX_WIDTH_PX } from "./chatContentLayout";

function createMessages(): AIChatMessage[] {
    return [
        {
            id: "status:turn-1",
            role: "system",
            kind: "status",
            title: "New turn",
            content: "New turn",
            timestamp: Date.now() - 632_000,
            meta: {
                status_event: "turn_started",
                status: "completed",
                emphasis: "neutral",
            },
        },
        {
            id: "assistant:1",
            role: "assistant",
            kind: "text",
            content: "Working on it",
            timestamp: Date.now() - 1000,
        },
    ];
}

function createLongTranscript(count: number): AIChatMessage[] {
    return Array.from({ length: count }, (_, index) => ({
        id: `assistant:${index}`,
        role: "assistant" as const,
        kind: "text" as const,
        content: `Long message ${index}`,
        timestamp: index + 1,
    }));
}

function configureScrollableViewport(
    container: HTMLElement,
    height = 320,
    options?: {
        getWidth?: () => number;
        width?: number;
        getScrollHeight?: () => number;
    },
) {
    let currentScrollTop = container.scrollTop;

    Object.defineProperty(container, "clientHeight", {
        configurable: true,
        get: () => height,
    });
    Object.defineProperty(container, "scrollHeight", {
        configurable: true,
        get: () => options?.getScrollHeight?.() ?? 12_000,
    });
    Object.defineProperty(container, "clientWidth", {
        configurable: true,
        get: () => options?.getWidth?.() ?? options?.width ?? 420,
    });
    Object.defineProperty(container, "scrollTop", {
        configurable: true,
        get: () => currentScrollTop,
        set: (value: number) => {
            currentScrollTop = value;
        },
    });

    act(() => {
        window.dispatchEvent(new Event("resize"));
    });
}

function getScrollContainer(root: HTMLElement) {
    const container = root.querySelector(
        '[data-scrollbar-active="true"]',
    ) as HTMLDivElement | null;
    expect(container).not.toBeNull();
    return container!;
}

function getMessageColumn(root: HTMLElement) {
    const column = root.querySelector(
        '[data-selectable="true"]',
    ) as HTMLDivElement | null;
    expect(column).not.toBeNull();
    return column!;
}

function expectSharedChatContentColumn(element: HTMLElement) {
    expect(element).toHaveStyle({
        width: "100%",
        maxWidth: `${AI_CHAT_CONTENT_MAX_WIDTH_PX}px`,
        marginInline: "auto",
    });
}

describe("AIChatMessageList streaming run indicator", () => {
    afterEach(() => {
        vi.useRealTimers();
        resetChatMessageListViewState();
        resetChatRowUiStore();
        useChatStore.setState({ toolActivityDisplayMode: "collapsed" });
    });

    it("keeps reasoning, web, edit, and MCP activity in one chronological rail", () => {
        renderComponent(
            <AIChatMessageList
                messages={[
                    {
                        content: "Checking sources",
                        id: "thinking:1",
                        kind: "thinking",
                        role: "assistant",
                        timestamp: 1,
                        title: "Thinking",
                    },
                    {
                        content: "Search: site:aljazeera.com",
                        id: "tool:web",
                        kind: "tool",
                        meta: {
                            status: "completed",
                            target: "site:aljazeera.com",
                            tool: "web_search",
                        },
                        role: "assistant",
                        timestamp: 2,
                        title: "Web search",
                    },
                    {
                        content: "Comparing results",
                        id: "thinking:2",
                        kind: "thinking",
                        role: "assistant",
                        timestamp: 3,
                        title: "Thinking",
                    },
                    {
                        content: "Updated daily.md",
                        id: "tool:edit",
                        kind: "tool",
                        meta: {
                            status: "completed",
                            target: "/vault/daily.md",
                            tool: "edit",
                        },
                        role: "assistant",
                        timestamp: 4,
                        title: "Edit daily note",
                    },
                    {
                        content: "Fetched market data",
                        id: "tool:mcp",
                        kind: "tool",
                        meta: {
                            status: "completed",
                            tool: "mcp_market_data",
                        },
                        role: "assistant",
                        timestamp: 5,
                        title: "Query market MCP",
                    },
                ]}
                status="idle"
            />,
        );

        expect(document.querySelectorAll("[data-activity-rail]")).toHaveLength(1);
        expect(document.querySelector("[data-activity-count]")).toHaveAttribute(
            "data-activity-count",
            "3",
        );

        fireEvent.click(
            screen.getByRole("button", { name: /show full activity/i }),
        );

        expect(
            Array.from(
                document.querySelectorAll<HTMLElement>("[data-chat-message-id]"),
            ).map((entry) => entry.dataset.chatMessageId),
        ).toEqual(["thinking:1", "tool:web", "thinking:2", "tool:edit", "tool:mcp"]);
    });

    it("renders the elapsed timer during streaming and hides it when the run ends", () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-03-12T15:00:00Z"));

        const messages = createMessages();
        const view = renderComponent(
            <AIChatMessageList messages={messages} status="streaming" />,
        );

        expect(screen.getByTestId("streaming-run-indicator")).toHaveTextContent(
            "10m 32s",
        );

        act(() => {
            vi.advanceTimersByTime(2_000);
        });

        expect(screen.getByTestId("streaming-run-indicator")).toHaveTextContent(
            "10m 34s",
        );

        // When status becomes idle, the live indicator disappears.
        // The elapsed time is now stamped on the turn_started message by the store.
        view.rerender(<AIChatMessageList messages={messages} status="idle" />);

        expect(
            screen.queryByTestId("streaming-run-indicator"),
        ).not.toBeInTheDocument();
    });

    it("does not render turn-start markers after a run completes", () => {
        const messages: AIChatMessage[] = [
            {
                id: "status:turn-1",
                role: "system",
                kind: "status",
                title: "New turn",
                content: "New turn",
                timestamp: Date.now() - 45_000,
                meta: {
                    status_event: "turn_started",
                    status: "completed",
                    emphasis: "neutral",
                    elapsed_ms: 45_000,
                },
            },
            {
                id: "assistant:1",
                role: "assistant",
                kind: "text",
                content: "Done",
                timestamp: Date.now(),
            },
        ];

        renderComponent(
            <AIChatMessageList messages={messages} status="idle" />,
        );

        expect(screen.queryByText("New turn")).not.toBeInTheDocument();
        expect(screen.queryByText("45s")).not.toBeInTheDocument();
        expect(screen.getByText("Done")).toBeInTheDocument();
    });

    it("falls back to the latest user message when the turn-start event is missing", () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-03-12T15:00:00Z"));

        const messages: AIChatMessage[] = [
            {
                id: "user:1",
                role: "user",
                kind: "text",
                content: "Please continue",
                timestamp: Date.now() - 17_000,
            },
            {
                id: "assistant:1",
                role: "assistant",
                kind: "text",
                content: "Working on it",
                timestamp: Date.now() - 1_000,
            },
        ];

        renderComponent(
            <AIChatMessageList messages={messages} status="streaming" />,
        );

        expect(screen.getByTestId("streaming-run-indicator")).toHaveTextContent(
            "17s",
        );
    });

    it("applies the selected chat font family to message content", () => {
        const view = renderComponent(
            <AIChatMessageList
                messages={createMessages()}
                status="idle"
                chatFontFamily="typewriter"
            />,
        );

        const messageColumn = getMessageColumn(view.container);

        expectSharedChatContentColumn(messageColumn);
        expect(messageColumn).toHaveStyle({
            fontFamily:
                '"American Typewriter", "Courier Prime", "Courier New", "Nimbus Mono PS", monospace',
        });
    });

    it("constrains the transcript content while keeping the scroll container full-width", () => {
        const view = renderComponent(
            <AIChatMessageList
                sessionId="session-column"
                messages={createMessages()}
                status="idle"
            />,
        );

        const scrollContainer = getScrollContainer(view.container);
        const messageColumn = getMessageColumn(view.container);

        expect(scrollContainer).toHaveClass("flex-1");
        expectSharedChatContentColumn(messageColumn);
    });

    it.each([
        ["narrow", 320],
        ["wide", 1200],
    ])(
        "keeps the shared transcript column responsive in a %s panel",
        (_label, width) => {
            const view = renderComponent(
                <AIChatMessageList
                    sessionId={`session-${width}`}
                    messages={createMessages()}
                    status="idle"
                />,
            );
            const scrollContainer = getScrollContainer(view.container);
            configureScrollableViewport(scrollContainer, 320, { width });

            expect(scrollContainer.clientWidth).toBe(width);
            expectSharedChatContentColumn(getMessageColumn(view.container));
        },
    );

    it("keeps the shared transcript column during width-change scroll anchoring", () => {
        let width = 1200;
        const messages = createLongTranscript(80);
        const view = renderComponent(
            <AIChatMessageList
                sessionId="session-resize-column"
                messages={messages}
                status="idle"
            />,
        );
        const scrollContainer = getScrollContainer(view.container);
        configureScrollableViewport(scrollContainer, 320, {
            getWidth: () => width,
        });

        act(() => {
            scrollContainer.scrollTop = 2_400;
            scrollContainer.dispatchEvent(new Event("scroll"));
        });

        width = 360;
        act(() => {
            window.dispatchEvent(new Event("resize"));
        });

        expect(scrollContainer.clientWidth).toBe(360);
        expectSharedChatContentColumn(getMessageColumn(view.container));
    });

    it("keeps empty new chats top-aligned", () => {
        const view = renderComponent(
            <AIChatMessageList
                sessionId="session-empty"
                messages={[]}
                status="idle"
            />,
        );

        expect(
            view.container.querySelector('[data-selectable="true"]'),
        ).not.toHaveClass("mt-auto");
    });

    it("keeps short transcripts top-aligned", () => {
        const view = renderComponent(
            <AIChatMessageList
                sessionId="session-short"
                messages={createMessages()}
                status="idle"
            />,
        );

        expect(getScrollContainer(view.container)).toHaveClass("flex-col");
        expect(
            view.container.querySelector('[data-selectable="true"]'),
        ).not.toHaveClass("mt-auto");
    });

    it("keeps the transcript top-aligned while older messages can load", () => {
        const view = renderComponent(
            <AIChatMessageList
                sessionId="session-short-with-older"
                messages={createMessages()}
                status="idle"
                hasOlderMessages
            />,
        );

        expect(
            view.container.querySelector('[data-selectable="true"]'),
        ).not.toHaveClass("mt-auto");
    });

    it("renders long transcripts while keeping the scrolled region accessible", () => {
        const messages = createLongTranscript(140);
        const view = renderComponent(
            <AIChatMessageList
                sessionId="session-long"
                messages={messages}
                status="idle"
            />,
        );
        const scrollContainer = getScrollContainer(view.container);
        configureScrollableViewport(scrollContainer);

        act(() => {
            scrollContainer.scrollTop = 11_000;
            scrollContainer.dispatchEvent(new Event("scroll"));
        });

        expect(
            view.container.querySelectorAll('[data-chat-row="true"]').length,
        ).toBe(140);
        expect(screen.getByText("Long message 0")).toBeInTheDocument();
        expect(screen.getByText("Long message 139")).toBeInTheDocument();
    });

    it("scopes row keys by session id", () => {
        const messages = createLongTranscript(140);
        const view = renderComponent(
            <AIChatMessageList
                sessionId="session-a"
                messages={messages}
                status="idle"
            />,
        );
        const scrollContainer = getScrollContainer(view.container);
        configureScrollableViewport(scrollContainer);

        act(() => {
            scrollContainer.scrollTop = 11_000;
            scrollContainer.dispatchEvent(new Event("scroll"));
        });

        const initialKeys = Array.from(
            view.container.querySelectorAll("[data-chat-row-key]"),
        ).map((node) => node.getAttribute("data-chat-row-key"));
        expect(initialKeys.every((key) => key?.startsWith("session-a:"))).toBe(
            true,
        );

        view.rerender(
            <AIChatMessageList
                sessionId="session-b"
                messages={messages}
                status="idle"
            />,
        );

        const nextKeys = Array.from(
            view.container.querySelectorAll("[data-chat-row-key]"),
        ).map((node) => node.getAttribute("data-chat-row-key"));
        expect(nextKeys.every((key) => key?.startsWith("session-b:"))).toBe(
            true,
        );
    });

    it("requests older persisted messages when the user scrolls near the top", () => {
        const onLoadOlderMessages = vi.fn();
        const messages = createLongTranscript(140);
        const view = renderComponent(
            <AIChatMessageList
                sessionId="session-lazy"
                messages={messages}
                status="idle"
                hasOlderMessages
                onLoadOlderMessages={onLoadOlderMessages}
            />,
        );
        const scrollContainer = getScrollContainer(view.container);
        configureScrollableViewport(scrollContainer);

        act(() => {
            scrollContainer.scrollTop = 0;
            scrollContainer.dispatchEvent(new Event("scroll"));
        });

        expect(onLoadOlderMessages).toHaveBeenCalledTimes(1);
        expect(
            screen.getByText("Scroll up to load earlier messages"),
        ).toBeInTheDocument();
    });

    it("preserves the viewport when older persisted messages are prepended", () => {
        const onLoadOlderMessages = vi.fn();
        let scrollHeight = 1_000;
        const latestMessages = Array.from({ length: 20 }, (_, index) => ({
            id: `assistant:${index + 60}`,
            role: "assistant" as const,
            kind: "text" as const,
            content: `Loaded message ${index + 60}`,
            timestamp: index + 60,
        }));
        const prependedMessages = Array.from({ length: 80 }, (_, index) => ({
            id: `assistant:${index}`,
            role: "assistant" as const,
            kind: "text" as const,
            content: `Loaded message ${index}`,
            timestamp: index,
        }));

        const view = renderComponent(
            <AIChatMessageList
                sessionId="session-prepend"
                messages={latestMessages}
                status="idle"
                hasOlderMessages
                onLoadOlderMessages={onLoadOlderMessages}
            />,
        );
        const scrollContainer = getScrollContainer(view.container);
        configureScrollableViewport(scrollContainer, 320, {
            getScrollHeight: () => scrollHeight,
        });

        act(() => {
            scrollContainer.scrollTop = 90;
            scrollContainer.dispatchEvent(new Event("scroll"));
        });

        expect(onLoadOlderMessages).toHaveBeenCalledTimes(1);

        scrollHeight = 1_420;
        view.rerender(
            <AIChatMessageList
                sessionId="session-prepend"
                messages={prependedMessages}
                status="idle"
                hasOlderMessages={false}
                isLoadingOlderMessages={false}
                onLoadOlderMessages={onLoadOlderMessages}
            />,
        );

        expect(scrollContainer.scrollTop).toBe(510);
    });

    it("restores the previous scroll position when the chat list remounts for the same session", () => {
        const messages = createLongTranscript(140);
        const firstMount = renderComponent(
            <AIChatMessageList
                sessionId="session-remount"
                messages={messages}
                status="idle"
            />,
        );
        const firstScrollContainer = getScrollContainer(firstMount.container);
        configureScrollableViewport(firstScrollContainer);

        act(() => {
            firstScrollContainer.scrollTop = 4_320;
            firstScrollContainer.dispatchEvent(new Event("scroll"));
        });

        firstMount.unmount();

        const secondMount = renderComponent(
            <AIChatMessageList
                sessionId="session-remount"
                messages={messages}
                status="idle"
            />,
        );
        const secondScrollContainer = getScrollContainer(secondMount.container);
        configureScrollableViewport(secondScrollContainer);

        secondMount.rerender(
            <AIChatMessageList
                sessionId="session-remount"
                messages={[...messages]}
                status="idle"
            />,
        );

        expect(secondScrollContainer.scrollTop).toBe(4_320);
    });

    it("keeps non-visible diff work cycles as rich cards", () => {
        const messages: AIChatMessage[] = [
            {
                id: "tool:oldest",
                role: "assistant",
                kind: "tool",
                content: "Updated oldest.ts",
                title: "Edit oldest",
                timestamp: 1,
                workCycleId: "cycle-oldest",
                diffs: [
                    {
                        path: "/vault/src/oldest.ts",
                        kind: "update",
                        old_text: "oldest old",
                        new_text: "oldest new",
                    },
                ],
                meta: {
                    tool: "edit",
                    status: "completed",
                    target: "/vault/src/oldest.ts",
                },
            },
            {
                id: "tool:older",
                role: "assistant",
                kind: "tool",
                content: "Updated older.ts",
                title: "Edit older",
                timestamp: 2,
                workCycleId: "cycle-older",
                diffs: [
                    {
                        path: "/vault/src/older.ts",
                        kind: "update",
                        old_text: "older old",
                        new_text: "older new",
                    },
                ],
                meta: {
                    tool: "edit",
                    status: "completed",
                    target: "/vault/src/older.ts",
                },
            },
            {
                id: "tool:recent",
                role: "assistant",
                kind: "tool",
                content: "Updated recent.ts",
                title: "Edit recent",
                timestamp: 3,
                workCycleId: "cycle-recent",
                diffs: [
                    {
                        path: "/vault/src/recent.ts",
                        kind: "update",
                        old_text: "recent old",
                        new_text: "recent new",
                    },
                ],
                meta: {
                    tool: "edit",
                    status: "completed",
                    target: "/vault/src/recent.ts",
                },
            },
            {
                id: "tool:current",
                role: "assistant",
                kind: "tool",
                content: "Updated current.ts",
                title: "Edit current",
                timestamp: 4,
                workCycleId: "cycle-current",
                diffs: [
                    {
                        path: "/vault/src/current.ts",
                        kind: "update",
                        old_text: "current old",
                        new_text: "current new",
                    },
                ],
                meta: {
                    tool: "edit",
                    status: "completed",
                    target: "/vault/src/current.ts",
                },
            },
        ];

        renderComponent(
            <AIChatMessageList
                sessionId="session-recent-cycles"
                messages={messages}
                status="idle"
                visibleWorkCycleId="cycle-current"
            />,
        );

        expect(screen.queryByTestId("recent-diff-badge")).toBeNull();
        expect(screen.queryByTestId("historical-diff-summary")).toBeNull();
        expect(screen.queryByText("Earlier change")).not.toBeInTheDocument();

        fireEvent.click(
            screen.getByRole("button", { name: /show full activity/i }),
        );

        expect(
            document.querySelector('[data-change-review-path="/vault/src/oldest.ts"]'),
        ).toBeInTheDocument();
        expect(
            document.querySelector('[data-change-review-path="/vault/src/older.ts"]'),
        ).toBeInTheDocument();
        expect(
            document.querySelector('[data-change-review-path="/vault/src/recent.ts"]'),
        ).toBeInTheDocument();
        expect(
            document.querySelector('[data-change-review-path="/vault/src/current.ts"]'),
        ).toBeInTheDocument();
    });

    it("lets the user dismiss the pinned plan banner and keeps the plan in the timeline", () => {
        const now = Date.now();
        const messages: AIChatMessage[] = [
            {
                id: "user:plan",
                role: "user",
                kind: "text",
                content: "Please make a plan",
                timestamp: now - 2_000,
            },
            {
                id: "plan:active",
                role: "assistant",
                kind: "plan",
                title: "Plan",
                content: "Inspect\nImplement",
                timestamp: now - 1_000,
                planEntries: [
                    {
                        content: "Inspect",
                        priority: "medium",
                        status: "completed",
                    },
                    {
                        content: "Implement",
                        priority: "medium",
                        status: "in_progress",
                    },
                ],
            },
            {
                id: "assistant:done",
                role: "assistant",
                kind: "text",
                content: "Started implementation",
                timestamp: now,
            },
        ];

        const view = renderComponent(
            <AIChatMessageList
                sessionId="session-dismiss-plan"
                messages={messages}
                status="idle"
            />,
        );

        expect(screen.getAllByText("Implement")).toHaveLength(1);
        expectSharedChatContentColumn(
            screen.getByTestId("chat-pinned-plan-column"),
        );
        expect(
            view.container.querySelector('[aria-label="Dismiss plan banner"]'),
        ).not.toBeNull();

        act(() => {
            fireEvent.click(screen.getByLabelText("Dismiss plan banner"));
        });

        expect(
            screen.queryByLabelText("Dismiss plan banner"),
        ).not.toBeInTheDocument();
        expect(screen.getAllByText("Implement")).toHaveLength(1);
        expect(screen.getByText("Started implementation")).toBeInTheDocument();
    });

    it("scrolls to a requested chat message row and highlights it", async () => {
        const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
        const scrollIntoView = vi.fn();
        Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
            value: scrollIntoView,
            configurable: true,
        });

        const messages: AIChatMessage[] = [
            {
                id: "user-1",
                role: "user",
                kind: "text",
                content: "First prompt",
                timestamp: 10,
            },
            {
                id: "user-2",
                role: "user",
                kind: "text",
                content: "Second prompt",
                timestamp: 20,
            },
        ];
        const onComplete = vi.fn();

        try {
            const view = renderComponent(
                <AIChatMessageList
                    sessionId="session-outline"
                    messages={messages}
                    status="idle"
                    scrollToMessageId="user-2"
                    onScrollToMessageComplete={onComplete}
                />,
            );

            await waitFor(() => {
                expect(scrollIntoView).toHaveBeenCalledWith({
                    block: "center",
                    behavior: "smooth",
                });
                expect(onComplete).toHaveBeenCalledTimes(1);
            });

            expect(
                view.container.querySelector(
                    '[data-chat-message-id="user-2"]',
                ),
            ).toHaveAttribute("data-chat-outline-active", "true");
        } finally {
            Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
                value: originalScrollIntoView,
                configurable: true,
            });
        }
    });

    it("groups consecutive tools into a collapsed activity rail", () => {
        const messages: AIChatMessage[] = [
            {
                id: "user:prompt",
                role: "user",
                kind: "text",
                content: "Inspect the project",
                timestamp: 1,
            },
            {
                id: "tool:read",
                role: "assistant",
                kind: "tool",
                content: "Read package.json",
                title: "Read package.json",
                timestamp: 2,
                meta: {
                    status: "completed",
                    target: "/vault/package.json",
                    tool: "read",
                },
            },
            {
                id: "tool:search",
                role: "assistant",
                kind: "tool",
                content: "Search for review",
                title: "Search for review",
                timestamp: 3,
                meta: {
                    status: "completed",
                    tool: "grep",
                },
            },
            {
                id: "assistant:answer",
                role: "assistant",
                kind: "text",
                content: "The review flow is ready.",
                timestamp: 4,
            },
        ];

        const view = renderComponent(
            <AIChatMessageList
                sessionId="session-activity-rail"
                messages={messages}
                status="idle"
            />,
        );

        expect(
            view.container.querySelectorAll('[data-chat-row="true"]'),
        ).toHaveLength(3);
        expect(
            view.container.querySelector('[data-activity-rail="true"]'),
        ).toHaveAttribute("data-activity-count", "2");
        expect(
            view.container.querySelectorAll("[data-tool-activity-id]"),
        ).toHaveLength(0);

        fireEvent.click(
            screen.getByRole("button", { name: /show full activity/i }),
        );

        expect(
            view.container.querySelectorAll("[data-tool-activity-id]"),
        ).toHaveLength(2);
        expect(
            view.container.querySelector('[data-chat-message-id="tool:read"]'),
        ).not.toBeNull();
        expect(
            view.container.querySelector('[data-chat-message-id="tool:search"]'),
        ).not.toBeNull();
    });

    it("hides routine activity while preserving changes, failures, and subagents", () => {
        useChatStore.setState({ toolActivityDisplayMode: "hidden" });
        const view = renderComponent(
            <AIChatMessageList
                sessionId="session-hidden-activity"
                status="idle"
                messages={[
                    {
                        id: "tool:read",
                        role: "assistant",
                        kind: "tool",
                        content: "Read notes",
                        timestamp: 1,
                        meta: { status: "completed", tool: "read" },
                    },
                    {
                        id: "tool:search",
                        role: "assistant",
                        kind: "tool",
                        content: "Search notes",
                        timestamp: 2,
                        meta: { status: "completed", tool: "search" },
                    },
                    {
                        id: "tool:edit",
                        role: "assistant",
                        kind: "tool",
                        content: "Edited notes",
                        timestamp: 3,
                        meta: { status: "completed", tool: "edit" },
                    },
                    {
                        id: "status:subagent",
                        role: "system",
                        kind: "status",
                        content: "Subagent completed",
                        timestamp: 4,
                        title: "Analyst completed",
                        meta: {
                            status: "completed",
                            status_event: "subagent_lifecycle",
                        },
                    },
                    {
                        id: "tool:failed",
                        role: "assistant",
                        kind: "tool",
                        content: "Command failed",
                        timestamp: 5,
                        meta: { status: "failed", tool: "command" },
                    },
                    {
                        id: "tool:subagent",
                        role: "assistant",
                        kind: "tool",
                        content: "Spawned analyst",
                        timestamp: 6,
                        meta: { status: "completed", tool: "other" },
                        toolAction: {
                            kind: "open_session",
                            session_id: "child-session",
                        },
                    },
                ]}
            />,
        );

        expect(
            Array.from(
                view.container.querySelectorAll<HTMLElement>(
                    "[data-tool-activity-id]",
                ),
            ).map((entry) => entry.dataset.toolActivityId),
        ).toEqual([
            "tool:edit",
            "status:subagent",
            "tool:failed",
            "tool:subagent",
        ]);
    });

    it("does not mark a completed change as active when hidden routine work follows it", () => {
        useChatStore.setState({ toolActivityDisplayMode: "hidden" });
        const view = renderComponent(
            <AIChatMessageList
                sessionId="session-hidden-active-tail"
                status="streaming"
                messages={[
                    {
                        id: "tool:edit",
                        role: "assistant",
                        kind: "tool",
                        content: "Edited notes",
                        timestamp: 1,
                        meta: { status: "completed", tool: "edit" },
                    },
                    {
                        id: "tool:read",
                        role: "assistant",
                        kind: "tool",
                        content: "Reading context",
                        timestamp: 2,
                        meta: {
                            status: "in_progress",
                            tool: "read",
                        },
                    },
                ]}
            />,
        );

        expect(
            view.container.querySelector('[data-activity-rail="true"]'),
        ).toHaveAttribute("aria-busy", "false");
        expect(screen.queryByText(/working/i)).not.toBeInTheDocument();
    });

    it("opens a hidden routine rail when the outline targets one of its tools", async () => {
        useChatStore.setState({ toolActivityDisplayMode: "hidden" });
        const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
        const scrollIntoView = vi.fn();
        Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
            value: scrollIntoView,
            configurable: true,
        });
        const messages: AIChatMessage[] = [
            createMessages()[0]!,
            {
                id: "tool:outline",
                role: "assistant",
                kind: "tool",
                content: "Read context",
                title: "Read context",
                timestamp: 2,
                meta: {
                    status: "completed",
                    target: "/vault/context.md",
                    tool: "read",
                },
            },
        ];

        try {
            const view = renderComponent(
                <AIChatMessageList
                    sessionId="session-activity-outline"
                    messages={messages}
                    status="idle"
                    scrollToMessageId="tool:outline"
                />,
            );

            await waitFor(() => {
                expect(scrollIntoView).toHaveBeenCalledWith({
                    block: "center",
                    behavior: "smooth",
                });
            });

            expect(
                view.container.querySelector(
                    '[data-chat-message-id="tool:outline"]',
                ),
            ).toHaveAttribute("data-chat-outline-active", "true");

            view.rerender(
                <AIChatMessageList
                    sessionId="session-activity-outline"
                    messages={messages}
                    status="idle"
                />,
            );

            expect(
                view.container.querySelector('[data-tool-activity-id="tool:outline"]'),
            ).toBeNull();
        } finally {
            Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
                value: originalScrollIntoView,
                configurable: true,
            });
        }
    });

    it("expands rails while find searches tool activity", async () => {
        useChatStore.setState({ toolActivityDisplayMode: "hidden" });
        const view = renderComponent(
            <AIChatMessageList
                sessionId="session-activity-find"
                messages={[
                    {
                        id: "tool:find",
                        role: "assistant",
                        kind: "tool",
                        content: "Read hidden context",
                        title: "Read hidden context",
                        timestamp: 1,
                        meta: {
                            status: "completed",
                            target: "/vault/context.md",
                            tool: "read",
                        },
                    },
                ]}
                status="idle"
                findOpen
            />,
        );

        expect(
            view.container.querySelectorAll("[data-tool-activity-id]"),
        ).toHaveLength(0);

        fireEvent.change(screen.getByRole("textbox", { name: "Find in chat" }), {
            target: { value: "hidden context" },
        });

        await waitFor(() => {
            expect(
                view.container.querySelector('[data-tool-activity-id="tool:find"]'),
            ).not.toBeNull();
        });
    });
});
