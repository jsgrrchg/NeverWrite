import type { AIComposerPart } from "./types";

export const MAX_IMAGE_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_ATTACHMENTS_PER_MESSAGE = 12;
export const ALLOWED_IMAGE_ATTACHMENT_MIME_TYPES = [
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
] as const;

export type ImageAttachmentValidationFailure =
    | "too_large"
    | "too_many"
    | "unsupported_type";

const ALLOWED_IMAGE_ATTACHMENT_MIME_TYPE_SET = new Set<string>(
    ALLOWED_IMAGE_ATTACHMENT_MIME_TYPES,
);

export function isAllowedImageAttachmentMimeType(mimeType: string | null | undefined) {
    return Boolean(
        mimeType && ALLOWED_IMAGE_ATTACHMENT_MIME_TYPE_SET.has(mimeType),
    );
}

export function countComposerImageAttachments(parts: AIComposerPart[]) {
    return parts.filter((part) => {
        if (part.type === "screenshot") return true;
        return (
            part.type === "file_attachment" &&
            part.mimeType.startsWith("image/")
        );
    }).length;
}

export function getImageAttachmentExtension(mimeType: string | null | undefined) {
    if (mimeType === "image/jpeg") return "jpg";
    if (mimeType === "image/gif") return "gif";
    if (mimeType === "image/webp") return "webp";
    return "png";
}

export function validateNewImageAttachment(
    file: Pick<File, "size" | "type">,
    currentParts: AIComposerPart[],
): { ok: true } | { ok: false; reason: ImageAttachmentValidationFailure } {
    if (!isAllowedImageAttachmentMimeType(file.type)) {
        return { ok: false, reason: "unsupported_type" };
    }

    if (file.size > MAX_IMAGE_ATTACHMENT_BYTES) {
        return { ok: false, reason: "too_large" };
    }

    if (countComposerImageAttachments(currentParts) >= MAX_IMAGE_ATTACHMENTS_PER_MESSAGE) {
        return { ok: false, reason: "too_many" };
    }

    return { ok: true };
}

export function imageAttachmentValidationMessage(
    reason: ImageAttachmentValidationFailure,
) {
    if (reason === "too_large") return "Image is too large";
    if (reason === "too_many") return "Too many images attached";
    return "Unsupported image type";
}
