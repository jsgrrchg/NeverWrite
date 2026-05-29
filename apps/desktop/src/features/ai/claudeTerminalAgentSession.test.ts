import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useEditorStore } from "../../app/store/editorStore";
import { useVaultStore } from "../../app/store/vaultStore";
import { setEditorTabs } from "../../test/test-utils";
import {
    resetTerminalRuntimeStoreForTests,
    useTerminalRuntimeStore,
    type WorkspaceTerminalRuntime,
} from "../terminal/terminalRuntimeStore";
import { EMPTY_TERMINAL_SNAPSHOT } from "../terminal/terminalTypes";
import {
    focusClaudeTerminalAgentSession,
    pruneClaudeTerminalAgentSessions,
    registerClaudeTerminalAgentSession,
} from "./claudeTerminalAgentSession";
import { resetChatStore, useChatStore } from "./store/chatStore";
import { CLAUDE_TERMINAL_RUNTIME_ID } from "./utils/runtimeMetadata";

function seedTerminalRuntime(terminalId: string) {
    useTerminalRuntimeStore.setState((state) => ({
        runtimesById: {
            ...state.runtimesById,
            [terminalId]: {
                terminalId,
                tabId: `${terminalId}-tab`,
                sessionId: `session-${terminalId}`,
                snapshot: { ...EMPTY_TERMINAL_SNAPSHOT, status: "running" },
                hasOutput: false,
                busy: false,
                launchError: null,
            } satisfies WorkspaceTerminalRuntime,
        },
    }));
}

const SESSION_ID = "claude-terminal:term-1";

describe("claudeTerminalAgentSession", () => {
    beforeEach(() => {
        resetChatStore();
        resetTerminalRuntimeStoreForTests();
        useVaultStore.setState({ vaultPath: "/vault" });
        setEditorTabs([]);
    });

    afterEach(() => {
        resetChatStore();
        resetTerminalRuntimeStoreForTests();
    });

    it("registers a listed, non-active agent entry for a Claude Code terminal", () => {
        registerClaudeTerminalAgentSession({
            terminalId: "term-1",
            title: "Claude Code 1",
        });

        const state = useChatStore.getState();
        const session = state.sessionsById[SESSION_ID];
        expect(session).toBeDefined();
        expect(session?.runtimeId).toBe(CLAUDE_TERMINAL_RUNTIME_ID);
        expect(session?.terminalId).toBe("term-1");
        expect(session?.customTitle).toBe("Claude Code 1");
        expect(session?.messages).toEqual([]);
        expect(state.sessionOrder).toContain(SESSION_ID);
        // A terminal agent is never a real chat target, so it must not steal the
        // active session (even when none was active before).
        expect(state.activeSessionId).not.toBe(SESSION_ID);
    });

    it("is idempotent — re-registering the same terminal updates one entry", () => {
        registerClaudeTerminalAgentSession({
            terminalId: "term-1",
            title: "Claude Code 1",
        });
        registerClaudeTerminalAgentSession({
            terminalId: "term-1",
            title: "Claude Code 1 (renamed)",
        });

        const state = useChatStore.getState();
        expect(
            state.sessionOrder.filter((id) => id === SESSION_ID),
        ).toHaveLength(1);
        expect(state.sessionsById[SESSION_ID]?.customTitle).toBe(
            "Claude Code 1 (renamed)",
        );
    });

    it("focuses the terminal tab when the agent entry is opened", () => {
        const tabs = [
            { id: "note-1", kind: "note", noteId: "notes/a", title: "Note A" },
            {
                id: "term-tab-1",
                kind: "terminal",
                terminalId: "term-1",
                title: "Claude Code 1",
                cwd: "/vault",
            },
        ] as Parameters<typeof setEditorTabs>[0];
        setEditorTabs(tabs, "note-1");

        const focused = focusClaudeTerminalAgentSession({ terminalId: "term-1" });

        expect(focused).toBe(true);
        expect(useEditorStore.getState().activeTabId).toBe("term-tab-1");
    });

    it("returns false when no terminal tab backs the entry", () => {
        setEditorTabs([]);
        expect(
            focusClaudeTerminalAgentSession({ terminalId: "missing" }),
        ).toBe(false);
    });

    it("prunes agent entries whose terminal is gone, keeping live ones", async () => {
        seedTerminalRuntime("term-live");
        registerClaudeTerminalAgentSession({
            terminalId: "term-live",
            title: "Live",
        });
        registerClaudeTerminalAgentSession({
            terminalId: "term-dead",
            title: "Dead",
        });

        pruneClaudeTerminalAgentSessions();

        await waitFor(() => {
            expect(
                useChatStore.getState().sessionsById["claude-terminal:term-dead"],
            ).toBeUndefined();
        });
        expect(
            useChatStore.getState().sessionsById["claude-terminal:term-live"],
        ).toBeDefined();
    });
});
