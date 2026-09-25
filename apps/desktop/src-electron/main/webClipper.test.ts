import { beforeEach, describe, expect, it, vi } from "vitest";

const readText = vi.hoisted(() => vi.fn<() => Promise<string>>());

vi.mock("electron", () => ({
    app: {},
    clipboard: { readText },
}));

import { saveWebClipperDeepLink } from "./webClipper";
import { createClipDeepLink } from "../../../web-clipper/src/lib/deep-link";

function createRuntime() {
    const invoke = vi.fn(async () => ({
        noteId: "saved-note",
        targetWindowLabel: "main",
    }));
    const emitEvent = vi.fn();
    const runtime = {
        backend: { invoke },
        emitEvent,
    } as unknown as Parameters<typeof saveWebClipperDeepLink>[1];
    return { runtime, invoke, emitEvent };
}

function clipLink(mode: "clipboard" | "inline", content?: string) {
    const params = new URLSearchParams({
        requestId: "clip-1",
        title: "Clipped page",
        folder: "Inbox",
        mode,
        vaultPathHint: "/vault",
    });
    if (content !== undefined) params.set("content", content);
    return `neverwrite://clip?${params}`;
}

describe("web clipper deep link", () => {
    beforeEach(() => readText.mockReset());

    it("awaits the extension clipboard handoff before saving", async () => {
        const { runtime, invoke, emitEvent } = createRuntime();
        readText.mockResolvedValue("  # Clipped page\n\nBody  ");
        const deepLink = createClipDeepLink({
            requestId: "clip-1",
            createdAt: "2026-09-25T00:00:00.000Z",
            source: "web-clipper",
            vault: "/vault",
            vaultPathHint: "/vault",
            folder: "Inbox",
            title: "Clipped page",
            url: "https://example.com/article",
            mode: "clipboard",
            clipboardToken: "clip-token",
        });

        await saveWebClipperDeepLink(deepLink, runtime);

        expect(readText).toHaveBeenCalledOnce();
        expect(invoke).toHaveBeenCalledWith("web_clipper_save_note", {
            requestId: "clip-1",
            vaultPathHint: "/vault",
            vaultNameHint: null,
            title: "Clipped page",
            folder: "Inbox",
            content: "# Clipped page\n\nBody",
        });
        expect(emitEvent).toHaveBeenCalledWith(
            "neverwrite:web-clipper/clip-saved",
            { noteId: "saved-note", targetWindowLabel: "main" },
        );
    });

    it("keeps empty clipboard content from reaching the backend", async () => {
        const { runtime, invoke } = createRuntime();
        readText.mockResolvedValue("  \n ");

        await expect(
            saveWebClipperDeepLink(clipLink("clipboard"), runtime),
        ).rejects.toThrow("Clip content is empty.");
        expect(invoke).not.toHaveBeenCalled();
    });

    it("preserves clipboard read failures", async () => {
        const { runtime, invoke } = createRuntime();
        readText.mockImplementation(async () => {
            throw new Error("clipboard unavailable");
        });

        await expect(
            saveWebClipperDeepLink(clipLink("clipboard"), runtime),
        ).rejects.toThrow("clipboard unavailable");
        expect(readText).toHaveBeenCalledOnce();
        expect(invoke).not.toHaveBeenCalled();
        // Clear the rejected mock result before Vitest restores the mocks.
        readText.mockReset();
    });

    it("keeps inline deep links independent of the clipboard", async () => {
        const { runtime, invoke } = createRuntime();

        await saveWebClipperDeepLink(clipLink("inline", "  Inline text  "), runtime);

        expect(readText).not.toHaveBeenCalled();
        expect(invoke).toHaveBeenCalledWith(
            "web_clipper_save_note",
            expect.objectContaining({ content: "Inline text" }),
        );
    });
});
