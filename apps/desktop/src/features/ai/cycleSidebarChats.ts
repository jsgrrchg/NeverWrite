import { useEditorStore, selectPaneState } from "../../app/store/editorStore";
import { useChatTabsStore } from "./store/chatTabsStore";
import { useChatStore } from "./store/chatStore";
import { usePinnedChatsStore } from "./store/pinnedChatsStore";
import { useArchivedChatsStore, isSessionArchived } from "./store/archivedChatsStore";
import { buildAiSessionHierarchyGroups } from "./sessionHierarchy";
import { isClaudeTerminalAgentSession } from "./claudeTerminalAgentSession";
import { openChatSessionInWorkspace } from "./chatPaneMovement";

export function cycleFocusedWorkspaceTabs(backward: boolean) {
    const nav = useChatTabsStore.getState();
    if (nav.focusedSurface !== "chat") {
        const state = useEditorStore.getState();
        const pane = selectPaneState(state);
        const index = pane.tabs.findIndex(tab => tab.id === pane.activeTabId);
        if (index < 0 || pane.tabs.length < 2) return;
        state.switchTab(pane.tabs[(index + (backward ? -1 : 1) + pane.tabs.length) % pane.tabs.length].id);
        return;
    }
    const { sessionsById, sessionOrder } = useChatStore.getState();
    const pins = usePinnedChatsStore.getState().entries;
    const archives = useArchivedChatsStore.getState().entries;
    const sessions = sessionOrder.map(id => sessionsById[id]).filter(session => session && !isClaudeTerminalAgentSession(session));
    const { groups } = buildAiSessionHierarchyGroups({
        sessions,
        pinnedSessionIds: new Set(Object.keys(pins)),
        compareSiblings: () => 0,
    });
    const currentId = nav.view.mode === "conversation" ? nav.view.sessionId : null;
    const current = currentId ? sessionsById[currentId] : null;
    const archived = Boolean(current && isSessionArchived(current, sessionsById, archives));
    const positions = new Map(sessionOrder.map((id, index) => [id, index]));
    const position = (ids: string[]) => Math.min(...ids.map(id => positions.get(id) ?? Infinity));
    const ordered = groups
        .filter(group => isSessionArchived(group.root, sessionsById, archives) === archived)
        .sort((a, b) => {
            if (!archived) {
                if (a.isPinnedRoot !== b.isPinnedRoot) return a.isPinnedRoot ? -1 : 1;
                if (a.isPinnedRoot && b.isPinnedRoot) {
                    const delta = (pins[b.root.sessionId]?.pinnedAt ?? 0) - (pins[a.root.sessionId]?.pinnedAt ?? 0);
                    if (delta) return delta;
                }
            }
            return position(a.sessionIds) - position(b.sessionIds);
        })
        .flatMap(group => [group.root.sessionId, ...group.children.map(child => child.sessionId)]);
    if (!ordered.length) return;
    const index = currentId ? ordered.indexOf(currentId) : -1;
    const next = index < 0 ? (backward ? ordered.length - 1 : 0) : (index + (backward ? -1 : 1) + ordered.length) % ordered.length;
    if (ordered[next] !== currentId) void openChatSessionInWorkspace(ordered[next]);
}
