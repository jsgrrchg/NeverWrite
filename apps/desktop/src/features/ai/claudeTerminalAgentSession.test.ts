import { invoke } from "@neverwrite/runtime";
import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    selectEditorWorkspaceTabs,
    useEditorStore,
} from "../../app/store/editorStore";
import { useVaultStore } from "../../app/store/vaultStore";
import { setEditorTabs } from "../../test/test-utils";
import { openChatSessionInWorkspace } from "./chatPaneMovement";
import {
    resetTerminalRuntimeStoreForTests,
    useTerminalRuntimeStore,
    type WorkspaceTerminalRuntime,
} from "../terminal/terminalRuntimeStore";
import { EMPTY_TERMINAL_SNAPSHOT } from "../terminal/terminalTypes";
import {
    closeClaudeTerminalAgentSession,
    focusClaudeTerminalAgentSession,
    pruneClaudeTerminalAgentSessions,
    refreshClaudeTerminalAgentTranscripts,
    registerClaudeTerminalAgentSession,
    resetClaudeTerminalAgentSessionsForTests,
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
        resetClaudeTerminalAgentSessionsForTests();
        resetChatStore();
        resetTerminalRuntimeStoreForTests();
        vi.mocked(invoke).mockReset();
        useVaultStore.setState({ vaultPath: "/vault" });
        setEditorTabs([]);
        // The entry is self-healing: it only survives while its terminal is
        // live, so seed the runtime the default-case tests register against.
        seedTerminalRuntime("term-1");
    });

    afterEach(() => {
        resetClaudeTerminalAgentSessionsForTests();
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
        // Default label lives in persistedTitle, so a manual rename (customTitle)
        // and the transcript-derived title can both override it.
        expect(session?.persistedTitle).toBe("Claude Code 1");
        // No manual rename, so the title falls back to persistedTitle.
        expect(session?.customTitle).toBeFalsy();
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
        expect(state.sessionsById[SESSION_ID]?.persistedTitle).toBe(
            "Claude Code 1 (renamed)",
        );
    });

    it("fills title and preview from the Claude Code transcript", async () => {
        vi.mocked(invoke).mockResolvedValue({
            found: true,
            changed: true,
            mtimeMs: 1000,
            title: "How do I add a route?",
            preview: "First, open the router file and add an entry.",
        });
        setEditorTabs(
            [
                {
                    id: "term-tab-1",
                    kind: "terminal",
                    terminalId: "term-1",
                    title: "Claude Code 1",
                    cwd: "/vault",
                },
            ],
            "term-tab-1",
        );

        registerClaudeTerminalAgentSession({
            terminalId: "term-1",
            title: "Claude Code 1",
            transcriptSessionId: "uuid-1",
            cwd: "/vault",
        });

        await refreshClaudeTerminalAgentTranscripts();

        const session = useChatStore.getState().sessionsById[SESSION_ID];
        expect(session?.persistedTitle).toBe("How do I add a route?");
        expect(session?.persistedPreview).toBe(
            "First, open the router file and add an entry.",
        );
        expect(useEditorStore.getState().tabs[0]?.title).toBe(
            "How do I add a route?",
        );
        // It read the transcript via the backend with the pinned session id.
        expect(vi.mocked(invoke)).toHaveBeenCalledWith(
            "devtools_read_claude_transcript",
            {
                input: {
                    sessionId: "uuid-1",
                    cwd: "/vault",
                    sinceMtimeMs: null,
                },
            },
        );
    });

    it("does not replace a manually renamed terminal tab with the transcript title", async () => {
        vi.mocked(invoke).mockResolvedValue({
            found: true,
            changed: true,
            mtimeMs: 1000,
            title: "How do I add a route?",
            preview: "First, open the router file and add an entry.",
        });
        setEditorTabs(
            [
                {
                    id: "term-tab-1",
                    kind: "terminal",
                    terminalId: "term-1",
                    title: "Pinned Claude Scratchpad",
                    cwd: "/vault",
                },
            ],
            "term-tab-1",
        );

        registerClaudeTerminalAgentSession({
            terminalId: "term-1",
            title: "Claude Code 1",
            transcriptSessionId: "uuid-1",
            cwd: "/vault",
        });

        await refreshClaudeTerminalAgentTranscripts();

        expect(useChatStore.getState().sessionsById[SESSION_ID]?.persistedTitle).toBe(
            "How do I add a route?",
        );
        expect(useEditorStore.getState().tabs[0]?.title).toBe(
            "Pinned Claude Scratchpad",
        );
    });

    it("syncs sidebar renames to the backing terminal tab", async () => {
        setEditorTabs(
            [
                {
                    id: "term-tab-1",
                    kind: "terminal",
                    terminalId: "term-1",
                    title: "Claude Code 1",
                    cwd: "/vault",
                },
            ],
            "term-tab-1",
        );
        registerClaudeTerminalAgentSession({
            terminalId: "term-1",
            title: "Claude Code 1",
        });

        useChatStore.getState().renameSession(SESSION_ID, "Renamed task");

        expect(
            useChatStore.getState().sessionsById[SESSION_ID]?.customTitle,
        ).toBe("Renamed task");
        expect(useEditorStore.getState().tabs[0]?.title).toBe("Renamed task");
    });

    it("leaves the default title when the transcript has not been written yet", async () => {
        vi.mocked(invoke).mockResolvedValue({
            found: false,
            changed: false,
            mtimeMs: null,
            title: null,
            preview: null,
        });

        registerClaudeTerminalAgentSession({
            terminalId: "term-1",
            title: "Claude Code 1",
            transcriptSessionId: "uuid-1",
            cwd: "/vault",
        });

        await refreshClaudeTerminalAgentTranscripts();

        const session = useChatStore.getState().sessionsById[SESSION_ID];
        expect(session?.persistedTitle).toBe("Claude Code 1");
        expect(session?.persistedPreview).toBeFalsy();
    });

    it("does not read a transcript without an exact Claude session id", async () => {
        registerClaudeTerminalAgentSession({
            terminalId: "term-1",
            title: "Claude Code 1",
            transcriptSessionId: null,
            cwd: "/vault",
        });

        await refreshClaudeTerminalAgentTranscripts();

        expect(vi.mocked(invoke)).not.toHaveBeenCalledWith(
            "devtools_read_claude_transcript",
            expect.anything(),
        );
        const session = useChatStore.getState().sessionsById[SESSION_ID];
        expect(session?.persistedTitle).toBe("Claude Code 1");
        expect(session?.persistedPreview).toBeFalsy();
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

    it("closes the terminal tab and runtime backing the agent entry", async () => {
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
        setEditorTabs(tabs, "term-tab-1");

        await expect(
            closeClaudeTerminalAgentSession({ terminalId: "term-1" }),
        ).resolves.toBe(true);

        expect(useEditorStore.getState().tabs).toHaveLength(1);
        expect(useEditorStore.getState().tabs[0]?.id).toBe("note-1");
        expect(
            useTerminalRuntimeStore.getState().runtimesById["term-1"],
        ).toBeUndefined();
    });

    it("opening the entry in the workspace focuses the terminal, not an ACP chat", () => {
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
        registerClaudeTerminalAgentSession({
            terminalId: "term-1",
            title: "Claude Code 1",
        });

        openChatSessionInWorkspace(SESSION_ID);

        // Focused the terminal tab; no ai-chat tab was opened for it (which would
        // have resumed a nonexistent ACP session).
        expect(useEditorStore.getState().activeTabId).toBe("term-tab-1");
        const chatTabs = selectEditorWorkspaceTabs(
            useEditorStore.getState(),
        ).filter((tab) => "sessionId" in tab && tab.kind === "ai-chat");
        expect(chatTabs).toHaveLength(0);
    });

    it("re-asserts the entry if a store rebuild drops it while the terminal is live", () => {
        registerClaudeTerminalAgentSession({
            terminalId: "term-1",
            title: "Claude Code 1",
        });
        expect(useChatStore.getState().sessionsById[SESSION_ID]).toBeDefined();

        // Simulate a backend reconcile rebuilding sessionsById without our
        // client-only entry (what happens when opening another agent).
        useChatStore.setState((state) => {
            const sessionsById = { ...state.sessionsById };
            delete sessionsById[SESSION_ID];
            return {
                sessionsById,
                sessionOrder: state.sessionOrder.filter(
                    (id) => id !== SESSION_ID,
                ),
            };
        });

        // The chatStore subscription re-adds it because the terminal is alive.
        expect(useChatStore.getState().sessionsById[SESSION_ID]).toBeDefined();
        expect(useChatStore.getState().sessionOrder).toContain(SESSION_ID);
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
