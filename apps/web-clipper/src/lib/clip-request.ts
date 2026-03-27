import type { ClipData } from "./clipper-contract";

export type ClipRequestMode = "inline" | "clipboard";

export const CLIP_REQUEST_SOURCE = "web-clipper";
export const INLINE_PAYLOAD_MAX_BYTES = 2048;

export interface ClipRequestInput {
    clipData: ClipData;
    contentMarkdown: string;
    title: string;
    vault: string;
    vaultPathHint?: string;
    vaultNameHint?: string;
    folder?: string;
    preferClipboard?: boolean;
}

export interface ClipRequestPayload {
    requestId: string;
    createdAt: string;
    source: typeof CLIP_REQUEST_SOURCE;
    vault: string;
    vaultPathHint?: string;
    vaultNameHint?: string;
    folder: string;
    title: string;
    url: string;
    mode: ClipRequestMode;
    content?: string;
    clipboardToken?: string;
}

export interface ClipRequestDraft {
    payload: ClipRequestPayload;
    clipboardMarkdown: string | null;
}

function generateRandomId(): string {
    return crypto.randomUUID();
}

function countUtf8Bytes(value: string): number {
    return new TextEncoder().encode(value).length;
}

export function createClipRequestDraft({
    clipData,
    contentMarkdown,
    title,
    vault,
    vaultPathHint,
    vaultNameHint,
    folder = "",
    preferClipboard = false,
}: ClipRequestInput): ClipRequestDraft {
    const requestId = generateRandomId();
    const createdAt = new Date().toISOString();
    const normalizedTitle = title.trim() || clipData.metadata.title;
    const normalizedMarkdown = contentMarkdown.trim();

    if (
        !preferClipboard &&
        countUtf8Bytes(normalizedMarkdown) < INLINE_PAYLOAD_MAX_BYTES
    ) {
        return {
            payload: {
                requestId,
                createdAt,
                source: CLIP_REQUEST_SOURCE,
                vault,
                vaultPathHint,
                vaultNameHint,
                folder,
                title: normalizedTitle,
                url: clipData.metadata.url,
                mode: "inline",
                content: normalizedMarkdown,
            },
            clipboardMarkdown: null,
        };
    }

    return {
        payload: {
            requestId,
            createdAt,
            source: CLIP_REQUEST_SOURCE,
            vault,
            vaultPathHint,
            vaultNameHint,
            folder,
            title: normalizedTitle,
            url: clipData.metadata.url,
            mode: "clipboard",
            clipboardToken: generateRandomId(),
        },
        clipboardMarkdown: normalizedMarkdown,
    };
}
