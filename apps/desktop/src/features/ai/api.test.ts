import { describe, expect, it } from "vitest";
import { normalizeBackendSession } from "./api";
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
