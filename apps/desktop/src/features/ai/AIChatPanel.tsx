import { useCallback, useEffect, useRef, useState } from "react";
import { open as tauriOpen } from "@tauri-apps/plugin-dialog";
import { useEditorStore, isNoteTab } from "../../app/store/editorStore";
import { useLayoutStore } from "../../app/store/layoutStore";
import { useVaultStore } from "../../app/store/vaultStore";
import {
    listenToAiMessageCompleted,
    listenToAiMessageDelta,
    listenToAiMessageStarted,
    listenToAiPlanUpdated,
    listenToAiPermissionRequest,
    listenToAiSessionCreated,
    listenToAiSessionError,
    listenToAiSessionUpdated,
    listenToAiStatusEvent,
    listenToAiThinkingCompleted,
    listenToAiThinkingDelta,
    listenToAiThinkingStarted,
    listenToAiToolActivity,
    listenToAiUserInputRequest,
    whisperCheckAudioFile,
    whisperGetStatus,
    whisperTranscribe,
} from "./api";
import { buildSelectionLabel } from "./types";
import { AIChatAgentControls } from "./components/AIChatAgentControls";
import { AIChatComposer } from "./components/AIChatComposer";
import { AIChatContextBar } from "./components/AIChatContextBar";
import { EditedFilesBufferPanel } from "./components/EditedFilesBufferPanel";
import { AIChatHeader } from "./components/AIChatHeader";
import { AIChatMessageList } from "./components/AIChatMessageList";
import { AIChatOnboardingCard } from "./components/AIChatOnboardingCard";
import { QueuedMessagesPanel } from "./components/QueuedMessagesPanel";
import { AIChatRuntimeBanner } from "./components/AIChatRuntimeBanner";
import { WhisperSetupModal } from "./components/WhisperSetupModal";
import { exportChatSessionToVaultNote } from "./chatExport";
import { useChatStore } from "./store/chatStore";
import { useChatTabsStore } from "./store/chatTabsStore";

export function AIChatPanel() {
    const [savingSetup, setSavingSetup] = useState(false);
    const [composerExpanded, setComposerExpanded] = useState(false);
    const tabDrivenSessionIdRef = useRef<string | null>(null);
    const suppressedAutoTabSessionIdRef = useRef<string | null>(null);
    // Data selectors — only subscribe to data that drives renders
    const runtimeConnection = useChatStore((s) => s.runtimeConnection);
    const setupStatus = useChatStore((s) => s.setupStatus);
    const runtimes = useChatStore((s) => s.runtimes);
    const activeSessionId = useChatStore((s) => s.activeSessionId);
    const sessionsById = useChatStore((s) => s.sessionsById);
    const sessionOrder = useChatStore((s) => s.sessionOrder);
    const composerPartsBySessionId = useChatStore(
        (s) => s.composerPartsBySessionId,
    );
    const queuedMessagesBySessionId = useChatStore(
        (s) => s.queuedMessagesBySessionId,
    );
    const queuedMessageEditBySessionId = useChatStore(
        (s) => s.queuedMessageEditBySessionId,
    );
    const rightPanelExpanded = useLayoutStore((s) => s.rightPanelExpanded);
    const toggleRightPanelExpanded = useLayoutStore(
        (s) => s.toggleRightPanelExpanded,
    );

    // Actions — access via getState() to avoid 30+ unnecessary subscriptions
    const chatActions = useRef(useChatStore.getState()).current;

    const [whisperSetupOpen, setWhisperSetupOpen] = useState(false);
    const pendingAudioPathRef = useRef<string | null>(null);
    // Tracks which attachment IDs have been removed so in-flight transcriptions
    // can check and bail out early.
    const cancelledAttachmentsRef = useRef<Set<string>>(new Set());
    // Simple transcription queue: only one transcription at a time.
    const transcriptionQueueRef = useRef<
        Array<{ filePath: string; attachmentId: string }>
    >([]);
    const isTranscribingRef = useRef(false);

    const processTranscriptionQueue = useCallback(async () => {
        if (isTranscribingRef.current) return;
        const next = transcriptionQueueRef.current.shift();
        if (!next) return;

        const { filePath, attachmentId } = next;

        // Skip if the attachment was removed while queued
        if (cancelledAttachmentsRef.current.has(attachmentId)) {
            cancelledAttachmentsRef.current.delete(attachmentId);
            void processTranscriptionQueue();
            return;
        }

        isTranscribingRef.current = true;
        chatActions.updateAttachment(attachmentId, { status: "processing" });

        try {
            const result = await whisperTranscribe(filePath);
            // Check cancellation after await
            if (cancelledAttachmentsRef.current.has(attachmentId)) {
                cancelledAttachmentsRef.current.delete(attachmentId);
            } else {
                chatActions.updateAttachment(attachmentId, {
                    status: "ready",
                    transcription: result.text,
                });
            }
        } catch (e) {
            if (!cancelledAttachmentsRef.current.has(attachmentId)) {
                chatActions.updateAttachment(attachmentId, {
                    status: "error",
                    errorMessage: String(e),
                });
            } else {
                cancelledAttachmentsRef.current.delete(attachmentId);
            }
        }

        isTranscribingRef.current = false;
        void processTranscriptionQueue();
    }, []);

    const enqueueTranscription = useCallback(
        (filePath: string, attachmentId: string) => {
            transcriptionQueueRef.current.push({ filePath, attachmentId });
            void processTranscriptionQueue();
        },
        [processTranscriptionQueue],
    );

    // Wrap removeAttachment to also cancel pending transcriptions
    const handleRemoveAttachment = useCallback((attachmentId: string) => {
        cancelledAttachmentsRef.current.add(attachmentId);
        // Remove from queue if still pending
        transcriptionQueueRef.current = transcriptionQueueRef.current.filter(
            (item) => item.attachmentId !== attachmentId,
        );
        chatActions.removeAttachment(attachmentId);
    }, []);

    const handleClearAttachments = useCallback(() => {
        // Mark all audio attachments as cancelled
        const state = useChatStore.getState();
        const session = state.activeSessionId
            ? state.sessionsById[state.activeSessionId]
            : null;
        session?.attachments
            .filter((a) => a.type === "audio" && a.status === "processing")
            .forEach((a) => cancelledAttachmentsRef.current.add(a.id));
        transcriptionQueueRef.current = [];
        chatActions.clearAttachments();
    }, []);

    const handleAttachAudio = useCallback(async () => {
        const selected = await tauriOpen({
            multiple: false,
            filters: [
                {
                    name: "Audio",
                    extensions: ["mp3", "wav", "ogg", "flac"],
                },
            ],
        });
        if (!selected) return;
        const filePath =
            typeof selected === "string"
                ? selected
                : (selected as { path: string }).path;
        const fileName = filePath.split(/[/\\]/).pop() ?? "audio";

        // Check file size (25 MB limit)
        try {
            const info = await whisperCheckAudioFile(filePath);
            if (info.tooLarge) {
                const maxMb = Math.round(info.maxSizeBytes / (1024 * 1024));
                const sizeMb = (info.sizeBytes / (1024 * 1024)).toFixed(1);
                chatActions.attachAudio(filePath, fileName);
                const state = useChatStore.getState();
                const session = state.activeSessionId
                    ? state.sessionsById[state.activeSessionId]
                    : null;
                const attachment = session?.attachments.findLast(
                    (a) => a.filePath === filePath && a.type === "audio",
                );
                if (attachment) {
                    chatActions.updateAttachment(attachment.id, {
                        status: "error",
                        errorMessage: `File is too large (${sizeMb} MB). Maximum allowed: ${maxMb} MB.`,
                    });
                }
                return;
            }
        } catch {
            // If check fails, proceed anyway — transcribe will also validate
        }

        // Check if whisper model is downloaded
        try {
            const status = await whisperGetStatus();
            if (status.downloadedModels.length === 0) {
                pendingAudioPathRef.current = filePath;
                setWhisperSetupOpen(true);
                return;
            }
        } catch {
            // If we can't check, try anyway
        }

        chatActions.attachAudio(filePath, fileName);
        const state = useChatStore.getState();
        const session = state.activeSessionId
            ? state.sessionsById[state.activeSessionId]
            : null;
        const attachment = session?.attachments.findLast(
            (a) => a.filePath === filePath && a.type === "audio",
        );
        if (attachment) {
            enqueueTranscription(filePath, attachment.id);
        }
    }, [enqueueTranscription]);

    const handleAttachFile = useCallback(async () => {
        const selected = await tauriOpen({
            multiple: false,
            filters: [
                {
                    name: "Files",
                    extensions: [
                        "txt",
                        "json",
                        "csv",
                        "pdf",
                        "xml",
                        "yaml",
                        "yml",
                        "toml",
                        "log",
                    ],
                },
            ],
        });
        if (!selected) return;
        const filePath =
            typeof selected === "string"
                ? selected
                : (selected as { path: string }).path;
        const fileName = filePath.split(/[/\\]/).pop() ?? "file";
        const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
        const mimeMap: Record<string, string> = {
            txt: "text/plain",
            json: "application/json",
            csv: "text/csv",
            pdf: "application/pdf",
            xml: "application/xml",
            yaml: "text/yaml",
            yml: "text/yaml",
            toml: "text/toml",
            log: "text/plain",
        };
        chatActions.attachFile(
            filePath,
            fileName,
            mimeMap[ext] ?? "application/octet-stream",
        );
    }, []);

    const handleWhisperReady = useCallback(() => {
        setWhisperSetupOpen(false);
        const filePath = pendingAudioPathRef.current;
        pendingAudioPathRef.current = null;
        if (!filePath) return;

        const fileName = filePath.split(/[/\\]/).pop() ?? "audio";
        chatActions.attachAudio(filePath, fileName);
        setTimeout(() => {
            const state = useChatStore.getState();
            const session = state.activeSessionId
                ? state.sessionsById[state.activeSessionId]
                : null;
            const attachment = session?.attachments.findLast(
                (a) => a.filePath === filePath && a.type === "audio",
            );
            if (attachment) {
                enqueueTranscription(filePath, attachment.id);
            }
        }, 0);
    }, [enqueueTranscription]);
    const autoContextEnabled = useChatStore(
        (state) => state.autoContextEnabled,
    );
    const toggleAutoContext = useChatStore((state) => state.toggleAutoContext);
    const requireCmdEnterToSend = useChatStore(
        (state) => state.requireCmdEnterToSend,
    );
    const composerFontSize = useChatStore((state) => state.composerFontSize);
    const composerFontFamily = useChatStore(
        (state) => state.composerFontFamily,
    );
    const chatFontSize = useChatStore((state) => state.chatFontSize);
    const chatFontFamily = useChatStore((state) => state.chatFontFamily);
    const tabs = useChatTabsStore((state) => state.tabs);
    const activeTabId = useChatTabsStore((state) => state.activeTabId);
    const tabsReady = useChatTabsStore((state) => state.isReady);
    const ensureSessionTab = useChatTabsStore(
        (state) => state.ensureSessionTab,
    );
    const openSessionTab = useChatTabsStore((state) => state.openSessionTab);
    const setActiveTab = useChatTabsStore((state) => state.setActiveTab);
    const closeTab = useChatTabsStore((state) => state.closeTab);
    const resetTabs = useChatTabsStore((state) => state.reset);

    const notes = useVaultStore((state) => state.notes);
    const createNote = useVaultStore((state) => state.createNote);
    const openNote = useEditorStore((state) => state.openNote);
    const activeEditorNoteId = useEditorStore((state) => {
        const tab = state.tabs.find(
            (candidate) => candidate.id === state.activeTabId,
        );
        return tab && isNoteTab(tab) ? tab.noteId : null;
    });
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
    const queuedMessages = composerSessionId
        ? (queuedMessagesBySessionId[composerSessionId] ?? [])
        : [];
    const queuedMessageEdit = composerSessionId
        ? (queuedMessageEditBySessionId[composerSessionId] ?? null)
        : null;

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
                        label: buildSelectionLabel(
                            currentSelection.text,
                            currentSelection.startLine,
                            currentSelection.endLine,
                        ),
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
                unlistenStatusEvent,
                unlistenPlanUpdated,
                unlistenPermissionRequest,
                unlistenUserInputRequest,
            ] = await Promise.all([
                listenToAiSessionCreated((session) => {
                    if (!disposed) chatActions.upsertSession(session);
                }),
                listenToAiSessionUpdated((session) => {
                    if (!disposed) chatActions.upsertSession(session);
                }),
                listenToAiSessionError((payload) => {
                    if (!disposed) chatActions.applySessionError(payload);
                }),
                listenToAiMessageStarted((payload) => {
                    if (!disposed) chatActions.applyMessageStarted(payload);
                }),
                listenToAiMessageDelta((payload) => {
                    if (!disposed) chatActions.applyMessageDelta(payload);
                }),
                listenToAiMessageCompleted((payload) => {
                    if (!disposed) chatActions.applyMessageCompleted(payload);
                }),
                listenToAiThinkingStarted((payload) => {
                    if (!disposed) chatActions.applyThinkingStarted(payload);
                }),
                listenToAiThinkingDelta((payload) => {
                    if (!disposed) chatActions.applyThinkingDelta(payload);
                }),
                listenToAiThinkingCompleted((payload) => {
                    if (!disposed) chatActions.applyThinkingCompleted(payload);
                }),
                listenToAiToolActivity((payload) => {
                    if (!disposed) chatActions.applyToolActivity(payload);
                }),
                listenToAiStatusEvent((payload) => {
                    if (!disposed) chatActions.applyStatusEvent(payload);
                }),
                listenToAiPlanUpdated((payload) => {
                    if (!disposed) chatActions.applyPlanUpdate(payload);
                }),
                listenToAiPermissionRequest((payload) => {
                    if (!disposed) chatActions.applyPermissionRequest(payload);
                }),
                listenToAiUserInputRequest((payload) => {
                    if (!disposed) chatActions.applyUserInputRequest(payload);
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
                unlistenStatusEvent,
                unlistenPlanUpdated,
                unlistenPermissionRequest,
                unlistenUserInputRequest,
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
    }, []);

    useEffect(() => {
        if (!tabsReady) return;
        if (!activeSessionId) return;
        if (activeTabSessionId && !sessionsById[activeTabSessionId]) return;

        if (
            suppressedAutoTabSessionIdRef.current &&
            suppressedAutoTabSessionIdRef.current !== activeSessionId
        ) {
            suppressedAutoTabSessionIdRef.current = null;
        }

        if (
            suppressedAutoTabSessionIdRef.current === activeSessionId &&
            (tabs.length === 0 || activeTabSessionId !== activeSessionId)
        ) {
            return;
        }

        if (
            suppressedAutoTabSessionIdRef.current === activeSessionId &&
            activeTabSessionId === activeSessionId
        ) {
            suppressedAutoTabSessionIdRef.current = null;
        }

        if (tabDrivenSessionIdRef.current === activeSessionId) {
            tabDrivenSessionIdRef.current = null;
            return;
        }

        const activeSessionHasTab = tabs.some(
            (tab) => tab.sessionId === activeSessionId,
        );
        if (!activeSessionHasTab || !activeTabId) {
            const tabId = ensureSessionTab(
                activeSessionId,
                sessionsById[activeSessionId]?.historySessionId ?? null,
            );
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
        chatActions.setActiveSession(activeTabSessionId);
    }, [activeSessionId, activeTabSessionId, sessionsById]);

    useEffect(() => {
        if (!tabsReady || !activeTabSessionId) {
            return;
        }

        const session = sessionsById[activeTabSessionId];
        if (!session?.isPersistedSession || session.isResumingSession) {
            return;
        }

        void chatActions.resumeSession(activeTabSessionId);
    }, [activeTabSessionId, sessionsById, tabsReady]);

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
                    void chatActions.newSession(runtimeId);
                }}
                onSelectSession={(sessionId) => {
                    openSessionTab(sessionId, {
                        activate: true,
                        historySessionId:
                            sessionsById[sessionId]?.historySessionId ?? null,
                    });
                    void chatActions.loadSession(sessionId);
                }}
                onSelectTab={(tabId) => {
                    setActiveTab(tabId);
                }}
                onCloseTab={(tabId) => {
                    const closingTab =
                        tabs.find((tab) => tab.id === tabId) ?? null;
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
                        runtimes: runtimes.map(
                            (descriptor) => descriptor.runtime,
                        ),
                        notes,
                        createNote,
                        openNote,
                    }).catch((error) => {
                        console.error("Failed to export chat session:", error);
                    });
                }}
                onDeleteSession={(sessionId) => {
                    void chatActions.deleteSession(sessionId);
                }}
                onDeleteAllSessions={() => {
                    resetTabs();
                    void chatActions.deleteAllSessions();
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
                                void chatActions
                                    .startAuth(input)
                                    .finally(() => {
                                        setSavingSetup(false);
                                    });
                            }}
                        />
                    </div>
                ) : (
                    <AIChatMessageList
                        messages={currentSession?.messages ?? []}
                        status={currentSession?.status ?? "idle"}
                        visibleWorkCycleId={
                            currentSession?.visibleWorkCycleId ?? null
                        }
                        chatFontSize={chatFontSize}
                        chatFontFamily={chatFontFamily}
                        onPermissionResponse={(requestId, optionId) => {
                            void chatActions.respondPermission(
                                requestId,
                                optionId,
                            );
                        }}
                        onUserInputResponse={(requestId, answers) => {
                            void chatActions.respondUserInput(
                                requestId,
                                answers,
                            );
                        }}
                    />
                ))}
            <EditedFilesBufferPanel />
            <div
                className={
                    composerExpanded
                        ? "flex min-h-0 flex-1 flex-col px-1.5 pb-1.5 pt-1.5"
                        : "px-3 pb-3 pt-2"
                }
            >
                <QueuedMessagesPanel
                    items={queuedMessages}
                    editingItem={queuedMessageEdit?.item ?? null}
                    onCancel={(messageId) => {
                        if (!composerSessionId) return;
                        chatActions.removeQueuedMessage(
                            composerSessionId,
                            messageId,
                        );
                    }}
                    onClearAll={() => {
                        if (!composerSessionId) return;
                        chatActions.clearSessionQueue(composerSessionId);
                    }}
                    onEdit={(messageId) => {
                        if (!composerSessionId) return;
                        chatActions.editQueuedMessage(
                            composerSessionId,
                            messageId,
                        );
                    }}
                    onSendNow={(messageId) => {
                        if (!composerSessionId) return;
                        void chatActions.sendQueuedMessageNow(
                            composerSessionId,
                            messageId,
                        );
                    }}
                    onCancelEdit={() => {
                        if (!composerSessionId) return;
                        chatActions.cancelQueuedMessageEdit(composerSessionId);
                    }}
                />
                <AIChatComposer
                    parts={composerParts}
                    notes={noteOptions}
                    status={currentSession?.status ?? "idle"}
                    runtimeName={runtimeLabel}
                    autoContextEnabled={autoContextEnabled}
                    hasActiveNote={activeNote !== null}
                    requireCmdEnterToSend={requireCmdEnterToSend}
                    composerFontSize={composerFontSize}
                    composerFontFamily={composerFontFamily}
                    onToggleAutoContext={toggleAutoContext}
                    expanded={composerExpanded}
                    onToggleExpanded={() => setComposerExpanded((v) => !v)}
                    disabled={
                        !currentSession ||
                        runtimeConnection.status === "loading" ||
                        Boolean(currentSession?.isResumingSession) ||
                        Boolean(setupStatus?.onboardingRequired)
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
                                        noteId: attachment.noteId,
                                        label: attachment.label,
                                        path: attachment.path,
                                        removable: true,
                                        type: attachment.type,
                                        status: attachment.status,
                                        errorMessage: attachment.errorMessage,
                                    })),
                                ...autoContextAttachments,
                            ]}
                            onRemoveAttachment={handleRemoveAttachment}
                            onClearAll={handleClearAttachments}
                        />
                    }
                    footer={
                        <AIChatAgentControls
                            disabled={
                                !currentSession ||
                                currentSession?.status === "streaming" ||
                                Boolean(currentSession?.isResumingSession) ||
                                currentSession?.status ===
                                    "waiting_permission" ||
                                currentSession?.status === "waiting_user_input"
                            }
                            modelId={currentSession?.modelId ?? ""}
                            modeId={currentSession?.modeId ?? ""}
                            effortsByModel={
                                currentSession?.effortsByModel ?? {}
                            }
                            models={runtimeModels}
                            modes={runtimeModes}
                            configOptions={currentSession?.configOptions ?? []}
                            onModelChange={chatActions.setModel}
                            onModeChange={chatActions.setMode}
                            onConfigOptionChange={chatActions.setConfigOption}
                        />
                    }
                    onChange={chatActions.setComposerParts}
                    onAttachAudio={handleAttachAudio}
                    onAttachFile={handleAttachFile}
                    onFileAttach={chatActions.attachFile}
                    onMentionAttach={chatActions.attachNote}
                    onFolderAttach={chatActions.attachFolder}
                    onSubmit={chatActions.sendMessage}
                    onStop={chatActions.stopStreaming}
                />
            </div>
            <WhisperSetupModal
                open={whisperSetupOpen}
                onClose={() => setWhisperSetupOpen(false)}
                onReady={handleWhisperReady}
            />
        </div>
    );
}
