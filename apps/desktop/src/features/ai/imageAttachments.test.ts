import { describe, expect, it } from "vitest";
import type { AIComposerPart } from "./types";
import {
    MAX_IMAGE_ATTACHMENT_BYTES,
    MAX_IMAGE_ATTACHMENTS_PER_MESSAGE,
    countComposerImageAttachments,
    getImageAttachmentExtension,
    imageAttachmentValidationMessage,
    validateNewImageAttachment,
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

    it("maps supported image MIME types to persisted file extensions", () => {
        expect(getImageAttachmentExtension("image/jpeg")).toBe("jpg");
        expect(getImageAttachmentExtension("image/gif")).toBe("gif");
        expect(getImageAttachmentExtension("image/webp")).toBe("webp");
        expect(getImageAttachmentExtension("image/png")).toBe("png");
    });
});
