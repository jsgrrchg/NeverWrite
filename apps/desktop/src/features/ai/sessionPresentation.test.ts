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

    it("formats review tab titles with normalized runtime names for Kilo", () => {
        const session = {
            ...createSession("live-session-2", "history-2"),
            runtimeId: "kilo-acp",
        };
        const runtimes: AIRuntimeDescriptor[] = [
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

        expect(getReviewTabTitle(session, runtimes)).toBe("Review Kilo");
    });
});
