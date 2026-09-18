import { useLayoutStore } from "../../app/store/layoutStore";
import { isSessionArchived, useArchivedChatsStore } from "./store/archivedChatsStore";
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
    background?: boolean;
    skipLoad?: boolean;
}

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
    return state.getDefaultNewChatRuntimeId();
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
    if (!runtimeId || isClaudeTerminalRuntimeId(runtimeId)) {
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
    const view = useChatTabsStore.getState().view;
    const focusedChatRuntimeId = view.mode === "conversation" ? getSessionRuntimeId(view.sessionId) : null;
    if (
        focusedChatRuntimeId &&
        !isClaudeTerminalRuntimeId(focusedChatRuntimeId)
    ) {
        return focusedChatRuntimeId;
    }

    const lastFocusedRuntimeId = getSessionRuntimeId(
        chatState.lastFocusedSessionId,
    );
    const activeRuntimeId = getSessionRuntimeId(chatState.activeSessionId);
    return (
        (!isClaudeTerminalRuntimeId(lastFocusedRuntimeId)
            ? lastFocusedRuntimeId
            : null) ??
        (!isClaudeTerminalRuntimeId(activeRuntimeId) ? activeRuntimeId : null) ??
        defaultRuntimeId ??
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
        const state = useChatStore.getState();
        const session = state.sessionsById[sessionId];
        if (session && isSessionArchived(session, state.sessionsById, useArchivedChatsStore.getState().entries)) void state.ensureSessionTranscriptLoaded(sessionId, "full");
        else void state.loadSession(sessionId);
    }
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
    prepareChatSessionForWorkspace(sessionId);
    if (!options?.background) {
        useChatTabsStore.getState().showConversation(sessionId);
        useLayoutStore.getState().setChatPaneVisible(true);
    }
    finalizeChatSessionWorkspaceOpen(sessionId, options);
    return sessionId;
}

export function openChatHistoryInWorkspace() {
    useChatTabsStore.getState().showHistory();
    useLayoutStore.getState().setChatPaneVisible(true);
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
        const fallbackRuntimeId =
            resolveStoreNewSessionRuntimeId(resolvedRuntimeId);
        if (
            !fallbackRuntimeId ||
            isClaudeTerminalRuntimeId(fallbackRuntimeId)
        ) {
            return null;
        }

        const createdSessionId = await useChatStore
            .getState()
            .newSession(fallbackRuntimeId);
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
    const sessions = useChatStore.getState().sessionsById;
    const archived = (id: string) => sessions[id] && isSessionArchived(sessions[id], sessions, useArchivedChatsStore.getState().entries);
    if (visibleSessionId && !archived(visibleSessionId)) {
        if (isClaudeTerminalRuntimeId(getSessionRuntimeId(visibleSessionId))) {
            return null;
        }
        return visibleSessionId;
    }

    const activeSessionId = useChatStore.getState().activeSessionId;
    if (activeSessionId && !archived(activeSessionId)) {
        if (isClaudeTerminalRuntimeId(getSessionRuntimeId(activeSessionId))) {
            return null;
        }
        return openChatSessionInWorkspace(activeSessionId, options);
    }

    return createNewChatInWorkspace(options?.runtimeId, options);
}
