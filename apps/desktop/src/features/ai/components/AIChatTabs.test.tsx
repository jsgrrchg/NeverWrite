import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderComponent } from "../../../test/test-utils";
import type { AIChatSession, AIRuntimeOption } from "../types";
import type { ChatWorkspaceTab } from "../store/chatTabsStore";
import { AIChatTabs } from "./AIChatTabs";

function createSession(
    sessionId: string,
    title: string,
    status: AIChatSession["status"] = "idle",
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
    };
}

const runtimes: AIRuntimeOption[] = [
    {
        id: "codex-acp",
        name: "Codex ACP",
        description: "Codex runtime embedded as an ACP sidecar.",
        capabilities: ["attachments", "permissions", "reasoning"],
    },
    {
        id: "claude-acp",
        name: "Claude ACP",
        description: "Claude runtime embedded as an ACP sidecar.",
        capabilities: ["create_session", "resume_session"],
    },
];

describe("AIChatTabs", () => {
    it("renders tabs with active state and status badges", () => {
        const tabs: ChatWorkspaceTab[] = [
            { id: "tab-a", sessionId: "session-a" },
            { id: "tab-b", sessionId: "session-b" },
        ];

        renderComponent(
            <AIChatTabs
                tabs={tabs}
                activeTabId="tab-b"
                sessionsById={{
                    "session-a": createSession("session-a", "First tab"),
                    "session-b": createSession(
                        "session-b",
                        "Second tab",
                        "streaming",
                    ),
                }}
                runtimes={runtimes}
                onSelectTab={() => {}}
                onCloseTab={() => {}}
                onExportSession={() => {}}
            />,
        );

        expect(screen.getByRole("tab", { name: /Second tab/ })).toHaveAttribute(
            "aria-selected",
            "true",
        );
        expect(screen.getByTitle("Streaming")).toBeInTheDocument();
    });

    it("selects and closes tabs through their callbacks", () => {
        const onSelectTab = vi.fn();
        const onCloseTab = vi.fn();

        renderComponent(
            <AIChatTabs
                tabs={[
                    { id: "tab-a", sessionId: "session-a" },
                    { id: "tab-b", sessionId: "session-b" },
                ]}
                activeTabId="tab-a"
                sessionsById={{
                    "session-a": createSession("session-a", "First tab"),
                    "session-b": createSession("session-b", "Second tab"),
                }}
                runtimes={runtimes}
                onSelectTab={onSelectTab}
                onCloseTab={onCloseTab}
                onExportSession={() => {}}
            />,
        );

        fireEvent.click(screen.getByRole("tab", { name: /Second tab/ }));
        fireEvent.click(screen.getByLabelText("Close First tab"));

        expect(onSelectTab).toHaveBeenCalledWith("tab-b");
        expect(onCloseTab).toHaveBeenCalledWith("tab-a");
    });

    it("hides secondary tab metadata in compact densities", () => {
        renderComponent(
            <AIChatTabs
                tabs={[{ id: "tab-a", sessionId: "session-a" }]}
                activeTabId="tab-a"
                sessionsById={{
                    "session-a": createSession("session-a", "First tab"),
                }}
                runtimes={runtimes}
                density="compact"
                onSelectTab={() => {}}
                onCloseTab={() => {}}
                onExportSession={() => {}}
            />,
        );

        expect(screen.getByRole("tablist")).toHaveClass("scrollbar-hidden");
        expect(screen.queryByText("Codex")).toBeNull();
    });

    it("opens a context menu and exports the selected session", () => {
        const onExportSession = vi.fn();

        renderComponent(
            <AIChatTabs
                tabs={[{ id: "tab-a", sessionId: "session-a" }]}
                activeTabId="tab-a"
                sessionsById={{
                    "session-a": createSession("session-a", "First tab"),
                }}
                runtimes={runtimes}
                onSelectTab={() => {}}
                onCloseTab={() => {}}
                onExportSession={onExportSession}
            />,
        );

        fireEvent.contextMenu(screen.getByRole("tab", { name: /First tab/ }), {
            clientX: 24,
            clientY: 18,
        });
        fireEvent.click(screen.getByText("Export chat to Markdown"));

        expect(onExportSession).toHaveBeenCalledWith("session-a");
    });

    it("uses the tab runtime as fallback metadata for restored tabs", () => {
        renderComponent(
            <AIChatTabs
                tabs={[
                    {
                        id: "tab-a",
                        sessionId: "persisted:history-1",
                        runtimeId: "claude-acp",
                    },
                ]}
                activeTabId="tab-a"
                sessionsById={{}}
                runtimes={runtimes}
                onSelectTab={() => {}}
                onCloseTab={() => {}}
                onExportSession={() => {}}
            />,
        );

        expect(screen.getByRole("tab", { name: /Saved chat/ })).toHaveAttribute(
            "title",
            "Claude ACP • Saved chat",
        );
    });
});
