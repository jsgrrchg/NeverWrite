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
    useLayoutEffect,
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
    selectFocusedPaneId,
    selectPaneTab,
    useEditorStore,
} from "../../../app/store/editorStore";
import { useSettingsStore } from "../../../app/store/settingsStore";
import { useVaultStore } from "../../../app/store/vaultStore";
import { isTextLikeVaultEntry } from "../../../app/utils/vaultEntries";
import {
    vaultInvoke,
    vaultInvokeForPath,
} from "../../../app/utils/vaultInvoke";
import {
    type AcpConversationBinding,
    type AIComposerPart,
    type AIChatMessage,
    type AIRuntimeConnectionState,
    type ConversationSelection,
    type DraftAttachmentId,
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
import { formatShortcutAction } from "../../../app/shortcuts/format";
import { getDesktopPlatform } from "../../../app/utils/platform";
import { AIDiscardedRootsBanner } from "./AIDiscardedRootsBanner";
import { useInlineRename } from "./useInlineRename";
import { getAiChatContentColumnStyle } from "./chatContentLayout";
import { useChatFindShortcut } from "./find/useChatFindShortcut";
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
import {
    ChatPromptOutlineMenu,
    type ChatPromptOutlineItem,
} from "./ChatPromptOutlineMenu";
import {
    buildConversationProviderOptions,
    getConversationTurnCatalog,
    getDefaultConversationSelection,
    updateConversationSelection,
} from "../conversationPickerModel";
import { getConversationSelection } from "../conversationModel";

const EMPTY_COMPOSER_PARTS: AIComposerPart[] = [];
const EMPTY_CONVERSATION_BINDINGS: AcpConversationBinding[] = [];

function managedAttachmentIds(parts: AIComposerPart[]) {
    return new Set(
        parts.flatMap((part) =>
            part.type === "screenshot" && part.managedAttachmentId
                ? [part.managedAttachmentId]
                : [],
        ),
    );
}

function draftAttachmentIds(parts: AIComposerPart[]) {
    return new Set(
        parts.flatMap((part) =>
            part.type === "screenshot" && part.draftAttachmentId
                ? [part.draftAttachmentId]
                : [],
        ),
    );
}

function cleanupRemovedScreenshotAttachments(
    sessionId: string,
    previousParts: AIComposerPart[],
    nextParts: AIComposerPart[],
) {
    const state = useChatStore.getState();
    const retainedQueueState = [
        state.queuedMessagesBySessionId[sessionId],
        state.queuedMessageEditBySessionId[sessionId],
        state.activeQueuedMessageBySessionId[sessionId],
        state.pausedQueueBySessionId[sessionId],
        state.interruptedTurnStateBySessionId[sessionId],
    ];
    const containsId = (value: unknown, attachmentId: string): boolean => {
        if (!value || typeof value !== "object") return false;
        if (
            ("managedAttachmentId" in value &&
                value.managedAttachmentId === attachmentId) ||
            ("draftAttachmentId" in value &&
                value.draftAttachmentId === attachmentId)
        ) {
            return true;
        }
        return Object.values(value).some((child) =>
            containsId(child, attachmentId),
        );
    };
    const nextIds = managedAttachmentIds(nextParts);
    for (const attachmentId of managedAttachmentIds(previousParts)) {
        if (nextIds.has(attachmentId)) continue;
        if (retainedQueueState.some((value) => containsId(value, attachmentId))) {
            continue;
        }
        void vaultInvoke("ai_delete_managed_attachment_if_unreferenced", {
            attachmentId,
        }).catch((error) => {
            console.error("[chat] Failed to clean up managed attachment:", error);
        });
    }
    const nextDraftIds = draftAttachmentIds(nextParts);
    for (const draftAttachmentId of draftAttachmentIds(previousParts)) {
        if (nextDraftIds.has(draftAttachmentId)) continue;
        if (
            retainedQueueState.some((value) =>
                containsId(value, draftAttachmentId),
            )
        ) {
            continue;
        }
        void vaultInvoke("ai_delete_draft_attachment", {
            draftAttachmentId,
        }).catch((error) => {
            console.error("[chat] Failed to clean up draft attachment:", error);
        });
    }
}
const EMPTY_QUEUED_MESSAGES: QueuedChatMessage[] = [];
const IDLE_CONNECTION: AIRuntimeConnectionState = {
    status: "idle",
    message: null,
};
const PROMPT_OUTLINE_LABEL_MAX_LENGTH = 96;

function buildPromptOutlineLabel(message: AIChatMessage) {
    const source = (message.content || message.title || "").trim();
    const normalized = source.replace(/\s+/g, " ").trim();
    const fallback =
        (message.attachments?.length ?? 0) > 0
            ? "Prompt with attachments"
            : "Untitled prompt";
    const label = normalized || fallback;

    if (label.length <= PROMPT_OUTLINE_LABEL_MAX_LENGTH) {
        return label;
    }

    return `${label.slice(0, PROMPT_OUTLINE_LABEL_MAX_LENGTH - 1).trimEnd()}…`;
}

function ChatContentColumn({
    children,
}: {
    children: ReactNode;
}) {
    const aiChatContentWidth = useSettingsStore((s) => s.aiChatContentWidth);

    return (
        <div
            className="min-w-0"
            data-testid="chat-content-column"
            style={getAiChatContentColumnStyle(aiChatContentWidth)}
        >
            {children}
        </div>
    );
}

interface AIChatSessionViewProps {
    paneId?: string;
    tabId?: string;
}

export function AIChatSessionView({ paneId, tabId }: AIChatSessionViewProps) {
    const [composerExpanded, setComposerExpanded] = useState(false);
    const bottomDockRef = useRef<HTMLDivElement>(null);
    const [bottomDockMeasurement, setBottomDockMeasurement] = useState<{
        sessionId: string | null;
        height: number;
    }>({ sessionId: null, height: 0 });
    const [imageAttachmentNotice, setImageAttachmentNotice] = useState<
        string | null
    >(null);
    const [findOpen, setFindOpen] = useState(false);
    const [promptOutlineOpen, setPromptOutlineOpen] = useState(false);
    const [scrollToMessageId, setScrollToMessageId] = useState<string | null>(
        null,
    );
    const rootRef = useRef<HTMLDivElement>(null);
    const promptOutlineButtonRef = useRef<HTMLButtonElement>(null);

    // Resolve sessionId from this column's ChatTab (stacked) or the pane's
    // active ChatTab (normal mode, when no explicit tabId is bound).
    const sessionId = useEditorStore((state) => {
        const tab = tabId
            ? selectPaneTab(state, paneId, tabId)
            : selectEditorPaneActiveTab(state, paneId);
        return tab && isChatTab(tab) ? tab.sessionId : null;
    });
    const bottomDockHeight =
        bottomDockMeasurement.sessionId === sessionId
            ? bottomDockMeasurement.height
            : 0;

    // Actions ref — avoids subscribing to every action
    const chatActions = useRef(useChatStore.getState()).current;
    const aiReviewEnabled = useSettingsStore((state) => state.aiReviewEnabled);

    // Session data
    const {
        session,
        conversationId,
        conversation,
        conversationBindings,
        preparedTurnCatalog,
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
            const conversationId = sid
                ? (state.conversationIdBySessionRef[sid] ??
                  s?.historySessionId ??
                  null)
                : null;
            const conversation = conversationId
                ? (state.conversationsById[conversationId] ?? null)
                : null;
            const parent = s?.parentSessionId
                ? findSessionForHistorySelection(
                      state.sessionsById,
                      s.parentSessionId,
                  )
                : null;
            return {
                session: s,
                conversationId,
                conversation,
                conversationBindings:
                    s?.conversationBindings?.providerBindings ??
                    EMPTY_CONVERSATION_BINDINGS,
                preparedTurnCatalog: conversationId
                    ? (state.preparedTurnCatalogByConversationId[
                          conversationId
                      ] ?? null)
                    : null,
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
    const setupStatusByRuntimeId = useChatStore(
        (state) => state.setupStatusByRuntimeId,
    );
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

    const turnSelection = useMemo<ConversationSelection | null>(() => {
        if (conversation) {
            return conversation.preferredSelection;
        }
        return session ? getConversationSelection(session) : null;
    }, [conversation, session]);
    const selectedRuntime = runtimes.find(
        (runtime) => runtime.runtime.id === turnSelection?.runtimeId,
    );
    const agentCatalog = useMemo(
        () =>
            session && turnSelection
                ? getConversationTurnCatalog({
                      selection: turnSelection,
                      session,
                      runtimes,
                      bindings: conversationBindings,
                      preparedCatalog: preparedTurnCatalog,
                  })
                : {
                      models: [],
                      modes: [],
                      configOptions: [],
                      effortsByModel: {},
                  },
        [
            conversationBindings,
            preparedTurnCatalog,
            runtimes,
            session,
            turnSelection,
        ],
    );

    useEffect(() => {
        if (!conversationId || !session || !turnSelection) return;

        // A staged provider/model switch has no live session yet, so its
        // dynamic ACP options cannot be projected from the active provider.
        // Prepare the exact target catalog before the user sends the turn.
        const preparedMatches =
            preparedTurnCatalog?.runtimeId === turnSelection.runtimeId &&
            preparedTurnCatalog.modelId === turnSelection.modelId;
        if (preparedMatches) return;

        const liveSelection = getConversationSelection(session);
        const selectionMatchesLiveSession =
            liveSelection.runtimeId === turnSelection.runtimeId &&
            liveSelection.modelId === turnSelection.modelId;
        const runtimeAdvertisesReasoning =
            selectedRuntime?.runtime.capabilities.includes("reasoning") ??
            false;
        const liveCatalogHasReasoning = session.configOptions.some(
            (option) => option.category === "reasoning",
        );
        if (
            selectionMatchesLiveSession &&
            session.configOptions.length > 0 &&
            (!runtimeAdvertisesReasoning || liveCatalogHasReasoning)
        ) {
            // Prefer the real live-session catalog when it already represents
            // the selected provider/model; probing it again would be wasteful.
            return;
        }

        void chatActions.prepareConversationTurnCatalog(
            conversationId,
            turnSelection,
        );
    }, [
        chatActions,
        conversationId,
        preparedTurnCatalog,
        selectedRuntime,
        session,
        turnSelection,
    ]);
    const providerOptions = useMemo(
        () =>
            conversation && session
                ? buildConversationProviderOptions({
                      runtimes,
                      setupStatusByRuntimeId,
                      conversation,
                      bindings: conversationBindings,
                      activeRuntimeId: session.runtimeId,
                      hasQueuedMessages:
                          queuedMessages.length > 0 ||
                          queuedMessageEdit != null,
                  })
                : [],
        [
            conversation,
            conversationBindings,
            queuedMessageEdit,
            queuedMessages.length,
            runtimes,
            session,
            setupStatusByRuntimeId,
        ],
    );

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
    const contextBarAttachments = useMemo(
        () =>
            (session?.attachments ?? [])
                .filter(
                    (attachment) =>
                        !composerParts.some(
                            (part) =>
                                (part.type === "mention" &&
                                    part.noteId === attachment.noteId) ||
                                (part.type === "file_mention" &&
                                    attachment.type === "file" &&
                                    attachment.path === part.path) ||
                                (part.type === "folder_mention" &&
                                    attachment.type === "folder" &&
                                    part.folderPath === attachment.noteId),
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
        [composerParts, session?.attachments],
    );

    const runtimeLabel =
        selectedRuntime?.runtime.name.replace(/ ACP$/, "") ??
        activeRuntime?.runtime.name.replace(/ ACP$/, "") ??
        "Assistant";
    const isClosedSubagent = Boolean(session?.parentSessionId && session.closedAt);
    const isRemovedGeminiAcpSession = session?.runtimeId === "gemini-acp";
    const agentControlsDisabled =
        !session ||
        isClosedSubagent ||
        isRemovedGeminiAcpSession ||
        isPendingSessionCreation ||
        Boolean(session.isResumingSession);
    const lockIncompatibleModelSwitches =
        turnSelection?.runtimeId === "grok-acp" &&
        conversationBindings.some(
            (binding) => binding.runtimeId === "grok-acp",
        ) &&
        ((session?.messages.length ?? 0) > 0 ||
            (session?.persistedMessageCount ?? 0) > 0);
    const updateTurnSelection = useCallback(
        (selection: ConversationSelection) => {
            if (!conversationId) return;
            chatActions.setConversationTurnSelection(
                conversationId,
                selection,
            );
        },
        [chatActions, conversationId],
    );

    const handleProviderModelChange = useCallback(
        (runtimeId: string, modelId: string) => {
            if (!session || !turnSelection) {
                return;
            }
            if (runtimeId === session.runtimeId) {
                const currentSelection =
                    turnSelection.runtimeId === runtimeId
                        ? turnSelection
                        : getConversationSelection(session);
                if (modelId && modelId !== currentSelection.modelId) {
                    updateTurnSelection(
                        updateConversationSelection(
                            currentSelection,
                            agentCatalog.configOptions,
                            { kind: "model", value: modelId },
                        ),
                    );
                }
                return;
            }
            const option = providerOptions.find(
                (candidate) => candidate.runtimeId === runtimeId,
            );
            const runtime = runtimes.find(
                (candidate) => candidate.runtime.id === runtimeId,
            );
            if (!option || option.disabledReason || !runtime) return;

            let nextSelection = getDefaultConversationSelection({
                runtime,
            });
            if (modelId && modelId !== nextSelection.modelId) {
                const targetCatalog = getConversationTurnCatalog({
                    selection: nextSelection,
                    session,
                    runtimes,
                    bindings: conversationBindings,
                });
                nextSelection = updateConversationSelection(
                    nextSelection,
                    targetCatalog.configOptions,
                    { kind: "model", value: modelId },
                );
            }
            updateTurnSelection(nextSelection);
        },
        [
            agentCatalog.configOptions,
            conversationBindings,
            providerOptions,
            runtimes,
            session,
            turnSelection,
            updateTurnSelection,
        ],
    );

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
            const vaultPathAtStart = useVaultStore.getState().vaultPath;
            const sessionAtStart =
                useChatStore.getState().sessionsById[sessionId];
            if (!vaultPathAtStart || !sessionAtStart) return;
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
                const saved = await vaultInvokeForPath<{
                    draft_attachment_id: DraftAttachmentId;
                    file_name: string;
                    mime_type: string;
                }>(
                    "ai_create_draft_attachment",
                    vaultPathAtStart,
                    {
                        fileName,
                        mimeType: file.type,
                        bytes,
                    },
                );
                const currentSession =
                    useChatStore.getState().sessionsById[sessionId];
                // The IPC call can outlive a vault or session change. Do not
                // attach a draft created for the previous ownership context to
                // whichever session now happens to have this ID.
                const stillOwnsDraft =
                    useVaultStore.getState().vaultPath === vaultPathAtStart &&
                    currentSession?.runtimeId === sessionAtStart.runtimeId &&
                    currentSession?.historySessionId ===
                        sessionAtStart.historySessionId;
                if (!stillOwnsDraft) {
                    await vaultInvokeForPath(
                        "ai_delete_draft_attachment",
                        vaultPathAtStart,
                        { draftAttachmentId: saved.draft_attachment_id },
                    ).catch((cleanupError) => {
                        console.error(
                            "[chat] Failed to remove detached pasted image:",
                            cleanupError,
                        );
                    });
                    return;
                }
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
                    await vaultInvokeForPath(
                        "ai_delete_draft_attachment",
                        vaultPathAtStart,
                        { draftAttachmentId: saved.draft_attachment_id },
                    ).catch((cleanupError) => {
                        console.error(
                            "[chat] Failed to remove rejected pasted image:",
                            cleanupError,
                        );
                    });
                    setImageAttachmentNotice(
                        imageAttachmentValidationMessage(
                            latestValidation.reason,
                            runtimeId,
                        ),
                    );
                    return;
                }
                chatActions.setComposerParts(
                    appendScreenshotPart(latestParts, {
                        draftAttachmentId: saved.draft_attachment_id,
                        fileName: saved.file_name,
                        mimeType: saved.mime_type,
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
        [chatActions, session?.runtimeId, sessionId],
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
            cleanupRemovedScreenshotAttachments(
                sessionId,
                composerParts,
                prunedParts,
            );
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
                cleanupRemovedScreenshotAttachments(
                    sessionId,
                    currentParts,
                    nextParts,
                );
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
        setPromptOutlineOpen(false);
        setScrollToMessageId(null);
    }, [sessionId]);

    // Keep local message-list overlays closed while the expanded composer makes
    // the transcript visual-only beneath its translucent surface.
    useEffect(() => {
        if (composerExpanded) {
            setFindOpen(false);
            setPromptOutlineOpen(false);
        }
    }, [composerExpanded]);

    const openFind = useCallback(() => {
        setFindOpen(true);
    }, []);
    useChatFindShortcut({
        rootRef,
        disabled: composerExpanded,
        onOpen: openFind,
    });
    useEffect(() => {
        if (!findOpen) return;
        const handleEscape = (event: KeyboardEvent) => {
            if (event.defaultPrevented || event.key !== "Escape") return;
            if (
                event.metaKey ||
                event.ctrlKey ||
                event.altKey ||
                event.shiftKey
            ) {
                return;
            }
            const focusedPaneId = selectFocusedPaneId(useEditorStore.getState());
            if (paneId && focusedPaneId !== paneId) return;

            event.preventDefault();
            event.stopPropagation();
            setFindOpen(false);
            rootRef.current?.focus();
        };

        window.addEventListener("keydown", handleEscape, true);
        return () => window.removeEventListener("keydown", handleEscape, true);
    }, [findOpen, paneId]);

    useLayoutEffect(() => {
        if (composerExpanded) {
            setBottomDockMeasurement({ sessionId, height: 0 });
            return;
        }

        const dock = bottomDockRef.current;
        if (!dock) return;

        const updateHeight = () => {
            const nextHeight = Math.max(
                0,
                Math.ceil(dock.getBoundingClientRect().height),
            );
            setBottomDockMeasurement((currentMeasurement) =>
                currentMeasurement.sessionId === sessionId &&
                currentMeasurement.height === nextHeight
                    ? currentMeasurement
                    : { sessionId, height: nextHeight },
            );
        };

        updateHeight();
        const observer = new ResizeObserver(updateHeight);
        observer.observe(dock);

        return () => observer.disconnect();
    }, [composerExpanded, sessionId]);

    const isSubagent = Boolean(session?.parentSessionId?.trim());
    const parentTitle = parentSession ? getSessionTitle(parentSession) : null;
    const findDisabled = composerExpanded;
    const promptOutlineDisabled = composerExpanded;
    const hasEarlierMessages = (session?.loadedPersistedMessageStart ?? 0) > 0;
    const promptOutlineItems = useMemo<ChatPromptOutlineItem[]>(
        () =>
            (session?.messages ?? [])
                .filter(
                    (message) =>
                        message.role === "user" && message.kind === "text",
                )
                .map((message, index) => ({
                    id: message.id,
                    label: buildPromptOutlineLabel(message),
                    ordinal: index + 1,
                })),
        [session?.messages],
    );

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
                {!isSubagent && editingKey !== sessionId ? (
                    <button
                        type="button"
                        onClick={startTitleEdit}
                        aria-label="Rename chat"
                        title="Rename chat"
                        className="nw-control-trigger flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md"
                        style={{
                            color: "var(--text-secondary)",
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
                            <path d="M8.5 3 11 5.5" />
                            <path d="M3 11l.5-2.2 5.3-5.3a1 1 0 0 1 1.4 0l.8.8a1 1 0 0 1 0 1.4l-5.3 5.3L3 11z" />
                        </svg>
                    </button>
                ) : null}
                <button
                    ref={promptOutlineButtonRef}
                    type="button"
                    onClick={() => {
                        if (promptOutlineDisabled) return;
                        setPromptOutlineOpen((value) => !value);
                    }}
                    disabled={promptOutlineDisabled}
                    aria-label="User prompts"
                    aria-pressed={promptOutlineOpen}
                    title={
                        promptOutlineDisabled
                            ? "User prompts are unavailable while the composer is expanded"
                            : "User prompts"
                    }
                    className="nw-control-trigger flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md"
                    style={{
                        color: promptOutlineOpen
                            ? "var(--accent)"
                            : "var(--text-secondary)",
                        border: "none",
                        backgroundColor: "transparent",
                        opacity: promptOutlineDisabled ? 0.45 : 1,
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
                        <path d="M3 3.5h8" />
                        <path d="M3 7h8" />
                        <path d="M3 10.5h8" />
                        <path d="M1.5 3.5h.01" />
                        <path d="M1.5 7h.01" />
                        <path d="M1.5 10.5h.01" />
                    </svg>
                </button>
                <button
                    type="button"
                    onClick={() => {
                        if (findDisabled) return;
                        setFindOpen((value) => !value);
                    }}
                    disabled={findDisabled}
                    aria-label="Find in chat"
                    aria-pressed={findOpen}
                    title={
                        findDisabled
                            ? "Find is unavailable while the composer is expanded"
                            : `Find in chat (${formatShortcutAction(
                                  "find_in_note",
                                  getDesktopPlatform(),
                              )})`
                    }
                    className="nw-control-trigger flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md"
                    style={{
                        color: findOpen
                            ? "var(--accent)"
                            : "var(--text-secondary)",
                        border: "none",
                        backgroundColor: "transparent",
                        opacity: findDisabled ? 0.45 : 1,
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
                {promptOutlineOpen ? (
                    <ChatPromptOutlineMenu
                        anchorRef={promptOutlineButtonRef}
                        items={promptOutlineItems}
                        hasEarlierMessages={hasEarlierMessages}
                        onSelect={(messageId) => {
                            setPromptOutlineOpen(false);
                            setScrollToMessageId(messageId);
                        }}
                        onClose={() => setPromptOutlineOpen(false)}
                    />
                ) : null}
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

            <div className="relative flex min-h-0 flex-1 flex-col">
                <div
                    data-testid="chat-transcript-region"
                    className="flex min-h-0 flex-1 flex-col"
                    aria-hidden={composerExpanded || undefined}
                    inert={composerExpanded || undefined}
                >
                    <AIChatMessageList
                        sessionId={sessionId}
                        messages={session?.messages ?? []}
                        status={session?.status ?? "idle"}
                        bottomInset={bottomDockHeight}
                        hasOlderMessages={
                            (session?.loadedPersistedMessageStart ?? 0) > 0
                        }
                        isLoadingOlderMessages={
                            session?.isLoadingPersistedMessages ?? false
                        }
                        visibleWorkCycleId={session?.visibleWorkCycleId ?? null}
                        findOpen={findOpen}
                        scrollToMessageId={scrollToMessageId}
                        onScrollToMessageComplete={() => {
                            setScrollToMessageId(null);
                        }}
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
                </div>

                <div
                    ref={composerExpanded ? undefined : bottomDockRef}
                    data-testid={
                        composerExpanded
                            ? "chat-expanded-composer-region"
                            : "chat-bottom-dock"
                    }
                    className={
                        composerExpanded
                            ? "nw-chat-translucent-surface absolute inset-0 z-20 flex min-h-0 flex-col"
                            : "nw-chat-translucent-surface nw-chat-bottom-dock absolute inset-x-0 bottom-0 z-20 flex max-h-full flex-col"
                    }
                >
                    {/* Queue and Edits yield their height before Composer,
                        then share a scrollable region in short panes. */}
                    <div
                        data-testid="chat-bottom-dock-auxiliary-region"
                        data-scrollbar-active="true"
                        className="min-h-0 overflow-y-auto"
                        style={{ flexShrink: 999 }}
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
                                    chatActions.editQueuedMessage(
                                        sessionId,
                                        messageId,
                                    );
                                }}
                                onSendNow={(messageId) => {
                                    void chatActions.sendQueuedMessageNow(
                                        sessionId,
                                        messageId,
                                    );
                                }}
                                onCancelEdit={() => {
                                    chatActions.cancelQueuedMessageEdit(
                                        sessionId,
                                    );
                                }}
                            />
                        </ChatContentColumn>

                        {aiReviewEnabled ? (
                            <ChatContentColumn>
                                <EditedFilesBufferPanel sessionId={sessionId} />
                            </ChatContentColumn>
                        ) : null}
                    </div>

                    <div
                        data-testid="chat-bottom-dock-composer-region"
                        className={
                            composerExpanded
                                ? "flex min-h-0 flex-1 flex-col"
                                : "flex min-h-16 shrink flex-col"
                        }
                    >
                        <AIChatComposer
                            key={sessionId}
                            sessionId={sessionId}
                            parts={composerParts}
                            notes={noteOptions}
                            files={fileOptions}
                            status={session?.status ?? "idle"}
                            runtimeName={runtimeLabel}
                            runtimeId={turnSelection?.runtimeId}
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
                                contextBarAttachments.length > 0 ? (
                                    <AIChatContextBar
                                        attachments={contextBarAttachments}
                                        onRemoveAttachment={handleRemoveAttachment}
                                        onClearAll={handleClearAttachments}
                                    />
                                ) : null
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
                                            runtimeId={turnSelection?.runtimeId}
                                            lockIncompatibleModelSwitches={
                                                lockIncompatibleModelSwitches
                                            }
                                            modelId={turnSelection?.modelId ?? ""}
                                            modeId={turnSelection?.modeId ?? ""}
                                            effortsByModel={
                                                agentCatalog.effortsByModel
                                            }
                                            models={agentCatalog.models}
                                            modes={agentCatalog.modes}
                                            configOptions={agentCatalog.configOptions}
                                            providers={providerOptions}
                                            onProviderModelChange={(
                                                runtimeId,
                                                modelId,
                                            ) => {
                                                void handleProviderModelChange(
                                                    runtimeId,
                                                    modelId,
                                                );
                                            }}
                                            onModelChange={(modelId) => {
                                                if (!turnSelection) return;
                                                updateTurnSelection(
                                                    updateConversationSelection(
                                                        turnSelection,
                                                        agentCatalog.configOptions,
                                                        {
                                                            kind: "model",
                                                            value: modelId,
                                                        },
                                                    ),
                                                );
                                            }}
                                            onModeChange={(modeId) => {
                                                if (!turnSelection) return;
                                                updateTurnSelection(
                                                    updateConversationSelection(
                                                        turnSelection,
                                                        agentCatalog.configOptions,
                                                        {
                                                            kind: "mode",
                                                            value: modeId,
                                                        },
                                                    ),
                                                );
                                            }}
                                            onConfigOptionChange={(optionId, value) => {
                                                if (!turnSelection) return;
                                                updateTurnSelection(
                                                    updateConversationSelection(
                                                        turnSelection,
                                                        agentCatalog.configOptions,
                                                        {
                                                            kind: "option",
                                                            optionId,
                                                            value,
                                                        },
                                                    ),
                                                );
                                            }}
                                        />
                                    )}
                                </div>
                            }
                            onChange={(parts) => {
                                cleanupRemovedScreenshotAttachments(
                                    sessionId,
                                    composerParts,
                                    parts,
                                );
                                chatActions.setComposerParts(parts, sessionId);
                            }}
                            onAttachFile={handleAttachFile}
                            onPasteImage={handlePasteImage}
                            onImageAttachmentValidationFailure={(reason) => {
                                const runtimeId = turnSelection?.runtimeId ?? null;
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
                                if (conversationId && turnSelection) {
                                    void chatActions.startConversationTurn(
                                        conversationId,
                                        turnSelection,
                                    );
                                } else {
                                    void chatActions.sendMessage(sessionId);
                                }
                            }}
                            onStop={() => {
                                void chatActions.stopStreaming(sessionId);
                            }}
                        />
                    </div>
                </div>
            </div>
        </div>
    );
}
