import { create } from "zustand";

interface ChatSubmission {
    sessionId: string;
    messageId: string;
    revision: number;
}

// Renderer-local intent, deliberately separate from persisted/replayed messages.
// Queue entries publish only when dispatch inserts their real transcript row.
export const useChatSubmissionStore = create<{
    revision: number;
    submissionsBySessionId: Record<string, ChatSubmission>;
}>(() => ({ revision: 0, submissionsBySessionId: {} }));

export function announceChatSubmission(sessionId: string, messageId: string) {
    useChatSubmissionStore.setState((state) => {
        const revision = state.revision + 1;
        return {
            revision,
            submissionsBySessionId: {
                ...state.submissionsBySessionId,
                [sessionId]: { sessionId, messageId, revision },
            },
        };
    });
}
