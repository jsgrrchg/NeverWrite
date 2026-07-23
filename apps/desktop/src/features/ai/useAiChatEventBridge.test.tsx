import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AITokenUsagePayload } from "./types";

const listeners = vi.hoisted(() => ({
    tokenUsage: undefined as
        | ((payload: AITokenUsagePayload) => void)
        | undefined,
}));

const unlisten = vi.hoisted(() => vi.fn());
const noOpListener = vi.hoisted(() => vi.fn(async () => unlisten));
const tokenUsageListener = vi.hoisted(() =>
    vi.fn(async (callback: (payload: AITokenUsagePayload) => void) => {
        listeners.tokenUsage = callback;
        return unlisten;
    }),
);

vi.mock("./api", () => ({
    listenToAiAvailableCommandsUpdated: noOpListener,
    listenToAiImageGeneration: noOpListener,
    listenToAiMessageCompleted: noOpListener,
    listenToAiMessageDelta: noOpListener,
    listenToAiMessageStarted: noOpListener,
    listenToAiPermissionRequest: noOpListener,
    listenToAiPlanUpdated: noOpListener,
    listenToAiRuntimeConnection: noOpListener,
    listenToAiSessionCreated: noOpListener,
    listenToAiSessionError: noOpListener,
    listenToAiSessionUpdated: noOpListener,
    listenToAiStatusEvent: noOpListener,
    listenToAiThinkingCompleted: noOpListener,
    listenToAiThinkingDelta: noOpListener,
    listenToAiThinkingStarted: noOpListener,
    listenToAiTokenUsage: tokenUsageListener,
    listenToAiToolActivity: noOpListener,
    listenToAiUrlElicitationRequest: noOpListener,
    listenToAiUserInputRequest: noOpListener,
}));

import { resetChatStore, useChatStore } from "./store/chatStore";
import { useAiChatEventBridge } from "./useAiChatEventBridge";

describe("useAiChatEventBridge", () => {
    beforeEach(() => {
        resetChatStore();
        listeners.tokenUsage = undefined;
        unlisten.mockClear();
        noOpListener.mockClear();
        tokenUsageListener.mockClear();
        useChatStore.setState({
            sessionsById: { "session-1": {} as never },
        });
    });

    afterEach(() => {
        resetChatStore();
    });

    it("applies the dynamic context window payload from the native event", async () => {
        const { unmount } = renderHook(() => useAiChatEventBridge());

        await waitFor(() => expect(listeners.tokenUsage).toBeTypeOf("function"));

        act(() => {
            listeners.tokenUsage?.({
                session_id: "session-1",
                used: 136_000,
                size: 272_000,
            });
        });

        expect(useChatStore.getState().tokenUsageBySessionId["session-1"])
            .toMatchObject({
                session_id: "session-1",
                used: 136_000,
                size: 272_000,
        });

        unmount();
        expect(unlisten).toHaveBeenCalledTimes(19);
    });
});
