import type { EditorFontFamily } from "../store/settingsStore";
import { getEditorFontFamily } from "../../features/editor/editorExtensions";

export interface PretextFontSignature {
    key: string;
    cssFont: string;
    family: string;
    sizePx: number;
    lineHeightPx: number;
    weight: number;
    style: "normal" | "italic";
}

const PRETEXT_SYSTEM_SANS_FAMILY =
    '"Inter", "IBM Plex Sans", "Avenir Next", "Segoe UI", sans-serif';

const PRETEXT_CODE_FAMILY =
    '"JetBrains Mono", "Geist Mono", "IBM Plex Mono", "SFMono-Regular", Menlo, Monaco, Consolas, monospace';

function sanitizeFamilyForPretext(fontFamily: string) {
    if (
        fontFamily ===
        'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    ) {
        return PRETEXT_SYSTEM_SANS_FAMILY;
    }

    return fontFamily;
}

function buildPretextFontSignature(options: {
    family: string;
    sizePx: number;
    lineHeightPx: number;
    weight?: number;
    style?: "normal" | "italic";
}) {
    const weight = options.weight ?? 400;
    const style = options.style ?? "normal";
    const sanitizedFamily = sanitizeFamilyForPretext(options.family);
    const cssFont = `${style === "italic" ? "italic " : ""}${weight} ${options.sizePx}px ${sanitizedFamily}`;

    return {
        key: [cssFont, options.lineHeightPx].join("|"),
        cssFont,
        family: sanitizedFamily,
        sizePx: options.sizePx,
        lineHeightPx: options.lineHeightPx,
        weight,
        style,
    } satisfies PretextFontSignature;
}

export function buildChatFontSignature(
    chatFontSize: number,
    chatFontFamily: EditorFontFamily,
    options?: {
        lineHeightPx?: number;
        weight?: number;
        style?: "normal" | "italic";
    },
) {
    return buildPretextFontSignature({
        family: getEditorFontFamily(chatFontFamily),
        sizePx: chatFontSize,
        lineHeightPx: options?.lineHeightPx ?? chatFontSize * 1.5,
        weight: options?.weight,
        style: options?.style,
    });
}

export function buildCodeFontSignature(
    fontSizePx: number,
    options?: {
        lineHeightPx?: number;
        family?: string;
        weight?: number;
        style?: "normal" | "italic";
    },
) {
    return buildPretextFontSignature({
        family: options?.family ?? PRETEXT_CODE_FAMILY,
        sizePx: fontSizePx,
        lineHeightPx: options?.lineHeightPx ?? fontSizePx * 1.55,
        weight: options?.weight,
        style: options?.style,
    });
}

export function resizePretextFontSignature(
    font: PretextFontSignature,
    sizePx: number,
    lineHeightPx = font.lineHeightPx,
) {
    return buildPretextFontSignature({
        family: font.family,
        sizePx,
        lineHeightPx,
        weight: font.weight,
        style: font.style,
    });
}
