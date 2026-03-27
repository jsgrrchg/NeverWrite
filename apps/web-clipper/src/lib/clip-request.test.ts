import { describe, expect, it } from "vitest";
import {
    createClipRequestDraft,
    INLINE_PAYLOAD_MAX_BYTES,
} from "./clip-request";
import { createClipDeepLink } from "./deep-link";

const clipData = {
    metadata: {
        title: "Example note",
        url: "https://example.com/post",
        domain: "example.com",
        description: "",
        author: "",
        published: "",
        image: "",
        favicon: "",
        language: "en",
    },
    content: {
        html: "<p>Example note</p>",
        markdown: "Example note",
        wordCount: 2,
    },
    selection: null,
    extractedAt: "2026-03-24T00:00:00.000Z",
};

describe("createClipRequestDraft", () => {
    it("uses inline mode for short payloads", () => {
        const draft = createClipRequestDraft({
            clipData,
            contentMarkdown: "Short note",
            title: "Short note",
            vault: "/vaults/personal",
            vaultPathHint: "/vaults/personal",
            vaultNameHint: "Personal",
            folder: "Inbox",
        });

        expect(draft.payload.mode).toBe("inline");
        expect(draft.payload.content).toBe("Short note");
        expect(draft.payload.clipboardToken).toBeUndefined();
        expect(draft.clipboardMarkdown).toBeNull();

        const deepLink = createClipDeepLink(draft.payload);
        expect(deepLink).toContain("mode=inline");
        expect(deepLink).toContain("vault=%2Fvaults%2Fpersonal");
        expect(deepLink).toContain("vaultPathHint=%2Fvaults%2Fpersonal");
        expect(deepLink).toContain("vaultNameHint=Personal");
        expect(deepLink).toContain("folder=Inbox");
    });

    it("uses clipboard mode for large payloads", () => {
        const contentMarkdown = "x".repeat(INLINE_PAYLOAD_MAX_BYTES + 50);
        const draft = createClipRequestDraft({
            clipData,
            contentMarkdown,
            title: "Large note",
            vault: "/vaults/personal",
            vaultPathHint: "/vaults/personal",
            vaultNameHint: "Personal",
        });

        expect(draft.payload.mode).toBe("clipboard");
        expect(draft.payload.content).toBeUndefined();
        expect(draft.payload.clipboardToken).toBeTruthy();
        expect(draft.clipboardMarkdown).toBe(contentMarkdown);

        const deepLink = createClipDeepLink(draft.payload);
        expect(deepLink).toContain("mode=clipboard");
        expect(deepLink).toContain("clipboardToken=");
    });

    it("allows forcing clipboard mode for short payloads", () => {
        const draft = createClipRequestDraft({
            clipData,
            contentMarkdown: "Short note",
            title: "Short note",
            vault: "/vaults/personal",
            vaultPathHint: "/vaults/personal",
            vaultNameHint: "Personal",
            preferClipboard: true,
        });

        expect(draft.payload.mode).toBe("clipboard");
        expect(draft.clipboardMarkdown).toBe("Short note");
    });

    it("keeps legacy vault populated with a usable identity", () => {
        const draft = createClipRequestDraft({
            clipData,
            contentMarkdown: "Short note",
            title: "Short note",
            vault: "/vaults/personal",
            vaultPathHint: "/vaults/personal",
            vaultNameHint: "Personal",
        });

        expect(draft.payload.vault).toBe("/vaults/personal");
        expect(draft.payload.vaultPathHint).toBe("/vaults/personal");
        expect(draft.payload.vaultNameHint).toBe("Personal");
    });
});
