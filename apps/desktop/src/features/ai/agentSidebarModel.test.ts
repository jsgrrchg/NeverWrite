import { describe, expect, it } from "vitest";
import {
    applyPreferredAgentOrder,
    buildAgentSidebarProjection,
    resolveAgentSidebarSessionStatus,
} from "./agentSidebarModel";
import type { AgentSidebarSessionMetadata } from "./store/agentSidebarStore";
import type { AIChatSession, AIChatSessionStatus } from "./types";

function session(
    id: string,
    status: AIChatSessionStatus = "idle",
    timestamp = 100,
    overrides: Partial<AIChatSession> = {},
): AIChatSession {
    return {
        sessionId: id,
        historySessionId: id,
        status,
        runtimeId: "codex-acp",
        modelId: "test",
        modeId: "default",
        models: [],
        modes: [],
        configOptions: [],
        messages: [
            {
                id: `${id}-user`,
                role: "user",
                kind: "text",
                content: id,
                timestamp,
            },
        ],
        attachments: [],
        persistedCreatedAt: timestamp,
        ...overrides,
    };
}

function metadata(
    overrides: Partial<AgentSidebarSessionMetadata> = {},
): AgentSidebarSessionMetadata {
    return {
        pinnedAt: null,
        completedAt: null,
        snoozedAt: null,
        snoozedUntil: null,
        lastVisitedAt: null,
        ...overrides,
    };
}

function project(
    sessions: AIChatSession[],
    metadataBySessionId: Record<string, AgentSidebarSessionMetadata> = {},
    now = 1_000,
) {
    return buildAgentSidebarProjection({
        sessions,
        metadataBySessionId,
        pinnedOrder: [],
        activeOrder: [],
        now,
    });
}

describe("agentSidebarModel", () => {
    it.each([
        ["review_required", "review"],
        ["waiting_permission", "approval"],
        ["waiting_user_input", "input"],
        ["streaming", "working"],
        ["error", "failed"],
        ["idle", "ready"],
    ] as const)("maps %s to %s", (source, expected) => {
        expect(resolveAgentSidebarSessionStatus(session("root", source))).toBe(
            expected,
        );
    });

    it("reports an unseen assistant completion as done", () => {
        const done = session("done", "idle", 10, {
            messages: [
                {
                    id: "assistant",
                    role: "assistant",
                    kind: "text",
                    content: "Finished",
                    timestamp: 20,
                },
            ],
        });
        expect(resolveAgentSidebarSessionStatus(done, metadata())).toBe("done");
        expect(
            resolveAgentSidebarSessionStatus(
                done,
                metadata({ lastVisitedAt: 20 }),
            ),
        ).toBe("ready");
    });

    it("rolls the highest-priority child status up to its root", () => {
        const root = session("root", "streaming");
        const failed = session("failed", "error", 101, {
            parentSessionId: "root",
        });
        const review = session("review", "review_required", 102, {
            parentSessionId: "root",
        });
        expect(project([root, failed, review]).activeGroups[0].status).toBe(
            "review",
        );
    });

    it("assigns every root to exactly one lifecycle bucket", () => {
        const result = project(
            [session("pin"), session("active"), session("sleep"), session("done")],
            {
                pin: metadata({ pinnedAt: 2 }),
                sleep: metadata({ snoozedAt: 2, snoozedUntil: 2_000 }),
                done: metadata({ completedAt: 200 }),
            },
        );
        expect(result.pinnedGroups.map((group) => group.root.sessionId)).toEqual([
            "pin",
        ]);
        expect(
            result.activeGroups.map((group) => group.root.sessionId),
        ).toEqual(["active"]);
        expect(result.snoozedGroups.map((group) => group.root.sessionId)).toEqual([
            "sleep",
        ]);
        expect(
            result.completedGroups.map((group) => group.root.sessionId),
        ).toEqual(["done"]);
    });

    it.each([
        ["review_required", true],
        ["waiting_permission", true],
        ["waiting_user_input", true],
        ["error", true],
        ["streaming", false],
        ["idle", false],
    ] as const)("applies attention wake for %s", (status, wakes) => {
        const result = project(
            [session("root", status)],
            { root: metadata({ snoozedAt: 10, snoozedUntil: 2_000 }) },
        );
        expect(result.snoozedGroups).toHaveLength(wakes ? 0 : 1);
        expect(result.activeGroups).toHaveLength(wakes ? 1 : 0);
    });

    it("wakes an expired pinned snooze back into pinned", () => {
        const result = project(
            [session("root")],
            {
                root: metadata({
                    pinnedAt: 1,
                    snoozedAt: 2,
                    snoozedUntil: 900,
                }),
            },
        );
        expect(result.pinnedGroups[0].root.sessionId).toBe("root");
    });

    it("reactivates completed work only after newer activity", () => {
        const old = project(
            [session("old", "idle", 100)],
            { old: metadata({ completedAt: 200 }) },
        );
        const newer = project(
            [session("new", "idle", 300)],
            { new: metadata({ completedAt: 200 }) },
        );
        expect(old.completedGroups).toHaveLength(1);
        expect(newer.activeGroups).toHaveLength(1);
    });

    it("honors preferred ids, drops stale ids, and appends keyless roots", () => {
        const projection = project([
            session("older", "idle", 1),
            session("newer", "idle", 2),
            session("manual", "idle", 0),
        ]);
        const ordered = applyPreferredAgentOrder(
            projection.activeGroups,
            ["stale", "manual"],
        );
        expect(ordered.map((group) => group.root.sessionId)).toEqual([
            "manual",
            "newer",
            "older",
        ]);
    });

    it("does not reorder a root when its working status changes", () => {
        const idle = project([
            session("newer", "idle", 2),
            session("older", "idle", 1),
        ]);
        const working = project([
            session("newer", "idle", 2),
            session("older", "streaming", 1),
        ]);
        expect(
            working.activeGroups.map((group) => group.root.sessionId),
        ).toEqual(
            idle.activeGroups.map((group) => group.root.sessionId),
        );
    });

    it("searches child preview and retains root context across all buckets", () => {
        const root = session("root", "idle", 1);
        const child = session("child", "idle", 2, {
            parentSessionId: "root",
            messages: [
                {
                    id: "child-assistant",
                    role: "assistant",
                    kind: "text",
                    content: "Needle preview",
                    timestamp: 2,
                },
            ],
        });
        const result = buildAgentSidebarProjection({
            sessions: [root, child],
            metadataBySessionId: {
                root: metadata({ completedAt: 10 }),
            },
            filterText: "needle",
            now: 100,
        });
        expect(result.searchResults).toHaveLength(1);
        expect(result.searchResults[0].root.sessionId).toBe("root");
        expect(result.searchResults[0].visibleChildren[0].sessionId).toBe(
            "child",
        );
    });
});
