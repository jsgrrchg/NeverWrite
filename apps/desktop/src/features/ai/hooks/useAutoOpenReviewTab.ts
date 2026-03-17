import { useEffect, useRef } from "react";
import { useEditorStore } from "../../../app/store/editorStore";
import { useChatStore } from "../store/chatStore";
import { getReviewTabTitle } from "../reviewTabTitle";
import { selectVisibleTrackedFilesCount } from "../store/editedFilesBufferModel";

export function useAutoOpenReviewTab() {
    const prevCountsRef = useRef<Map<string, number>>(new Map());

    useEffect(() => {
        const initialState = useChatStore.getState();
        prevCountsRef.current = new Map(
            Object.keys(initialState.sessionsById).map((sessionId) => [
                sessionId,
                selectVisibleTrackedFilesCount(initialState, sessionId),
            ]),
        );

        const unsubscribe = useChatStore.subscribe((state) => {
            const nextSessionIds = new Set(Object.keys(state.sessionsById));

            for (const sessionId of nextSessionIds) {
                const count = selectVisibleTrackedFilesCount(state, sessionId);
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

            for (const sessionId of Array.from(prevCountsRef.current.keys())) {
                if (!nextSessionIds.has(sessionId)) {
                    prevCountsRef.current.delete(sessionId);
                }
            }
        });

        return unsubscribe;
    }, []);
}
