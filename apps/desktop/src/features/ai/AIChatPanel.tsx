import { useEffect, useState } from "react";
import { useVaultStore } from "../../app/store/vaultStore";
import {
    listenToAiMessageCompleted,
    listenToAiMessageDelta,
    listenToAiMessageStarted,
    listenToAiPermissionRequest,
    listenToAiSessionCreated,
    listenToAiSessionError,
    listenToAiSessionUpdated,
    listenToAiThinkingCompleted,
    listenToAiThinkingDelta,
    listenToAiThinkingStarted,
    listenToAiToolActivity,
} from "./api";
import { AIChatAgentControls } from "./components/AIChatAgentControls";
import { AIChatComposer } from "./components/AIChatComposer";
import { AIChatContextBar } from "./components/AIChatContextBar";
import { AIChatHeader } from "./components/AIChatHeader";
import { AIChatMessageList } from "./components/AIChatMessageList";
import { AIChatOnboardingCard } from "./components/AIChatOnboardingCard";
import { AIChatRuntimeBanner } from "./components/AIChatRuntimeBanner";
import { useChatStore } from "./store/chatStore";

export function AIChatPanel() {
    const [savingSetup, setSavingSetup] = useState(false);
    const runtimeConnection = useChatStore((state) => state.runtimeConnection);
    const setupStatus = useChatStore((state) => state.setupStatus);
    const runtimes = useChatStore((state) => state.runtimes);
    const activeSessionId = useChatStore((state) => state.activeSessionId);
    const sessionsById = useChatStore((state) => state.sessionsById);
    const sessionOrder = useChatStore((state) => state.sessionOrder);
    const composerPartsBySessionId = useChatStore(
        (state) => state.composerPartsBySessionId,
    );
    const initialize = useChatStore((state) => state.initialize);
    const startAuth = useChatStore((state) => state.startAuth);
    const upsertSession = useChatStore((state) => state.upsertSession);
    const applySessionError = useChatStore((state) => state.applySessionError);
    const applyMessageStarted = useChatStore((state) => state.applyMessageStarted);
    const applyMessageDelta = useChatStore((state) => state.applyMessageDelta);
    const applyMessageCompleted = useChatStore((state) => state.applyMessageCompleted);
    const applyThinkingStarted = useChatStore((state) => state.applyThinkingStarted);
    const applyThinkingDelta = useChatStore((state) => state.applyThinkingDelta);
    const applyThinkingCompleted = useChatStore((state) => state.applyThinkingCompleted);
    const applyToolActivity = useChatStore((state) => state.applyToolActivity);
    const applyPermissionRequest = useChatStore((state) => state.applyPermissionRequest);
    const respondPermission = useChatStore((state) => state.respondPermission);
    const loadSession = useChatStore((state) => state.loadSession);
    const setModel = useChatStore((state) => state.setModel);
    const setMode = useChatStore((state) => state.setMode);
    const setConfigOption = useChatStore((state) => state.setConfigOption);
    const setComposerParts = useChatStore((state) => state.setComposerParts);
    const sendMessage = useChatStore((state) => state.sendMessage);
    const stopStreaming = useChatStore((state) => state.stopStreaming);
    const newSession = useChatStore((state) => state.newSession);
    const attachNote = useChatStore((state) => state.attachNote);
    const attachFolder = useChatStore((state) => state.attachFolder);
    const removeAttachment = useChatStore((state) => state.removeAttachment);

    const notes = useVaultStore((state) => state.notes);
    const currentSession = activeSessionId ? sessionsById[activeSessionId] ?? null : null;
    const orderedSessions = sessionOrder
        .map((sessionId) => sessionsById[sessionId])
        .filter((session): session is NonNullable<typeof session> => Boolean(session));
    const composerParts = activeSessionId
        ? composerPartsBySessionId[activeSessionId] ?? []
        : [];

    const noteOptions = notes.map((note) => ({
        id: note.id,
        title: note.title,
        path: note.path,
    }));
    const currentRuntime = runtimes.find(
        (descriptor) => descriptor.runtime.id === currentSession?.runtimeId,
    );
    const runtimeModels = currentSession?.models ?? currentRuntime?.models ?? [];
    const runtimeModes = currentSession?.modes ?? currentRuntime?.modes ?? [];
    const runtimeLabel = currentRuntime?.runtime.name.replace(/ ACP$/, "") ?? "Assistant";

    useEffect(() => {
        void initialize();

        let disposed = false;
        let cleanupFns: Array<() => void> = [];

        const bind = async () => {
            const [
                unlistenCreated,
                unlistenUpdated,
                unlistenError,
                unlistenMessageStarted,
                unlistenMessageDelta,
                unlistenMessageCompleted,
                unlistenThinkingStarted,
                unlistenThinkingDelta,
                unlistenThinkingCompleted,
                unlistenToolActivity,
                unlistenPermissionRequest,
            ] =
                await Promise.all([
                    listenToAiSessionCreated((session) => {
                        if (!disposed) upsertSession(session);
                    }),
                    listenToAiSessionUpdated((session) => {
                        if (!disposed) upsertSession(session);
                    }),
                    listenToAiSessionError((payload) => {
                        if (!disposed) applySessionError(payload);
                    }),
                    listenToAiMessageStarted((payload) => {
                        if (!disposed) applyMessageStarted(payload);
                    }),
                    listenToAiMessageDelta((payload) => {
                        if (!disposed) applyMessageDelta(payload);
                    }),
                    listenToAiMessageCompleted((payload) => {
                        if (!disposed) applyMessageCompleted(payload);
                    }),
                    listenToAiThinkingStarted((payload) => {
                        if (!disposed) applyThinkingStarted(payload);
                    }),
                    listenToAiThinkingDelta((payload) => {
                        if (!disposed) applyThinkingDelta(payload);
                    }),
                    listenToAiThinkingCompleted((payload) => {
                        if (!disposed) applyThinkingCompleted(payload);
                    }),
                    listenToAiToolActivity((payload) => {
                        if (!disposed) applyToolActivity(payload);
                    }),
                    listenToAiPermissionRequest((payload) => {
                        if (!disposed) applyPermissionRequest(payload);
                    }),
                ]);

            cleanupFns = [
                unlistenCreated,
                unlistenUpdated,
                unlistenError,
                unlistenMessageStarted,
                unlistenMessageDelta,
                unlistenMessageCompleted,
                unlistenThinkingStarted,
                unlistenThinkingDelta,
                unlistenThinkingCompleted,
                unlistenToolActivity,
                unlistenPermissionRequest,
            ];
        };

        void bind();

        return () => {
            disposed = true;
            cleanupFns.forEach((cleanup) => {
                void cleanup();
            });
        };
    }, [
        applyMessageCompleted,
        applyMessageDelta,
        applyMessageStarted,
        applyThinkingCompleted,
        applyThinkingDelta,
        applyThinkingStarted,
        applyPermissionRequest,
        applySessionError,
        applyToolActivity,
        initialize,
        respondPermission,
        startAuth,
        upsertSession,
    ]);

    return (
        <div
            className="relative flex h-full min-h-0 flex-col"
            style={{ backgroundColor: "var(--bg-primary)" }}
        >
            <AIChatHeader
                activeSessionId={activeSessionId}
                currentSession={currentSession}
                sessions={orderedSessions}
                runtimes={runtimes.map((descriptor) => descriptor.runtime)}
                status={currentSession?.status ?? "idle"}
                onNewChat={newSession}
                onSelectSession={(sessionId) => {
                    void loadSession(sessionId);
                }}
            />
            <AIChatRuntimeBanner connection={runtimeConnection} />
            {setupStatus?.onboardingRequired ? (
                <div className="min-h-0 flex-1 overflow-y-auto" data-scrollbar-active="true">
                    <AIChatOnboardingCard
                        setupStatus={setupStatus}
                        saving={savingSetup}
                        onAuthenticate={(input) => {
                            setSavingSetup(true);
                            void startAuth(input).finally(() => {
                                setSavingSetup(false);
                            });
                        }}
                    />
                </div>
            ) : (
                <AIChatMessageList
                    messages={currentSession?.messages ?? []}
                    onPermissionResponse={(requestId, optionId) => {
                        void respondPermission(requestId, optionId);
                    }}
                />
            )}
            <div className="px-3 pb-3 pt-2">
                <AIChatComposer
                    parts={composerParts}
                    notes={noteOptions}
                    status={currentSession?.status ?? "idle"}
                    runtimeName={runtimeLabel}
                    disabled={
                        !currentSession ||
                        runtimeConnection.status === "loading" ||
                        Boolean(setupStatus?.onboardingRequired)
                    }
                    contextBar={
                        <AIChatContextBar
                            attachments={(currentSession?.attachments ?? []).filter(
                                (a) =>
                                    !composerParts.some(
                                        (p) =>
                                            (p.type === "mention" && p.noteId === a.noteId) ||
                                            (p.type === "folder_mention" && a.type === "folder" && p.folderPath === a.noteId),
                                    ),
                            )}
                            onRemoveAttachment={removeAttachment}
                        />
                    }
                    footer={
                        <AIChatAgentControls
                            disabled={!currentSession}
                            modelId={currentSession?.modelId ?? ""}
                            modeId={currentSession?.modeId ?? ""}
                            models={runtimeModels}
                            modes={runtimeModes}
                            configOptions={currentSession?.configOptions ?? []}
                            onModelChange={setModel}
                            onModeChange={setMode}
                            onConfigOptionChange={setConfigOption}
                        />
                    }
                    onChange={setComposerParts}
                    onMentionAttach={attachNote}
                    onFolderAttach={attachFolder}
                    onSubmit={sendMessage}
                    onStop={stopStreaming}
                />
            </div>
        </div>
    );
}
