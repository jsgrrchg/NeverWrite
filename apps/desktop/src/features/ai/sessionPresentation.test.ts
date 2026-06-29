import { describe, expect, it } from "vitest";
import type { AIChatSession, AIRuntimeDescriptor } from "./types";
import {
    findSessionForHistorySelection,
    getReviewTabTitle,
    getHistorySelectionId,
    getSessionTitleText,
} from "./sessionPresentation";

function createSession(
    sessionId: string,
    historySessionId: string,
): AIChatSession {
    return {
        sessionId,
        historySessionId,
        status: "idle",
        runtimeId: "codex-acp",
        modelId: "test-model",
        modeId: "default",
        models: [],
        modes: [],
        configOptions: [],
        messages: [],
        attachments: [],
    };
}

const runtimes: AIRuntimeDescriptor[] = [
    {
        runtime: {
            id: "codex-acp",
            name: "Codex ACP",
            description: "Codex runtime",
            capabilities: [],
        },
        models: [],
        modes: [],
        configOptions: [],
    },
    {
        runtime: {
            id: "kilo-acp",
            name: "Kilo ACP",
            description: "Kilo runtime",
            capabilities: [],
        },
        models: [],
        modes: [],
        configOptions: [],
    },
    {
        runtime: {
            id: "grok-acp",
            name: "Grok",
            description: "Grok runtime",
            capabilities: [],
        },
        models: [],
        modes: [],
        configOptions: [],
    },
];

describe("sessionPresentation history selection", () => {
    it("prefers manual titles over runtime titles", () => {
        const session = {
            ...createSession("live-session-title-1", "history-title-1"),
            customTitle: "Manual title",
            persistedTitle: "Runtime title",
            messages: [
                {
                    id: "message-1",
                    role: "user" as const,
                    kind: "text" as const,
                    content: "First prompt",
                    timestamp: 1,
                },
            ],
        };

        expect(getSessionTitleText(session)).toBe("Manual title");
    });

    it("prefers runtime titles over first-message fallback", () => {
        const session = {
            ...createSession("live-session-title-2", "history-title-2"),
            persistedTitle: "Runtime generated title",
            messages: [
                {
                    id: "message-2",
                    role: "user" as const,
                    kind: "text" as const,
                    content: "First prompt",
                    timestamp: 1,
                },
            ],
        };

        expect(getSessionTitleText(session)).toBe("Runtime generated title");
    });

    it("uses historySessionId as the stable history selection key", () => {
        const session = createSession("live-session-1", "history-1");

        expect(getHistorySelectionId(session)).toBe("history-1");
    });

    it("resolves a resumed live session from its historySessionId", () => {
        const liveSession = createSession("live-session-1", "history-1");

        expect(
            findSessionForHistorySelection([liveSession], "history-1")
                ?.sessionId,
        ).toBe("live-session-1");
    });

    it("still resolves legacy persisted-prefixed selection ids", () => {
        const persistedSession = createSession(
            "persisted:history-1",
            "history-1",
        );

        expect(
            findSessionForHistorySelection(
                [persistedSession],
                "persisted:history-1",
            )?.sessionId,
        ).toBe("persisted:history-1");
    });

    it("formats root review tab titles with normalized runtime names for Codex", () => {
        const session = createSession("live-session-2", "history-2");

        expect(getReviewTabTitle(session, runtimes)).toBe("Review Codex");
    });

    it("formats review tab titles with normalized runtime names for Kilo", () => {
        const session = {
            ...createSession("live-session-3", "history-3"),
            runtimeId: "kilo-acp",
        };

        expect(getReviewTabTitle(session, runtimes)).toBe("Review Kilo");
    });

    it("formats review tab titles with Grok runtime ids", () => {
        const session = {
            ...createSession("live-session-grok", "history-grok"),
            runtimeId: "grok-acp",
        };

        expect(getReviewTabTitle(session, runtimes)).toBe("Review Grok");
    });

    it("formats subagent review tab titles with the visible session name", () => {
        const session = {
            ...createSession("live-session-4", "history-4"),
            parentSessionId: "parent-session",
            customTitle: "Descartes",
        };

        expect(getReviewTabTitle(session, runtimes)).toBe("Review: Descartes");
    });

    it("uses a subagent fallback when the visible session name is not useful", () => {
        const session = {
            ...createSession("live-session-5", "history-5"),
            parentSessionId: "parent-session",
        };

        expect(getReviewTabTitle(session, runtimes)).toBe("Review: Subagent");
    });
});
