export interface ChatPillMetrics {
    fontSize: number;
    lineHeight: number;
    paddingX: number;
    paddingY: number;
    radius: number;
    gapX: number;
    maxWidth: number;
    offsetY: number;
}

function clamp(value: number, min: number, max: number) {
    return Math.min(max, Math.max(min, value));
}

export function getChatPillMetrics(chatFontSize: number): ChatPillMetrics {
    const safeChatFontSize = Number.isFinite(chatFontSize) ? chatFontSize : 20;

    return {
        fontSize: clamp(Math.round(safeChatFontSize * 0.82), 12, 19),
        lineHeight: 1.3,
        paddingX: clamp(Math.round(safeChatFontSize * 0.26), 5, 8),
        paddingY: clamp(Math.round(safeChatFontSize * 0.08), 1, 2),
        radius: clamp(Math.round(safeChatFontSize * 0.34), 5, 9),
        gapX: 2,
        maxWidth: clamp(Math.round(safeChatFontSize * 8.5), 108, 180),
        offsetY: safeChatFontSize >= 16 ? -1 : 0,
    };
}
