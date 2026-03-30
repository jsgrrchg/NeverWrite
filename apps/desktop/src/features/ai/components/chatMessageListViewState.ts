const DETACHED_CHAT_VIEW_SCOPE = "__detached_timeline__";

export interface PersistedChatViewState {
    scrollTop: number;
    nearBottom: boolean;
    anchorRowKey: string | null;
    anchorOffset: number;
}

export interface VisibleChatAnchorSnapshot {
    nearBottom: boolean;
    rowKey: string | null;
    offset: number;
}

const persistedViewStateByScope = new Map<string, PersistedChatViewState>();

export function resolveChatMessageListViewStateScope(
    sessionId: string | null | undefined,
) {
    return sessionId ?? DETACHED_CHAT_VIEW_SCOPE;
}

export function captureVisibleChatAnchor(
    container: HTMLElement,
    isNearBottom: (element: HTMLElement) => boolean,
): VisibleChatAnchorSnapshot {
    const nearBottom = isNearBottom(container);
    if (nearBottom) {
        return {
            nearBottom,
            rowKey: null,
            offset: 0,
        };
    }

    const containerRect = container.getBoundingClientRect();
    const rows = container.querySelectorAll<HTMLElement>("[data-chat-row]");
    for (const row of rows) {
        const rect = row.getBoundingClientRect();
        if (rect.bottom > containerRect.top) {
            return {
                nearBottom,
                rowKey: row.dataset.chatRowKey ?? null,
                offset: rect.top - containerRect.top,
            };
        }
    }

    return {
        nearBottom,
        rowKey: null,
        offset: 0,
    };
}

export function findChatRowByKey(container: HTMLElement, rowKey: string) {
    const rows = container.querySelectorAll<HTMLElement>("[data-chat-row]");
    for (const row of rows) {
        if (row.dataset.chatRowKey === rowKey) {
            return row;
        }
    }
    return null;
}

export function readPersistedChatMessageListViewState(scope: string) {
    return persistedViewStateByScope.get(scope) ?? null;
}

export function persistChatMessageListViewState(
    scope: string,
    container: HTMLElement | null,
    isNearBottom: (element: HTMLElement) => boolean,
) {
    if (!container) {
        return readPersistedChatMessageListViewState(scope);
    }

    const anchor = captureVisibleChatAnchor(container, isNearBottom);
    const nextState: PersistedChatViewState = {
        scrollTop: Math.max(0, container.scrollTop),
        nearBottom: anchor.nearBottom,
        anchorRowKey: anchor.rowKey,
        anchorOffset: anchor.offset,
    };
    persistedViewStateByScope.set(scope, nextState);
    return nextState;
}

export function restoreChatMessageListViewState(
    container: HTMLElement,
    state: PersistedChatViewState,
) {
    if (state.nearBottom) {
        container.scrollTop = container.scrollHeight;
        return true;
    }

    if (state.anchorRowKey) {
        const row = findChatRowByKey(container, state.anchorRowKey);
        if (row) {
            const containerRect = container.getBoundingClientRect();
            const rect = row.getBoundingClientRect();
            container.scrollTop +=
                rect.top - containerRect.top - state.anchorOffset;
            return true;
        }
    }

    container.scrollTop = state.scrollTop;
    return container.childElementCount > 0;
}

export function resetChatMessageListViewState() {
    persistedViewStateByScope.clear();
}
