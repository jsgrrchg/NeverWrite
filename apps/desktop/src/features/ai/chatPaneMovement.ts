import { useEditorStore } from "../../app/store/editorStore";
import { getSessionTitle } from "./sessionPresentation";
import { useChatStore } from "./store/chatStore";
import { useChatTabsStore } from "./store/chatTabsStore";
import { getPreferredWorkspaceChatSessionId } from "./chatWorkspaceSelectors";

interface OpenChatInWorkspaceOptions {
    paneId?: string;
    background?: boolean;
}

function resolveCreatedSessionId(beforeSessionIds: Set<string>) {
    const nextState = useChatStore.getState();
    return (
        Object.keys(nextState.sessionsById).find(
            (sessionId) => !beforeSessionIds.has(sessionId),
        ) ??
        (nextState.activeSessionId &&
        !beforeSessionIds.has(nextState.activeSessionId)
            ? nextState.activeSessionId
            : null)
    );
}

export function openChatSessionInWorkspace(
    sessionId: string,
    options?: OpenChatInWorkspaceOptions,
) {
    const session = useChatStore.getState().sessionsById[sessionId];
    useChatTabsStore.getState().openSessionTab(sessionId, {
        activate: true,
        historySessionId: session?.historySessionId ?? null,
        runtimeId: session?.runtimeId ?? null,
    });
    useEditorStore.getState().openChat(sessionId, {
        title: session ? getSessionTitle(session) : "Chat",
        paneId: options?.paneId,
        background: options?.background,
    });

    void useChatStore.getState().loadSession(sessionId);
    return sessionId;
}

export async function createNewChatInWorkspace(
    runtimeId?: string,
    options?: OpenChatInWorkspaceOptions,
) {
    const beforeSessionIds = new Set(
        Object.keys(useChatStore.getState().sessionsById),
    );

    await useChatStore.getState().newSession(runtimeId);
    const createdSessionId = resolveCreatedSessionId(beforeSessionIds);
    if (!createdSessionId) {
        return null;
    }

    openChatSessionInWorkspace(createdSessionId, options);
    return createdSessionId;
}

export async function ensureWorkspaceChatSession(
    options?: OpenChatInWorkspaceOptions & { runtimeId?: string },
) {
    const visibleSessionId = getPreferredWorkspaceChatSessionId();
    if (visibleSessionId) {
        return visibleSessionId;
    }

    const activeSessionId = useChatStore.getState().activeSessionId;
    if (activeSessionId) {
        return openChatSessionInWorkspace(activeSessionId, options);
    }

    return createNewChatInWorkspace(options?.runtimeId, options);
}
