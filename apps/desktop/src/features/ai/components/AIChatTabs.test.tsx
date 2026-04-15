import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderComponent } from "../../../test/test-utils";
import type { AIChatSession, AIRuntimeOption } from "../types";
import type { ChatWorkspaceTab } from "../store/chatTabsStore";
import { AIChatTabs } from "./AIChatTabs";

if (typeof window.PointerEvent === "undefined") {
    class MockPointerEvent extends MouseEvent {
        pointerId: number;
        pointerType: string;
        isPrimary: boolean;

        constructor(
            type: string,
            init: MouseEventInit & {
                pointerId?: number;
                pointerType?: string;
                isPrimary?: boolean;
            } = {},
        ) {
            super(type, init);
            this.pointerId = init.pointerId ?? 1;
            this.pointerType = init.pointerType ?? "mouse";
            this.isPrimary = init.isPrimary ?? true;
        }
    }

    Object.defineProperty(window, "PointerEvent", {
        configurable: true,
        value: MockPointerEvent,
    });
    Object.defineProperty(globalThis, "PointerEvent", {
        configurable: true,
        value: MockPointerEvent,
    });
}

if (typeof HTMLElement.prototype.setPointerCapture !== "function") {
    Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
        configurable: true,
        value: () => {},
    });
}

if (typeof HTMLElement.prototype.releasePointerCapture !== "function") {
    Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", {
        configurable: true,
        value: () => {},
    });
}

if (typeof HTMLElement.prototype.hasPointerCapture !== "function") {
    Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", {
        configurable: true,
        value: () => false,
    });
}

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
                onReorderTabs={() => {}}
                onCloseTab={() => {}}
                onExportSession={() => {}}
                onRenameSession={() => {}}
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
                onReorderTabs={() => {}}
                onCloseTab={onCloseTab}
                onExportSession={() => {}}
                onRenameSession={() => {}}
            />,
        );

        fireEvent.click(screen.getByRole("tab", { name: /Second tab/ }));
        fireEvent.click(screen.getByLabelText("Close First tab"));

        expect(onSelectTab).toHaveBeenCalledWith("tab-b");
        expect(onCloseTab).toHaveBeenCalledWith("tab-a");
    });

    it("waits until pointer release before selecting a tab", () => {
        const onSelectTab = vi.fn();

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
                onReorderTabs={() => {}}
                onCloseTab={() => {}}
                onExportSession={() => {}}
                onRenameSession={() => {}}
            />,
        );

        const targetTab = screen.getByRole("tab", { name: /Second tab/ });

        fireEvent.pointerDown(targetTab, {
            pointerId: 1,
            button: 0,
            buttons: 1,
            clientX: 120,
            clientY: 18,
            screenX: 120,
            screenY: 18,
        });

        expect(onSelectTab).not.toHaveBeenCalled();

        fireEvent.pointerUp(targetTab, {
            pointerId: 1,
            button: 0,
            buttons: 0,
            clientX: 120,
            clientY: 18,
            screenX: 120,
            screenY: 18,
        });

        expect(onSelectTab).toHaveBeenCalledTimes(1);
        expect(onSelectTab).toHaveBeenCalledWith("tab-b");
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
                onReorderTabs={() => {}}
                onCloseTab={() => {}}
                onExportSession={() => {}}
                onRenameSession={() => {}}
            />,
        );

        expect(screen.getByRole("tablist")).toHaveClass("scrollbar-hidden");
        expect(screen.queryByText("Codex")).toBeNull();
    });

    it("opens a context menu and exports the selected session", async () => {
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
                onReorderTabs={() => {}}
                onCloseTab={() => {}}
                onExportSession={onExportSession}
                onRenameSession={() => {}}
            />,
        );

        fireEvent.contextMenu(screen.getByRole("tab", { name: /First tab/ }), {
            clientX: 24,
            clientY: 18,
        });
        fireEvent.click(screen.getByText("Export chat to Markdown"));

        await waitFor(() => {
            expect(onExportSession).toHaveBeenCalledWith("session-a");
        });
    });

    it("renames a tab session from the context menu and cancels with Escape", async () => {
        const onRenameSession = vi.fn();

        renderComponent(
            <AIChatTabs
                tabs={[{ id: "tab-a", sessionId: "session-a" }]}
                activeTabId="tab-a"
                sessionsById={{
                    "session-a": createSession("session-a", "First tab"),
                }}
                runtimes={runtimes}
                onSelectTab={() => {}}
                onReorderTabs={() => {}}
                onCloseTab={() => {}}
                onExportSession={() => {}}
                onRenameSession={onRenameSession}
            />,
        );

        fireEvent.contextMenu(screen.getByRole("tab", { name: /First tab/ }), {
            clientX: 24,
            clientY: 18,
        });
        fireEvent.click(screen.getByText("Rename chat"));

        const input = await screen.findByDisplayValue("First tab");
        fireEvent.change(input, { target: { value: "Renamed tab" } });
        fireEvent.keyDown(input, { key: "Escape" });
        fireEvent.blur(input);

        expect(onRenameSession).not.toHaveBeenCalled();

        fireEvent.contextMenu(screen.getByRole("tab", { name: /First tab/ }), {
            clientX: 24,
            clientY: 18,
        });
        fireEvent.click(screen.getByText("Rename chat"));

        const secondInput = await screen.findByDisplayValue("First tab");
        fireEvent.change(secondInput, { target: { value: "Renamed tab" } });
        fireEvent.keyDown(secondInput, { key: "Enter" });

        await waitFor(() => {
            expect(onRenameSession).toHaveBeenCalledWith(
                "session-a",
                "Renamed tab",
            );
        });
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
                onReorderTabs={() => {}}
                onCloseTab={() => {}}
                onExportSession={() => {}}
                onRenameSession={() => {}}
            />,
        );

        expect(screen.getByRole("tab", { name: /Saved chat/ })).toHaveAttribute(
            "title",
            "Claude ACP • Saved chat",
        );
    });
});
