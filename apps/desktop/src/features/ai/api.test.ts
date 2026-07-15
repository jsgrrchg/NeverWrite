import { invoke } from "@neverwrite/runtime";
import { describe, expect, it, vi } from "vitest";
import { aiMoveAllSessionHistories, normalizeBackendSession } from "./api";
import type { AIBackendSessionPayload } from "./types";

function createBackendSession(
    overrides: Partial<AIBackendSessionPayload> = {},
): AIBackendSessionPayload {
    return {
        session_id: "session-1",
        title: "Runtime generated title",
        runtime_id: "codex-acp",
        model_id: "test-model",
        mode_id: "default",
        status: "idle",
        models: [],
        modes: [],
        config_options: [],
        ...overrides,
    };
}

describe("normalizeBackendSession", () => {
    it("treats backend titles as persisted runtime titles, not manual renames", () => {
        const session = normalizeBackendSession(createBackendSession());

        expect(session.persistedTitle).toBe("Runtime generated title");
        expect(session.customTitle).toBeNull();
    });
});

describe("aiMoveAllSessionHistories", () => {
    it("invokes only the all-history move contract", async () => {
        const invokeMock = vi.mocked(invoke);
        invokeMock.mockResolvedValueOnce({
            completed: true,
            from_scope: "device",
            to_scope: "vault",
            histories_moved: 2,
            histories_deduplicated: 1,
            conflicts: [],
            recovery_required: false,
        });

        await aiMoveAllSessionHistories({
            vaultPath: "/vault",
            fromScope: "device",
            toScope: "vault",
        });

        expect(invokeMock).toHaveBeenCalledWith(
            "ai_move_all_session_histories",
            {
                vaultPath: "/vault",
                fromScope: "device",
                toScope: "vault",
            },
        );
    });
});
