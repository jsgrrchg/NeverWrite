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
});
