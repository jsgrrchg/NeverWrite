import { useLayoutStore } from "../../app/store/layoutStore";
import { useChatTabsStore } from "./store/chatTabsStore";
export function getFocusedWorkspaceChatSessionId() {
    const navigation = useChatTabsStore.getState();
    return useLayoutStore.getState().chatPaneVisible &&
        navigation.focusedSurface === "chat" &&
        navigation.view.mode === "conversation"
        ? navigation.view.sessionId
        : null;
}

export function getVisibleWorkspaceChatSessionIds() {
    const view = useChatTabsStore.getState().view;
    return useLayoutStore.getState().chatPaneVisible &&
        view.mode === "conversation"
        ? [view.sessionId]
        : [];
}

export function getPreferredWorkspaceChatSessionId() {
    return getPreferredWorkspaceChatSessionIdForSession(null);
}

export function getPreferredWorkspaceChatSessionIdForSession(
    preferredSessionId: string | null,
) {
    const visibleSessionIds = getVisibleWorkspaceChatSessionIds();
    if (preferredSessionId && visibleSessionIds.includes(preferredSessionId)) {
        return preferredSessionId;
    }

    return getFocusedWorkspaceChatSessionId() ?? visibleSessionIds[0] ?? null;
}

export function getSelectedChatSessionId() {
    const view = useChatTabsStore.getState().view;
    return view.mode === "conversation" ? view.sessionId : null;
}
