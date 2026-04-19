import { useEditorStore } from "../../app/store/editorStore";
import { getSessionTitle } from "./sessionPresentation";
import { useChatStore } from "./store/chatStore";
import { useChatTabsStore } from "./store/chatTabsStore";
import { getPreferredWorkspaceChatSessionIdForSession } from "./chatWorkspaceSelectors";
import type { AIChatSession, AIRuntimeDescriptor } from "./types";

interface OpenChatInWorkspaceOptions {
    paneId?: string;
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
        historySessionId: session?.historySessionId ?? null,
    });
    if (!options?.background) {
        useChatStore.getState().markSessionFocused(sessionId);
    }

    if (!options?.skipLoad) {
        void useChatStore.getState().loadSession(sessionId);
    }
    return sessionId;
}

export function openChatHistoryInWorkspace() {
    useEditorStore.getState().openChatHistory();
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
