import { invoke } from "@tauri-apps/api/core";
import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    isChatTab,
    selectFocusedEditorTab,
    useEditorStore,
} from "../../app/store/editorStore";
import { useVaultStore } from "../../app/store/vaultStore";
import { createDeferred, setEditorTabs } from "../../test/test-utils";
import { createNewChatInWorkspace } from "./chatPaneMovement";
import { resetChatStore, useChatStore } from "./store/chatStore";
import { resetChatTabsStore } from "./store/chatTabsStore";

const invokeMock = vi.mocked(invoke);

const runtimeDescriptor = {
    runtime: {
        id: "codex-acp",
        name: "Codex ACP",
        description: "Codex runtime",
        capabilities: ["create_session"],
    },
    models: [
        {
            id: "test-model",
            runtimeId: "codex-acp",
            name: "Test Model",
            description: "Model for tests",
        },
    ],
    modes: [
        {
            id: "default",
            runtimeId: "codex-acp",
            name: "Default",
            description: "Default mode",
            disabled: false,
        },
    ],
    configOptions: [
        {
            id: "model",
            runtimeId: "codex-acp",
            category: "model" as const,
            label: "Model",
            type: "select" as const,
            value: "test-model",
            options: [{ value: "test-model", label: "Test Model" }],
        },
    ],
};

const setupStatusPayload = {
    runtime_id: "codex-acp",
    binary_ready: true,
    binary_path: "/Applications/NeverWrite/codex-acp",
    binary_source: "bundled" as const,
    auth_ready: true,
    auth_method: "openai-api-key",
    auth_methods: [],
    onboarding_required: false,
    message: null,
};

const createdSessionPayload = {
    session_id: "codex-session-1",
    runtime_id: "codex-acp",
    model_id: "test-model",
    mode_id: "default",
    status: "idle" as const,
    efforts_by_model: {},
    models: [
        {
            id: "test-model",
            runtime_id: "codex-acp",
            name: "Test Model",
            description: "Model for tests",
        },
    ],
    modes: [
        {
            id: "default",
            runtime_id: "codex-acp",
            name: "Default",
            description: "Default mode",
            disabled: false,
        },
    ],
    config_options: [
        {
            id: "model",
            runtime_id: "codex-acp",
            category: "model",
            label: "Model",
            type: "select",
            value: "test-model",
            options: [{ value: "test-model", label: "Test Model" }],
        },
    ],
};

describe("createNewChatInWorkspace", () => {
    beforeEach(() => {
        resetChatStore();
        resetChatTabsStore();
        setEditorTabs([], null);
        useVaultStore.setState({ vaultPath: "/vault", notes: [], entries: [] });
        useChatStore.setState((state) => ({
            ...state,
            runtimes: [runtimeDescriptor],
            selectedRuntimeId: "codex-acp",
        }));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        resetChatStore();
        resetChatTabsStore();
        setEditorTabs([], null);
        useVaultStore.setState({ vaultPath: null, notes: [], entries: [] });
    });

    it("opens a pending chat tab immediately and swaps in the real session once creation finishes", async () => {
        const deferredSession = createDeferred<typeof createdSessionPayload>();
        invokeMock.mockImplementation((command) => {
            if (command === "ai_get_setup_status") {
                return Promise.resolve(setupStatusPayload);
            }
            if (command === "ai_create_session") {
                return deferredSession.promise;
            }
            return Promise.reject(new Error(`Unexpected invoke: ${command}`));
        });

        const pendingSessionId = await createNewChatInWorkspace("codex-acp");
        expect(pendingSessionId).toMatch(/^pending:/);

        const pendingSession =
            useChatStore.getState().sessionsById[pendingSessionId!];
        expect(pendingSession?.isPendingSessionCreation).toBe(true);

        const focusedPendingTab = selectFocusedEditorTab(useEditorStore.getState());
        expect(focusedPendingTab && isChatTab(focusedPendingTab)).toBe(true);
        if (!focusedPendingTab || !isChatTab(focusedPendingTab)) {
            throw new Error("Expected the focused tab to be the pending chat tab");
        }
        expect(focusedPendingTab.sessionId).toBe(pendingSessionId);

        deferredSession.resolve(createdSessionPayload);

        await waitFor(() => {
            expect(
                useChatStore.getState().sessionsById["codex-session-1"],
            ).toBeDefined();
        });

        expect(
            useChatStore.getState().sessionsById[pendingSessionId!],
        ).toBeUndefined();

        const focusedResolvedTab = selectFocusedEditorTab(useEditorStore.getState());
        expect(focusedResolvedTab && isChatTab(focusedResolvedTab)).toBe(true);
        if (!focusedResolvedTab || !isChatTab(focusedResolvedTab)) {
            throw new Error("Expected the focused tab to remain a chat tab");
        }
        expect(focusedResolvedTab.sessionId).toBe("codex-session-1");
    });
});
