import { emitTo } from "@tauri-apps/api/event";
import { getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    createDetachedWindowPayload,
    findWindowTabDropTarget,
    getDetachedNoteWindowUrl,
    openSettingsWindow,
    publishWindowTabDropZone,
} from "./detachedWindows";

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
