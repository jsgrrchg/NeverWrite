import { describe, expect, it } from "vitest";
import {
    getFirstUserTextMessage,
    getLastMeaningfulTranscriptMessage,
    getLastTranscriptMessage,
    getSessionTranscriptLength,
    normalizeSessionTranscript,
} from "./transcriptModel";
import type { AIChatMessage, AIChatSession } from "./types";

function createSession(messages: AIChatMessage[]): AIChatSession {
    return {
        sessionId: "session-a",
        historySessionId: "session-a",
        status: "idle",
        runtimeId: "codex-acp",
        modelId: "test-model",
        modeId: "default",
        models: [],
        modes: [],
        configOptions: [],
        messages,
        attachments: [],
    };
}

describe("transcriptModel", () => {
    it("builds normalized transcript metadata and selectors from raw messages", () => {
        const session = createSession([
            {
                id: "user:empty",
                role: "user",
                kind: "text",
                content: "   ",
                timestamp: 1,
            },
            {
                id: "user:prompt",
                role: "user",
                kind: "text",
                content: "Ship phase 3",
                timestamp: 2,
            },
            {
                id: "status:turn",
                role: "system",
                kind: "status",
                title: "Turn started",
                content: "Turn started",
                timestamp: 3,
                meta: {
                    status_event: "turn_started",
                    status: "completed",
                },
            },
            {
                id: "assistant:reply",
                role: "assistant",
                kind: "text",
                content: "Working on it",
                timestamp: 4,
            },
            {
                id: "plan:active",
                role: "assistant",
                kind: "plan",
                title: "Plan",
                content: "Implement transcript model",
                timestamp: 5,
                planEntries: [
                    {
                        content: "Implement transcript model",
                        priority: "medium",
                        status: "in_progress",
                    },
                ],
            },
            {
                id: "status:tail",
                role: "system",
                kind: "status",
                title: "Checkpoint",
                content: "Checkpoint",
                timestamp: 6,
            },
        ]);

        const normalized = normalizeSessionTranscript(session);

        expect(normalized.messageOrder).toEqual([
            "user:empty",
            "user:prompt",
            "status:turn",
            "assistant:reply",
            "plan:active",
            "status:tail",
        ]);
        expect(normalized.messagesById?.["assistant:reply"]?.content).toBe(
            "Working on it",
        );
        expect(normalized.messageIndexById?.["plan:active"]).toBe(4);
        expect(normalized.lastTurnStartedMessageId).toBe("status:turn");
        expect(normalized.lastAssistantMessageId).toBe("assistant:reply");
        expect(normalized.activePlanMessageId).toBe("plan:active");
        expect(getSessionTranscriptLength(normalized)).toBe(6);
        expect(getFirstUserTextMessage(normalized)?.id).toBe("user:prompt");
        expect(getLastMeaningfulTranscriptMessage(normalized)?.id).toBe(
            "plan:active",
        );
        expect(getLastTranscriptMessage(normalized)?.id).toBe("status:tail");
    });

    it("rebuilds stale normalized metadata when the transcript changed", () => {
        const staleSession: AIChatSession = {
            ...createSession([
                {
                    id: "assistant:new",
                    role: "assistant",
                    kind: "text",
                    content: "Fresh",
                    timestamp: 10,
                },
            ]),
            messageOrder: ["assistant:old"],
            messagesById: {
                "assistant:old": {
                    id: "assistant:old",
                    role: "assistant",
                    kind: "text",
                    content: "Stale",
                    timestamp: 1,
                },
            },
            messageIndexById: {
                "assistant:old": 0,
            },
            lastAssistantMessageId: "assistant:old",
            lastTurnStartedMessageId: null,
            activePlanMessageId: null,
        };

        const normalized = normalizeSessionTranscript(staleSession);

        expect(normalized.messageOrder).toEqual(["assistant:new"]);
        expect(normalized.messagesById?.["assistant:new"]?.content).toBe(
            "Fresh",
        );
        expect(normalized.lastAssistantMessageId).toBe("assistant:new");
        expect(normalized).not.toBe(staleSession);
    });

    it("reuses the same session reference when transcript metadata is already valid", () => {
        const normalized = normalizeSessionTranscript(
            createSession([
                {
                    id: "assistant:ok",
                    role: "assistant",
                    kind: "text",
                    content: "Ready",
                    timestamp: 1,
                },
            ]),
        );

        expect(normalizeSessionTranscript(normalized)).toBe(normalized);
    });
});
