import { useEffect, useRef } from "react";
import {
    listenToAiAvailableCommandsUpdated,
    listenToAiMessageCompleted,
    listenToAiMessageDelta,
    listenToAiMessageStarted,
    listenToAiPermissionRequest,
    listenToAiPlanUpdated,
    listenToAiRuntimeConnection,
    listenToAiSessionCreated,
    listenToAiSessionError,
    listenToAiSessionUpdated,
    listenToAiStatusEvent,
    listenToAiThinkingCompleted,
    listenToAiThinkingDelta,
    listenToAiThinkingStarted,
    listenToAiTokenUsage,
    listenToAiToolActivity,
    listenToAiUserInputRequest,
} from "./api";
import { useChatStore } from "./store/chatStore";

export function useAiChatEventBridge(enabled = true) {
    const chatActions = useRef(useChatStore.getState()).current;

    useEffect(() => {
        if (!enabled) return;

        let disposed = false;
        let cleanupFns: Array<() => void> = [];

        const cleanup = () => {
            cleanupFns.forEach((fn) => {
                if (typeof fn === "function") {
                    void fn();
                }
            });
            cleanupFns = [];
        };

        const bind = async () => {
            const listeners = await Promise.all([
                listenToAiSessionCreated((session) => {
                    if (!disposed) chatActions.upsertSession(session);
                }),
                listenToAiSessionUpdated((session) => {
                    if (!disposed) chatActions.upsertSession(session);
                }),
                listenToAiSessionError((payload) => {
                    if (!disposed) chatActions.applySessionError(payload);
                }),
                listenToAiMessageStarted((payload) => {
                    if (!disposed) chatActions.applyMessageStarted(payload);
                }),
                listenToAiMessageDelta((payload) => {
                    if (!disposed) chatActions.applyMessageDelta(payload);
                }),
                listenToAiMessageCompleted((payload) => {
                    if (!disposed) chatActions.applyMessageCompleted(payload);
                }),
                listenToAiThinkingStarted((payload) => {
                    if (!disposed) chatActions.applyThinkingStarted(payload);
                }),
                listenToAiThinkingDelta((payload) => {
                    if (!disposed) chatActions.applyThinkingDelta(payload);
                }),
                listenToAiThinkingCompleted((payload) => {
                    if (!disposed) chatActions.applyThinkingCompleted(payload);
                }),
                listenToAiToolActivity((payload) => {
                    if (!disposed) chatActions.applyToolActivity(payload);
                }),
                listenToAiStatusEvent((payload) => {
                    if (!disposed) chatActions.applyStatusEvent(payload);
                }),
                listenToAiPlanUpdated((payload) => {
                    if (!disposed) chatActions.applyPlanUpdate(payload);
                }),
                listenToAiAvailableCommandsUpdated((payload) => {
                    if (!disposed) {
                        chatActions.applyAvailableCommandsUpdate(payload);
                    }
                }),
                listenToAiPermissionRequest((payload) => {
                    if (!disposed) chatActions.applyPermissionRequest(payload);
                }),
                listenToAiUserInputRequest((payload) => {
                    if (!disposed) chatActions.applyUserInputRequest(payload);
                }),
                listenToAiRuntimeConnection((payload) => {
                    if (!disposed) chatActions.applyRuntimeConnection(payload);
                }),
                listenToAiTokenUsage((payload) => {
                    if (!disposed) chatActions.applyTokenUsage(payload);
                }),
            ]);

            if (disposed) {
                listeners.forEach((fn) => {
                    if (typeof fn === "function") {
                        void fn();
                    }
                });
                return;
            }

            cleanupFns = listeners;
        };

        void bind();

        return () => {
            disposed = true;
            cleanup();
        };
    }, [chatActions, enabled]);
}
