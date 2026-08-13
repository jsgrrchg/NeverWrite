import { useEffect, useRef } from "react";
import {
    listenToAiAvailableCommandsUpdated,
    listenToAiMessageCompleted,
    listenToAiMessageDelta,
    listenToAiMessageStarted,
    listenToAiImageGeneration,
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
    listenToAiUrlElicitationRequest,
    listenToAiUserInputRequest,
} from "./api";
import { resolveChatSessionId, useChatStore } from "./store/chatStore";

function routeSessionEvent<T extends { session_id: string }>(payload: T): T {
    const sessionId = resolveChatSessionId(
        useChatStore.getState(),
        payload.session_id,
    );
    return sessionId && sessionId !== payload.session_id
        ? { ...payload, session_id: sessionId }
        : payload;
}

function routeOptionalSessionEvent<T extends { session_id?: string | null }>(
    payload: T,
): T {
    if (!payload.session_id) return payload;
    const sessionId = resolveChatSessionId(
        useChatStore.getState(),
        payload.session_id,
    );
    return sessionId && sessionId !== payload.session_id
        ? { ...payload, session_id: sessionId }
        : payload;
}

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
            const applySessionEvent = <T extends { session_id: string }>(
                apply: (payload: T) => void,
            ) =>
                (payload: T) => {
                    if (!disposed) apply(routeSessionEvent(payload));
                };
            const applyOptionalSessionEvent = <
                T extends { session_id?: string | null },
            >(
                apply: (payload: T) => void,
            ) =>
                (payload: T) => {
                    if (!disposed) apply(routeOptionalSessionEvent(payload));
                };
            const listeners = await Promise.all([
                listenToAiSessionCreated((session) => {
                    if (!disposed) chatActions.upsertSession(session);
                }),
                listenToAiSessionUpdated((session) => {
                    if (!disposed) chatActions.upsertSession(session);
                }),
                listenToAiSessionError(
                    applyOptionalSessionEvent(chatActions.applySessionError),
                ),
                listenToAiMessageStarted(
                    applySessionEvent(chatActions.applyMessageStarted),
                ),
                listenToAiMessageDelta(
                    applySessionEvent(chatActions.applyMessageDelta),
                ),
                listenToAiMessageCompleted(
                    applySessionEvent(chatActions.applyMessageCompleted),
                ),
                listenToAiThinkingStarted(
                    applySessionEvent(chatActions.applyThinkingStarted),
                ),
                listenToAiThinkingDelta(
                    applySessionEvent(chatActions.applyThinkingDelta),
                ),
                listenToAiThinkingCompleted(
                    applySessionEvent(chatActions.applyThinkingCompleted),
                ),
                listenToAiToolActivity(
                    applySessionEvent(chatActions.applyToolActivity),
                ),
                listenToAiStatusEvent(
                    applySessionEvent(chatActions.applyStatusEvent),
                ),
                listenToAiImageGeneration(
                    applySessionEvent(chatActions.applyImageGeneration),
                ),
                listenToAiPlanUpdated(
                    applySessionEvent(chatActions.applyPlanUpdate),
                ),
                listenToAiAvailableCommandsUpdated(
                    applySessionEvent(chatActions.applyAvailableCommandsUpdate),
                ),
                listenToAiPermissionRequest(
                    applySessionEvent(chatActions.applyPermissionRequest),
                ),
                listenToAiUserInputRequest(
                    applySessionEvent(chatActions.applyUserInputRequest),
                ),
                listenToAiUrlElicitationRequest(
                    applySessionEvent(chatActions.applyUrlElicitationRequest),
                ),
                listenToAiRuntimeConnection(
                    applyOptionalSessionEvent(
                        chatActions.applyRuntimeConnection,
                    ),
                ),
                listenToAiTokenUsage(
                    applySessionEvent(chatActions.applyTokenUsage),
                ),
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
