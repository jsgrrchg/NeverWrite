import {
    isChatTab,
    selectFocusedEditorTab,
    useEditorStore,
} from "../../app/store/editorStore";
import { createChatTab } from "../../app/store/editorTabs";
import type { WorkspaceDropTarget } from "../../app/store/workspaceContracts";
import {
    focusClaudeTerminalAgentSession,
    isClaudeTerminalAgentSession,
} from "./claudeTerminalAgentSession";
import { getSessionTitle } from "./sessionPresentation";
import { useChatStore } from "./store/chatStore";
import { useChatTabsStore } from "./store/chatTabsStore";
import { getPreferredWorkspaceChatSessionIdForSession } from "./chatWorkspaceSelectors";
import { CLAUDE_TERMINAL_RUNTIME_ID } from "./utils/runtimeMetadata";
import type {
    AIChatSession,
    AIRuntimeDescriptor,
    AIRuntimeSetupStatus,
} from "./types";

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

function isRuntimeSetupReady(setupStatus?: AIRuntimeSetupStatus | null) {
    return setupStatus?.authReady === true && !setupStatus.onboardingRequired;
}

function isClaudeTerminalRuntimeId(runtimeId?: string | null) {
    return runtimeId === CLAUDE_TERMINAL_RUNTIME_ID;
}

function resolvePendingRuntime(runtimeId?: string) {
    const state = useChatStore.getState();
    if (isClaudeTerminalRuntimeId(runtimeId)) {
        return null;
    }
    if (!runtimeId && isClaudeTerminalRuntimeId(state.selectedRuntimeId)) {
        return null;
    }

    const getRuntime = (candidateRuntimeId?: string | null) =>
        candidateRuntimeId
            ? (state.runtimes.find(
                  (descriptor) =>
                      descriptor.runtime.id === candidateRuntimeId,
              ) ?? null)
            : null;
    const firstReadyRuntime = state.runtimes.find(
        (descriptor) =>
            !isClaudeTerminalRuntimeId(descriptor.runtime.id) &&
            isRuntimeSetupReady(
                state.setupStatusByRuntimeId[descriptor.runtime.id],
            ),
    );
    const selectedRuntime = getRuntime(state.selectedRuntimeId);
    const readySelectedRuntimeId =
        selectedRuntime &&
        !isClaudeTerminalRuntimeId(selectedRuntime.runtime.id) &&
        isRuntimeSetupReady(
            state.setupStatusByRuntimeId[selectedRuntime.runtime.id],
        )
            ? selectedRuntime.runtime.id
            : null;
    const selectedRuntimeId = !isClaudeTerminalRuntimeId(
        state.selectedRuntimeId,
    )
        ? state.selectedRuntimeId
        : null;
    const firstConfiguredRuntimeId = state.runtimes.find(
        (descriptor) => !isClaudeTerminalRuntimeId(descriptor.runtime.id),
    )?.runtime.id;
    const resolvedRuntimeId =
        runtimeId ??
        readySelectedRuntimeId ??
        firstReadyRuntime?.runtime.id ??
        selectedRuntimeId ??
        firstConfiguredRuntimeId;
    if (!resolvedRuntimeId) {
        return null;
    }

    const runtime = getRuntime(resolvedRuntimeId);
    if (!runtime) {
        return null;
    }

    return {
        runtime,
        runtimeId: resolvedRuntimeId,
    };
}

function resolveStoreNewSessionRuntimeId(runtimeId?: string | null) {
    if (runtimeId) {
        return runtimeId;
    }

    const state = useChatStore.getState();
    const firstReadyRuntimeId = state.runtimes.find((descriptor) =>
        isRuntimeSetupReady(
            state.setupStatusByRuntimeId[descriptor.runtime.id],
        ),
    )?.runtime.id;

    return (
        state.selectedRuntimeId ??
        firstReadyRuntimeId ??
        state.runtimes[0]?.runtime.id ??
        null
    );
}

function getSessionRuntimeId(sessionId?: string | null) {
    if (!sessionId) {
        return null;
    }
    return useChatStore.getState().sessionsById[sessionId]?.runtimeId ?? null;
}

function getExplicitDefaultRuntimeId() {
    const state = useChatStore.getState();
    const runtimeId = state.defaultRuntimeId;
    if (!runtimeId) {
        return null;
    }
    const runtime = state.runtimes.find(
        (descriptor) => descriptor.runtime.id === runtimeId,
    );
    if (!runtime) {
        return null;
    }
    return isRuntimeSetupReady(state.setupStatusByRuntimeId[runtimeId])
        ? runtimeId
        : null;
}

function resolveWorkspaceNewChatRuntimeId(runtimeId?: string) {
    if (runtimeId) {
        return runtimeId;
    }

    const explicitDefaultRuntimeId = getExplicitDefaultRuntimeId();
    if (explicitDefaultRuntimeId) {
        return explicitDefaultRuntimeId;
    }

    const chatState = useChatStore.getState();
    const defaultRuntimeId = chatState.getDefaultNewChatRuntimeId();
    if (isClaudeTerminalRuntimeId(defaultRuntimeId)) {
        return defaultRuntimeId;
    }

    const focusedTab = selectFocusedEditorTab(useEditorStore.getState());
    const focusedChatRuntimeId =
        focusedTab && isChatTab(focusedTab)
            ? getSessionRuntimeId(focusedTab.sessionId)
            : null;
    if (focusedChatRuntimeId) {
        return focusedChatRuntimeId;
    }

    return (
        getSessionRuntimeId(chatState.lastFocusedSessionId) ??
        getSessionRuntimeId(chatState.activeSessionId) ??
        undefined
    );
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
    // A claude-code-terminal agent has no ACP session — opening it as a chat
    // would resume a nonexistent backend session. Focus its terminal instead.
    const session = useChatStore.getState().sessionsById[sessionId];
    if (session && isClaudeTerminalAgentSession(session)) {
        focusClaudeTerminalAgentSession(session);
        return sessionId;
    }
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
    // Dragging a claude-code-terminal agent into the workspace focuses its
    // terminal tab rather than opening a (nonexistent) ACP chat session.
    const terminalAgentSession =
        useChatStore.getState().sessionsById[sessionId];
    if (
        terminalAgentSession &&
        isClaudeTerminalAgentSession(terminalAgentSession)
    ) {
        focusClaudeTerminalAgentSession(terminalAgentSession);
        return sessionId;
    }
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
    const resolvedRuntimeId = resolveWorkspaceNewChatRuntimeId(runtimeId);
    // The claude-terminal pseudo-runtime has no ACP backend — callers that
    // detect it should route to openClaudeCodeTerminalWithContext instead.
    if (resolvedRuntimeId === CLAUDE_TERMINAL_RUNTIME_ID) return null;
    const pendingSession = createPendingWorkspaceSession(resolvedRuntimeId);
    if (!pendingSession) {
        if (
            isClaudeTerminalRuntimeId(
                resolveStoreNewSessionRuntimeId(resolvedRuntimeId),
            )
        ) {
            return null;
        }

        const createdSessionId = await useChatStore
            .getState()
            .newSession(resolvedRuntimeId);
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
    if (isClaudeTerminalRuntimeId(options?.runtimeId)) {
        return null;
    }

    const visibleSessionId = getPreferredWorkspaceChatSessionIdForSession(
        useChatStore.getState().lastFocusedSessionId,
    );
    if (visibleSessionId) {
        if (isClaudeTerminalRuntimeId(getSessionRuntimeId(visibleSessionId))) {
            return null;
        }
        return visibleSessionId;
    }

    const activeSessionId = useChatStore.getState().activeSessionId;
    if (activeSessionId) {
        if (isClaudeTerminalRuntimeId(getSessionRuntimeId(activeSessionId))) {
            return null;
        }
        return openChatSessionInWorkspace(activeSessionId, options);
    }

    return createNewChatInWorkspace(options?.runtimeId, options);
}
