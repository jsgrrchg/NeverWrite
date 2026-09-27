const DETACHED_CHAT_VIEW_SCOPE = "__detached_timeline__";

export interface PersistedChatViewState {
    scrollTop: number;
    nearBottom: boolean;
    anchorRowKey: string | null;
    anchorOffset: number;
    runwayMessageId?: string | null;
}

export interface VisibleChatAnchorSnapshot {
    nearBottom: boolean;
    rowKey: string | null;
    offset: number;
}

// Only the mounted scroll controller keeps the DOM node. Persisted state stores
// the row key and offset so detached nodes cannot survive a conversation switch.
export interface CapturedChatAnchor extends VisibleChatAnchorSnapshot {
    node: HTMLElement | null;
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
): CapturedChatAnchor {
    const nearBottom = isNearBottom(container);
    if (nearBottom) {
        return {
            nearBottom,
            rowKey: null,
            offset: 0,
            node: null,
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
                node: row,
            };
        }
    }

    return {
        nearBottom,
        rowKey: null,
        offset: 0,
        node: null,
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
    anchor: VisibleChatAnchorSnapshot,
    runwayMessageId: string | null = null,
) {
    if (!container) {
        return readPersistedChatMessageListViewState(scope);
    }

    const nextState: PersistedChatViewState = {
        scrollTop: Math.max(0, container.scrollTop),
        nearBottom: anchor.nearBottom,
        anchorRowKey: anchor.rowKey,
        anchorOffset: anchor.offset,
        runwayMessageId,
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
