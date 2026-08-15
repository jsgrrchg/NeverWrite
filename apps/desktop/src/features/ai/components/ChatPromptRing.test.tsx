import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderComponent } from "../../../test/test-utils";
import type { AIChatMessage } from "../types";
import { ChatPromptRing } from "./ChatPromptRing";
import {
    buildChatPromptRingItems,
    resolveChatPromptRingHeight,
    resolveChatPromptRingIndexFromPointer,
    resolveChatPromptRingLayout,
    resolveChatPromptRingTopPercent,
} from "./ChatPromptRing.logic";

describe("ChatPromptRing", () => {
    it("pairs each prompt with the final assistant response in its turn", () => {
        const messages: AIChatMessage[] = [
            {
                id: "user-1",
                role: "user",
                kind: "text",
                content: "First\n prompt",
                timestamp: 1,
            },
            {
                id: "assistant-1",
                role: "assistant",
                kind: "text",
                content: "Initial answer",
                timestamp: 2,
            },
            {
                id: "assistant-2",
                role: "assistant",
                kind: "text",
                content: "Final answer",
                timestamp: 3,
            },
            {
                id: "user-2",
                role: "user",
                kind: "text",
                content: "Second prompt",
                timestamp: 4,
            },
        ];

        expect(buildChatPromptRingItems(messages)).toEqual([
            {
                id: "user-1",
                userText: "First prompt",
                assistantText: "Final answer",
            },
            {
                id: "user-2",
                userText: "Second prompt",
                assistantText: null,
            },
        ]);
    });

    it("matches the T3 ring geometry and protects narrow content gutters", () => {
        expect(resolveChatPromptRingHeight(5)).toBe(
            "min(32px, calc(100vh - 18rem))",
        );
        expect(resolveChatPromptRingTopPercent(2, 5)).toBe(50);
        expect(
            resolveChatPromptRingIndexFromPointer({
                itemCount: 101,
                railTop: 100,
                railHeight: 500,
                pointerY: 350,
            }),
        ).toBe(50);
        expect(resolveChatPromptRingLayout(600, 600)).toEqual({
            hasPersistentGutter: false,
            hitStripWidth: 0,
        });
        expect(resolveChatPromptRingLayout(700, 600)).toEqual({
            hasPersistentGutter: true,
            hitStripWidth: 38,
        });
    });

    it("previews prompts and supports keyboard navigation", () => {
        const onSelect = vi.fn();
        renderComponent(
            <ChatPromptRing
                hasPersistentGutter
                hitStripWidth={40}
                items={[
                    {
                        id: "user-1",
                        userText: "First prompt",
                        assistantText: "First response",
                    },
                    {
                        id: "user-2",
                        userText: "Second prompt",
                        assistantText: "Second response",
                    },
                ]}
                stripMap={new Map()}
                onSelect={onSelect}
            />,
        );

        const ring = screen.getByTestId("chat-prompt-ring");
        expect(ring).toHaveAttribute("data-persistent-gutter", "true");
        const button = screen.getByRole("button", {
            name: /Jump to prompt/i,
        });

        fireEvent.focus(button);
        expect(screen.getByText("First prompt")).toBeInTheDocument();
        expect(screen.getByText("First response")).toBeInTheDocument();

        fireEvent.keyDown(button, { key: "End" });
        expect(screen.getByText("Second prompt")).toBeInTheDocument();
        expect(screen.getByText("Second response")).toBeInTheDocument();

        fireEvent.keyDown(button, { key: "Enter" });
        expect(onSelect).toHaveBeenCalledWith(
            expect.objectContaining({ id: "user-2" }),
        );
    });
});
