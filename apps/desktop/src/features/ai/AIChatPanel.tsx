import { useCallback, useEffect, useRef, useState } from "react";
import { open as tauriOpen } from "@tauri-apps/plugin-dialog";
import { useEditorStore, isNoteTab } from "../../app/store/editorStore";
import { vaultInvoke } from "../../app/utils/vaultInvoke";
import { useLayoutStore } from "../../app/store/layoutStore";
import { useVaultStore } from "../../app/store/vaultStore";
import {
    listenToAiAvailableCommandsUpdated,
    listenToAiMessageCompleted,
    listenToAiMessageDelta,
    listenToAiMessageStarted,
    listenToAiPlanUpdated,
    listenToAiPermissionRequest,
    listenToAiRuntimeConnection,
    listenToAiSessionCreated,
    listenToAiSessionError,
    listenToAiSessionUpdated,
    listenToAiStatusEvent,
    listenToAiThinkingCompleted,
    listenToAiThinkingDelta,
    listenToAiThinkingStarted,
    listenToAiToolActivity,
    listenToAiUserInputRequest,
} from "./api";
import { buildSelectionLabel, type AIRuntimeConnectionState } from "./types";
import { AIChatAgentControls } from "./components/AIChatAgentControls";
import { AIChatComposer } from "./components/AIChatComposer";
import { AIChatContextBar } from "./components/AIChatContextBar";
import { EditedFilesBufferPanel } from "./components/EditedFilesBufferPanel";
import { AIChatHeader } from "./components/AIChatHeader";
import { AIChatMessageList } from "./components/AIChatMessageList";
import { AIAuthTerminalModal } from "./components/AIAuthTerminalModal";
import { AIChatOnboardingCard } from "./components/AIChatOnboardingCard";
import { QueuedMessagesPanel } from "./components/QueuedMessagesPanel";
import { AIChatRuntimeBanner } from "./components/AIChatRuntimeBanner";
import {
    appendFileAttachmentPart,
    appendScreenshotPart,
    createEmptyComposerParts,
} from "./composerParts";
import { exportChatSessionToVaultNote } from "./chatExport";
import { useChatStore } from "./store/chatStore";
import { useChatTabsStore } from "./store/chatTabsStore";

export function AIChatPanel() {
    const [savingSetup, setSavingSetup] = useState(false);
    const [composerExpanded, setComposerExpanded] = useState(false);
    const [authTerminalRequest, setAuthTerminalRequest] = useState<{
        runtimeId: string;
        runtimeName: string;
        customBinaryPath?: string;
    } | null>(null);
    const tabDrivenSessionIdRef = useRef<string | null>(null);
    const suppressedAutoTabSessionIdRef = useRef<string | null>(null);
    // Data selectors — only subscribe to data that drives renders
    const runtimeConnectionByRuntimeId = useChatStore(
        (s) => s.runtimeConnectionByRuntimeId,
    );
    const setupStatusByRuntimeId = useChatStore(
        (s) => s.setupStatusByRuntimeId,
    );
    const runtimes = useChatStore((s) => s.runtimes);
    const activeSessionId = useChatStore((s) => s.activeSessionId);
    const selectedRuntimeId = useChatStore((s) => s.selectedRuntimeId);
    const isInitializing = useChatStore((s) => s.isInitializing);
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
    const refreshEntries = useVaultStore((state) => state.refreshEntries);
    const vaultPath = useVaultStore((state) => state.vaultPath);

    const handleRemoveAttachment = useCallback(
        (sessionId: string, attachmentId: string) => {
            chatActions.removeAttachmentFromSession(sessionId, attachmentId);
        },
        [chatActions],
    );

    const handleClearAttachments = useCallback(
        (sessionId: string) => {
            chatActions.clearAttachmentsForSession(sessionId);
        },
        [chatActions],
    );

    const handleAttachFile = useCallback(
        async (sessionId: string) => {
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
            const currentParts =
                useChatStore.getState().composerPartsBySessionId[sessionId] ??
                createEmptyComposerParts();
            chatActions.setComposerPartsForSession(
                sessionId,
                appendFileAttachmentPart(currentParts, {
                    filePath,
                    mimeType: mimeMap[ext] ?? "application/octet-stream",
                    label: fileName,
                }),
            );
        },
        [chatActions],
    );

    const handlePasteImage = useCallback(
        async (sessionId: string, file: File) => {
            const MAX_SIZE = 25 * 1024 * 1024; // 25 MB
            if (file.size > MAX_SIZE) {
                console.warn("[chat] Pasted image too large:", file.size);
                return;
            }
            try {
                const buffer = await file.arrayBuffer();
                const bytes = Array.from(new Uint8Array(buffer));
                const ext =
                    file.type === "image/jpeg"
                        ? "jpg"
                        : file.type === "image/gif"
                          ? "gif"
                          : file.type === "image/webp"
                            ? "webp"
                            : "png";
                const now = new Date();
                const ts = [
                    now.getFullYear(),
                    String(now.getMonth() + 1).padStart(2, "0"),
                    String(now.getDate()).padStart(2, "0"),
                    "-",
                    String(now.getHours()).padStart(2, "0"),
                    String(now.getMinutes()).padStart(2, "0"),
                    String(now.getSeconds()).padStart(2, "0"),
                ].join("");
                const fileName = `pasted-image-${ts}.${ext}`;

                const saved = await vaultInvoke<{
                    path: string;
                    relative_path: string;
                    file_name: string;
                    mime_type: string | null;
                }>("save_vault_binary_file", {
                    relativeDir: "assets/chat",
                    fileName,
                    bytes,
                });
                await refreshEntries();

                const timeLabel = `Screenshot ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")} hrs`;
                const currentParts =
                    useChatStore.getState().composerPartsBySessionId[
                        sessionId
                    ] ?? createEmptyComposerParts();
                chatActions.setComposerPartsForSession(
                    sessionId,
                    appendScreenshotPart(currentParts, {
                        filePath: saved.path,
                        mimeType: saved.mime_type ?? file.type,
                        label: timeLabel,
                    }),
                );
            } catch (error) {
                console.error("[chat] Failed to save pasted image:", error);
            }
        },
        [chatActions, refreshEntries],
    );

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
    const selectedSetupStatus = selectedRuntimeId
        ? (setupStatusByRuntimeId[selectedRuntimeId] ?? null)
        : null;
    const selectedConnection: AIRuntimeConnectionState = selectedRuntimeId
        ? (runtimeConnectionByRuntimeId[selectedRuntimeId] ?? {
              status: "idle",
              message: null,
          })
        : { status: "idle", message: null };
    const shouldFocusSelectedRuntime =
        Boolean(selectedRuntimeId) &&
        selectedRuntimeId !== currentSession?.runtimeId &&
        (!currentSession ||
            Boolean(selectedSetupStatus?.onboardingRequired) ||
            selectedConnection.status !== "idle" ||
            authTerminalRequest?.runtimeId === selectedRuntimeId);
    const activeRuntimeId = shouldFocusSelectedRuntime
        ? selectedRuntimeId
        : (currentSession?.runtimeId ??
          selectedRuntimeId ??
          runtimes[0]?.runtime.id ??
          null);
    const activeRuntime = runtimes.find(
        (descriptor) => descriptor.runtime.id === activeRuntimeId,
    );
    const activeSetupStatus = activeRuntimeId
        ? (setupStatusByRuntimeId[activeRuntimeId] ?? null)
        : null;
    const activeConnection: AIRuntimeConnectionState = activeRuntimeId
        ? (runtimeConnectionByRuntimeId[activeRuntimeId] ?? {
              status: "idle",
              message: null,
          })
        : { status: "idle", message: null };
    const runtimeModels = currentSession?.models ?? activeRuntime?.models ?? [];
    const runtimeModes = currentSession?.modes ?? activeRuntime?.modes ?? [];
    const composerRuntimeLabel =
        (currentSession
            ? runtimes.find(
                  (descriptor) =>
                      descriptor.runtime.id === currentSession.runtimeId,
              )?.runtime.name
            : activeRuntime?.runtime.name
        )?.replace(/ ACP$/, "") ?? "Assistant";
    const handleRefreshSetup = useCallback(
        async (runtimeId: string) => {
            await chatActions.refreshSetupStatus(runtimeId);
        },
        [chatActions],
    );

    useEffect(() => {
        if (!authTerminalRequest) return;
        if (activeSetupStatus?.runtimeId !== authTerminalRequest.runtimeId)
            return;
        if (activeSetupStatus.onboardingRequired) return;
        setAuthTerminalRequest(null);
    }, [activeSetupStatus, authTerminalRequest]);

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
                unlistenAvailableCommandsUpdated,
                unlistenPermissionRequest,
                unlistenUserInputRequest,
                unlistenRuntimeConnection,
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
                listenToAiAvailableCommandsUpdated((payload) => {
                    if (!disposed)
                        chatActions.applyAvailableCommandsUpdate(payload);
                }),
                listenToAiPermissionRequest((payload) => {
                    if (!disposed) chatActions.applyPermissionRequest(payload);
                }),
                listenToAiUserInputRequest((payload) => {
                    if (!disposed) chatActions.applyUserInputRequest(payload);
                }),
                listenToAiRuntimeConnection((payload) => {
                    if (!disposed) chatActions.applyRuntimeConnection(payload);
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
                unlistenAvailableCommandsUpdated,
                unlistenPermissionRequest,
                unlistenUserInputRequest,
                unlistenRuntimeConnection,
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
    }, [chatActions]);

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
                sessionsById[activeSessionId]?.runtimeId ?? null,
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
        if (shouldFocusSelectedRuntime) {
            return;
        }
        if (!activeTabSessionId || activeTabSessionId === activeSessionId) {
            return;
        }

        if (!sessionsById[activeTabSessionId]) return;
        tabDrivenSessionIdRef.current = activeTabSessionId;
        chatActions.setActiveSession(activeTabSessionId);
    }, [
        activeSessionId,
        activeTabSessionId,
        chatActions,
        sessionsById,
        shouldFocusSelectedRuntime,
    ]);

    useEffect(() => {
        if (shouldFocusSelectedRuntime) {
            return;
        }
        if (!tabsReady || !activeTabSessionId) {
            return;
        }

        const session = sessionsById[activeTabSessionId];
        if (session?.runtimeState === "live" || session?.isResumingSession) {
            return;
        }

        void chatActions.resumeSession(activeTabSessionId);
    }, [
        activeTabSessionId,
        chatActions,
        sessionsById,
        shouldFocusSelectedRuntime,
        tabsReady,
    ]);

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
                        runtimeId: sessionsById[sessionId]?.runtimeId ?? null,
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
            <AIChatRuntimeBanner
                connection={activeConnection}
                runtimeName={activeRuntime?.runtime.name.replace(/ ACP$/, "")}
            />
            {!composerExpanded &&
                (activeSetupStatus?.onboardingRequired ? (
                    <div
                        className="min-h-0 flex-1 overflow-y-auto"
                        data-scrollbar-active="true"
                    >
                        <AIChatOnboardingCard
                            runtime={activeRuntime?.runtime ?? null}
                            setupStatus={activeSetupStatus}
                            saving={savingSetup}
                            onSaveSetup={(input) => {
                                setSavingSetup(true);
                                void chatActions
                                    .saveSetup(input)
                                    .finally(() => {
                                        setSavingSetup(false);
                                    });
                            }}
                            onAuthenticate={(input) => {
                                if (
                                    input.runtimeId === "claude-acp" &&
                                    input.methodId === "claude-login"
                                ) {
                                    setAuthTerminalRequest({
                                        runtimeId: input.runtimeId,
                                        runtimeName:
                                            activeRuntime?.runtime.name.replace(
                                                / ACP$/,
                                                "",
                                            ) ?? "Claude",
                                        customBinaryPath:
                                            input.customBinaryPath,
                                    });
                                    return;
                                }
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
                            if (!composerSessionId) return;
                            void chatActions.respondPermissionForSession(
                                composerSessionId,
                                requestId,
                                optionId,
                            );
                        }}
                        onUserInputResponse={(requestId, answers) => {
                            if (!composerSessionId) return;
                            void chatActions.respondUserInputForSession(
                                composerSessionId,
                                requestId,
                                answers,
                            );
                        }}
                    />
                ))}
            <EditedFilesBufferPanel sessionId={composerSessionId} />
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
                    key={composerSessionId ?? "no-session"}
                    parts={composerParts}
                    notes={noteOptions}
                    status={currentSession?.status ?? "idle"}
                    runtimeName={composerRuntimeLabel}
                    runtimeId={currentSession?.runtimeId}
                    autoContextEnabled={autoContextEnabled}
                    hasActiveNote={activeNote !== null}
                    requireCmdEnterToSend={requireCmdEnterToSend}
                    composerFontSize={composerFontSize}
                    composerFontFamily={composerFontFamily}
                    availableCommands={currentSession?.availableCommands}
                    onToggleAutoContext={toggleAutoContext}
                    expanded={composerExpanded}
                    onToggleExpanded={() => setComposerExpanded((v) => !v)}
                    disabled={
                        !currentSession ||
                        isInitializing ||
                        activeConnection.status === "loading" ||
                        Boolean(currentSession?.isResumingSession) ||
                        Boolean(activeSetupStatus?.onboardingRequired)
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
                            onRemoveAttachment={(attachmentId) => {
                                if (!composerSessionId) return;
                                handleRemoveAttachment(
                                    composerSessionId,
                                    attachmentId,
                                );
                            }}
                            onClearAll={() => {
                                if (!composerSessionId) return;
                                handleClearAttachments(composerSessionId);
                            }}
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
                            onModelChange={(modelId) => {
                                if (!composerSessionId) return;
                                void chatActions.setModelForSession(
                                    composerSessionId,
                                    modelId,
                                );
                            }}
                            onModeChange={(modeId) => {
                                if (!composerSessionId) return;
                                void chatActions.setModeForSession(
                                    composerSessionId,
                                    modeId,
                                );
                            }}
                            onConfigOptionChange={(optionId, value) => {
                                if (!composerSessionId) return;
                                void chatActions.setConfigOptionForSession(
                                    composerSessionId,
                                    optionId,
                                    value,
                                );
                            }}
                        />
                    }
                    onChange={(parts) => {
                        if (!composerSessionId) return;
                        chatActions.setComposerPartsForSession(
                            composerSessionId,
                            parts,
                        );
                    }}
                    onAttachFile={() => {
                        if (!composerSessionId) return;
                        void handleAttachFile(composerSessionId);
                    }}
                    onPasteImage={(file) => {
                        if (!composerSessionId) return;
                        void handlePasteImage(composerSessionId, file);
                    }}
                    onMentionAttach={(note) => {
                        if (!composerSessionId) return;
                        chatActions.attachNoteToSession(
                            composerSessionId,
                            note,
                        );
                    }}
                    onFolderAttach={(folderPath, name) => {
                        if (!composerSessionId) return;
                        chatActions.attachFolderToSession(
                            composerSessionId,
                            folderPath,
                            name,
                        );
                    }}
                    onSubmit={() => {
                        if (!composerSessionId) return;
                        void chatActions.sendMessageForSession(
                            composerSessionId,
                        );
                    }}
                    onStop={() => {
                        if (!composerSessionId) return;
                        void chatActions.stopStreamingForSession(
                            composerSessionId,
                        );
                    }}
                />
            </div>
            {authTerminalRequest ? (
                <AIAuthTerminalModal
                    open
                    runtimeId={authTerminalRequest.runtimeId}
                    runtimeName={authTerminalRequest.runtimeName}
                    vaultPath={vaultPath}
                    customBinaryPath={authTerminalRequest.customBinaryPath}
                    onClose={() => setAuthTerminalRequest(null)}
                    onRefreshSetup={handleRefreshSetup}
                />
            ) : null}
        </div>
    );
}
