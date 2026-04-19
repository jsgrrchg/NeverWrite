import { useEffect, useMemo, useState } from "react";
import { openChatSessionInWorkspace } from "../chatPaneMovement";
import {
    findSessionForHistorySelection,
    getHistorySelectionId,
    getSessionUpdatedAt,
} from "../sessionPresentation";
import { useChatStore } from "../store/chatStore";
import { ChatHistoryView } from "./ChatHistoryView";

export function AIChatHistoryWorkspaceView() {
    const sessionsById = useChatStore((state) => state.sessionsById);
    const sessionOrder = useChatStore((state) => state.sessionOrder);
    const [selectedHistorySessionId, setSelectedHistorySessionId] = useState<
        string | null
    >(null);

    const orderedSessions = useMemo(
        () =>
            sessionOrder
                .map((sessionId) => sessionsById[sessionId])
                .filter(
                    (
                        session,
                    ): session is NonNullable<(typeof sessionsById)[string]> =>
                        Boolean(session),
                )
                .sort(
                    (left, right) =>
                        getSessionUpdatedAt(right) - getSessionUpdatedAt(left),
                ),
        [sessionOrder, sessionsById],
    );

    useEffect(() => {
        const selectedSession = findSessionForHistorySelection(
            sessionsById,
            selectedHistorySessionId,
        );
        if (selectedSession) {
            return;
        }

        const fallbackSession = orderedSessions[0] ?? null;
        const fallbackHistorySessionId = fallbackSession
            ? getHistorySelectionId(fallbackSession)
            : null;

        if (fallbackHistorySessionId !== selectedHistorySessionId) {
            setSelectedHistorySessionId(fallbackHistorySessionId);
        }
    }, [orderedSessions, selectedHistorySessionId, sessionsById]);

    return (
        <div data-testid="ai-chat-history-workspace-view" className="h-full">
            <ChatHistoryView
                selectedHistorySessionId={selectedHistorySessionId}
                onSelectHistorySessionId={setSelectedHistorySessionId}
                onRestoreHistorySession={(historySessionId) => {
                    const session = findSessionForHistorySelection(
                        sessionsById,
                        historySessionId,
                    );
                    if (!session) {
                        return;
                    }

                    openChatSessionInWorkspace(session.sessionId);
                }}
                showBackButton={false}
            />
        </div>
    );
}
