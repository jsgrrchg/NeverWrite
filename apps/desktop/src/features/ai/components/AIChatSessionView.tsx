/**
 * AIChatSessionView — renders a single chat session inside an editor workspace pane.
 *
 * Unlike the window-level chat host, this component:
 * - Does NOT bind desktop runtime event listeners itself.
 * - Does NOT manage tabs or history — the workspace pane handles that.
 * - Derives its sessionId from the active ChatTab in the pane via editorStore.
 *
 * All session data is read reactively from chatStore, which is the single
 * source of truth regardless of where the UI renders.
 */
import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode,
} from "react";
import { open as runtimeOpen } from "@neverwrite/runtime";
import { useShallow } from "zustand/react/shallow";
import {
    isChatTab,
    selectEditorPaneActiveTab,
    selectEditorWorkspaceTabs,
    useEditorStore,
} from "../../../app/store/editorStore";
import { useVaultStore } from "../../../app/store/vaultStore";
import {
    isTextLikeVaultEntry,
    moveVaultEntryToTrash,
} from "../../../app/utils/vaultEntries";
import { vaultInvoke } from "../../../app/utils/vaultInvoke";
import {
    type AIComposerPart,
    type AIRuntimeConnectionState,
    type QueuedChatMessage,
} from "../types";
import {
    REMOVED_GEMINI_ACP_COMPOSER_MESSAGE,
    useChatStore,
} from "../store/chatStore";
import { AIChatMessageList } from "./AIChatMessageList";
import { AIChatComposer } from "./AIChatComposer";
import { AIChatContextBar } from "./AIChatContextBar";
import { AIChatAgentControls } from "./AIChatAgentControls";
import { AIChatContextUsageBar } from "./AIChatContextUsageBar";
import { EditedFilesBufferPanel } from "./EditedFilesBufferPanel";
import { QueuedMessagesPanel } from "./QueuedMessagesPanel";
import { AIChatRuntimeBanner } from "./AIChatRuntimeBanner";
import { matchesShortcutAction } from "../../../app/shortcuts/registry";
import { formatShortcutAction } from "../../../app/shortcuts/format";
import { getDesktopPlatform } from "../../../app/utils/platform";
import { AIDiscardedRootsBanner } from "./AIDiscardedRootsBanner";
import { useInlineRename } from "./useInlineRename";
import { AI_CHAT_CONTENT_COLUMN_STYLE } from "./chatContentLayout";
import {
    appendFileAttachmentPart,
    appendScreenshotPart,
    createEmptyComposerParts,
} from "../composerParts";
import {
    getNextScreenshotExpiryDelayMs,
    normalizeScreenshotPartTimestamps,
    pruneExpiredScreenshotParts,
} from "../screenshotRetention";
import {
    getImageAttachmentExtension,
    imageAttachmentValidationMessage,
    validateNewImageAttachment,
} from "../imageAttachments";
import {
    findSessionForHistorySelection,
    getSessionTitle,
    getSessionTitleText,
} from "../sessionPresentation";

const EMPTY_COMPOSER_PARTS: AIComposerPart[] = [];
const EMPTY_QUEUED_MESSAGES: QueuedChatMessage[] = [];
const IDLE_CONNECTION: AIRuntimeConnectionState = {
    status: "idle",
    message: null,
};

function ChatContentColumn({
    children,
}: {
    children: ReactNode;
}) {
    return (
        <div
            className="min-w-0"
            data-testid="chat-content-column"
            style={AI_CHAT_CONTENT_COLUMN_STYLE}
        >
            {children}
        </div>
    );
}

interface AIChatSessionViewProps {
    paneId?: string;
}

export function AIChatSessionView({ paneId }: AIChatSessionViewProps) {
    const [composerExpanded, setComposerExpanded] = useState(false);
    const [imageAttachmentNotice, setImageAttachmentNotice] = useState<
        string | null
    >(null);
    const [findOpen, setFindOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);

    // Resolve sessionId from the active ChatTab in this pane
    const sessionId = useEditorStore((state) => {
        const tab = selectEditorPaneActiveTab(state, paneId);
        return tab && isChatTab(tab) ? tab.sessionId : null;
    });

    // Actions ref — avoids subscribing to every action
    const chatActions = useRef(useChatStore.getState()).current;
    const refreshEntries = useVaultStore((state) => state.refreshEntries);

    // Session data
    const {
        session,
        parentSession,
        composerParts,
        queuedMessages,
        queuedMessageEdit,
        interruptedTurnState,
        tokenUsage,
        screenshotRetentionSeconds,
    } = useChatStore(
        useShallow((state) => {
            const s = sessionId
                ? (state.sessionsById[sessionId] ?? null)
                : null;
            const sid = s?.sessionId ?? null;
            const parent = s?.parentSessionId
                ? findSessionForHistorySelection(
                      state.sessionsById,
                      s.parentSessionId,
                  )
                : null;
            return {
                session: s,
                parentSession: parent,
                composerParts: sid
                    ? (state.composerPartsBySessionId[sid] ??
                      EMPTY_COMPOSER_PARTS)
                    : EMPTY_COMPOSER_PARTS,
                queuedMessages: sid
                    ? (state.queuedMessagesBySessionId[sid] ??
                      EMPTY_QUEUED_MESSAGES)
                    : EMPTY_QUEUED_MESSAGES,
                queuedMessageEdit: sid
                    ? (state.queuedMessageEditBySessionId[sid] ?? null)
                    : null,
                interruptedTurnState: sid
                    ? (state.interruptedTurnStateBySessionId[sid] ?? null)
                    : null,
                tokenUsage: sid
                    ? (state.tokenUsageBySessionId[sid] ?? null)
                    : null,
                screenshotRetentionSeconds: state.screenshotRetentionSeconds,
            };
        }),
    );

    // Runtime resolution
    const runtimes = useChatStore((s) => s.runtimes);
    const activeRuntimeId = session?.runtimeId ?? null;
    const activeRuntime = runtimes.find(
        (d) => d.runtime.id === activeRuntimeId,
    );
    const activeConnection = useChatStore((state) =>
        activeRuntimeId
            ? (state.runtimeConnectionByRuntimeId[activeRuntimeId] ??
              IDLE_CONNECTION)
            : IDLE_CONNECTION,
    );
    const isPendingSessionCreation = Boolean(session?.isPendingSessionCreation);
    const pendingSessionError = session?.pendingSessionError ?? null;
    const displayedConnection: AIRuntimeConnectionState =
        isPendingSessionCreation
        ? {
              status: pendingSessionError ? "error" : "loading",
              message: pendingSessionError,
          }
        : activeConnection;

    const agentCatalog = useMemo(() => {
        const models =
            session && session.models.length > 0
                ? session.models
                : (activeRuntime?.models ?? []);
        const modes =
            session && session.modes.length > 0
                ? session.modes
                : (activeRuntime?.modes ?? []);
        const configOptions =
            session && session.configOptions.length > 0
                ? session.configOptions
                : (activeRuntime?.configOptions ?? []);
        return { models, modes, configOptions };
    }, [session, activeRuntime]);

    // Settings
    const requireCmdEnterToSend = useChatStore((s) => s.requireCmdEnterToSend);
    const contextUsageBarEnabled = useChatStore(
        (s) => s.contextUsageBarEnabled,
    );
    const composerFontSize = useChatStore((s) => s.composerFontSize);
    const composerFontFamily = useChatStore((s) => s.composerFontFamily);
    const chatFontSize = useChatStore((s) => s.chatFontSize);
    const chatFontFamily = useChatStore((s) => s.chatFontFamily);
    const {
        editingKey,
        editValue,
        inputRef,
        setEditValue,
        startEditing,
        cancelEditing,
        commitEditing,
    } = useInlineRename<string>();

    // Notes/files for mentions
    const notes = useVaultStore((s) => s.notes);
    const entries = useVaultStore((s) => s.entries);
    const noteOptions = useMemo(
        () => notes.map((n) => ({ id: n.id, title: n.title, path: n.path })),
        [notes],
    );
    const fileOptions = useMemo(
        () =>
            entries
                .filter((e) => e.kind === "file" && isTextLikeVaultEntry(e))
                .map((e) => ({
                    id: e.id,
                    title: e.title,
                    path: e.path,
                    relativePath: e.relative_path,
                    fileName: e.file_name,
                    mimeType: e.mime_type,
                })),
        [entries],
    );

    const runtimeLabel =
        activeRuntime?.runtime.name.replace(/ ACP$/, "") ?? "Assistant";
    const isClosedSubagent = Boolean(session?.parentSessionId && session.closedAt);
    const isRemovedGeminiAcpSession = session?.runtimeId === "gemini-acp";
    const agentControlsDisabled =
        !session ||
        isClosedSubagent ||
        isRemovedGeminiAcpSession ||
        isPendingSessionCreation ||
        Boolean(session.isResumingSession);
    const lockIncompatibleModelSwitches =
        session?.runtimeId === "grok-acp" &&
        (session.messages.length > 0 ||
            (session.persistedMessageCount ?? 0) > 0);

    // Handlers
    const handleRemoveAttachment = useCallback(
        (attachmentId: string) => {
            if (!sessionId) return;
            chatActions.removeAttachment(attachmentId, sessionId);
        },
        [chatActions, sessionId],
    );

    const handleClearAttachments = useCallback(() => {
        if (!sessionId) return;
        chatActions.clearAttachments(sessionId);
    }, [chatActions, sessionId]);

    const handleAttachFile = useCallback(async () => {
        if (!sessionId) return;
        const selected = await runtimeOpen({
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
    }, [chatActions, sessionId]);

    const handlePasteImage = useCallback(
        async (file: File) => {
            if (!sessionId) return;
            const currentParts =
                useChatStore.getState().composerPartsBySessionId[sessionId] ??
                createEmptyComposerParts();
            const runtimeId = session?.runtimeId ?? null;
            const validation = validateNewImageAttachment(
                file,
                currentParts,
                runtimeId,
            );
            if (!validation.ok) {
                setImageAttachmentNotice(
                    imageAttachmentValidationMessage(validation.reason, runtimeId),
                );
                return;
            }
            try {
                const buffer = await file.arrayBuffer();
                const bytes = Array.from(new Uint8Array(buffer));
                const ext = getImageAttachmentExtension(file.type);
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
                const timeLabel = `Screenshot ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")} hrs`;
                const latestParts =
                    useChatStore.getState().composerPartsBySessionId[
                        sessionId
                    ] ?? createEmptyComposerParts();
                const latestValidation = validateNewImageAttachment(
                    file,
                    latestParts,
                    runtimeId,
                );
                if (!latestValidation.ok) {
                    await moveVaultEntryToTrash(saved.relative_path).catch(
                        (cleanupError) => {
                            console.error(
                                "[chat] Failed to remove rejected pasted image:",
                                cleanupError,
                            );
                        },
                    );
                    await refreshEntries();
                    setImageAttachmentNotice(
                        imageAttachmentValidationMessage(
                            latestValidation.reason,
                            runtimeId,
                        ),
                    );
                    return;
                }
                await refreshEntries();
                chatActions.setComposerParts(
                    appendScreenshotPart(latestParts, {
                        filePath: saved.path,
                        mimeType: saved.mime_type ?? file.type,
                        label: timeLabel,
                        createdAt: now.getTime(),
                    }),
                    sessionId,
                );
                setImageAttachmentNotice(null);
            } catch (error) {
                console.error("[chat] Failed to save pasted image:", error);
                setImageAttachmentNotice("Image could not be attached");
            }
        },
        [chatActions, refreshEntries, session?.runtimeId, sessionId],
    );

    useEffect(() => {
        if (!imageAttachmentNotice) return;
        const timer = window.setTimeout(() => {
            setImageAttachmentNotice(null);
        }, 3500);
        return () => window.clearTimeout(timer);
    }, [imageAttachmentNotice]);

    useEffect(() => {
        if (!sessionId || screenshotRetentionSeconds <= 0) return;

        const now = Date.now();
        const normalizedParts = normalizeScreenshotPartTimestamps(
            composerParts,
            now,
        );
        const prunedParts = pruneExpiredScreenshotParts(
            normalizedParts,
            screenshotRetentionSeconds,
            now,
        );

        if (prunedParts !== composerParts) {
            chatActions.setComposerParts(prunedParts, sessionId);
            return;
        }

        const nextDelay = getNextScreenshotExpiryDelayMs(
            composerParts,
            screenshotRetentionSeconds,
            now,
        );
        if (nextDelay == null) return;

        const timer = window.setTimeout(() => {
            const state = useChatStore.getState();
            const currentParts =
                state.composerPartsBySessionId[sessionId] ??
                createEmptyComposerParts();
            const currentRetentionSeconds = state.screenshotRetentionSeconds;
            const currentNow = Date.now();
            const normalizedCurrentParts = normalizeScreenshotPartTimestamps(
                currentParts,
                currentNow,
            );
            const nextParts = pruneExpiredScreenshotParts(
                normalizedCurrentParts,
                currentRetentionSeconds,
                currentNow,
            );

            if (nextParts !== currentParts) {
                state.setComposerParts(nextParts, sessionId);
            }
        }, nextDelay);

        return () => window.clearTimeout(timer);
    }, [
        chatActions,
        composerParts,
        screenshotRetentionSeconds,
        sessionId,
    ]);

    // Title sync: keep the editor tab title in sync with session title
    useEffect(() => {
        if (!session || !sessionId) return;
        const title = getSessionTitle(session);
        const editorState = useEditorStore.getState();
        const allTabs = selectEditorWorkspaceTabs(editorState);
        const chatTabs = allTabs.filter(
            (t) => isChatTab(t) && t.sessionId === sessionId,
        );
        for (const chatTab of chatTabs) {
            if (chatTab.title !== title) {
                editorState.updateTabTitle(chatTab.id, title);
            }
        }
    }, [session, sessionId]);

    const sessionTitle = session ? getSessionTitleText(session) : "Chat";
    // Close the finder when switching to another session.
    useEffect(() => {
        setFindOpen(false);
    }, [sessionId]);

    // Cmd/Ctrl+F opens the chat finder. The listener lives on this view's root,
    // so it only fires when focus is inside the chat (CodeMirror keeps its own
    // "find in note" binding for the editor — no global collision).
    useEffect(() => {
        const root = rootRef.current;
        if (!root) return;
        const platform = getDesktopPlatform();
        const onKeyDown = (event: KeyboardEvent) => {
            if (!matchesShortcutAction(event, "find_in_note", platform)) return;
            event.preventDefault();
            event.stopPropagation();
            setFindOpen(true);
            requestAnimationFrame(() => {
                root.querySelector<HTMLInputElement>(
                    '[role="search"] input',
                )?.focus();
            });
        };
        root.addEventListener("keydown", onKeyDown);
        return () => root.removeEventListener("keydown", onKeyDown);
    }, [sessionId]);

    const isSubagent = Boolean(session?.parentSessionId?.trim());
    const parentTitle = parentSession ? getSessionTitle(parentSession) : null;

    const startTitleEdit = useCallback(() => {
        if (!session || !sessionId || isSubagent) return;
        startEditing(sessionId, getSessionTitleText(session));
    }, [isSubagent, session, sessionId, startEditing]);

    const commitTitleEdit = useCallback(() => {
        commitEditing(chatActions.renameSession);
    }, [chatActions, commitEditing]);

    if (!sessionId) {
        return (
            <div
                className="flex h-full items-center justify-center"
                style={{ color: "var(--text-secondary)" }}
            >
                No active chat session
            </div>
        );
    }

    return (
        <div
            ref={rootRef}
            tabIndex={-1}
            className="relative flex h-full min-h-0 flex-col outline-none"
            style={{ backgroundColor: "var(--bg-secondary)" }}
        >
            {/* Compact local session header for the workspace chat tab */}
            <div
                className="flex items-center gap-2 px-3 py-1 text-xs shrink-0"
                style={{
                    height: 31,
                    boxSizing: "border-box",
                    borderBottom: "1px solid var(--border)",
                    color: "var(--text-secondary)",
                }}
            >
                {editingKey === sessionId ? (
                    <input
                        ref={inputRef}
                        className="min-w-0 flex-1 overflow-hidden whitespace-nowrap bg-transparent font-medium outline-none"
                        style={{
                            color: "var(--text-primary)",
                            border: "none",
                            padding: 0,
                            minHeight: 0,
                            boxSizing: "border-box",
                            boxShadow: "inset 0 -1px 0 var(--accent)",
                        }}
                        value={editValue}
                        onChange={(event) => setEditValue(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Enter") {
                                commitTitleEdit();
                            } else if (event.key === "Escape") {
                                event.preventDefault();
                                cancelEditing();
                            }
                        }}
                        onBlur={commitTitleEdit}
                    />
                ) : (
                    <span
                        className="min-w-0 flex-1 overflow-hidden whitespace-nowrap font-medium"
                        onDoubleClick={startTitleEdit}
                        title={
                            isSubagent
                                ? "Subagents are named by their parent run"
                                : "Double-click to rename"
                        }
                        style={{ color: "var(--text-primary)" }}
                    >
                        {sessionTitle}
                    </span>
                )}
                {isSubagent ? (
                    <span
                        className="max-w-[45%] truncate rounded px-1.5 py-0.5 text-[10px]"
                        title={
                            parentTitle
                                ? `Subagent of ${parentTitle}`
                                : "Subagent"
                        }
                        style={{
                            color: "var(--accent)",
                            background:
                                "color-mix(in srgb, var(--accent) 10%, transparent)",
                        }}
                    >
                        {parentTitle
                            ? `Subagent of ${parentTitle}`
                            : "Subagent"}
                    </span>
                ) : null}
                <button
                    type="button"
                    onClick={() => setFindOpen((value) => !value)}
                    aria-label="Find in chat"
                    aria-pressed={findOpen}
                    title={`Find in chat (${formatShortcutAction(
                        "find_in_note",
                        getDesktopPlatform(),
                    )})`}
                    className="nw-control-trigger flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md"
                    style={{
                        color: findOpen
                            ? "var(--accent)"
                            : "var(--text-secondary)",
                        border: "none",
                        backgroundColor: "transparent",
                    }}
                >
                    <svg
                        width="14"
                        height="14"
                        viewBox="0 0 14 14"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    >
                        <circle cx="6" cy="6" r="4" />
                        <path d="M9 9L12.5 12.5" />
                    </svg>
                </button>
            </div>

            <AIChatRuntimeBanner
                connection={displayedConnection}
                runtimeName={activeRuntime?.runtime.name.replace(/ ACP$/, "")}
            />

            {session && (session.discardedAdditionalRoots?.length ?? 0) > 0 ? (
                <AIDiscardedRootsBanner
                    roots={session.discardedAdditionalRoots ?? []}
                    dismissed={session.discardedRootsBannerDismissed}
                    onDismiss={() =>
                        chatActions.dismissDiscardedRootsBanner(session.sessionId)
                    }
                />
            ) : null}

            {!composerExpanded && (
                <AIChatMessageList
                    sessionId={sessionId}
                    messages={session?.messages ?? []}
                    status={session?.status ?? "idle"}
                    hasOlderMessages={
                        (session?.loadedPersistedMessageStart ?? 0) > 0
                    }
                    isLoadingOlderMessages={
                        session?.isLoadingPersistedMessages ?? false
                    }
                    visibleWorkCycleId={session?.visibleWorkCycleId ?? null}
                    findOpen={findOpen}
                    onCloseFind={() => {
                        setFindOpen(false);
                        rootRef.current?.focus();
                    }}
                    chatFontSize={chatFontSize}
                    chatFontFamily={chatFontFamily}
                    onLoadOlderMessages={() => {
                        void chatActions.loadOlderMessages(sessionId);
                    }}
                    onPermissionResponse={(requestId, optionId) => {
                        void chatActions.respondPermissionForSession(
                            sessionId,
                            requestId,
                            optionId,
                        );
                    }}
                    onUserInputResponse={(requestId, answers, action) => {
                        void chatActions.respondUserInput(
                            requestId,
                            answers,
                            sessionId,
                            action,
                        );
                    }}
                    onUrlElicitationOpen={(requestId) => {
                        void chatActions.openUrlElicitation(
                            requestId,
                            sessionId,
                        );
                    }}
                    onUrlElicitationResponse={(requestId, action) => {
                        void chatActions.respondUrlElicitation(
                            requestId,
                            action,
                            sessionId,
                        );
                    }}
                />
            )}

            <ChatContentColumn>
                <EditedFilesBufferPanel sessionId={sessionId} />
            </ChatContentColumn>

            <div
                className={
                    composerExpanded
                        ? "flex min-h-0 flex-1 flex-col pt-1.5"
                        : "pt-2"
                }
            >
                <ChatContentColumn>
                    <QueuedMessagesPanel
                        items={queuedMessages}
                        editingItem={queuedMessageEdit?.item ?? null}
                        onCancel={(messageId) => {
                            chatActions.removeQueuedMessage(
                                sessionId,
                                messageId,
                            );
                        }}
                        onClearAll={() => {
                            chatActions.clearSessionQueue(sessionId);
                        }}
                        onEdit={(messageId) => {
                            chatActions.editQueuedMessage(sessionId, messageId);
                        }}
                        onSendNow={(messageId) => {
                            void chatActions.sendQueuedMessageNow(
                                sessionId,
                                messageId,
                            );
                        }}
                        onCancelEdit={() => {
                            chatActions.cancelQueuedMessageEdit(sessionId);
                        }}
                    />
                </ChatContentColumn>
                <AIChatComposer
                    key={sessionId}
                    sessionId={sessionId}
                    parts={composerParts}
                    notes={noteOptions}
                    files={fileOptions}
                    status={session?.status ?? "idle"}
                    runtimeName={runtimeLabel}
                    runtimeId={session?.runtimeId}
                    requireCmdEnterToSend={requireCmdEnterToSend}
                    composerFontSize={composerFontSize}
                    composerFontFamily={composerFontFamily}
                    availableCommands={session?.availableCommands}
                    isStopping={Boolean(interruptedTurnState?.isStopping)}
                    hasPendingSubmitAfterStop={Boolean(
                        interruptedTurnState?.pendingManualSend,
                    )}
                    expanded={composerExpanded}
                    onToggleExpanded={() => setComposerExpanded((v) => !v)}
                    disabled={
                        !session ||
                        isClosedSubagent ||
                        isRemovedGeminiAcpSession ||
                        isPendingSessionCreation ||
                        activeConnection.status === "loading" ||
                        Boolean(session.isResumingSession)
                    }
                    placeholderText={
                        isClosedSubagent
                            ? "This subagent was closed by its parent thread."
                            : isRemovedGeminiAcpSession
                              ? REMOVED_GEMINI_ACP_COMPOSER_MESSAGE
                            : isPendingSessionCreation
                              ? pendingSessionError
                                  ? "Agent unavailable"
                                  : "Loading agent"
                              : undefined
                    }
                    contextBar={
                        <AIChatContextBar
                            attachments={[
                                ...(session?.attachments ?? [])
                                    .filter(
                                        (a) =>
                                            !composerParts.some(
                                                (p) =>
                                                    (p.type === "mention" &&
                                                        p.noteId ===
                                                            a.noteId) ||
                                                    (p.type ===
                                                        "file_mention" &&
                                                        a.type === "file" &&
                                                        a.path === p.path) ||
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
                            ]}
                            onRemoveAttachment={handleRemoveAttachment}
                            onClearAll={handleClearAttachments}
                        />
                    }
                    bottomAccent={
                        contextUsageBarEnabled ? (
                            <AIChatContextUsageBar
                                usage={tokenUsage}
                                cornerRadius={composerExpanded ? 9 : 11}
                            />
                        ) : null
                    }
                    footer={
                        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                            {imageAttachmentNotice ? (
                                <div
                                    role="status"
                                    aria-live="polite"
                                    className="rounded-md px-2 py-1 text-xs font-medium"
                                    style={{
                                        color: "#f87171",
                                        backgroundColor:
                                            "color-mix(in srgb, #ef4444 8%, transparent)",
                                        border: "1px solid color-mix(in srgb, #ef4444 24%, var(--border))",
                                    }}
                                >
                                    {imageAttachmentNotice}
                                </div>
                            ) : null}
                            {!isPendingSessionCreation && (
                                <AIChatAgentControls
                                    disabled={agentControlsDisabled}
                                    runtimeId={session?.runtimeId}
                                    lockIncompatibleModelSwitches={
                                        lockIncompatibleModelSwitches
                                    }
                                    modelId={session?.modelId ?? ""}
                                    modeId={session?.modeId ?? ""}
                                    effortsByModel={
                                        session?.effortsByModel ?? {}
                                    }
                                    models={agentCatalog.models}
                                    modes={agentCatalog.modes}
                                    configOptions={agentCatalog.configOptions}
                                    onModelChange={(modelId) => {
                                        void chatActions.setModel(
                                            modelId,
                                            sessionId,
                                        );
                                    }}
                                    onModeChange={(modeId) => {
                                        void chatActions.setMode(
                                            modeId,
                                            sessionId,
                                        );
                                    }}
                                    onConfigOptionChange={(optionId, value) => {
                                        void chatActions.setConfigOption(
                                            optionId,
                                            value,
                                            sessionId,
                                        );
                                    }}
                                />
                            )}
                        </div>
                    }
                    onChange={(parts) => {
                        chatActions.setComposerParts(parts, sessionId);
                    }}
                    onAttachFile={handleAttachFile}
                    onPasteImage={handlePasteImage}
                    onImageAttachmentValidationFailure={(reason) => {
                        const runtimeId = session?.runtimeId ?? null;
                        setImageAttachmentNotice(
                            imageAttachmentValidationMessage(reason, runtimeId),
                        );
                    }}
                    onFocus={() => {
                        if (!sessionId) return;
                        chatActions.markSessionFocused(sessionId);
                    }}
                    onMentionAttach={(note) => {
                        chatActions.attachNote(note, sessionId);
                    }}
                    onFileMentionAttach={(file) => {
                        chatActions.attachVaultFile(file, sessionId);
                    }}
                    onFolderAttach={(folderPath, name) => {
                        chatActions.attachFolder(folderPath, name, sessionId);
                    }}
                    onSubmit={() => {
                        setComposerExpanded(false);
                        void chatActions.sendMessage(sessionId);
                    }}
                    onStop={() => {
                        void chatActions.stopStreaming(sessionId);
                    }}
                />
            </div>
        </div>
    );
}
