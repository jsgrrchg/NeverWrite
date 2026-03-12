import { useEffect, useRef } from "react";
import { useEditorStore } from "../../../app/store/editorStore";
import { useChatStore } from "../store/chatStore";
import { getReviewTabTitle } from "../reviewTabTitle";
import { selectVisibleEditedFilesBufferCount } from "../store/editedFilesBufferModel";

export function useAutoOpenReviewTab() {
    const prevCountRef = useRef(0);

    useEffect(() => {
        const unsubscribe = useChatStore.subscribe((state) => {
            const sessionId = state.activeSessionId;
            if (!sessionId) return;

            const count = selectVisibleEditedFilesBufferCount(state, sessionId);
            const prev = prevCountRef.current;
            prevCountRef.current = count;

            // Open review tab in background when entries appear for the first time
            if (count > 0 && prev === 0) {
                const session = state.sessionsById[sessionId];
                useEditorStore.getState().openReview(sessionId, {
                    background: true,
                    title: getReviewTabTitle(session, state.runtimes),
                });
            }
        });

        return unsubscribe;
    }, []);
}
