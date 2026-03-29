import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type MutableRefObject,
} from "react";
import { open as tauriOpen } from "@tauri-apps/plugin-dialog";
import { useShallow } from "zustand/react/shallow";
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
import {
    type AIChatSession,
    type AIRuntimeConnectionState,
    type AIRuntimeDescriptor,
    type AIComposerPart,
    type AISecretPatch,
    type QueuedChatMessage,
} from "./types";
import { AIChatAgentControls } from "./components/AIChatAgentControls";
import { AIChatComposer } from "./components/AIChatComposer";
import { AIChatContextBar } from "./components/AIChatContextBar";
import { EditedFilesBufferPanel } from "./components/EditedFilesBufferPanel";
import { AIChatHeader } from "./components/AIChatHeader";
import { AIChatMessageList } from "./components/AIChatMessageList";
import { AIChatOnboardingCard } from "./components/AIChatOnboardingCard";
import { AIAuthTerminalModal } from "./components/AIAuthTerminalModal";
import { QueuedMessagesPanel } from "./components/QueuedMessagesPanel";
import { AIChatRuntimeBanner } from "./components/AIChatRuntimeBanner";
import {
    appendFileAttachmentPart,
    appendScreenshotPart,
    createEmptyComposerParts,
    normalizeComposerParts,
} from "./composerParts";
import { exportChatSessionToVaultNote } from "./chatExport";
import { useChatStore } from "./store/chatStore";
import { useChatTabsStore } from "./store/chatTabsStore";

const EMPTY_COMPOSER_PARTS: AIComposerPart[] = [];
const EMPTY_QUEUED_MESSAGES: QueuedChatMessage[] = [];
const IDLE_CONNECTION: AIRuntimeConnectionState = {
    status: "idle",
    message: null,
};
const UNCHANGED_SECRET_PATCH: AISecretPatch = { action: "unchanged" };

function getAgentCatalog(
    session: Pick<AIChatSession, "models" | "modes" | "configOptions"> | null,
    runtime: AIRuntimeDescriptor | undefined,
) {
    return {
        models:
            session && session.models.length > 0
                ? session.models
                : (runtime?.models ?? []),
        modes:
            session && session.modes.length > 0
                ? session.modes
                : (runtime?.modes ?? []),
        configOptions:
            session && session.configOptions.length > 0
                ? session.configOptions
                : (runtime?.configOptions ?? []),
    };
}

export function AIChatPanel() {
    const [composerExpanded, setComposerExpanded] = useState(false);
    const [authTerminalRequest, setAuthTerminalRequest] = useState<{
        runtimeId: string;
        runtimeName: string;
        customBinaryPath?: string;
    } | null>(null);
    const tabDrivenSessionIdRef = useRef<string | null>(null);
    const suppressedAutoTabSessionIdRef = useRef<string | null>(null);
    // Data selectors — only subscribe to data that drives renders
    const runtimes = useChatStore((s) => s.runtimes);
    const activeSessionId = useChatStore((s) => s.activeSessionId);
    const selectedRuntimeId = useChatStore((s) => s.selectedRuntimeId);
    const isInitializing = useChatStore((s) => s.isInitializing);

    // Actions — access via getState() to avoid 30+ unnecessary subscriptions
    const chatActions = useRef(useChatStore.getState()).current;
    const refreshEntries = useVaultStore((state) => state.refreshEntries);
    const vaultPath = useVaultStore((state) => state.vaultPath);
    const screenshotRetentionSeconds = useChatStore(
        (state) => state.screenshotRetentionSeconds,
    );
    const composerPartsBySessionId = useChatStore(
        (state) => state.composerPartsBySessionId,
    );
    const screenshotTimersRef = useRef<
        Map<string, { timeoutId: number; durationMs: number }>
    >(new Map());

    const handleRemoveAttachment = useCallback(
        (sessionId: string, attachmentId: string) => {
            chatActions.removeAttachment(attachmentId, sessionId);
        },
        [chatActions],
    );

    const handleClearAttachments = useCallback(
        (sessionId: string) => {
            chatActions.clearAttachments(sessionId);
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
            chatActions.setComposerParts(
                appendFileAttachmentPart(currentParts, {
                    filePath,
                    mimeType: mimeMap[ext] ?? "application/octet-stream",
                    label: fileName,
                }),
                sessionId,
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
                chatActions.setComposerParts(
                    appendScreenshotPart(currentParts, {
                        filePath: saved.path,
                        mimeType: saved.mime_type ?? file.type,
                        label: timeLabel,
                    }),
                    sessionId,
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
    const setActiveTab = useChatTabsStore((state) => state.setActiveTab);

    const notes = useVaultStore((state) => state.notes);
    const createNote = useVaultStore((state) => state.createNote);
    const openNote = useEditorStore((state) => state.openNote);
    const activeEditorNoteId = useEditorStore((state) => {
        const tab = state.tabs.find(
            (candidate) => candidate.id === state.activeTabId,
        );
        return tab && isNoteTab(tab) ? tab.noteId : null;
    });
    const activeTab = activeTabId
        ? (tabs.find((tab) => tab.id === activeTabId) ?? null)
        : null;
    const activeTabSessionId = activeTab?.sessionId ?? null;
    const {
        activeSession,
        currentSession,
        composerParts,
        queuedMessages,
        queuedMessageEdit,
    } = useChatStore(
        useShallow((state) => {
            const nextActiveSession = activeSessionId
                ? (state.sessionsById[activeSessionId] ?? null)
                : null;
            const nextCurrentSession = activeTabSessionId
                ? (state.sessionsById[activeTabSessionId] ?? null)
                : null;
            const sessionId = nextCurrentSession?.sessionId ?? null;
            return {
                activeSession: nextActiveSession,
                currentSession: nextCurrentSession,
                composerParts: sessionId
                    ? (state.composerPartsBySessionId[sessionId] ??
                      EMPTY_COMPOSER_PARTS)
                    : EMPTY_COMPOSER_PARTS,
                queuedMessages: sessionId
                    ? (state.queuedMessagesBySessionId[sessionId] ??
                      EMPTY_QUEUED_MESSAGES)
                    : EMPTY_QUEUED_MESSAGES,
                queuedMessageEdit: sessionId
                    ? (state.queuedMessageEditBySessionId[sessionId] ?? null)
                    : null,
            };
        }),
    );
    const composerSessionId = currentSession?.sessionId ?? null;

    useEffect(() => {
        const timers = screenshotTimersRef.current;
        const durationMs = screenshotRetentionSeconds * 1000;

        if (durationMs <= 0) {
            for (const { timeoutId } of timers.values()) {
                window.clearTimeout(timeoutId);
            }
            timers.clear();
            return;
        }

        const activeKeys = new Set<string>();

        for (const [sessionId, parts] of Object.entries(
            composerPartsBySessionId,
        )) {
            for (const part of parts) {
                if (part.type !== "screenshot") continue;

                const key = `${sessionId}:${part.id}`;
                activeKeys.add(key);

                const existing = timers.get(key);
                if (existing && existing.durationMs === durationMs) {
                    continue;
                }
                if (existing) {
                    window.clearTimeout(existing.timeoutId);
                }

                const timeoutId = window.setTimeout(() => {
                    const currentParts =
                        useChatStore.getState().composerPartsBySessionId[
                            sessionId
                        ] ?? createEmptyComposerParts();
                    const nextParts = normalizeComposerParts(
                        currentParts.filter(
                            (candidate) =>
                                candidate.type !== "screenshot" ||
                                candidate.id !== part.id,
                        ),
                    );
                    chatActions.setComposerParts(nextParts, sessionId);
                    screenshotTimersRef.current.delete(key);
                }, durationMs);

                timers.set(key, { timeoutId, durationMs });
            }
        }

        for (const [key, { timeoutId }] of timers.entries()) {
            if (activeKeys.has(key)) continue;
            window.clearTimeout(timeoutId);
            timers.delete(key);
        }
    }, [chatActions, composerPartsBySessionId, screenshotRetentionSeconds]);

    useEffect(() => {
        const timers = screenshotTimersRef.current;
        return () => {
            for (const { timeoutId } of timers.values()) {
                window.clearTimeout(timeoutId);
            }
            timers.clear();
        };
    }, []);

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
          ].filter((attachment): attachment is NonNullable<typeof attachment> =>
              Boolean(attachment),
          )
        : [];
    const selectedSetupStatus = useChatStore((state) =>
        selectedRuntimeId
            ? (state.setupStatusByRuntimeId[selectedRuntimeId] ?? null)
            : null,
    );
    const selectedConnection = useChatStore((state) =>
        selectedRuntimeId
            ? (state.runtimeConnectionByRuntimeId[selectedRuntimeId] ??
              IDLE_CONNECTION)
            : IDLE_CONNECTION,
    );
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
    const activeSetupStatus = useChatStore((state) =>
        activeRuntimeId
            ? (state.setupStatusByRuntimeId[activeRuntimeId] ?? null)
            : null,
    );
    const activeConnection = useChatStore((state) =>
        activeRuntimeId
            ? (state.runtimeConnectionByRuntimeId[activeRuntimeId] ??
              IDLE_CONNECTION)
            : IDLE_CONNECTION,
    );
    const agentCatalog = getAgentCatalog(currentSession ?? null, activeRuntime);
    const runtimeModels = agentCatalog.models;
    const runtimeModes = agentCatalog.modes;
    const runtimeConfigOptions = agentCatalog.configOptions;
    const agentControlsDisabled =
        !currentSession ||
        currentSession?.status === "streaming" ||
        Boolean(currentSession?.isResumingSession) ||
        currentSession?.status === "waiting_permission" ||
        currentSession?.status === "waiting_user_input";
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
    const handleOnboardingSaveSetup = useCallback(
        async (input: {
            runtimeId?: string;
            customBinaryPath?: string;
            codexApiKey: AISecretPatch;
            openaiApiKey: AISecretPatch;
            geminiApiKey: AISecretPatch;
            gatewayBaseUrl?: string;
            gatewayHeaders: AISecretPatch;
            anthropicBaseUrl?: string;
            anthropicCustomHeaders: AISecretPatch;
            anthropicAuthToken: AISecretPatch;
        }) => {
            await chatActions.saveSetup({
                ...input,
                googleApiKey: UNCHANGED_SECRET_PATCH,
                googleCloudProject: undefined,
                googleCloudLocation: undefined,
            });
        },
        [chatActions],
    );
    const handleOnboardingAuthenticate = useCallback(
        async (input: {
            runtimeId?: string;
            methodId: string;
            customBinaryPath?: string;
            openaiApiKey: AISecretPatch;
            codexApiKey: AISecretPatch;
            geminiApiKey: AISecretPatch;
            gatewayBaseUrl?: string;
            gatewayHeaders: AISecretPatch;
            anthropicBaseUrl?: string;
            anthropicCustomHeaders: AISecretPatch;
            anthropicAuthToken: AISecretPatch;
        }) => {
            const runtimeId = input.runtimeId ?? activeRuntimeId;
            if (!runtimeId) return;

            const runtime = runtimes.find(
                (descriptor) => descriptor.runtime.id === runtimeId,
            );
            if (
                (runtimeId === "claude-acp" &&
                    input.methodId === "claude-login") ||
                (runtimeId === "gemini-acp" &&
                    input.methodId === "login_with_google")
            ) {
                setAuthTerminalRequest({
                    runtimeId,
                    runtimeName:
                        runtime?.runtime.name.replace(/ ACP$/, "") ??
                        (runtimeId === "claude-acp" ? "Claude" : "Gemini"),
                    customBinaryPath: input.customBinaryPath,
                });
                return;
            }

            await chatActions.startAuth({
                ...input,
                runtimeId,
                googleApiKey: UNCHANGED_SECRET_PATCH,
                googleCloudProject: undefined,
                googleCloudLocation: undefined,
            });
        },
        [activeRuntimeId, chatActions, runtimes],
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
        if (activeTabSessionId && !currentSession) return;

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
                activeSession?.historySessionId ?? null,
                activeSession?.runtimeId ?? null,
            );
            setActiveTab(tabId);
        }
    }, [
        activeSessionId,
        activeSession,
        activeTabId,
        activeTabSessionId,
        currentSession,
        ensureSessionTab,
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

        if (!currentSession) return;
        tabDrivenSessionIdRef.current = activeTabSessionId;
        void chatActions.loadSession(activeTabSessionId);
    }, [
        activeSessionId,
        activeTabSessionId,
        chatActions,
        currentSession,
        shouldFocusSelectedRuntime,
    ]);

    useEffect(() => {
        if (shouldFocusSelectedRuntime) {
            return;
        }
        if (!tabsReady || !activeTabSessionId) {
            return;
        }

        if (
            currentSession?.runtimeState === "live" ||
            currentSession?.isResumingSession
        ) {
            return;
        }

        void chatActions.resumeSession(activeTabSessionId);
    }, [
        activeTabSessionId,
        chatActions,
        currentSession,
        shouldFocusSelectedRuntime,
        tabsReady,
    ]);

    return (
        <div
            className="relative flex h-full min-h-0 flex-col"
            style={{ backgroundColor: "var(--bg-secondary)" }}
        >
            <AIChatHeaderBridge
                activeTabId={activeTabId}
                tabs={tabs}
                notes={notes}
                createNote={createNote}
                openNote={openNote}
                runtimes={runtimes}
                chatActions={chatActions}
                suppressedAutoTabSessionIdRef={suppressedAutoTabSessionIdRef}
            />
            <AIChatRuntimeBanner
                connection={activeConnection}
                runtimeName={activeRuntime?.runtime.name.replace(/ ACP$/, "")}
            />
            {activeSetupStatus?.onboardingRequired ? (
                <AIChatOnboardingCard
                    runtime={activeRuntime?.runtime ?? null}
                    setupStatus={activeSetupStatus}
                    onSaveSetup={handleOnboardingSaveSetup}
                    onAuthenticate={handleOnboardingAuthenticate}
                />
            ) : null}
            {!composerExpanded && (
                <AIChatMessageList
                    sessionId={composerSessionId}
                    messages={currentSession?.messages ?? []}
                    status={currentSession?.status ?? "idle"}
                    hasOlderMessages={
                        (currentSession?.loadedPersistedMessageStart ?? 0) > 0
                    }
                    isLoadingOlderMessages={
                        currentSession?.isLoadingPersistedMessages ?? false
                    }
                    visibleWorkCycleId={
                        currentSession?.visibleWorkCycleId ?? null
                    }
                    chatFontSize={chatFontSize}
                    chatFontFamily={chatFontFamily}
                    onLoadOlderMessages={() => {
                        if (!composerSessionId) return;
                        void chatActions.loadOlderMessages(composerSessionId);
                    }}
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
                        void chatActions.respondUserInput(
                            requestId,
                            answers,
                            composerSessionId,
                        );
                    }}
                />
            )}
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
                            disabled={agentControlsDisabled}
                            modelId={currentSession?.modelId ?? ""}
                            modeId={currentSession?.modeId ?? ""}
                            effortsByModel={
                                currentSession?.effortsByModel ?? {}
                            }
                            models={runtimeModels}
                            modes={runtimeModes}
                            configOptions={runtimeConfigOptions}
                            onModelChange={(modelId) => {
                                if (!composerSessionId) return;
                                void chatActions.setModel(
                                    modelId,
                                    composerSessionId,
                                );
                            }}
                            onModeChange={(modeId) => {
                                if (!composerSessionId) return;
                                void chatActions.setMode(
                                    modeId,
                                    composerSessionId,
                                );
                            }}
                            onConfigOptionChange={(optionId, value) => {
                                if (!composerSessionId) return;
                                void chatActions.setConfigOption(
                                    optionId,
                                    value,
                                    composerSessionId,
                                );
                            }}
                        />
                    }
                    onChange={(parts) => {
                        if (!composerSessionId) return;
                        chatActions.setComposerParts(parts, composerSessionId);
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
                        chatActions.attachNote(note, composerSessionId);
                    }}
                    onFolderAttach={(folderPath, name) => {
                        if (!composerSessionId) return;
                        chatActions.attachFolder(
                            folderPath,
                            name,
                            composerSessionId,
                        );
                    }}
                    onSubmit={() => {
                        if (!composerSessionId) return;
                        void chatActions.sendMessage(composerSessionId);
                    }}
                    onStop={() => {
                        if (!composerSessionId) return;
                        void chatActions.stopStreaming(composerSessionId);
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

function AIChatHeaderBridge({
    activeTabId,
    tabs,
    notes,
    createNote,
    openNote,
    runtimes,
    chatActions,
    suppressedAutoTabSessionIdRef,
}: {
    activeTabId: string | null;
    tabs: ReturnType<typeof useChatTabsStore.getState>["tabs"];
    notes: ReturnType<typeof useVaultStore.getState>["notes"];
    createNote: ReturnType<typeof useVaultStore.getState>["createNote"];
    openNote: ReturnType<typeof useEditorStore.getState>["openNote"];
    runtimes: ReturnType<typeof useChatStore.getState>["runtimes"];
    chatActions: ReturnType<typeof useChatStore.getState>;
    suppressedAutoTabSessionIdRef: MutableRefObject<string | null>;
}) {
    const activeSessionId = useChatStore((state) => state.activeSessionId);
    const sessionsById = useChatStore((state) => state.sessionsById);
    const sessionOrder = useChatStore((state) => state.sessionOrder);
    const panelExpanded = useLayoutStore((state) => state.rightPanelExpanded);
    const toggleRightPanelExpanded = useLayoutStore(
        (state) => state.toggleRightPanelExpanded,
    );
    const openSessionTab = useChatTabsStore((state) => state.openSessionTab);
    const setActiveTab = useChatTabsStore((state) => state.setActiveTab);
    const reorderTabs = useChatTabsStore((state) => state.reorderTabs);
    const closeTab = useChatTabsStore((state) => state.closeTab);
    const resetTabs = useChatTabsStore((state) => state.reset);

    const orderedSessions = sessionOrder
        .map((sessionId) => sessionsById[sessionId])
        .filter((session): session is NonNullable<typeof session> =>
            Boolean(session),
        );
    const runtimeOptions = runtimes.map((descriptor) => descriptor.runtime);

    return (
        <AIChatHeader
            activeSessionId={activeSessionId}
            activeTabId={activeTabId}
            tabs={tabs}
            sessionsById={sessionsById}
            sessions={orderedSessions}
            runtimes={runtimeOptions}
            panelExpanded={panelExpanded}
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
            onReorderTabs={(fromIndex, toIndex) => {
                reorderTabs(fromIndex, toIndex);
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

                void (async () => {
                    const transcriptLoaded =
                        await chatActions.ensureSessionTranscriptLoaded(
                            sessionId,
                            "full",
                        );
                    if (!transcriptLoaded) {
                        throw new Error(
                            "Failed to load the full saved transcript before exporting.",
                        );
                    }

                    const hydratedSession =
                        useChatStore.getState().sessionsById[sessionId];
                    if (!hydratedSession) {
                        return;
                    }

                    await exportChatSessionToVaultNote({
                        session: hydratedSession,
                        runtimes: runtimeOptions,
                        notes,
                        createNote,
                        openNote,
                    });
                })().catch((error) => {
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
    );
}
