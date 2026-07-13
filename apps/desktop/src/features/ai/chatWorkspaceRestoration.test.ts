import { describe, expect, it } from "vitest";
import { listChatWorkspaceHistoryReferences } from "./chatWorkspaceRestoration";

describe("chatWorkspaceRestoration", () => {
    it("lists every session projected by a physical chat tab", () => {
        expect(
            listChatWorkspaceHistoryReferences([
                {
                    id: "chat-tab",
                    kind: "ai-chat",
                    sessionId: "session-b",
                    historySessionId: "history-b",
                    title: "Second",
                    history: [
                        {
                            sessionId: "session-a",
                            historySessionId: "history-a",
                            title: "First",
                        },
                        {
                            sessionId: "session-b",
                            historySessionId: "history-b",
                            title: "Second",
                        },
                    ],
                    historyIndex: 1,
                },
            ]),
        ).toEqual([
            {
                id: "chat-tab:history:0",
                tabId: "chat-tab",
                historyIndex: 0,
                isCurrent: false,
                sessionId: "session-a",
                historySessionId: "history-a",
                title: "First",
            },
            {
                id: "chat-tab",
                tabId: "chat-tab",
                historyIndex: 1,
                isCurrent: true,
                sessionId: "session-b",
                historySessionId: "history-b",
                title: "Second",
            },
        ]);
    });

    it("normalizes legacy chat tabs to a current history entry", () => {
        expect(
            listChatWorkspaceHistoryReferences([
                {
                    id: "legacy-chat",
                    kind: "ai-chat",
                    sessionId: "session-legacy",
                    title: "Legacy",
                },
            ]),
        ).toEqual([
            expect.objectContaining({
                id: "legacy-chat",
                tabId: "legacy-chat",
                historyIndex: 0,
                isCurrent: true,
                sessionId: "session-legacy",
            }),
        ]);
    });
});
