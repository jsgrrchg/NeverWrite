import { describe, expect, it } from "vitest";
import {
    insertAgentIntoOrder,
    normalizeAgentOrder,
    removeAgentFromOrder,
    reorderAgentScope,
    reorderVisiblePinnedAgents,
} from "./agentSidebarOrder";

describe("agentSidebarOrder", () => {
    it("normalizes, inserts, removes, and clamps", () => {
        expect(normalizeAgentOrder(["a", "a", "", "b"])).toEqual(["a", "b"]);
        expect(removeAgentFromOrder(["a", "b"], "a")).toEqual(["b"]);
        expect(insertAgentIntoOrder(["a", "b"], "b", -1)).toEqual(["b", "a"]);
        expect(insertAgentIntoOrder(["a"], "b", 99)).toEqual(["a", "b"]);
    });

    it("materializes keyless ids only inside the reordered active scope", () => {
        expect(
            reorderAgentScope(
                ["folder-a", "other-folder"],
                ["folder-new", "folder-a"],
                "folder-new",
                0,
            ),
        ).toEqual(["folder-new", "folder-a", "other-folder"]);
    });

    it("preserves hidden pinned slots while visible pins move", () => {
        expect(
            reorderVisiblePinnedAgents(
                ["visible-a", "snoozed", "visible-b"],
                ["visible-a", "visible-b"],
                "visible-b",
                0,
            ),
        ).toEqual(["visible-b", "snoozed", "visible-a"]);
    });
});
