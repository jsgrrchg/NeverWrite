import { fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useVaultStore } from "../../app/store/vaultStore";
import { renderComponent } from "../../test/test-utils";
import { AgentsSidebarPanel } from "./AgentsSidebarPanel";
import { resetChatStore, useChatStore } from "./store/chatStore";

const chatPaneMovementMock = vi.hoisted(() => ({
    createNewChatInWorkspace: vi.fn(),
    openChatHistoryInWorkspace: vi.fn(),
    openChatSessionInWorkspace: vi.fn(),
}));

vi.mock("./chatPaneMovement", () => chatPaneMovementMock);

describe("AgentsSidebarPanel", () => {
    beforeEach(() => {
        resetChatStore();
        vi.clearAllMocks();
        useVaultStore.setState({
            vaultPath: "/vault",
            notes: [],
            entries: [],
        });
        useChatStore.setState({
            runtimes: [
                {
                    runtime: {
                        id: "codex-acp",
                        name: "Codex ACP",
                        description: "",
                        capabilities: [],
                    },
                    models: [],
                    modes: [],
                    configOptions: [],
                },
                {
                    runtime: {
                        id: "claude-acp",
                        name: "Claude ACP",
                        description: "",
                        capabilities: [],
                    },
                    models: [],
                    modes: [],
                    configOptions: [],
                },
            ],
            selectedRuntimeId: "codex-acp",
        });
    });

    it("creates a chat directly from the plus button without opening a provider menu", () => {
        renderComponent(<AgentsSidebarPanel />);

        fireEvent.click(screen.getByRole("button", { name: "New chat" }));

        expect(
            chatPaneMovementMock.createNewChatInWorkspace,
        ).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole("button", { name: "Codex" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Claude" })).toBeNull();
        expect(
            screen.queryByRole("button", { name: "Add providers" }),
        ).toBeNull();
    });
});
