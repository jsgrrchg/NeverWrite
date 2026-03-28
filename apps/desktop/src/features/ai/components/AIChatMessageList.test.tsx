import { act, fireEvent, screen } from "@testing-library/react";
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

function mockVisibleRowRects(
    container: HTMLElement,
    rowTops: Record<string, number>,
    rowHeight = 80,
) {
    Object.defineProperty(container, "getBoundingClientRect", {
        configurable: true,
        value: () =>
            ({
                top: 0,
                bottom: 320,
                left: 0,
                right: 420,
                width: 420,
                height: 320,
                x: 0,
                y: 0,
                toJSON: () => ({}),
            }) satisfies DOMRect,
    });

    const rows = Array.from(
        container.querySelectorAll<HTMLElement>("[data-chat-row-key]"),
    );
    for (const row of rows) {
        const key = row.dataset.chatRowKey ?? "";
        const top = rowTops[key] ?? 500;
        Object.defineProperty(row, "getBoundingClientRect", {
            configurable: true,
            value: () =>
                ({
                    top,
                    bottom: top + rowHeight,
                    left: 0,
                    right: 420,
                    width: 420,
                    height: rowHeight,
                    x: 0,
                    y: top,
                    toJSON: () => ({}),
                }) satisfies DOMRect,
        });
    }
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

    it("virtualizes long transcripts while keeping the hot tail mounted", () => {
        const messages = createLongTranscript(140);
        const view = renderComponent(
            <AIChatMessageList
                sessionId="session-virtualized"
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
        ).toBeLessThan(140);
        expect(screen.queryByText("Long message 0")).not.toBeInTheDocument();
        expect(screen.getByText("Long message 139")).toBeInTheDocument();

        act(() => {
            scrollContainer.scrollTop = 0;
            scrollContainer.dispatchEvent(new Event("scroll"));
        });

        expect(screen.getByText("Long message 0")).toBeInTheDocument();
    });

    it("preserves user input drafts when a virtualized row unmounts and remounts", () => {
        const transcript = createLongTranscript(40);
        transcript.splice(10, 0, {
            id: "user-input:1",
            role: "assistant",
            kind: "user_input_request",
            title: "Need input",
            content: "Need input",
            timestamp: 500,
            userInputRequestId: "request-1",
            userInputQuestions: [
                {
                    id: "api-key",
                    header: "API key",
                    question: "Paste your API key",
                    is_secret: false,
                    is_other: false,
                    options: [],
                },
            ],
            meta: {
                status: "pending",
            },
        });
        const messages = [
            ...transcript,
            ...createLongTranscript(100).map((message, index) => ({
                ...message,
                id: `tail:${index}`,
                content: `Tail message ${index}`,
                timestamp: 1_000 + index,
            })),
        ];

        const view = renderComponent(
            <AIChatMessageList
                sessionId="session-drafts"
                messages={messages}
                status="idle"
            />,
        );
        const scrollContainer = getScrollContainer(view.container);
        configureScrollableViewport(scrollContainer);

        act(() => {
            scrollContainer.scrollTop = 0;
            scrollContainer.dispatchEvent(new Event("scroll"));
        });

        fireEvent.change(screen.getByRole("textbox"), {
            target: { value: "sk-test-123" },
        });

        act(() => {
            scrollContainer.scrollTop = 11_000;
            scrollContainer.dispatchEvent(new Event("scroll"));
        });

        expect(
            screen.queryByDisplayValue("sk-test-123"),
        ).not.toBeInTheDocument();

        act(() => {
            scrollContainer.scrollTop = 0;
            scrollContainer.dispatchEvent(new Event("scroll"));
        });

        expect(screen.getByDisplayValue("sk-test-123")).toBeInTheDocument();
    });

    it("scopes virtual row keys by session id so measurement cache does not bleed across sessions", () => {
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

    it("preserves the visible anchor when the chat panel width changes", () => {
        const messages = createLongTranscript(6);
        const view = renderComponent(
            <AIChatMessageList
                sessionId="session-resize"
                messages={messages}
                status="idle"
            />,
        );
        const scrollContainer = getScrollContainer(view.container);
        let viewportWidth = 420;
        configureScrollableViewport(scrollContainer, 320, {
            getWidth: () => viewportWidth,
        });

        mockVisibleRowRects(scrollContainer, {
            "session-resize:assistant:0": -120,
            "session-resize:assistant:1": 12,
            "session-resize:assistant:2": 108,
            "session-resize:assistant:3": 204,
        });

        act(() => {
            scrollContainer.scrollTop = 240;
            scrollContainer.dispatchEvent(new Event("scroll"));
        });

        mockVisibleRowRects(scrollContainer, {
            "session-resize:assistant:0": -120,
            "session-resize:assistant:1": 52,
            "session-resize:assistant:2": 164,
            "session-resize:assistant:3": 292,
        });

        viewportWidth = 320;

        act(() => {
            window.dispatchEvent(new Event("resize"));
        });

        expect(scrollContainer.scrollTop).toBe(280);
    });
});
