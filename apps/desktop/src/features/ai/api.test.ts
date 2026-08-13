import { invoke } from "@neverwrite/runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    aiCreateCustomRuntime,
    aiDeleteCustomRuntime,
    aiGetSetupStatus,
    aiListCustomRuntimes,
    aiListDeletedCustomRuntimes,
    aiRestoreCustomRuntime,
    aiUpdateCustomRuntime,
    aiVerifyCustomRuntime,
    normalizeBackendSession,
} from "./api";
import type {
    AIBackendRuntimeSetupStatusPayload,
    AIBackendSessionPayload,
    AICustomAcpRuntimeDefinition,
    AICustomAcpRuntimeDefinitionInput,
} from "./types";

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

beforeEach(() => {
    vi.mocked(invoke).mockReset();
});

describe("normalizeBackendSession", () => {
    it("treats backend titles as persisted runtime titles, not manual renames", () => {
        const session = normalizeBackendSession(createBackendSession());

        expect(session.persistedTitle).toBe("Runtime generated title");
        expect(session.customTitle).toBeNull();
    });
});

describe("runtime setup status", () => {
    it("preserves Claude ACP subscription authentication", async () => {
        const status: AIBackendRuntimeSetupStatusPayload = {
            runtime_id: "claude-acp",
            binary_ready: true,
            binary_source: "vendor",
            auth_ready: true,
            auth_method: "claude-ai-login",
            auth_methods: [
                {
                    id: "claude-ai-login",
                    name: "Claude subscription",
                    description: "Use a Claude subscription.",
                },
            ],
            onboarding_required: false,
        };
        vi.mocked(invoke).mockResolvedValue(status);

        await expect(aiGetSetupStatus("claude-acp")).resolves.toMatchObject({
            runtimeId: "claude-acp",
            authReady: true,
            authMethod: "claude-ai-login",
            authMethods: status.auth_methods,
        });
    });
});

describe("custom ACP runtime API", () => {
    const input: AICustomAcpRuntimeDefinitionInput = {
        displayName: "Local agent",
        command: "agent-acp",
        args: ["--stdio"],
        env: { AGENT_COLOR: "blue" },
        authMode: "external",
    };
    const definition: AICustomAcpRuntimeDefinition = {
        ...input,
        id: "custom:123e4567-e89b-12d3-a456-426614174000",
        revision: 1,
        launchFingerprint: "fingerprint",
    };

    it("lists active and deleted definitions through dedicated commands", async () => {
        vi.mocked(invoke).mockResolvedValue([]);

        await aiListCustomRuntimes();
        await aiListDeletedCustomRuntimes();

        expect(vi.mocked(invoke)).toHaveBeenNthCalledWith(
            1,
            "ai_list_custom_runtimes",
        );
        expect(vi.mocked(invoke)).toHaveBeenNthCalledWith(
            2,
            "ai_list_deleted_custom_runtimes",
        );
    });

    it("serializes CRUD and executable verification inputs", async () => {
        vi.mocked(invoke).mockResolvedValue(definition);

        await aiCreateCustomRuntime(input);
        await aiUpdateCustomRuntime({ id: definition.id, definition: input });
        await aiDeleteCustomRuntime(definition.id);
        await aiRestoreCustomRuntime(definition.id);
        await aiVerifyCustomRuntime(input);

        expect(vi.mocked(invoke).mock.calls).toEqual([
            ["ai_create_custom_runtime", { input }],
            [
                "ai_update_custom_runtime",
                { input: { id: definition.id, definition: input } },
            ],
            ["ai_delete_custom_runtime", { input: { id: definition.id } }],
            ["ai_restore_custom_runtime", { input: { id: definition.id } }],
            ["ai_verify_custom_runtime", { input }],
        ]);
    });
});
