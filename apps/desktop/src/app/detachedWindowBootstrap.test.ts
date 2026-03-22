import { describe, expect, it, vi } from "vitest";
import { bootstrapDetachedWindow } from "./detachedWindowBootstrap";

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

        expect(hydrateTabs).toHaveBeenCalledWith(payload.tabs, "tab-1");
        expect(errorSpy).toHaveBeenCalled();

        errorSpy.mockRestore();
    });
});
