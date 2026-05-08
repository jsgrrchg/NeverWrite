import { emitTo, getAllWebviewWindows } from "@neverwrite/runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    createDetachedWindowPayload,
    findWindowTabDropTarget,
    getDetachedNoteWindowUrl,
    openSettingsWindow,
    publishWindowTabDropZone,
    resolveDetachWindowDropTarget,
} from "./detachedWindows";
import { resetChatStore, useChatStore } from "../features/ai/store/chatStore";
import type { AIChatSession } from "../features/ai/types";

function createChatSession(overrides: Partial<AIChatSession> = {}): AIChatSession {
    return {
        sessionId: "live-session-1",
        historySessionId: "history-1",
        status: "streaming",
        activeWorkCycleId: null,
        visibleWorkCycleId: null,
        isResumingSession: false,
        runtimeId: "codex-acp",
        modelId: "gpt-test",
        modeId: "default",
        models: [],
        modes: [],
        configOptions: [],
        messages: [
            {
                id: "msg-1",
                role: "user",
                kind: "text",
                content: "keep this",
                timestamp: 1,
            },
        ],
        attachments: [],
        runtimeState: "live",
        ...overrides,
    };
}

function createMockWindow(
    label: string,
    overrides: Partial<{
        isMinimized: () => Promise<boolean>;
        isVisible: () => Promise<boolean>;
    }> = {},
) {
    return {
        label,
        isMinimized: overrides.isMinimized ?? vi.fn().mockResolvedValue(false),
        isVisible: overrides.isVisible ?? vi.fn().mockResolvedValue(true),
    };
}

describe("detachedWindows", () => {
    beforeEach(() => {
        resetChatStore();
        vi.mocked(getAllWebviewWindows).mockResolvedValue([]);
        vi.mocked(emitTo).mockReset();
        localStorage.clear();
    });

    it("includes the current vault path in detached window payloads", () => {
        expect(
            createDetachedWindowPayload(
                {
                    id: "tab-1",
                    noteId: "note-1",
                    title: "Note",
                    content: "Body",
                    history: [],
                    historyIndex: 0,
                },
                "/vaults/main",
            ),
        ).toEqual({
            tabs: [
                {
                    id: "tab-1",
                    noteId: "note-1",
                    title: "Note",
                    content: "Body",
                    history: [],
                    historyIndex: 0,
                },
            ],
            activeTabId: "tab-1",
            vaultPath: "/vaults/main",
        });
    });

    it("adds durable chat history identity to detached chat payloads", () => {
        expect(
            createDetachedWindowPayload(
                {
                    id: "chat-tab-1",
                    kind: "ai-chat",
                    sessionId: "live-session-1",
                    title: "Agent",
                },
                "/vaults/main",
            ),
        ).toEqual({
            tabs: [
                {
                    id: "chat-tab-1",
                    kind: "ai-chat",
                    sessionId: "live-session-1",
                    historySessionId: "live-session-1",
                    title: "Agent",
                },
            ],
            activeTabId: "chat-tab-1",
            vaultPath: "/vaults/main",
        });
    });

    it("includes live chat session snapshots in detached chat payloads", () => {
        const session = createChatSession();
        useChatStore.setState({
            sessionsById: {
                [session.sessionId]: session,
            },
        } as Partial<ReturnType<typeof useChatStore.getState>>);

        expect(
            createDetachedWindowPayload(
                {
                    id: "chat-tab-1",
                    kind: "ai-chat",
                    sessionId: "live-session-1",
                    title: "Agent",
                },
                "/vaults/main",
            ),
        ).toMatchObject({
            aiSessions: [
                {
                    sessionId: "live-session-1",
                    messages: [
                        {
                            content: "keep this",
                        },
                    ],
                    runtimeState: "live",
                },
            ],
        });
    });

    it("normalizes terminal tabs for detached payloads", () => {
        expect(
            createDetachedWindowPayload(
                {
                    id: "terminal-tab-1",
                    kind: "terminal",
                    terminalId: "terminal-1",
                    title: null,
                    cwd: null,
                },
                "/vaults/main",
            ).tabs[0],
        ).toEqual({
            id: "terminal-tab-1",
            kind: "terminal",
            terminalId: "terminal-1",
            title: "Terminal",
            cwd: null,
        });
    });

    it("builds the detached note url with the vault path for correct first-paint theme", () => {
        expect(getDetachedNoteWindowUrl("/vaults/main")).toBe(
            "/?window=note&vault=%2Fvaults%2Fmain",
        );
        expect(getDetachedNoteWindowUrl(null)).toBe("/?window=note");
    });

    it("matches only the published tab strip bounds", async () => {
        vi.mocked(getAllWebviewWindows).mockResolvedValue([
            createMockWindow("note-1"),
        ] as Awaited<ReturnType<typeof getAllWebviewWindows>>);
        publishWindowTabDropZone("note-1", {
            left: 300,
            top: 20,
            right: 620,
            bottom: 52,
            vaultPath: "/vaults/main",
        });

        await expect(
            findWindowTabDropTarget(200, 30, "main", "/vaults/main"),
        ).resolves.toBeNull();

        await expect(
            findWindowTabDropTarget(420, 36, "main", "/vaults/main"),
        ).resolves.toBe("note-1");
    });

    it("maps leaving the current window to the detach-window target", () => {
        expect(resolveDetachWindowDropTarget(40, 40)).toEqual({
            type: "none",
        });
        expect(resolveDetachWindowDropTarget(-64, 40)).toEqual({
            type: "detach-window",
        });
    });

    it("ignores ghost windows and windows from a different vault", async () => {
        vi.mocked(getAllWebviewWindows).mockResolvedValue([
            createMockWindow("ghost-1"),
            createMockWindow("note-1"),
            createMockWindow("note-2"),
        ] as Awaited<ReturnType<typeof getAllWebviewWindows>>);

        publishWindowTabDropZone("ghost-1", {
            left: 0,
            top: 0,
            right: 240,
            bottom: 40,
            vaultPath: "/vaults/main",
        });
        publishWindowTabDropZone("note-1", {
            left: 260,
            top: 0,
            right: 520,
            bottom: 40,
            vaultPath: "/vaults/other",
        });
        publishWindowTabDropZone("note-2", {
            left: 540,
            top: 0,
            right: 820,
            bottom: 40,
            vaultPath: "/vaults/main",
        });

        await expect(
            findWindowTabDropTarget(120, 20, "main", "/vaults/main"),
        ).resolves.toBeNull();

        await expect(
            findWindowTabDropTarget(400, 20, "main", "/vaults/main"),
        ).resolves.toBeNull();

        await expect(
            findWindowTabDropTarget(700, 20, "main", "/vaults/main"),
        ).resolves.toBe("note-2");
    });

    it("navigates an existing settings window to the requested section", async () => {
        const existingWindow = {
            label: "settings",
            show: vi.fn().mockResolvedValue(undefined),
            setFocus: vi.fn().mockResolvedValue(undefined),
        };
        vi.mocked(getAllWebviewWindows).mockResolvedValue([
            existingWindow,
        ] as unknown as Awaited<ReturnType<typeof getAllWebviewWindows>>);

        await openSettingsWindow(null, { section: "updates" });

        expect(existingWindow.show).toHaveBeenCalled();
        expect(existingWindow.setFocus).toHaveBeenCalled();
        expect(emitTo).toHaveBeenCalledWith(
            "settings",
            "neverwrite:settings-open-section",
            { section: "updates" },
        );
    });
});
