/**
 * AIChatSessionView — renders a single chat session inside an editor workspace pane.
 *
 * Unlike the window-level chat host, this component:
 * - Does NOT bind Tauri event listeners itself.
 * - Does NOT manage tabs or history — the workspace pane handles that.
 * - Derives its sessionId from the active ChatTab in the pane via editorStore.
 *
 * All session data is read reactively from chatStore, which is the single
 * source of truth regardless of where the UI renders.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open as tauriOpen } from "@tauri-apps/plugin-dialog";
import { useShallow } from "zustand/react/shallow";
import {
    isChatTab,
    selectEditorPaneActiveTab,
    selectEditorWorkspaceTabs,
    useEditorStore,
} from "../../../app/store/editorStore";
import { useVaultStore } from "../../../app/store/vaultStore";
import { isTextLikeVaultEntry } from "../../../app/utils/vaultEntries";
import { vaultInvoke } from "../../../app/utils/vaultInvoke";
import {
    type AIComposerPart,
    type AIRuntimeConnectionState,
    type QueuedChatMessage,
} from "../types";
import { useChatStore } from "../store/chatStore";
import { AIChatMessageList } from "./AIChatMessageList";
import { AIChatComposer } from "./AIChatComposer";
import { AIChatContextBar } from "./AIChatContextBar";
import { AIChatAgentControls } from "./AIChatAgentControls";
import { EditedFilesBufferPanel } from "./EditedFilesBufferPanel";
import { QueuedMessagesPanel } from "./QueuedMessagesPanel";
import { AIChatRuntimeBanner } from "./AIChatRuntimeBanner";
import { useInlineRename } from "./useInlineRename";
import {
    appendFileAttachmentPart,
    appendScreenshotPart,
    createEmptyComposerParts,
} from "../composerParts";
import { getSessionTitle } from "../sessionPresentation";

const EMPTY_COMPOSER_PARTS: AIComposerPart[] = [];
const EMPTY_QUEUED_MESSAGES: QueuedChatMessage[] = [];
const IDLE_CONNECTION: AIRuntimeConnectionState = {
    status: "idle",
    message: null,
};

interface AIChatSessionViewProps {
    paneId?: string;
}

export function AIChatSessionView({ paneId }: AIChatSessionViewProps) {
    const [composerExpanded, setComposerExpanded] = useState(false);

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
        composerParts,
        queuedMessages,
        queuedMessageEdit,
        interruptedTurnState,
    } = useChatStore(
        useShallow((state) => {
            const s = sessionId
                ? (state.sessionsById[sessionId] ?? null)
                : null;
            const sid = s?.sessionId ?? null;
            return {
                session: s,
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
    const agentControlsDisabled =
        !session || Boolean(session.isResumingSession);

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
    }, [chatActions, sessionId]);

    const handlePasteImage = useCallback(
        async (file: File) => {
            if (!sessionId) return;
            const MAX_SIZE = 25 * 1024 * 1024;
            if (file.size > MAX_SIZE) return;
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
        [chatActions, refreshEntries, sessionId],
    );

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

    const sessionTitle = session ? getSessionTitle(session) : "Chat";

    const startTitleEdit = useCallback(() => {
        if (!session || !sessionId) return;
        startEditing(sessionId, getSessionTitle(session));
    }, [session, sessionId, startEditing]);

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
            className="relative flex h-full min-h-0 flex-col"
            style={{ backgroundColor: "var(--bg-secondary)" }}
        >
            {/* Compact local session header for the workspace chat tab */}
            <div
                className="flex items-center gap-2 px-3 py-1.5 text-xs shrink-0"
                style={{
                    height: 39,
                    boxSizing: "border-box",
                    borderBottom: "1px solid var(--border)",
                    color: "var(--text-secondary)",
                }}
            >
                {editingKey === sessionId ? (
                    <input
                        ref={inputRef}
                        className="min-w-0 flex-1 truncate bg-transparent font-medium outline-none"
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
                                cancelEditing();
                            }
                        }}
                        onBlur={commitTitleEdit}
                    />
                ) : (
                    <span
                        className="flex-1 truncate font-medium"
                        onDoubleClick={startTitleEdit}
                        title="Double-click to rename"
                        style={{ color: "var(--text-primary)" }}
                    >
                        {sessionTitle}
                    </span>
                )}
            </div>

            <AIChatRuntimeBanner
                connection={activeConnection}
                runtimeName={activeRuntime?.runtime.name.replace(/ ACP$/, "")}
            />

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
                    onUserInputResponse={(requestId, answers) => {
                        void chatActions.respondUserInput(
                            requestId,
                            answers,
                            sessionId,
                        );
                    }}
                />
            )}

            <EditedFilesBufferPanel sessionId={sessionId} />

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
                        chatActions.removeQueuedMessage(sessionId, messageId);
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
                <AIChatComposer
                    key={sessionId}
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
                        activeConnection.status === "loading" ||
                        Boolean(session.isResumingSession)
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
                    footer={
                        <AIChatAgentControls
                            disabled={agentControlsDisabled}
                            runtimeId={session?.runtimeId}
                            modelId={session?.modelId ?? ""}
                            modeId={session?.modeId ?? ""}
                            effortsByModel={session?.effortsByModel ?? {}}
                            models={agentCatalog.models}
                            modes={agentCatalog.modes}
                            configOptions={agentCatalog.configOptions}
                            onModelChange={(modelId) => {
                                void chatActions.setModel(modelId, sessionId);
                            }}
                            onModeChange={(modeId) => {
                                void chatActions.setMode(modeId, sessionId);
                            }}
                            onConfigOptionChange={(optionId, value) => {
                                void chatActions.setConfigOption(
                                    optionId,
                                    value,
                                    sessionId,
                                );
                            }}
                        />
                    }
                    onChange={(parts) => {
                        chatActions.setComposerParts(parts, sessionId);
                    }}
                    onAttachFile={handleAttachFile}
                    onPasteImage={handlePasteImage}
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
