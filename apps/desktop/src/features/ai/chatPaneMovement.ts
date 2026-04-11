import { useChatTabsStore } from "./store/chatTabsStore";
import { useChatStore } from "./store/chatStore";
import { useEditorStore } from "../../app/store/editorStore";
import { getSessionTitle } from "./sessionPresentation";

/**
 * Move a chat session from the sidebar into an editor workspace pane.
 * The session tab is marked as "workspace" so the sidebar hides it,
 * and a ChatTab is created in the specified (or focused) editor pane.
 */
export function moveChatToWorkspace(
    sessionId: string,
    options?: { paneId?: string },
) {
    const session = useChatStore.getState().sessionsById[sessionId];
    if (!session) return;

    const title = getSessionTitle(session);

    useChatTabsStore.getState().moveToWorkspace(sessionId);
    useEditorStore.getState().openChat(sessionId, {
        title,
        paneId: options?.paneId,
    });
}

/**
 * Create a new chat session with the given runtime and open it directly
 * in the editor workspace (bypassing the sidebar).
 */
export async function newChatInWorkspace(runtimeId: string) {
    const chatState = useChatStore.getState();
    const beforeIds = new Set(Object.keys(chatState.sessionsById));

    await chatState.newSession(runtimeId);

    // Find the newly created session by diffing keys
    const afterIds = Object.keys(useChatStore.getState().sessionsById);
    const newSessionId = afterIds.find((id) => !beforeIds.has(id));
    if (newSessionId) {
        moveChatToWorkspace(newSessionId);
    }
}

/**
 * Move a chat session from the editor workspace back to the sidebar.
 * The ChatTab is closed in the editor, the session tab is unmarked,
 * and the sidebar re-activates it.
 */
export function moveChatToSidebar(sessionId: string) {
    useEditorStore.getState().closeChat(sessionId);
    const chatTabs = useChatTabsStore.getState();
    chatTabs.moveToSidebar(sessionId);
    chatTabs.openSessionTab(sessionId, { activate: true });
}
