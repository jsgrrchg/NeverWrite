import { getAllWebviewWindows } from "@neverwrite/runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    buildWindowSessionEntry,
    readWindowSessionSnapshot,
    refreshWindowSessionSnapshot,
    restoreWindowSession,
    writeWindowSessionEntry,
} from "./windowSession";

describe("windowSession", () => {
    beforeEach(() => {
        localStorage.clear();
        vi.mocked(getAllWebviewWindows).mockResolvedValue([] as never[]);
    });

    it("builds a persisted note-window entry from detached tabs", () => {
        expect(
            buildWindowSessionEntry({
                label: "note-1",
                windowMode: "note",
                vaultPath: "/vaults/main",
                tabs: [
                    {
                        id: "tab-1",
                        noteId: "note-1",
                        title: "Agents",
                        content: "body",
                        history: [],
                        historyIndex: 0,
                    },
                ],
                activeTabId: "tab-1",
            }),
        ).toEqual({
            label: "note-1",
            kind: "note",
            payload: {
                tabs: [
                    {
                        id: "tab-1",
                        noteId: "note-1",
                        title: "Agents",
                        content: "body",
                        history: [],
                        historyIndex: 0,
                    },
                ],
                activeTabId: "tab-1",
                vaultPath: "/vaults/main",
            },
            title: "Agents",
        });
    });

    it("refreshes the snapshot using only currently open windows", async () => {
        writeWindowSessionEntry("main", {
            label: "main",
            kind: "vault",
            vaultPath: "/vaults/main",
        });
        writeWindowSessionEntry("vault-2", {
            label: "vault-2",
            kind: "vault",
            vaultPath: "/vaults/work",
        });
        writeWindowSessionEntry("note-1", {
            label: "note-1",
            kind: "note",
            payload: {
                tabs: [],
                activeTabId: null,
                vaultPath: "/vaults/main",
            },
            title: "Detached",
        });

        vi.mocked(getAllWebviewWindows).mockResolvedValue([
            { label: "main" },
            { label: "note-1" },
        ] as Awaited<ReturnType<typeof getAllWebviewWindows>>);

        await refreshWindowSessionSnapshot();

        expect(readWindowSessionSnapshot()).toEqual([
            {
                label: "main",
                kind: "vault",
                vaultPath: "/vaults/main",
            },
            {
                label: "note-1",
                kind: "note",
                payload: {
                    tabs: [],
                    activeTabId: null,
                    vaultPath: "/vaults/main",
                },
                title: "Detached",
            },
        ]);
    });

    it("restores the primary vault into the main window and reopens the rest", async () => {
        localStorage.setItem(
            "neverwrite:window-session-snapshot",
            JSON.stringify(["main", "vault-2", "note-1"]),
        );
        writeWindowSessionEntry("main", {
            label: "main",
            kind: "vault",
            vaultPath: "/vaults/main",
        });
        writeWindowSessionEntry("vault-2", {
            label: "vault-2",
            kind: "vault",
            vaultPath: "/vaults/work",
        });
        writeWindowSessionEntry("note-1", {
            label: "note-1",
            kind: "note",
            payload: {
                tabs: [
                    {
                        id: "tab-1",
                        noteId: "note-1",
                        title: "Agents",
                        content: "body",
                        history: [],
                        historyIndex: 0,
                    },
                ],
                activeTabId: "tab-1",
                vaultPath: "/vaults/main",
            },
            title: "Agents",
        });

        const openPrimaryVault = vi.fn().mockResolvedValue(undefined);
        const restorePrimaryVaultSession = vi.fn().mockResolvedValue(undefined);
        const openVaultWindow = vi.fn().mockResolvedValue(undefined);
        const openDetachedNoteWindow = vi.fn().mockResolvedValue(undefined);

        const restored = await restoreWindowSession({
            openPrimaryVault,
            restorePrimaryVaultSession,
            openVaultWindow,
            openDetachedNoteWindow,
        });

        expect(restored).toBe(true);
        expect(openPrimaryVault).toHaveBeenCalledWith("/vaults/main");
        expect(restorePrimaryVaultSession).toHaveBeenCalled();
        expect(openVaultWindow).toHaveBeenCalledWith("/vaults/work");
        expect(openDetachedNoteWindow).toHaveBeenCalledWith(
            {
                tabs: [
                    {
                        id: "tab-1",
                        noteId: "note-1",
                        title: "Agents",
                        content: "body",
                        history: [],
                        historyIndex: 0,
                    },
                ],
                activeTabId: "tab-1",
                vaultPath: "/vaults/main",
            },
            { title: "Agents" },
        );
    });
});
