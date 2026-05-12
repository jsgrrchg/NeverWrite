import { describe, expect, it } from "vitest";
import type { AIChatSession, AIRuntimeDescriptor } from "./types";
import {
    findSessionForHistorySelection,
    getReviewTabTitle,
    getHistorySelectionId,
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
];

describe("sessionPresentation history selection", () => {
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
