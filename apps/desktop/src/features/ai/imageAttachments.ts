import type { AIComposerPart } from "./types";

export const MAX_IMAGE_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_ATTACHMENTS_PER_MESSAGE = 12;
const GROK_IMAGE_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const CONSERVATIVE_BASE64_IMAGE_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const CONSERVATIVE_BASE64_RAW_IMAGE_ATTACHMENT_BYTES =
    Math.floor(CONSERVATIVE_BASE64_IMAGE_ATTACHMENT_BYTES / 4) * 3;

export const ALLOWED_IMAGE_ATTACHMENT_MIME_TYPES = [
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
] as const;

const CONSERVATIVE_IMAGE_ATTACHMENT_MIME_TYPES = [
    "image/png",
    "image/jpeg",
    "image/webp",
] as const;

const GROK_IMAGE_ATTACHMENT_MIME_TYPES = ["image/png", "image/jpeg"] as const;

export interface ImageAttachmentLimits {
    runtimeLabel: string;
    maxBytes: number;
    maxImagesPerMessage: number;
    allowedMimeTypes: readonly string[];
}

export type ImageAttachmentValidationFailure =
    | "too_large"
    | "too_many"
    | "unsupported_type";

const DEFAULT_IMAGE_ATTACHMENT_LIMITS: ImageAttachmentLimits = {
    runtimeLabel: "this provider",
    maxBytes: MAX_IMAGE_ATTACHMENT_BYTES,
    maxImagesPerMessage: MAX_IMAGE_ATTACHMENTS_PER_MESSAGE,
    allowedMimeTypes: ALLOWED_IMAGE_ATTACHMENT_MIME_TYPES,
};

const RUNTIME_IMAGE_ATTACHMENT_LIMITS: Record<string, ImageAttachmentLimits> = {
    "codex-acp": {
        runtimeLabel: "Codex",
        maxBytes: MAX_IMAGE_ATTACHMENT_BYTES,
        maxImagesPerMessage: MAX_IMAGE_ATTACHMENTS_PER_MESSAGE,
        allowedMimeTypes: ALLOWED_IMAGE_ATTACHMENT_MIME_TYPES,
    },
    "claude-acp": {
        runtimeLabel: "Claude",
        maxBytes: CONSERVATIVE_BASE64_RAW_IMAGE_ATTACHMENT_BYTES,
        maxImagesPerMessage: MAX_IMAGE_ATTACHMENTS_PER_MESSAGE,
        allowedMimeTypes: ALLOWED_IMAGE_ATTACHMENT_MIME_TYPES,
    },
    "claude-code-terminal": {
        runtimeLabel: "Claude Code",
        maxBytes: CONSERVATIVE_BASE64_RAW_IMAGE_ATTACHMENT_BYTES,
        maxImagesPerMessage: MAX_IMAGE_ATTACHMENTS_PER_MESSAGE,
        allowedMimeTypes: ALLOWED_IMAGE_ATTACHMENT_MIME_TYPES,
    },
    "gemini-acp": {
        runtimeLabel: "Gemini",
        maxBytes: MAX_IMAGE_ATTACHMENT_BYTES,
        maxImagesPerMessage: MAX_IMAGE_ATTACHMENTS_PER_MESSAGE,
        allowedMimeTypes: CONSERVATIVE_IMAGE_ATTACHMENT_MIME_TYPES,
    },
    "grok-acp": {
        runtimeLabel: "Grok",
        maxBytes: GROK_IMAGE_ATTACHMENT_BYTES,
        maxImagesPerMessage: MAX_IMAGE_ATTACHMENTS_PER_MESSAGE,
        allowedMimeTypes: GROK_IMAGE_ATTACHMENT_MIME_TYPES,
    },
    "kilo-acp": {
        runtimeLabel: "Kilo",
        maxBytes: CONSERVATIVE_BASE64_RAW_IMAGE_ATTACHMENT_BYTES,
        maxImagesPerMessage: MAX_IMAGE_ATTACHMENTS_PER_MESSAGE,
        allowedMimeTypes: CONSERVATIVE_IMAGE_ATTACHMENT_MIME_TYPES,
    },
    "opencode-acp": {
        runtimeLabel: "OpenCode",
        maxBytes: CONSERVATIVE_BASE64_RAW_IMAGE_ATTACHMENT_BYTES,
        maxImagesPerMessage: MAX_IMAGE_ATTACHMENTS_PER_MESSAGE,
        allowedMimeTypes: CONSERVATIVE_IMAGE_ATTACHMENT_MIME_TYPES,
    },
};

export function getImageAttachmentLimits(
    runtimeId?: string | null,
): ImageAttachmentLimits {
    if (!runtimeId) return DEFAULT_IMAGE_ATTACHMENT_LIMITS;
    return RUNTIME_IMAGE_ATTACHMENT_LIMITS[runtimeId] ?? DEFAULT_IMAGE_ATTACHMENT_LIMITS;
}

export function isAllowedImageAttachmentMimeType(
    mimeType: string | null | undefined,
    runtimeId?: string | null,
) {
    const limits = getImageAttachmentLimits(runtimeId);
    return Boolean(
        mimeType && limits.allowedMimeTypes.includes(mimeType),
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
    runtimeId?: string | null,
): { ok: true } | { ok: false; reason: ImageAttachmentValidationFailure } {
    const limits = getImageAttachmentLimits(runtimeId);

    if (!isAllowedImageAttachmentMimeType(file.type, runtimeId)) {
        return { ok: false, reason: "unsupported_type" };
    }

    if (file.size > limits.maxBytes) {
        return { ok: false, reason: "too_large" };
    }

    if (countComposerImageAttachments(currentParts) >= limits.maxImagesPerMessage) {
        return { ok: false, reason: "too_many" };
    }

    return { ok: true };
}

export function validateNewImageAttachmentReference(
    attachment: {
        mimeType: string | null | undefined;
        sizeBytes?: number | null;
    },
    currentParts: AIComposerPart[],
    runtimeId?: string | null,
): { ok: true } | { ok: false; reason: ImageAttachmentValidationFailure } {
    const limits = getImageAttachmentLimits(runtimeId);

    if (!isAllowedImageAttachmentMimeType(attachment.mimeType, runtimeId)) {
        return { ok: false, reason: "unsupported_type" };
    }

    if (
        typeof attachment.sizeBytes === "number" &&
        attachment.sizeBytes > limits.maxBytes
    ) {
        return { ok: false, reason: "too_large" };
    }

    if (countComposerImageAttachments(currentParts) >= limits.maxImagesPerMessage) {
        return { ok: false, reason: "too_many" };
    }

    return { ok: true };
}

function formatAttachmentBytes(bytes: number) {
    const mib = bytes / (1024 * 1024);
    return `${mib.toFixed(mib >= 10 ? 0 : 1)} MB`;
}

export function imageAttachmentValidationMessage(
    reason: ImageAttachmentValidationFailure,
    runtimeId?: string | null,
) {
    const limits = getImageAttachmentLimits(runtimeId);
    if (!runtimeId) {
        if (reason === "too_large") return "Image is too large";
        if (reason === "too_many") return "Too many images attached";
        return "Unsupported image type";
    }

    if (reason === "too_large") {
        return `${limits.runtimeLabel} supports images up to ${formatAttachmentBytes(limits.maxBytes)}`;
    }
    if (reason === "too_many") {
        return `${limits.runtimeLabel} supports up to ${limits.maxImagesPerMessage} images per message`;
    }
    return `Unsupported image type for ${limits.runtimeLabel}`;
}
