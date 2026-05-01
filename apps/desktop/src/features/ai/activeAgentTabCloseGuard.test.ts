import { describe, expect, it } from "vitest";
import type { Tab } from "../../app/store/editorStore";
import {
    confirmActiveAgentTabClose,
    getActiveAgentSessionsForTabs,
} from "./activeAgentTabCloseGuard";
import type { AIChatSession, AIChatSessionStatus } from "./types";
import { confirm } from "@neverwrite/runtime";

function createSession(
    sessionId: string,
    title: string,
    status: AIChatSessionStatus,
    overrides: Partial<AIChatSession> = {},
): AIChatSession {
    return {
        sessionId,
        historySessionId: sessionId,
        status,
        runtimeId: "codex-acp",
        modelId: "test-model",
        modeId: "default",
        models: [],
        modes: [],
        configOptions: [],
        messages: [
            {
                id: `${sessionId}-message`,
                role: "user",
                kind: "text",
                content: title,
                timestamp: 10,
            },
        ],
        attachments: [],
        runtimeState: "live",
        ...overrides,
    };
}

function chatTab(sessionId: string): Tab {
    return {
        id: `tab:${sessionId}`,
        kind: "ai-chat",
        sessionId,
        title: "Chat",
    };
}

describe("activeAgentTabCloseGuard", () => {
    it("warns for active subagents when closing the parent tab", () => {
        const parent = createSession("session-parent", "Parent", "idle");
        const child = createSession(
            "session-child",
            "Research worker",
            "streaming",
            {
                parentSessionId: parent.sessionId,
            },
        );

        expect(
            getActiveAgentSessionsForTabs([chatTab(parent.sessionId)], {
                [parent.sessionId]: parent,
                [child.sessionId]: child,
            }),
        ).toEqual([
            {
                sessionId: child.sessionId,
                title: "Research worker",
                statusLabel: "Streaming response",
            },
        ]);
    });

    it("does not warn for the parent when closing only a child tab", () => {
        const parent = createSession("session-parent", "Parent", "streaming");
        const child = createSession("session-child", "Child", "idle", {
            parentSessionId: parent.sessionId,
        });

        expect(
            getActiveAgentSessionsForTabs([chatTab(child.sessionId)], {
                [parent.sessionId]: parent,
                [child.sessionId]: child,
            }),
        ).toEqual([]);
    });

    it("warns for active nested descendants even when intermediate agents are idle", () => {
        const parent = createSession("session-parent", "Parent", "idle");
        const child = createSession("session-child", "Child", "idle", {
            parentSessionId: parent.sessionId,
        });
        const grandchild = createSession(
            "session-grandchild",
            "Nested worker",
            "waiting_permission",
            {
                parentSessionId: child.sessionId,
            },
        );

        expect(
            getActiveAgentSessionsForTabs([chatTab(parent.sessionId)], {
                [parent.sessionId]: parent,
                [child.sessionId]: child,
                [grandchild.sessionId]: grandchild,
            }),
        ).toEqual([
            {
                sessionId: grandchild.sessionId,
                title: "Nested worker",
                statusLabel: "Waiting for permission",
            },
        ]);
    });

    it("explains that closing tabs does not stop active agents", async () => {
        const session = createSession("session-busy", "Busy", "streaming");

        await confirmActiveAgentTabClose({
            actionLabel: "close the tab",
            tabs: [chatTab(session.sessionId)],
            sessionsById: {
                [session.sessionId]: session,
            },
        });

        expect(confirm).toHaveBeenCalledWith(
            expect.stringContaining(
                "Closing the tab will not stop the agent automatically.",
            ),
            expect.objectContaining({ title: "Close active agent tab?" }),
        );
    });
});
