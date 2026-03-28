import { describe, expect, it } from "vitest";
import {
    allocateTabSessionVersion,
    collectSessionIdsToClose,
    deleteTabSessionVersions,
} from "./terminalSessionTracking";

describe("terminalSessionTracking", () => {
    it("keeps tab session versions monotonic even after deleting a tab entry", () => {
        const versionsByTabId = new Map<string, number>();
        const nextVersionRef = { current: 1 };

        expect(
            allocateTabSessionVersion(versionsByTabId, nextVersionRef, "tab-a"),
        ).toBe(1);

        deleteTabSessionVersions(versionsByTabId, ["tab-a"]);

        expect(
            allocateTabSessionVersion(versionsByTabId, nextVersionRef, "tab-a"),
        ).toBe(2);
    });

    it("deletes only the requested tab session version entries", () => {
        const versionsByTabId = new Map<string, number>([
            ["tab-a", 1],
            ["tab-b", 2],
            ["tab-c", 3],
        ]);

        deleteTabSessionVersions(versionsByTabId, ["tab-a", "tab-c"]);

        expect(Array.from(versionsByTabId.entries())).toEqual([["tab-b", 2]]);
    });

    it("dedupes closings, clears pending output and bounds retired session ids", () => {
        const retiredSessionIds = new Map<string, true>([
            ["existing", true],
            ["older", true],
        ]);
        const pendingOutputBySessionId = new Map<string, string>([
            ["existing", "old output"],
            ["new-a", "late output"],
            ["new-b", "late output"],
        ]);

        const sessionIdsToClose = collectSessionIdsToClose(
            ["", "existing", "new-a", "new-a", "new-b"],
            retiredSessionIds,
            pendingOutputBySessionId,
            3,
        );

        expect(sessionIdsToClose).toEqual(["new-a", "new-b"]);
        expect(pendingOutputBySessionId.has("existing")).toBe(false);
        expect(pendingOutputBySessionId.has("new-a")).toBe(false);
        expect(pendingOutputBySessionId.has("new-b")).toBe(false);
        expect(Array.from(retiredSessionIds.keys())).toEqual([
            "older",
            "new-a",
            "new-b",
        ]);
    });
});
