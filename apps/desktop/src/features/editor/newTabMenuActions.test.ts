import { waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextMenuEntry } from "../../components/context-menu/ContextMenu";
import { resetChatStore, useChatStore } from "../ai/store/chatStore";
import { CLAUDE_TERMINAL_RUNTIME_ID } from "../ai/utils/runtimeMetadata";
import { buildNewTabContextMenuEntries } from "./newTabMenuActions";

type ContextMenuItem = Extract<ContextMenuEntry, { label: string }>;

const chatPaneMovementMock = vi.hoisted(() => ({
    createNewChatInWorkspace: vi.fn(async () => undefined),
}));
const claudeCodeTerminalMock = vi.hoisted(() => ({
    openClaudeCodeTerminalWithContext: vi.fn(async () => undefined),
}));

vi.mock("../ai/chatPaneMovement", () => chatPaneMovementMock);
vi.mock("../terminal/claudeCodeTerminal", () => claudeCodeTerminalMock);

function seedRuntimes() {
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
                    id: CLAUDE_TERMINAL_RUNTIME_ID,
                    name: "Claude Code",
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
}

function isContextMenuItem(entry: ContextMenuEntry): entry is ContextMenuItem {
    return "label" in entry;
}

function getNewAgentChild(label: string): ContextMenuItem {
    const newAgent = buildNewTabContextMenuEntries({
        paneId: "secondary",
    }).find(
        (entry): entry is ContextMenuItem =>
            isContextMenuItem(entry) && entry.label === "New Agent",
    );
    const child = newAgent?.children?.find(
        (entry): entry is ContextMenuItem =>
            isContextMenuItem(entry) && entry.label === label,
    );
    expect(child).toBeDefined();
    return child!;
}

describe("newTabMenuActions", () => {
    beforeEach(() => {
        resetChatStore();
        vi.clearAllMocks();
        seedRuntimes();
    });

    it("opens Claude Code agent entries as terminal sessions in the target pane", async () => {
        getNewAgentChild("Claude Code").action?.();

        await waitFor(() => {
            expect(
                claudeCodeTerminalMock.openClaudeCodeTerminalWithContext,
            ).toHaveBeenCalledWith(undefined, "secondary");
        });
        expect(
            chatPaneMovementMock.createNewChatInWorkspace,
        ).not.toHaveBeenCalled();
        expect(useChatStore.getState().selectedRuntimeId).toBe(
            CLAUDE_TERMINAL_RUNTIME_ID,
        );
    });

    it("keeps ACP agent entries on the normal chat creation path", async () => {
        useChatStore.setState({
            selectedRuntimeId: CLAUDE_TERMINAL_RUNTIME_ID,
        });

        getNewAgentChild("Codex").action?.();

        await waitFor(() => {
            expect(
                chatPaneMovementMock.createNewChatInWorkspace,
            ).toHaveBeenCalledWith("codex-acp", { paneId: "secondary" });
        });
        expect(
            claudeCodeTerminalMock.openClaudeCodeTerminalWithContext,
        ).not.toHaveBeenCalled();
        expect(useChatStore.getState().selectedRuntimeId).toBe("codex-acp");
    });
});
