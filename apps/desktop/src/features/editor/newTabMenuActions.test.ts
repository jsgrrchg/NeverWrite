import { waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "../../app/store/settingsStore";
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
        setupStatusByRuntimeId: {
            [CLAUDE_TERMINAL_RUNTIME_ID]: {
                runtimeId: CLAUDE_TERMINAL_RUNTIME_ID,
                binaryReady: true,
                binarySource: "env",
                authReady: true,
                onboardingRequired: false,
                authMethods: [],
            },
        },
    });
}

function getEntry(label: string): ContextMenuItem | undefined {
    return buildNewTabContextMenuEntries({ paneId: "secondary" }).find(
        (entry): entry is ContextMenuItem =>
            "label" in entry && entry.label === label,
    );
}

describe("newTabMenuActions", () => {
    beforeEach(() => {
        resetChatStore();
        useSettingsStore.setState({ claudeCodeEnabled: false });
        vi.clearAllMocks();
        seedRuntimes();
    });

    it("creates a canonical agent directly without a provider submenu", async () => {
        const newAgent = getEntry("New Agent");

        expect(newAgent?.children).toBeUndefined();
        newAgent?.action?.();

        await waitFor(() => {
            expect(
                chatPaneMovementMock.createNewChatInWorkspace,
            ).toHaveBeenCalledWith(undefined, { paneId: "secondary" });
        });
        expect(getEntry("Codex")).toBeUndefined();
    });

    it("adds Claude Code as a separate action when enabled for the vault", async () => {
        useSettingsStore.setState({ claudeCodeEnabled: true });

        getEntry("Claude Code")?.action?.();

        await waitFor(() => {
            expect(
                claudeCodeTerminalMock.openClaudeCodeTerminalWithContext,
            ).toHaveBeenCalledWith(undefined, "secondary");
        });
        expect(
            chatPaneMovementMock.createNewChatInWorkspace,
        ).not.toHaveBeenCalled();
    });

    it("does not expose ACP runtimes as creation actions", () => {
        useChatStore.setState((state) => ({
            runtimes: [
                ...state.runtimes,
                {
                    runtime: {
                        id: "custom:123e4567-e89b-12d3-a456-426614174000",
                        name: "Local reviewer",
                        description: "Custom ACP runtime.",
                        capabilities: ["create_session"],
                    },
                    models: [],
                    modes: [],
                    configOptions: [],
                },
            ],
        }));

        expect(getEntry("Local reviewer")).toBeUndefined();
        expect(getEntry("New Agent")).toBeDefined();
    });
});
