import type { AIChatMessage } from "../types";

export const CHAT_PROMPT_RING_MIN_ITEMS = 2;
export const CHAT_PROMPT_RING_ITEM_SPACING = 8;
export const CHAT_PROMPT_RING_GUTTER_THRESHOLD = 48;
export const CHAT_PROMPT_RING_HIT_STRIP_LEFT = 12;
export const CHAT_PROMPT_RING_HIT_STRIP_MAX_WIDTH = 40;
export const CHAT_PROMPT_RING_EXPANDED_WIDTH = "22rem";

export interface ChatPromptRingItem {
    id: string;
    userText: string | null;
    assistantText: string | null;
}

function compactPreview(text: string | null | undefined) {
    const compact = text?.replace(/\s+/g, " ").trim() ?? "";
    return compact.length > 0 ? compact : null;
}

export function buildChatPromptRingItems(
    messages: readonly AIChatMessage[],
): ChatPromptRingItem[] {
    const items: ChatPromptRingItem[] = [];

    for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index];
        if (message?.role !== "user" || message.kind !== "text") continue;

        let assistantText: string | null = null;
        for (
            let nextIndex = index + 1;
            nextIndex < messages.length;
            nextIndex += 1
        ) {
            const nextMessage = messages[nextIndex];
            if (!nextMessage) continue;
            if (nextMessage.role === "user" && nextMessage.kind === "text") {
                break;
            }
            if (nextMessage.role === "assistant" && nextMessage.kind === "text") {
                assistantText = compactPreview(nextMessage.content);
            }
        }

        items.push({
            id: message.id,
            userText: compactPreview(message.content),
            assistantText,
        });
    }

    return items;
}

export function resolveChatPromptRingHeight(itemCount: number) {
    const naturalHeight = Math.max(
        1,
        (itemCount - 1) * CHAT_PROMPT_RING_ITEM_SPACING,
    );
    return `min(${naturalHeight}px, calc(100vh - 18rem))`;
}

export function resolveChatPromptRingTopPercent(
    index: number,
    itemCount: number,
) {
    if (itemCount <= 1) return 0;
    return (
        (Math.max(0, Math.min(index, itemCount - 1)) / (itemCount - 1)) *
        100
    );
}

export function resolveChatPromptRingIndexFromPointer(input: {
    itemCount: number;
    railTop: number;
    railHeight: number;
    pointerY: number;
}) {
    if (input.itemCount <= 0 || input.railHeight <= 0) return null;
    if (input.itemCount === 1) return 0;

    const progress = Math.max(
        0,
        Math.min(1, (input.pointerY - input.railTop) / input.railHeight),
    );
    return Math.max(
        0,
        Math.min(
            input.itemCount - 1,
            Math.round(progress * (input.itemCount - 1)),
        ),
    );
}

export function resolveChatPromptRingLayout(
    viewportWidth: number,
    contentMaxWidth: number,
) {
    if (
        !Number.isFinite(viewportWidth) ||
        viewportWidth <= 0 ||
        !Number.isFinite(contentMaxWidth) ||
        contentMaxWidth <= 0
    ) {
        return { hasPersistentGutter: false, hitStripWidth: 0 };
    }

    const contentWidth = Math.min(viewportWidth, contentMaxWidth);
    const sideGutter = Math.max(0, (viewportWidth - contentWidth) / 2);
    return {
        hasPersistentGutter:
            sideGutter >= CHAT_PROMPT_RING_GUTTER_THRESHOLD,
        hitStripWidth: Math.max(
            0,
            Math.min(
                CHAT_PROMPT_RING_HIT_STRIP_MAX_WIDTH,
                Math.floor(sideGutter) - CHAT_PROMPT_RING_HIT_STRIP_LEFT,
            ),
        ),
    };
}
