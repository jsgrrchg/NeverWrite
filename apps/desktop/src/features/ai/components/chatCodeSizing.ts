const DEFAULT_CHAT_FONT_SIZE = 14;
const MIN_CODE_BLOCK_FONT_SIZE = 12;
const MIN_CODE_LABEL_FONT_SIZE = 10;

function getSafeChatFontSize(chatFontSize: number) {
    return Number.isFinite(chatFontSize)
        ? chatFontSize
        : DEFAULT_CHAT_FONT_SIZE;
}

export function getChatCodeBlockFontSize(chatFontSize: number) {
    return Math.max(
        MIN_CODE_BLOCK_FONT_SIZE,
        getSafeChatFontSize(chatFontSize) - 1,
    );
}

export function getChatCodeLabelFontSize(chatFontSize: number) {
    return Math.max(
        MIN_CODE_LABEL_FONT_SIZE,
        getSafeChatFontSize(chatFontSize) - 3,
    );
}
