import { useLayoutStore } from "../../app/store/layoutStore";
import { useChatTabsStore } from "./store/chatTabsStore";
import {
    isChatTab,
    selectEditorPaneActiveTab,
    selectEditorWorkspaceTabs,
    selectFocusedPaneId,
    useEditorStore,
} from "../../app/store/editorStore";

export function getFocusedWorkspaceChatSessionId() {
    const navigation = useChatTabsStore.getState();
    if (navigation.dedicatedPaneEnabled) return useLayoutStore.getState().chatPaneVisible && navigation.focusedSurface === "chat" && navigation.view.mode === "conversation" ? navigation.view.sessionId : null;
    const editor = useEditorStore.getState();
    const focusedPaneId = selectFocusedPaneId(editor);
    const activeTab = selectEditorPaneActiveTab(editor, focusedPaneId);
    return activeTab && isChatTab(activeTab) ? activeTab.sessionId : null;
}

export function getVisibleWorkspaceChatSessionIds() {
    const navigation = useChatTabsStore.getState();
    if (navigation.dedicatedPaneEnabled) return useLayoutStore.getState().chatPaneVisible && navigation.view.mode === "conversation" ? [navigation.view.sessionId] : [];
    const sessionIds = new Set<string>();
    for (const tab of selectEditorWorkspaceTabs(useEditorStore.getState())) {
        if (!isChatTab(tab)) continue;
        sessionIds.add(tab.sessionId);
    }
    return [...sessionIds];
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
