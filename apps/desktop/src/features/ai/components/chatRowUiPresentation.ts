import { useCallback } from "react";

import {
    resolveChatRowUiSessionId,
    useChatRowUiStore,
    type ChatRowUiState,
} from "../store/chatRowUiStore";

export function useChatRowUiEntry(
    sessionId: string | null | undefined,
    messageId: string,
) {
    const resolvedSessionId = resolveChatRowUiSessionId(sessionId);
    const rowState = useChatRowUiStore(
        (state) => state.rowsBySessionId[resolvedSessionId]?.[messageId],
    );
    const patchRow = useChatRowUiStore((state) => state.patchRow);

    const updateRow = useCallback(
        (
            patch:
                | Partial<ChatRowUiState>
                | ((current: ChatRowUiState) => Partial<ChatRowUiState>),
        ) => {
            patchRow(resolvedSessionId, messageId, patch);
        },
        [messageId, patchRow, resolvedSessionId],
    );

    return {
        rowState,
        updateRow,
    };
}

export function useStoredRowExpanded(
    sessionId: string | null | undefined,
    messageId: string,
    fallback: boolean,
) {
    const { rowState, updateRow } = useChatRowUiEntry(sessionId, messageId);
    const expanded = rowState?.expanded ?? fallback;

    const setExpanded = useCallback(
        (value: boolean | ((current: boolean) => boolean)) => {
            updateRow((current) => ({
                expanded:
                    typeof value === "function"
                        ? value(current.expanded ?? fallback)
                        : value,
            }));
        },
        [fallback, updateRow],
    );

    return [expanded, setExpanded] as const;
}
