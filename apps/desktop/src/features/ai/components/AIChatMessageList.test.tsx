import { act, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderComponent } from "../../../test/test-utils";
import type { AIChatMessage } from "../types";
import { AIChatMessageList } from "./AIChatMessageList";

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
    let currentScrollTop = 0;

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

describe("AIChatMessageList streaming run indicator", () => {
    afterEach(() => {
        vi.useRealTimers();
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

    it("shows elapsed time on the turn_started divider when elapsed_ms is stamped", () => {
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

        // The elapsed time appears inline in the turn divider
        expect(screen.getByText("45s")).toBeInTheDocument();
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

        const messageColumn = view.container.querySelector(
            '[data-selectable="true"]',
        );

        expect(messageColumn).toHaveStyle({
            fontFamily:
                '"American Typewriter", "Courier Prime", "Courier New", "Nimbus Mono PS", monospace',
        });
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

    it("keeps only the two most recent non-visible diff work cycles as rich cards", () => {
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

        expect(screen.getAllByTestId("recent-diff-badge")).toHaveLength(2);
        expect(screen.getByText("Edited older.ts")).toBeInTheDocument();
        expect(screen.getByText("Edited recent.ts")).toBeInTheDocument();
        expect(screen.getByTestId("historical-diff-summary")).toHaveTextContent(
            "Edited oldest.ts",
        );
    });
});
