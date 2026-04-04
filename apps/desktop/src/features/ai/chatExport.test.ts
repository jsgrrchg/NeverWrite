import { describe, expect, it } from "vitest";
import type { AIChatSession, AIRuntimeOption } from "./types";
import { buildChatExportMarkdown, buildChatExportNoteName } from "./chatExport";

function createSession(
    sessionId: string,
    title: string,
    overrides: Partial<AIChatSession> = {},
): AIChatSession {
    return {
        sessionId,
        historySessionId: overrides.historySessionId ?? sessionId,
        status: overrides.status ?? "idle",
        runtimeId: overrides.runtimeId ?? "codex-acp",
        modelId: overrides.modelId ?? "test-model",
        modeId: overrides.modeId ?? "default",
        models: overrides.models ?? [],
        modes: overrides.modes ?? [],
        configOptions: overrides.configOptions ?? [],
        messages: overrides.messages ?? [
            {
                id: `${sessionId}-user`,
                role: "user",
                kind: "text",
                content: title,
                timestamp: Date.UTC(2026, 2, 10, 15, 0, 0),
            },
            {
                id: `${sessionId}-assistant`,
                role: "assistant",
                kind: "text",
                content: "Respuesta",
                timestamp: Date.UTC(2026, 2, 10, 15, 1, 0),
            },
        ],
        attachments: overrides.attachments ?? [],
        isPersistedSession: overrides.isPersistedSession,
        isResumingSession: overrides.isResumingSession,
        resumeContextPending: overrides.resumeContextPending,
        effortsByModel: overrides.effortsByModel,
    };
}

const runtimes: AIRuntimeOption[] = [
    {
        id: "codex-acp",
        name: "Codex ACP",
        description: "Codex runtime embedded as an ACP sidecar.",
        capabilities: ["attachments", "permissions", "reasoning"],
    },
];

describe("chatExport", () => {
    it("builds a unique export note name in the vault root", () => {
        const session = createSession("session-a", "Plan / test");

        const noteName = buildChatExportNoteName(session, [
            "Exported chat - Plan test.md",
            "Otra nota.md",
        ]);

        expect(noteName).toBe("Exported chat - Plan test 2");
    });

    it("renders a compact markdown transcript for the chat", () => {
        const session = createSession("session-a", "Plan de trabajo", {
            attachments: [
                {
                    id: "note-1",
                    type: "note",
                    noteId: "docs/spec.md",
                    label: "Spec",
                    path: "/vault/docs/spec.md",
                },
            ],
        });

        const markdown = buildChatExportMarkdown(
            session,
            runtimes,
            new Date(Date.UTC(2026, 2, 10, 15, 5, 0)),
        );

        expect(markdown).toContain("# Exported chat: Plan de trabajo");
        expect(markdown).toContain("- Runtime: Codex ACP");
        expect(markdown).toContain("## Attached context");
        expect(markdown).toContain("- Note: Spec (/vault/docs/spec.md)");
        expect(markdown).toContain("## Conversation");
        expect(markdown).toContain("### User");
        expect(markdown).toContain("### Assistant");
        expect(markdown).toContain("Respuesta");
    });
});
