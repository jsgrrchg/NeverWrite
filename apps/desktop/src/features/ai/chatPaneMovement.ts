import {
    isChatTab,
    useEditorStore,
} from "../../app/store/editorStore";
import { createChatTab } from "../../app/store/editorTabs";
import type { WorkspaceDropTarget } from "../../app/store/workspaceContracts";
import { getSessionTitle } from "./sessionPresentation";
import { useChatStore } from "./store/chatStore";
import { useChatTabsStore } from "./store/chatTabsStore";
import { getPreferredWorkspaceChatSessionIdForSession } from "./chatWorkspaceSelectors";
import type { AIChatSession, AIRuntimeDescriptor } from "./types";

interface OpenChatInWorkspaceOptions {
    paneId?: string;
    insertIndex?: number;
    background?: boolean;
    skipLoad?: boolean;
}

type ChatWorkspaceDropTarget = Extract<
    WorkspaceDropTarget,
    { type: "strip" | "pane-center" | "split" }
>;

function getConfigDefaultValue(
    runtime: AIRuntimeDescriptor,
    category: "model" | "mode",
) {
    return runtime.configOptions.find((option) => option.category === category)
        ?.value;
}

function resolvePendingRuntime(runtimeId?: string) {
    const state = useChatStore.getState();
    const resolvedRuntimeId =
        runtimeId ?? state.selectedRuntimeId ?? state.runtimes[0]?.runtime.id;
    if (!resolvedRuntimeId) {
        return null;
    }

    const runtime =
        state.runtimes.find(
            (descriptor) => descriptor.runtime.id === resolvedRuntimeId,
        ) ?? null;
    if (!runtime) {
        return null;
    }

    return {
        runtime,
        runtimeId: resolvedRuntimeId,
    };
}

function createPendingWorkspaceSession(
    runtimeId?: string,
): AIChatSession | null {
    const resolvedRuntime = resolvePendingRuntime(runtimeId);
    if (!resolvedRuntime) {
        return null;
    }

    const { runtime, runtimeId: resolvedRuntimeId } = resolvedRuntime;
    const pendingSessionId = `pending:${crypto.randomUUID()}`;

    return {
        sessionId: pendingSessionId,
        historySessionId: pendingSessionId,
        status: "idle",
        activeWorkCycleId: null,
        visibleWorkCycleId: null,
        isResumingSession: false,
        effortsByModel: {},
        runtimeId: resolvedRuntimeId,
        modelId:
            getConfigDefaultValue(runtime, "model") ??
            runtime.models[0]?.id ??
            "",
        modeId:
            getConfigDefaultValue(runtime, "mode") ??
            runtime.modes.find((mode) => !mode.disabled)?.id ??
            runtime.modes[0]?.id ??
            "",
        models: runtime.models,
        modes: runtime.modes,
        configOptions: runtime.configOptions,
        messages: [],
        attachments: [],
        isPersistedSession: false,
        isPendingSessionCreation: true,
        pendingSessionError: null,
        resumeContextPending: false,
        runtimeState: "live",
    };
}

function prepareChatSessionForWorkspace(sessionId: string) {
    const session = useChatStore.getState().sessionsById[sessionId];
    const historySessionId = session?.historySessionId ?? null;
    useChatTabsStore.getState().openSessionTab(sessionId, {
        activate: true,
        historySessionId,
        runtimeId: session?.runtimeId ?? null,
    });

    return {
        session,
        title: session ? getSessionTitle(session) : "Chat",
        historySessionId,
    };
}

function finalizeChatSessionWorkspaceOpen(
    sessionId: string,
    options?: Pick<OpenChatInWorkspaceOptions, "background" | "skipLoad">,
) {
    if (!options?.background) {
        useChatStore.getState().markSessionFocused(sessionId);
    }

    if (!options?.skipLoad) {
        void useChatStore.getState().loadSession(sessionId);
    }
}

function findWorkspaceChatTab(
    sessionId: string,
    historySessionId: string | null,
) {
    const workspace = useEditorStore.getState();
    for (const pane of workspace.panes) {
        for (const tab of pane.tabs) {
            if (
                isChatTab(tab) &&
                (tab.sessionId === sessionId ||
                    (historySessionId !== null &&
                        tab.historySessionId === historySessionId))
            ) {
                return { paneId: pane.id, tab };
            }
        }
    }
    return null;
}

export function openChatSessionInWorkspace(
    sessionId: string,
    options?: OpenChatInWorkspaceOptions,
) {
    const { title, historySessionId } = prepareChatSessionForWorkspace(sessionId);
    useEditorStore.getState().openChat(sessionId, {
        title,
        paneId: options?.paneId,
        insertIndex: options?.insertIndex,
        background: options?.background,
        historySessionId,
    });
    finalizeChatSessionWorkspaceOpen(sessionId, options);
    return sessionId;
}

export function openChatHistoryInWorkspace() {
    useEditorStore.getState().openChatHistory();
}

export function openOrMoveChatSessionAtDropTarget(
    sessionId: string,
    target: ChatWorkspaceDropTarget,
) {
    const { title, historySessionId } = prepareChatSessionForWorkspace(sessionId);
    const existing = findWorkspaceChatTab(sessionId, historySessionId);
    const editor = useEditorStore.getState();

    if (existing) {
        if (target.type === "strip") {
            if (existing.paneId === target.paneId) {
                editor.switchTab(existing.tab.id);
            } else {
                editor.moveTabToPane(
                    existing.tab.id,
                    target.paneId,
                    target.index,
                );
            }
        } else if (target.type === "pane-center") {
            if (existing.paneId === target.paneId) {
                editor.switchTab(existing.tab.id);
            } else {
                editor.moveTabToPane(existing.tab.id, target.paneId);
            }
        } else {
            editor.moveTabToPaneDropTarget(
                existing.tab.id,
                target.paneId,
                target.direction,
            );
        }
        finalizeChatSessionWorkspaceOpen(sessionId);
        return existing.tab.id;
    }

    const chatTab = createChatTab(sessionId, title, historySessionId);
    if (target.type === "strip") {
        editor.insertExternalTabInPane(chatTab, target.paneId, target.index);
    } else if (target.type === "pane-center") {
        editor.insertExternalTabInPane(chatTab, target.paneId);
    } else {
        editor.insertExternalTabAtPaneDropTarget(
            chatTab,
            target.paneId,
            target.direction,
        );
    }
    finalizeChatSessionWorkspaceOpen(sessionId);
    return chatTab.id;
}

export async function createNewChatInWorkspace(
    runtimeId?: string,
    options?: OpenChatInWorkspaceOptions,
) {
    const pendingSession = createPendingWorkspaceSession(runtimeId);
    if (!pendingSession) {
        const createdSessionId = await useChatStore
            .getState()
            .newSession(runtimeId);
        if (!createdSessionId) {
            return null;
        }

        openChatSessionInWorkspace(createdSessionId, options);
        return createdSessionId;
    }

    useChatStore.getState().upsertSession(pendingSession, true);
    openChatSessionInWorkspace(pendingSession.sessionId, {
        ...options,
        skipLoad: true,
    });
    void useChatStore
        .getState()
        .newSession(pendingSession.runtimeId, pendingSession.sessionId);
    return pendingSession.sessionId;
}

export async function ensureWorkspaceChatSession(
    options?: OpenChatInWorkspaceOptions & { runtimeId?: string },
) {
    const visibleSessionId = getPreferredWorkspaceChatSessionIdForSession(
        useChatStore.getState().lastFocusedSessionId,
    );
    if (visibleSessionId) {
        return visibleSessionId;
    }

    const activeSessionId = useChatStore.getState().activeSessionId;
    if (activeSessionId) {
        return openChatSessionInWorkspace(activeSessionId, options);
    }

    return createNewChatInWorkspace(options?.runtimeId, options);
}
