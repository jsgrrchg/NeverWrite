import { describe, expect, it, vi } from "vitest";
import { bootstrapDetachedWindow } from "./detachedWindowBootstrap";
import type { AIChatSession } from "../features/ai/types";

describe("bootstrapDetachedWindow", () => {
    it("restores the vault before hydrating detached tabs", async () => {
        const calls: string[] = [];
        const payload = {
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
        };

        await bootstrapDetachedWindow(payload, {
            openVault: async (path) => {
                calls.push(`open:${path}`);
            },
            hydrateTabs: (_tabs, activeTabId) => {
                calls.push(`hydrate:${activeTabId}`);
            },
        });

        expect(calls).toEqual(["open:/vaults/main", "hydrate:tab-1"]);
    });

    it("still hydrates tabs if restoring the vault fails", async () => {
        const payload = {
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
        };
        const hydrateTabs = vi.fn();
        const errorSpy = vi
            .spyOn(console, "error")
            .mockImplementation(() => {});

        await bootstrapDetachedWindow(payload, {
            openVault: vi.fn().mockRejectedValue(new Error("boom")),
            hydrateTabs,
        });

        expect(hydrateTabs).toHaveBeenCalledWith(payload.tabs, "tab-1", [], {
            allowEphemeralTabs: true,
        });
        expect(errorSpy).toHaveBeenCalled();

        errorSpy.mockRestore();
    });

    it("passes detached pinned tab ids into hydration", async () => {
        const payload = {
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
            vaultPath: null,
            pinnedTabIds: ["tab-1"],
        };
        const hydrateTabs = vi.fn();

        await bootstrapDetachedWindow(payload, {
            openVault: vi.fn(),
            hydrateTabs,
        });

        expect(hydrateTabs).toHaveBeenCalledWith(
            payload.tabs,
            "tab-1",
            ["tab-1"],
            { allowEphemeralTabs: true },
        );
    });

    it("hydrates detached AI session snapshots before hydrating tabs", async () => {
        const calls: string[] = [];
        const session = {
            sessionId: "session-1",
            historySessionId: "history-1",
            status: "streaming",
            runtimeId: "codex-acp",
            modelId: "gpt-test",
            modeId: "default",
            models: [],
            modes: [],
            configOptions: [],
            messages: [],
            attachments: [],
            runtimeState: "live",
        } satisfies AIChatSession;
        const payload = {
            tabs: [
                {
                    id: "chat-tab-1",
                    kind: "ai-chat" as const,
                    sessionId: "session-1",
                    historySessionId: "history-1",
                    title: "Agent",
                },
            ],
            activeTabId: "chat-tab-1",
            vaultPath: null,
            aiSessions: [session],
        };

        await bootstrapDetachedWindow(payload, {
            openVault: vi.fn(),
            hydrateAiSessions: (sessions) => {
                calls.push(`sessions:${sessions[0]?.sessionId ?? ""}`);
            },
            hydrateTabs: () => {
                calls.push("tabs");
            },
        });

        expect(calls).toEqual(["sessions:session-1", "tabs"]);
    });
});
