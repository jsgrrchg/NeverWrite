import { useEffect, useRef } from "react";
import { useEditorStore } from "../../../app/store/editorStore";
import { useChatStore } from "../store/chatStore";
import { getReviewTabTitle } from "../sessionPresentation";
import { getTrackedFilesForSession } from "../store/actionLogModel";
import type { AIChatSession } from "../types";

const trackedFileCountCache = new WeakMap<AIChatSession, number>();

function getVisibleTrackedFilesCountForSession(
    session: AIChatSession | null | undefined,
) {
    if (!session) {
        return 0;
    }

    const cached = trackedFileCountCache.get(session);
    if (typeof cached === "number") {
        return cached;
    }

    const count = Object.keys(
        getTrackedFilesForSession(session.actionLog),
    ).length;
    trackedFileCountCache.set(session, count);
    return count;
}

function ensureReviewTabsForSessions(
    sessionsById: Record<string, AIChatSession | undefined>,
    runtimes: ReturnType<typeof useChatStore.getState>["runtimes"],
) {
    for (const [sessionId, session] of Object.entries(sessionsById)) {
        if (getVisibleTrackedFilesCountForSession(session) <= 0) {
            continue;
        }

        useEditorStore.getState().openReview(sessionId, {
            background: true,
            title: getReviewTabTitle(session, runtimes),
        });
    }
}

export function useAutoOpenReviewTab() {
    const prevCountsRef = useRef<Map<string, number>>(new Map());
    const prevSessionsByIdRef = useRef(useChatStore.getState().sessionsById);

    useEffect(() => {
        const initialState = useChatStore.getState();
        prevCountsRef.current = new Map(
            Object.entries(initialState.sessionsById).map(
                ([sessionId, session]) => [
                    sessionId,
                    getVisibleTrackedFilesCountForSession(session),
                ],
            ),
        );
        prevSessionsByIdRef.current = initialState.sessionsById;
        ensureReviewTabsForSessions(
            initialState.sessionsById,
            initialState.runtimes,
        );

        const unsubscribe = useChatStore.subscribe((state) => {
            const prevSessionsById = prevSessionsByIdRef.current;
            const nextSessionsById = state.sessionsById;
            if (nextSessionsById === prevSessionsById) {
                return;
            }

            for (const [sessionId, session] of Object.entries(
                nextSessionsById,
            )) {
                if (prevSessionsById[sessionId] === session) {
                    continue;
                }
                const count = getVisibleTrackedFilesCountForSession(session);
                const prev = prevCountsRef.current.get(sessionId) ?? 0;
                prevCountsRef.current.set(sessionId, count);

                // Open a review tab the first time a session surfaces edits.
                if (count > 0 && prev === 0) {
                    const session = state.sessionsById[sessionId];
                    useEditorStore.getState().openReview(sessionId, {
                        background: true,
                        title: getReviewTabTitle(session, state.runtimes),
                    });
                }
            }

            for (const sessionId of Object.keys(prevSessionsById)) {
                if (!(sessionId in nextSessionsById)) {
                    prevCountsRef.current.delete(sessionId);
                }
            }

            prevSessionsByIdRef.current = nextSessionsById;
        });

        return unsubscribe;
    }, []);
}
