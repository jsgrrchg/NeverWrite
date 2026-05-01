import { describe, expect, it } from "vitest";
import { buildAiSessionHierarchyGroups } from "./sessionHierarchy";
import type { AIChatSession } from "./types";

function session(
    sessionId: string,
    title: string,
    options: Partial<AIChatSession> = {},
): AIChatSession {
    return {
        sessionId,
        historySessionId: sessionId,
        status: "idle",
        runtimeId: "codex-acp",
        modelId: "test-model",
        modeId: "default",
        models: [],
        modes: [],
        configOptions: [],
        messages: [
            {
                id: `${sessionId}-message`,
                role: "user",
                kind: "text",
                content: title,
                timestamp: 100,
            },
        ],
        attachments: [],
        runtimeState: "live",
        ...options,
    };
}

describe("buildAiSessionHierarchyGroups", () => {
    it("groups subagents under their parent session", () => {
        const parent = session("parent", "Parent task");
        const child = session("child", "Worker output", {
            parentSessionId: "parent",
        });

        const result = buildAiSessionHierarchyGroups({
            sessions: [child, parent],
        });

        expect(result.rootSessionIds).toEqual(["parent"]);
        expect(result.groups).toHaveLength(1);
        expect(result.groups[0].root.sessionId).toBe("parent");
        expect(result.groups[0].children.map((item) => item.sessionId)).toEqual(
            ["child"],
        );
    });

    it("keeps child search matches visible with parent context", () => {
        const parent = session("parent", "Quarterly planning");
        const child = session("child", "Investigate tokenizer regression", {
            parentSessionId: "parent",
        });

        const result = buildAiSessionHierarchyGroups({
            sessions: [parent, child],
            normalizedFilter: "tokenizer",
        });

        expect(result.groups).toHaveLength(1);
        expect(result.groups[0].root.sessionId).toBe("parent");
        expect(
            result.groups[0].visibleChildren.map((item) => item.sessionId),
        ).toEqual(["child"]);
    });

    it("only treats root pins as pinned groups", () => {
        const parent = session("parent", "Parent task");
        const child = session("child", "Pinned legacy child", {
            parentSessionId: "parent",
        });

        const result = buildAiSessionHierarchyGroups({
            sessions: [parent, child],
            pinnedSessionIds: new Set(["child"]),
        });

        expect(result.groups[0].isPinnedRoot).toBe(false);
    });

    it("marks a group as open when any child is open", () => {
        const parent = session("parent", "Parent task");
        const child = session("child", "Open child", {
            parentSessionId: "parent",
        });

        const result = buildAiSessionHierarchyGroups({
            sessions: [parent, child],
            openSessionIds: new Set(["child"]),
        });

        expect(result.groups[0].hasOpenSession).toBe(true);
    });

    it("uses the sibling comparator for child session order", () => {
        const parent = session("parent", "Parent task");
        const first = session("first", "First worker", {
            parentSessionId: "parent",
        });
        const second = session("second", "Second worker", {
            parentSessionId: "parent",
        });

        const result = buildAiSessionHierarchyGroups({
            sessions: [parent, second, first],
            compareSiblings: (left, right) => {
                const order = new Map([
                    ["first", 1],
                    ["second", 2],
                ]);
                return (
                    (order.get(left.sessionId) ?? 0) -
                    (order.get(right.sessionId) ?? 0)
                );
            },
        });

        expect(result.groups[0].children.map((item) => item.sessionId)).toEqual([
            "first",
            "second",
        ]);
    });
});
