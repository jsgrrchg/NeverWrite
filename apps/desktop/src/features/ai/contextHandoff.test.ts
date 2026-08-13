import { describe, expect, it } from "vitest";
import type { AIChatMessage } from "./types";
import {
    ACP_HANDOFF_TRANSCRIPT_MARKER,
    ACP_HANDOFF_USER_MESSAGE_MARKER,
    buildAcpContextHandoff,
    extractAcpContextHandoffUserMessage,
    isAcpContextHandoffPrompt,
} from "./contextHandoff";

function message(
    id: string,
    role: AIChatMessage["role"],
    content: string,
    overrides: Partial<AIChatMessage> = {},
): AIChatMessage {
    return {
        id,
        role,
        kind: "text",
        content,
        timestamp: Number(id.replace(/\D/g, "")) || 1,
        ...overrides,
    };
}

describe("ACP context handoff", () => {
    it("formats safe historical context without exposing interactive state", () => {
        const result = buildAcpContextHandoff({
            messages: [
                message("m1", "user", "Inspect the vault", {
                    attachments: [
                        {
                            id: "attachment-1",
                            type: "file",
                            noteId: null,
                            label: "notes.md",
                            path: "docs/notes.md",
                            content: "private attachment payload",
                        },
                    ],
                }),
                message("m2", "assistant", "Read docs/notes.md", {
                    kind: "tool",
                    title: "Read file",
                    meta: { status: "completed" },
                }),
                message("m3", "assistant", "Approve deletion?", {
                    kind: "permission",
                }),
                message("m4", "assistant", "Pending tool payload", {
                    kind: "tool",
                    meta: { status: "pending" },
                }),
                message("m5", "assistant", "Finished inspection"),
            ],
            newUserMessage: "Continue",
        });

        expect(result.hasHandoff).toBe(true);
        expect(result.prompt).toContain("User: Inspect the vault");
        expect(result.prompt).toContain(
            "Attachment (file): notes.md — docs/notes.md",
        );
        expect(result.prompt).toContain("Assistant (tool): Read docs/notes.md");
        expect(result.prompt).not.toContain("private attachment payload");
        expect(result.prompt).not.toContain("Approve deletion?");
        expect(result.prompt).not.toContain("Pending tool payload");
        expect(result.prompt).toContain(
            `${ACP_HANDOFF_USER_MESSAGE_MARKER} Continue`,
        );
    });

    it("redacts messages and inline blocks explicitly marked as secret", () => {
        const result = buildAcpContextHandoff({
            messages: [
                message("m1", "user", "API key sk-live-secret", {
                    meta: { secret: true },
                }),
                message(
                    "m2",
                    "assistant",
                    "Stored <secret>another-secret</secret> safely",
                ),
            ],
            contextSummary:
                "Earlier token [secret]summary-secret[/secret] was configured.",
            newUserMessage: "Continue safely",
        });

        expect(result.prompt).toContain("[Marked secret omitted]");
        expect(result.prompt).not.toContain("sk-live-secret");
        expect(result.prompt).not.toContain("another-secret");
        expect(result.prompt).not.toContain("summary-secret");
    });

    it("keeps recent turns whole and explicitly reports budget truncation", () => {
        const messages = Array.from({ length: 8 }, (_, index) => [
            message(`u${index}`, "user", `Request ${index} ${"x".repeat(120)}`),
            message(
                `a${index}`,
                "assistant",
                `Response ${index} ${"y".repeat(120)}`,
            ),
        ]).flat();
        const result = buildAcpContextHandoff({
            messages,
            newUserMessage: "Latest request",
            maxCharacters: 1_500,
        });

        expect(result.prompt.length).toBeLessThanOrEqual(1_500);
        expect(result.metadata.truncated).toBe(true);
        expect(result.metadata.omittedTurnCount).toBeGreaterThan(0);
        expect(result.metadata.nextCursor).toBe("a7");
        expect(result.prompt).toContain(
            "Some earlier context was summarized or omitted for this provider.",
        );
        expect(result.prompt).toContain("Request 7");
        expect(result.prompt).toContain("Response 7");
        for (let index = 0; index < 8; index += 1) {
            expect(result.prompt.includes(`Request ${index}`)).toBe(
                result.prompt.includes(`Response ${index}`),
            );
        }
    });

    it("uses only the delta after a binding cursor and is idempotent", () => {
        const messages = [
            message("m1", "user", "Old request"),
            message("m2", "assistant", "Old response"),
            message("m3", "user", "New request"),
            message("m4", "assistant", "New response"),
        ];
        const delta = buildAcpContextHandoff({
            messages,
            contextCursor: "m2",
            newUserMessage: "Next",
        });

        expect(delta.prompt).not.toContain("Old request");
        expect(delta.prompt).toContain("New request");
        expect(delta.metadata).toMatchObject({
            fromCursor: "m2",
            nextCursor: "m4",
            cursorFound: true,
            includedMessageIds: ["m3", "m4"],
        });

        const repeated = buildAcpContextHandoff({
            messages,
            contextCursor: delta.metadata.nextCursor,
            newUserMessage: "Next",
        });
        expect(repeated).toMatchObject({
            prompt: "Next",
            hasHandoff: false,
            metadata: {
                nextCursor: "m4",
                includedMessageIds: [],
            },
        });
    });

    it("does not recursively include a prior internal handoff prompt", () => {
        const leaked = [
            "Use the saved transcript below as prior conversation context for this session.",
            "",
            ACP_HANDOFF_TRANSCRIPT_MARKER,
            "User: leaked",
            "",
            `${ACP_HANDOFF_USER_MESSAGE_MARKER} leaked`,
        ].join("\n");
        const result = buildAcpContextHandoff({
            messages: [
                message("m1", "user", leaked),
                message("m2", "assistant", "Visible response"),
                message("m3", "user", "Visible request"),
            ],
            newUserMessage: "Sigue",
        });

        expect(result.prompt).not.toContain("User: leaked");
        expect(result.prompt).toContain("Visible response");
        expect(result.prompt).toContain("Visible request");
        expect(isAcpContextHandoffPrompt(result.prompt)).toBe(true);
        expect(extractAcpContextHandoffUserMessage(result.prompt)).toBe(
            "Sigue",
        );
    });

    it("keeps compact handoffs identifiable when only the user message fits", () => {
        const result = buildAcpContextHandoff({
            messages: [
                message("m1", "user", "x".repeat(2_000)),
                message("m2", "assistant", "y".repeat(2_000)),
            ],
            contextSummary: "z".repeat(2_000),
            newUserMessage: "Continue",
            maxCharacters: 512,
        });

        expect(result.prompt.length).toBeLessThanOrEqual(512);
        expect(isAcpContextHandoffPrompt(result.prompt)).toBe(true);
        expect(result.metadata).toMatchObject({
            nextCursor: "m2",
            truncated: true,
        });
    });
});
