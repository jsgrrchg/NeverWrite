import { create } from "zustand";

export interface ChatRowUiState {
    expanded?: boolean;
    singleDiffExpanded?: boolean;
    diffExpandedByPath?: Record<string, boolean>;
    userInputSelectedOptions?: Record<string, string>;
    userInputTextAnswers?: Record<string, string>;
    userInputOtherAnswers?: Record<string, string>;
}

interface ChatRowUiStoreState {
    rowsBySessionId: Record<string, Record<string, ChatRowUiState>>;
    patchRow: (
        sessionId: string,
        messageId: string,
        patch:
            | Partial<ChatRowUiState>
            | ((current: ChatRowUiState) => Partial<ChatRowUiState>),
    ) => void;
    clearSession: (sessionId: string) => void;
    replaceSessionId: (fromSessionId: string, toSessionId: string) => void;
    reset: () => void;
}

const INITIAL_STATE: Pick<ChatRowUiStoreState, "rowsBySessionId"> = {
    rowsBySessionId: {},
};

export function resolveChatRowUiSessionId(sessionId?: string | null) {
    return sessionId ?? "__detached_chat_session__";
}

export const useChatRowUiStore = create<ChatRowUiStoreState>((set) => ({
    ...INITIAL_STATE,
    patchRow: (sessionId, messageId, patch) =>
        set((state) => {
            const sessionRows = state.rowsBySessionId[sessionId] ?? {};
            const currentRow = sessionRows[messageId] ?? {};
            const resolvedPatch =
                typeof patch === "function" ? patch(currentRow) : patch;
            const nextRow = {
                ...currentRow,
                ...resolvedPatch,
            };

            return {
                rowsBySessionId: {
                    ...state.rowsBySessionId,
                    [sessionId]: {
                        ...sessionRows,
                        [messageId]: nextRow,
                    },
                },
            };
        }),
    clearSession: (sessionId) =>
        set((state) => {
            if (!state.rowsBySessionId[sessionId]) {
                return state;
            }

            const nextRowsBySessionId = { ...state.rowsBySessionId };
            delete nextRowsBySessionId[sessionId];
            return {
                rowsBySessionId: nextRowsBySessionId,
            };
        }),
    replaceSessionId: (fromSessionId, toSessionId) =>
        set((state) => {
            if (fromSessionId === toSessionId) {
                return state;
            }

            const sourceRows = state.rowsBySessionId[fromSessionId];
            if (!sourceRows) {
                return state;
            }

            const nextRowsBySessionId = { ...state.rowsBySessionId };
            delete nextRowsBySessionId[fromSessionId];
            nextRowsBySessionId[toSessionId] = {
                ...(nextRowsBySessionId[toSessionId] ?? {}),
                ...sourceRows,
            };

            return {
                rowsBySessionId: nextRowsBySessionId,
            };
        }),
    reset: () => set(INITIAL_STATE),
}));

export function resetChatRowUiStore() {
    useChatRowUiStore.getState().reset();
}

export function clearChatRowUiSession(sessionId?: string | null) {
    if (!sessionId) {
        return;
    }
    useChatRowUiStore.getState().clearSession(sessionId);
}

export function replaceChatRowUiSessionId(
    fromSessionId?: string | null,
    toSessionId?: string | null,
) {
    if (!fromSessionId || !toSessionId) {
        return;
    }
    useChatRowUiStore.getState().replaceSessionId(fromSessionId, toSessionId);
}
