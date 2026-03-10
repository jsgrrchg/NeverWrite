import { useEffect, useRef, useState } from "react";
import { useEditorStore } from "../../app/store/editorStore";
import { useLayoutStore } from "../../app/store/layoutStore";
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
import { exportChatSessionToVaultNote } from "./chatExport";
import { useChatStore } from "./store/chatStore";
import { useChatTabsStore } from "./store/chatTabsStore";

export function AIChatPanel() {
    const [savingSetup, setSavingSetup] = useState(false);
    const [composerExpanded, setComposerExpanded] = useState(false);
    const tabDrivenSessionIdRef = useRef<string | null>(null);
    const suppressedAutoTabSessionIdRef = useRef<string | null>(null);
    const runtimeConnection = useChatStore((state) => state.runtimeConnection);
    const rightPanelExpanded = useLayoutStore((state) => state.rightPanelExpanded);
    const toggleRightPanelExpanded = useLayoutStore(
        (state) => state.toggleRightPanelExpanded,
    );
    const setupStatus = useChatStore((state) => state.setupStatus);
    const runtimes = useChatStore((state) => state.runtimes);
    const activeSessionId = useChatStore((state) => state.activeSessionId);
    const sessionsById = useChatStore((state) => state.sessionsById);
    const sessionOrder = useChatStore((state) => state.sessionOrder);
    const composerPartsBySessionId = useChatStore(
        (state) => state.composerPartsBySessionId,
    );
    const startAuth = useChatStore((state) => state.startAuth);
    const upsertSession = useChatStore((state) => state.upsertSession);
    const applySessionError = useChatStore((state) => state.applySessionError);
    const applyMessageStarted = useChatStore(
        (state) => state.applyMessageStarted,
    );
    const applyMessageDelta = useChatStore((state) => state.applyMessageDelta);
    const applyMessageCompleted = useChatStore(
        (state) => state.applyMessageCompleted,
    );
    const applyThinkingStarted = useChatStore(
        (state) => state.applyThinkingStarted,
    );
    const applyThinkingDelta = useChatStore(
        (state) => state.applyThinkingDelta,
    );
    const applyThinkingCompleted = useChatStore(
        (state) => state.applyThinkingCompleted,
    );
    const applyToolActivity = useChatStore((state) => state.applyToolActivity);
    const applyPermissionRequest = useChatStore(
        (state) => state.applyPermissionRequest,
    );
    const respondPermission = useChatStore((state) => state.respondPermission);
    const loadSession = useChatStore((state) => state.loadSession);
    const resumeSession = useChatStore((state) => state.resumeSession);
    const setActiveSession = useChatStore((state) => state.setActiveSession);
    const setModel = useChatStore((state) => state.setModel);
    const setMode = useChatStore((state) => state.setMode);
    const setConfigOption = useChatStore((state) => state.setConfigOption);
    const setComposerParts = useChatStore((state) => state.setComposerParts);
    const sendMessage = useChatStore((state) => state.sendMessage);
    const stopStreaming = useChatStore((state) => state.stopStreaming);
    const newSession = useChatStore((state) => state.newSession);
    const deleteSession = useChatStore((state) => state.deleteSession);
    const deleteAllSessions = useChatStore((state) => state.deleteAllSessions);
    const attachNote = useChatStore((state) => state.attachNote);
    const attachFolder = useChatStore((state) => state.attachFolder);
    const removeAttachment = useChatStore((state) => state.removeAttachment);
    const clearAttachments = useChatStore((state) => state.clearAttachments);
    const autoContextEnabled = useChatStore(
        (state) => state.autoContextEnabled,
    );
    const toggleAutoContext = useChatStore((state) => state.toggleAutoContext);
    const requireCmdEnterToSend = useChatStore(
        (state) => state.requireCmdEnterToSend,
    );
    const composerFontSize = useChatStore((state) => state.composerFontSize);
    const chatFontSize = useChatStore((state) => state.chatFontSize);
    const tabs = useChatTabsStore((state) => state.tabs);
    const activeTabId = useChatTabsStore((state) => state.activeTabId);
    const tabsReady = useChatTabsStore((state) => state.isReady);
    const ensureSessionTab = useChatTabsStore((state) => state.ensureSessionTab);
    const openSessionTab = useChatTabsStore((state) => state.openSessionTab);
    const setActiveTab = useChatTabsStore((state) => state.setActiveTab);
    const closeTab = useChatTabsStore((state) => state.closeTab);
    const resetTabs = useChatTabsStore((state) => state.reset);

    const notes = useVaultStore((state) => state.notes);
    const createNote = useVaultStore((state) => state.createNote);
    const openNote = useEditorStore((state) => state.openNote);
    const activeEditorNoteId = useEditorStore(
        (state) =>
            state.tabs.find((tab) => tab.id === state.activeTabId)?.noteId ??
            null,
    );
    const currentSelection = useEditorStore((state) => state.currentSelection);
    const activeTab = activeTabId
        ? (tabs.find((tab) => tab.id === activeTabId) ?? null)
        : null;
    const activeTabSessionId = activeTab?.sessionId ?? null;
    const currentSession = activeTabSessionId
        ? (sessionsById[activeTabSessionId] ?? null)
        : null;
    const orderedSessions = sessionOrder
        .map((sessionId) => sessionsById[sessionId])
        .filter((session): session is NonNullable<typeof session> =>
            Boolean(session),
        );
    const composerSessionId = currentSession?.sessionId ?? null;
    const composerParts = composerSessionId
        ? (composerPartsBySessionId[composerSessionId] ?? [])
        : [];

    const noteOptions = notes.map((note) => ({
        id: note.id,
        title: note.title,
        path: note.path,
    }));
    const activeNote = activeEditorNoteId
        ? (notes.find((note) => note.id === activeEditorNoteId) ?? null)
        : null;
    const autoContextAttachments = autoContextEnabled
        ? [
              activeNote &&
              !currentSession?.attachments.some(
                  (attachment) =>
                      (attachment.type === "current_note" ||
                          attachment.type === "note") &&
                      attachment.noteId === activeNote.id,
              )
                  ? {
                        id: `auto:current_note:${activeNote.id}`,
                        label: activeNote.title,
                        path: activeNote.path,
                        removable: false,
                    }
                  : null,
              activeNote &&
              currentSelection &&
              currentSelection.noteId === activeNote.id &&
              currentSelection.text.trim() &&
              !currentSession?.attachments.some(
                  (attachment) =>
                      attachment.type === "selection" &&
                      attachment.noteId === currentSelection.noteId,
              )
                  ? {
                        id: `auto:selection:${currentSelection.noteId}`,
                        label: `${activeNote.title} selection`,
                        path: activeNote.path,
                        removable: false,
                    }
                  : null,
          ].filter((attachment): attachment is NonNullable<typeof attachment> =>
              Boolean(attachment),
          )
        : [];
    const currentRuntime = runtimes.find(
        (descriptor) => descriptor.runtime.id === currentSession?.runtimeId,
    );
    const runtimeModels =
        currentSession?.models ?? currentRuntime?.models ?? [];
    const runtimeModes = currentSession?.modes ?? currentRuntime?.modes ?? [];
    const runtimeLabel =
        currentRuntime?.runtime.name.replace(/ ACP$/, "") ?? "Assistant";

    useEffect(() => {
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
            ] = await Promise.all([
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
                if (typeof cleanup === "function") {
                    void cleanup();
                }
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
        respondPermission,
        startAuth,
        upsertSession,
    ]);

    useEffect(() => {
        if (!tabsReady) return;
        if (!activeSessionId) return;
        if (activeTabSessionId && !sessionsById[activeTabSessionId]) return;

        if (
            suppressedAutoTabSessionIdRef.current === activeSessionId &&
            (tabs.length === 0 || activeTabSessionId !== activeSessionId)
        ) {
            suppressedAutoTabSessionIdRef.current = null;
            return;
        }

        if (tabDrivenSessionIdRef.current === activeSessionId) {
            tabDrivenSessionIdRef.current = null;
            return;
        }

        const activeSessionHasTab = tabs.some(
            (tab) => tab.sessionId === activeSessionId,
        );
        if (!activeSessionHasTab || !activeTabId) {
            const tabId = ensureSessionTab(activeSessionId);
            setActiveTab(tabId);
        }
    }, [
        activeSessionId,
        activeTabId,
        activeTabSessionId,
        ensureSessionTab,
        sessionsById,
        setActiveTab,
        tabs,
        tabsReady,
    ]);

    useEffect(() => {
        if (!activeTabSessionId || activeTabSessionId === activeSessionId) {
            return;
        }

        if (!sessionsById[activeTabSessionId]) return;
        tabDrivenSessionIdRef.current = activeTabSessionId;
        setActiveSession(activeTabSessionId);
    }, [
        activeSessionId,
        activeTabSessionId,
        sessionsById,
        setActiveSession,
    ]);

    useEffect(() => {
        if (!tabsReady || !activeTabSessionId) {
            return;
        }

        const session = sessionsById[activeTabSessionId];
        if (!session?.isPersistedSession || session.isResumingSession) {
            return;
        }

        void resumeSession(activeTabSessionId);
    }, [activeTabSessionId, resumeSession, sessionsById, tabsReady]);

    return (
        <div
            className="relative flex h-full min-h-0 flex-col"
            style={{ backgroundColor: "var(--bg-secondary)" }}
        >
            <AIChatHeader
                activeSessionId={currentSession?.sessionId ?? null}
                activeTabId={activeTabId}
                tabs={tabs}
                sessionsById={sessionsById}
                sessions={orderedSessions}
                runtimes={runtimes.map((descriptor) => descriptor.runtime)}
                panelExpanded={rightPanelExpanded}
                onNewChat={(runtimeId) => {
                    void newSession(runtimeId);
                }}
                onSelectSession={(sessionId) => {
                    openSessionTab(sessionId, { activate: true });
                    void loadSession(sessionId);
                }}
                onSelectTab={(tabId) => {
                    setActiveTab(tabId);
                }}
                onCloseTab={(tabId) => {
                    const closingTab = tabs.find((tab) => tab.id === tabId) ?? null;
                    if (closingTab && closingTab.id === activeTabId) {
                        suppressedAutoTabSessionIdRef.current =
                            closingTab.sessionId;
                    }

                    closeTab(tabId);
                }}
                onExportSession={(sessionId) => {
                    const session = sessionsById[sessionId];
                    if (!session) {
                        return;
                    }

                    void exportChatSessionToVaultNote({
                        session,
                        runtimes: runtimes.map((descriptor) => descriptor.runtime),
                        notes,
                        createNote,
                        openNote,
                    }).catch((error) => {
                        console.error("Failed to export chat session:", error);
                    });
                }}
                onDeleteSession={(sessionId) => {
                    void deleteSession(sessionId);
                }}
                onDeleteAllSessions={() => {
                    resetTabs();
                    void deleteAllSessions();
                }}
                onToggleExpanded={toggleRightPanelExpanded}
            />
            <AIChatRuntimeBanner connection={runtimeConnection} />
            {!composerExpanded &&
                (setupStatus?.onboardingRequired ? (
                    <div
                        className="min-h-0 flex-1 overflow-y-auto"
                        data-scrollbar-active="true"
                    >
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
                        status={currentSession?.status ?? "idle"}
                        chatFontSize={chatFontSize}
                        onPermissionResponse={(requestId, optionId) => {
                            void respondPermission(requestId, optionId);
                        }}
                    />
                ))}
            <div
                className={
                    composerExpanded
                        ? "flex min-h-0 flex-1 flex-col px-1.5 pb-1.5 pt-1.5"
                        : "px-3 pb-3 pt-2"
                }
            >
                <AIChatComposer
                    parts={composerParts}
                    notes={noteOptions}
                    status={currentSession?.status ?? "idle"}
                    runtimeName={runtimeLabel}
                    autoContextEnabled={autoContextEnabled}
                    hasActiveNote={activeNote !== null}
                    requireCmdEnterToSend={requireCmdEnterToSend}
                    composerFontSize={composerFontSize}
                    onToggleAutoContext={toggleAutoContext}
                    expanded={composerExpanded}
                    onToggleExpanded={() => setComposerExpanded((v) => !v)}
                    disabled={
                        !currentSession ||
                        runtimeConnection.status === "loading" ||
                        Boolean(currentSession?.isResumingSession) ||
                        Boolean(setupStatus?.onboardingRequired) ||
                        currentSession?.status === "waiting_permission"
                    }
                    contextBar={
                        <AIChatContextBar
                            attachments={[
                                ...(currentSession?.attachments ?? [])
                                    .filter(
                                        (a) =>
                                            !composerParts.some(
                                                (p) =>
                                                    (p.type === "mention" &&
                                                        p.noteId ===
                                                            a.noteId) ||
                                                    (p.type ===
                                                        "folder_mention" &&
                                                        a.type === "folder" &&
                                                        p.folderPath ===
                                                            a.noteId),
                                            ),
                                    )
                                    .map((attachment) => ({
                                        id: attachment.id,
                                        label: attachment.label,
                                        path: attachment.path,
                                        removable: true,
                                    })),
                                ...autoContextAttachments,
                            ]}
                            onRemoveAttachment={removeAttachment}
                            onClearAll={clearAttachments}
                        />
                    }
                    footer={
                        <AIChatAgentControls
                            disabled={
                                !currentSession ||
                                currentSession?.status === "streaming" ||
                                Boolean(currentSession?.isResumingSession) ||
                                currentSession?.status === "waiting_permission"
                            }
                            modelId={currentSession?.modelId ?? ""}
                            modeId={currentSession?.modeId ?? ""}
                            effortsByModel={
                                currentSession?.effortsByModel ?? {}
                            }
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
