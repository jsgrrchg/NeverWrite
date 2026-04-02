import { describe, expect, it } from "vitest";
import type { AIChatSession } from "./types";
import {
    findSessionForHistorySelection,
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
            findSessionForHistorySelection([liveSession], "history-1")?.sessionId,
        ).toBe("live-session-1");
    });

    it("still resolves legacy persisted-prefixed selection ids", () => {
        const persistedSession = createSession("persisted:history-1", "history-1");

        expect(
            findSessionForHistorySelection(
                [persistedSession],
                "persisted:history-1",
            )?.sessionId,
        ).toBe("persisted:history-1");
    });
});
