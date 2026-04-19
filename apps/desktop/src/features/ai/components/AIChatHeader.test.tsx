import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useEditorStore } from "../../../app/store/editorStore";
import { useVaultStore } from "../../../app/store/vaultStore";
import { renderComponent } from "../../../test/test-utils";
import type { AIChatSession } from "../types";
import { AIChatHeader } from "./AIChatHeader";

function createSession(
    sessionId: string,
    content: string,
    overrides: Partial<AIChatSession> = {},
): AIChatSession {
    return {
        sessionId,
        historySessionId: sessionId,
        status: "idle",
        runtimeId: "codex-acp",
        modelId: "test-model",
        modeId: "default",
        models: [],
        modes: [],
        configOptions: [],
        messages: [
            {
                id: `${sessionId}-message-1`,
                role: "user",
                kind: "text",
                content,
                timestamp: 1,
            },
        ],
        attachments: [],
        activeWorkCycleId: null,
        visibleWorkCycleId: null,
        resumeContextPending: false,
        runtimeState: "live",
        ...overrides,
    };
}

describe("AIChatHeader", () => {
    beforeEach(() => {
        useVaultStore.setState({ vaultPath: "/vault", notes: [], entries: [] });
        useEditorStore.getState().hydrateWorkspace(
            [
                {
                    id: "primary",
                    tabs: [],
                    activeTabId: null,
                },
            ],
            "primary",
        );
    });

    it("opens chat history as a workspace tab from the recent chats menu", async () => {
        const session = createSession("session-a", "Saved conversation");

        renderComponent(
            <AIChatHeader
                activeSessionId={session.sessionId}
                activeTabId={null}
                tabs={[]}
                sessionsById={{ [session.sessionId]: session }}
                panelExpanded={false}
                sessions={[session]}
                runtimes={[
                    {
                        id: "codex-acp",
                        name: "Codex ACP",
                        description: "",
                        capabilities: [],
                    },
                ]}
                onNewChat={vi.fn()}
                onSelectSession={vi.fn()}
                onSelectTab={vi.fn()}
                onReorderTabs={vi.fn()}
                onCloseTab={vi.fn()}
                onExportSession={vi.fn()}
                onDeleteSession={vi.fn()}
                onDeleteAllSessions={vi.fn()}
                onRenameSession={vi.fn()}
                onToggleExpanded={vi.fn()}
            />,
        );

        fireEvent.click(screen.getByRole("button", { name: "Recent" }));
        fireEvent.click(screen.getByRole("button", { name: "Chat History" }));

        await waitFor(() => {
            expect(
                useEditorStore
                    .getState()
                    .tabs.some((tab) => tab.kind === "ai-chat-history"),
            ).toBe(true);
        });
    });
});
