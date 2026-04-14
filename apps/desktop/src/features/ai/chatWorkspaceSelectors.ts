import {
    isChatTab,
    selectEditorPaneActiveTab,
    selectEditorWorkspaceTabs,
    selectFocusedPaneId,
    useEditorStore,
} from "../../app/store/editorStore";

export function getFocusedWorkspaceChatSessionId() {
    const editor = useEditorStore.getState();
    const focusedPaneId = selectFocusedPaneId(editor);
    const activeTab = selectEditorPaneActiveTab(editor, focusedPaneId);
    return activeTab && isChatTab(activeTab) ? activeTab.sessionId : null;
}

export function getVisibleWorkspaceChatSessionIds() {
    const sessionIds = new Set<string>();
    for (const tab of selectEditorWorkspaceTabs(useEditorStore.getState())) {
        if (!isChatTab(tab)) continue;
        sessionIds.add(tab.sessionId);
    }
    return [...sessionIds];
}

export function getPreferredWorkspaceChatSessionId() {
    return (
        getFocusedWorkspaceChatSessionId() ??
        getVisibleWorkspaceChatSessionIds()[0] ??
        null
    );
}
