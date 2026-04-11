import { getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { subscribeSafeStorage } from "../../app/utils/safeStorage";
import {
    readSensitiveUpdateState,
    writeWindowOperationalState,
} from "./sensitiveState";

vi.mock("@tauri-apps/api/webviewWindow", () => ({
    getAllWebviewWindows: vi.fn(),
}));

afterEach(() => {
    localStorage.clear();
    vi.mocked(getAllWebviewWindows).mockReset();
});

describe("sensitiveState", () => {
    it("does not rebroadcast identical operational state snapshots", () => {
        const events: Array<{ key: string | null; newValue: string | null }> =
            [];
        const unsubscribe = subscribeSafeStorage((event) => {
            events.push(event);
        });

        const state = {
            label: "main",
            windowMode: "main" as const,
            windowRole: "main" as const,
            windowTitle: "NeverWrite",
            dirtyTabs: ["Draft"],
            pendingReviewSessions: ["Review"],
            activeAgentSessions: ["Agent · Streaming response"],
        };

        expect(writeWindowOperationalState("main", state)).toBe(true);
        expect(writeWindowOperationalState("main", state)).toBe(false);

        unsubscribe();

        expect(
            events.filter(
                (event) =>
                    event.key === "neverwrite:window-operational-state:main",
            ),
        ).toHaveLength(1);
    });

    it("reads the current sensitive update state from live windows", async () => {
        vi.mocked(getAllWebviewWindows).mockResolvedValue([
            { label: "main" },
            { label: "note-1" },
        ] as Awaited<ReturnType<typeof getAllWebviewWindows>>);

        writeWindowOperationalState("main", {
            label: "main",
            windowMode: "main",
            windowRole: "main",
            windowTitle: "NeverWrite",
            dirtyTabs: ["Draft note"],
            pendingReviewSessions: ["Inline review"],
            activeAgentSessions: [],
        });
        writeWindowOperationalState("note-1", {
            label: "note-1",
            windowMode: "note",
            windowRole: "detached-note",
            windowTitle: "Detached note",
            dirtyTabs: [],
            pendingReviewSessions: [],
            activeAgentSessions: [],
        });

        await expect(readSensitiveUpdateState()).resolves.toEqual({
            requiresConfirmation: true,
            items: [
                {
                    key: "dirty-tabs",
                    title: "Unsaved editor tabs",
                    details: ["NeverWrite: Draft note"],
                },
                {
                    key: "pending-review",
                    title: "Pending inline review or agent changes",
                    details: ["Inline review"],
                },
                {
                    key: "separate-windows",
                    title: "Separate operational windows are open",
                    details: [
                        "Detached note is open in a detached note window.",
                    ],
                },
            ],
        });
    });
});
