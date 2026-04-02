import type { EditorFontFamily } from "../../../app/store/settingsStore";
import { measurePretextText } from "../../../app/services/pretextService";
import {
    buildChatFontSignature,
    buildCodeFontSignature,
    resizePretextFontSignature,
    type PretextFontSignature,
} from "../../../app/utils/pretextFontSignatures";
import { getChatCodeBlockFontSize } from "./chatCodeSizing";

const MIN_ESTIMATE_CONTENT_WIDTH = 160;
const APPROX_CHAR_WIDTH_EM = 0.56;
const ASSISTANT_LINE_HEIGHT = 1.5;
const TEXT_BLOCK_GAP = 8;

function getEffectiveEstimateWidth(contentWidth: number) {
    return Math.max(MIN_ESTIMATE_CONTENT_WIDTH, contentWidth);
}

function estimateWrappedLineCount(
    text: string,
    width: number,
    fontSize: number,
    averageCharWidthEm = APPROX_CHAR_WIDTH_EM,
) {
    const normalized = text.replace(/\t/g, "    ");
    const averageCharWidth = Math.max(1, fontSize * averageCharWidthEm);
    const maxCharsPerLine = Math.max(10, Math.floor(width / averageCharWidth));
    const lines = normalized.split("\n");
    let total = 0;

    for (const line of lines) {
        if (line.length === 0) {
            total += 1;
            continue;
        }
        total += Math.max(1, Math.ceil(line.length / maxCharsPerLine));
    }

    return total;
}

function estimatePlainTextHeight(
    text: string,
    width: number,
    fontSignature: PretextFontSignature,
    options?: {
        lineHeightPx?: number;
        paddingY?: number;
        minHeight?: number;
        whiteSpace?: "normal" | "pre-wrap";
        cacheScope?: string;
    },
) {
    const lineHeight =
        options?.lineHeightPx ?? fontSignature.sizePx * ASSISTANT_LINE_HEIGHT;
    const paddingY = options?.paddingY ?? 0;
    const minHeight = options?.minHeight ?? lineHeight;
    const measured = measurePretextText({
        text,
        maxWidth: width,
        font: fontSignature,
        lineHeightPx: lineHeight,
        whiteSpace: options?.whiteSpace ?? "normal",
        cacheScope: options?.cacheScope ?? "plain-text",
    });

    if (measured) {
        return Math.max(minHeight, Math.ceil(measured.height + paddingY));
    }

    const lineCount = estimateWrappedLineCount(
        text,
        width,
        fontSignature.sizePx,
    );
    return Math.max(minHeight, Math.ceil(lineCount * lineHeight + paddingY));
}

function estimateMarkdownHeight(
    text: string,
    width: number,
    textFontSignature: PretextFontSignature,
    codeFontSignature: PretextFontSignature,
) {
    if (!text.trim()) {
        return Math.ceil(textFontSignature.lineHeightPx);
    }

    const codeBlockRegex = /```([^\n`]*)\n([\s\S]*?)```/g;
    let total = 0;
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    const estimateTextSegment = (segment: string) => {
        const trimmed = segment.trim();
        if (!trimmed) {
            return 0;
        }

        const paragraphs = trimmed.split(/\n{2,}/).filter(Boolean);
        return paragraphs.reduce((height, paragraph, index) => {
            const firstLine = paragraph.trimStart().split("\n", 1)[0] ?? "";
            const isHeading = /^#{1,6}\s/.test(firstLine);
            const fontSignature = isHeading
                ? resizePretextFontSignature(
                      textFontSignature,
                      textFontSignature.sizePx * 1.05,
                      textFontSignature.sizePx * 1.05 * ASSISTANT_LINE_HEIGHT,
                  )
                : textFontSignature;
            const paragraphHeight = estimatePlainTextHeight(
                paragraph,
                width,
                fontSignature,
                {
                    lineHeightPx: fontSignature.lineHeightPx,
                    cacheScope: isHeading
                        ? "markdown-heading"
                        : "markdown-paragraph",
                },
            );

            return (
                height + paragraphHeight + (index === 0 ? 0 : TEXT_BLOCK_GAP)
            );
        }, 0);
    };

    while ((match = codeBlockRegex.exec(text)) !== null) {
        if (match.index > lastIndex) {
            total += estimateTextSegment(text.slice(lastIndex, match.index));
            if (total > 0) {
                total += TEXT_BLOCK_GAP;
            }
        }

        const codeLineCount = Math.max(
            1,
            match[2].replace(/\n$/, "").split("\n").length,
        );
        const codeHeight = estimatePlainTextHeight(
            match[2].replace(/\n$/, ""),
            Math.max(80, width - 24),
            codeFontSignature,
            {
                lineHeightPx: codeFontSignature.lineHeightPx,
                whiteSpace: "pre-wrap",
                cacheScope: "markdown-code",
                minHeight: codeFontSignature.lineHeightPx * codeLineCount,
            },
        );

        total += Math.ceil(codeHeight + 28);
        lastIndex = match.index + match[0].length;
    }

    if (lastIndex < text.length) {
        const trailingHeight = estimateTextSegment(text.slice(lastIndex));
        if (trailingHeight > 0 && total > 0) {
            total += TEXT_BLOCK_GAP;
        }
        total += trailingHeight;
    }

    return Math.max(Math.ceil(textFontSignature.lineHeightPx), total);
}

export function estimateChatTextMessageHeight(options: {
    content: string;
    contentWidth: number;
    role: "assistant" | "user";
    chatFontSize: number;
    chatFontFamily: EditorFontFamily;
}) {
    const width = getEffectiveEstimateWidth(options.contentWidth);
    const chatFontSignature = buildChatFontSignature(
        options.chatFontSize,
        options.chatFontFamily,
    );
    const codeFontSize = getChatCodeBlockFontSize(options.chatFontSize);
    const codeFontSignature = buildCodeFontSignature(codeFontSize, {
        lineHeightPx: codeFontSize * 1.625,
    });

    if (options.role === "user") {
        return estimatePlainTextHeight(
            options.content,
            Math.max(80, width - 24),
            chatFontSignature,
            {
                lineHeightPx: options.chatFontSize * 1.45,
                paddingY: 16,
                minHeight: 42,
                whiteSpace: "pre-wrap",
                cacheScope: "user-text",
            },
        );
    }

    return estimateMarkdownHeight(
        options.content,
        width,
        chatFontSignature,
        codeFontSignature,
    );
}

export function estimateComposerTextHeight(options: {
    content: string;
    contentWidth: number;
    fontSize: number;
    fontFamily: EditorFontFamily;
    lineHeight?: number;
    paddingY?: number;
    minHeight?: number;
}) {
    const lineHeightPx =
        options.lineHeight ?? options.fontSize * ASSISTANT_LINE_HEIGHT;
    const fontSignature = buildChatFontSignature(
        options.fontSize,
        options.fontFamily,
        {
            lineHeightPx,
        },
    );

    return estimatePlainTextHeight(
        options.content,
        getEffectiveEstimateWidth(options.contentWidth),
        fontSignature,
        {
            lineHeightPx,
            paddingY: options.paddingY ?? 0,
            minHeight: options.minHeight ?? 0,
            whiteSpace: "pre-wrap",
            cacheScope: "composer-text",
        },
    );
}
