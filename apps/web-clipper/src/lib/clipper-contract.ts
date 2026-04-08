export const CLIPPER_EXTRACT_MESSAGE = "neverwrite:web-clipper/extract";
export const CLIPPER_SOURCE_TAB_QUERY_PARAM = "sourceTabId";

export interface ClipMetadata {
    title: string;
    url: string;
    domain: string;
    description: string;
    author: string;
    published: string;
    image: string;
    favicon: string;
    language: string;
}

export interface ClipContent {
    html: string;
    markdown: string;
    wordCount: number;
}

export interface ClipSelection {
    text: string;
    html: string;
    markdown: string;
}

export interface ClipData {
    metadata: ClipMetadata;
    content: ClipContent;
    selection: ClipSelection | null;
    extractedAt: string;
}

export interface ClipperExtractMessage {
    type: typeof CLIPPER_EXTRACT_MESSAGE;
}

export interface ClipperExtractSuccessResponse {
    ok: true;
    data: ClipData;
}

export interface ClipperExtractErrorResponse {
    ok: false;
    error: string;
}

export type ClipperExtractResponse =
    | ClipperExtractSuccessResponse
    | ClipperExtractErrorResponse;

export function isClipperExtractMessage(
    value: unknown,
): value is ClipperExtractMessage {
    return (
        typeof value === "object" &&
        value !== null &&
        "type" in value &&
        (value as { type?: unknown }).type === CLIPPER_EXTRACT_MESSAGE
    );
}

export function createClipperExtractMessage(): ClipperExtractMessage {
    return {
        type: CLIPPER_EXTRACT_MESSAGE,
    };
}
