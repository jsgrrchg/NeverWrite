import { describe, expect, it } from "vitest";
import type { AIComposerPart } from "./types";
import {
    MAX_IMAGE_ATTACHMENT_BYTES,
    MAX_IMAGE_ATTACHMENTS_PER_MESSAGE,
    countComposerImageAttachments,
    getImageAttachmentLimits,
    getImageAttachmentExtension,
    imageAttachmentValidationMessage,
    validateNewImageAttachment,
    validateNewImageAttachmentReference,
} from "./imageAttachments";

function imagePart(id: string): AIComposerPart {
    return {
        id,
        type: "screenshot",
        filePath: `/vault/assets/chat/${id}.png`,
        mimeType: "image/png",
        label: id,
    };
}

describe("imageAttachments", () => {
    it("counts screenshots and image file attachments as image attachments", () => {
        expect(
            countComposerImageAttachments([
                { id: "text", type: "text", text: "hello" },
                imagePart("shot"),
                {
                    id: "file-image",
                    type: "file_attachment",
                    filePath: "/vault/assets/photo.webp",
                    mimeType: "image/webp",
                    label: "photo.webp",
                },
                {
                    id: "file-text",
                    type: "file_attachment",
                    filePath: "/vault/docs/guide.md",
                    mimeType: "text/markdown",
                    label: "guide.md",
                },
            ]),
        ).toBe(2);
    });

    it("rejects unsupported image MIME types", () => {
        expect(
            validateNewImageAttachment(
                { size: 42, type: "image/tiff" },
                [],
            ),
        ).toEqual({ ok: false, reason: "unsupported_type" });
        expect(imageAttachmentValidationMessage("unsupported_type")).toBe(
            "Unsupported image type",
        );
    });

    it("rejects images above the per-image byte limit", () => {
        expect(
            validateNewImageAttachment(
                { size: MAX_IMAGE_ATTACHMENT_BYTES + 1, type: "image/png" },
                [],
            ),
        ).toEqual({ ok: false, reason: "too_large" });
        expect(imageAttachmentValidationMessage("too_large")).toBe(
            "Image is too large",
        );
    });

    it("applies conservative base64-backed limits for Claude", () => {
        const claudeLimits = getImageAttachmentLimits("claude-acp");

        expect(claudeLimits.maxBytes).toBeLessThan(MAX_IMAGE_ATTACHMENT_BYTES);
        expect(
            validateNewImageAttachment(
                { size: claudeLimits.maxBytes + 1, type: "image/png" },
                [],
                "claude-acp",
            ),
        ).toEqual({ ok: false, reason: "too_large" });
        expect(imageAttachmentValidationMessage("too_large", "claude-acp")).toBe(
            "Claude supports images up to 3.8 MB",
        );
    });

    it("uses Grok-specific image size and MIME limits", () => {
        const grokLimits = getImageAttachmentLimits("grok-acp");

        expect(grokLimits.maxBytes).toBe(20 * 1024 * 1024);
        expect(
            validateNewImageAttachment(
                { size: MAX_IMAGE_ATTACHMENT_BYTES + 1, type: "image/png" },
                [],
                "grok-acp",
            ),
        ).toEqual({ ok: true });
        expect(
            validateNewImageAttachment(
                { size: 42, type: "image/webp" },
                [],
                "grok-acp",
            ),
        ).toEqual({ ok: false, reason: "unsupported_type" });
    });

    it("rejects messages that already have the maximum image count", () => {
        const parts = Array.from(
            { length: MAX_IMAGE_ATTACHMENTS_PER_MESSAGE },
            (_, index) => imagePart(`shot-${index}`),
        );

        expect(
            validateNewImageAttachment(
                { size: 42, type: "image/png" },
                parts,
            ),
        ).toEqual({ ok: false, reason: "too_many" });
        expect(imageAttachmentValidationMessage("too_many")).toBe(
            "Too many images attached",
        );
    });

    it("validates existing image file references without a byte size", () => {
        expect(
            validateNewImageAttachmentReference(
                { mimeType: "image/svg+xml" },
                [],
            ),
        ).toEqual({ ok: false, reason: "unsupported_type" });

        expect(
            validateNewImageAttachmentReference(
                { mimeType: "image/png" },
                [imagePart("shot")],
            ),
        ).toEqual({ ok: true });
    });

    it("rejects existing image file references when known byte size exceeds the limit", () => {
        expect(
            validateNewImageAttachmentReference(
                {
                    mimeType: "image/png",
                    sizeBytes: MAX_IMAGE_ATTACHMENT_BYTES + 1,
                },
                [],
            ),
        ).toEqual({ ok: false, reason: "too_large" });
    });

    it("maps supported image MIME types to persisted file extensions", () => {
        expect(getImageAttachmentExtension("image/jpeg")).toBe("jpg");
        expect(getImageAttachmentExtension("image/gif")).toBe("gif");
        expect(getImageAttachmentExtension("image/webp")).toBe("webp");
        expect(getImageAttachmentExtension("image/png")).toBe("png");
    });
});
