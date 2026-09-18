import type { CSSProperties } from "react";

export const AI_CHAT_CONTENT_MAX_WIDTH_PX = 600;

export function getAiChatContentColumnStyle(
    maxWidth = AI_CHAT_CONTENT_MAX_WIDTH_PX,
) {
    return {
        width: "100%",
        maxWidth,
        marginInline: "auto",
    } satisfies CSSProperties;
}

export const AI_CHAT_CONTENT_COLUMN_STYLE = getAiChatContentColumnStyle();
