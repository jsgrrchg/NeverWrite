import { create } from "zustand";
import {
    normalizeEditorFontFamily,
    type EditorFontFamily,
} from "../../../app/store/settingsStore";
import {
    aiCancelTurn,
    aiCreateSession,
    aiDeleteSessionHistory,
    aiDeleteAllSessionHistories,
    aiGetTextFileHash,
    aiGetSetupStatus,
    aiListSessions,
    aiListRuntimes,
    aiLoadSession,
    aiLoadSessionHistories,
    aiPruneSessionHistories,
    aiRespondPermission,
    aiRespondUserInput,
    aiRestoreTextFile,
    aiSaveSessionHistory,
    aiSendMessage,
    aiStartAuth,
    aiSetConfigOption,
    aiSetMode,
    aiSetModel,
    aiUpdateSetup,
} from "../api";
import { useEditorStore, isNoteTab } from "../../../app/store/editorStore";
import { useVaultStore } from "../../../app/store/vaultStore";
import {
    appendSelectionMentionPart,
    createEmptyComposerParts,
    serializeComposerParts,
    serializeComposerPartsForAI,
} from "../composerParts";
import {
    clearVisibleEditedFilesBuffer,
    consolidateEditedFilesBuffer,
    deriveEditedFilesBufferFromLegacy,
    ensureSessionWorkCycle,
    getActiveEditedFilesBuffer,
    getSessionEditedFilesBuffer,
    markEditedFileEntryConflict,
    removeEditedFilesBufferEntry,
    setActiveEditedFilesBuffer,
    startNewWorkCycle,
    syncEditedFilesBufferState,
} from "./editedFilesBufferModel";
import { useChatTabsStore } from "./chatTabsStore";
import {
    buildSelectionLabel,
    type AIChatAttachment,
    type AIChatMessage,
    type AIChatMessageKind,
    type AIChatNoteSummary,
    type AIChatRole,
    type AIChatSession,
    type AIComposerPart,
    type AIEditedFileBufferEntry,
    type AIPermissionRequestPayload,
    type AIPlanUpdatePayload,
    type AIStatusEventPayload,
    type AIToolActivityPayload,
    type AIUserInputRequestPayload,
    type AIRuntimeConnectionState,
    type AIRuntimeDescriptor,
    type AIRuntimeSetupStatus,
    type AISessionErrorPayload,
    type PersistedSessionHistory,
    type QueuedChatMessage,
    type QueuedChatMessageStatus,
} from "../types";

const AI_PREFS_KEY = "vaultai.ai.preferences";
const AI_RUNTIME_CACHE_KEY = "vaultai.ai.runtime-catalog";

interface AiPreferences {
    modelId?: string;
    modeId?: string;
    configOptions?: Record<string, string>;
    autoContextEnabled?: boolean;
    requireCmdEnterToSend?: boolean;
    composerFontSize?: number;
    chatFontSize?: number;
    composerFontFamily?: EditorFontFamily;
    chatFontFamily?: EditorFontFamily;
    editDiffZoom?: number;
    historyRetentionDays?: number;
}

interface NormalizedAiPreferences {
    autoContextEnabled: boolean;
    requireCmdEnterToSend: boolean;
    composerFontSize: number;
    chatFontSize: number;
    composerFontFamily: EditorFontFamily;
    chatFontFamily: EditorFontFamily;
    editDiffZoom: number;
    historyRetentionDays: number;
}

interface AIRuntimeCatalogSnapshot {
    models: AIRuntimeDescriptor["models"];
    modes: AIRuntimeDescriptor["modes"];
    configOptions: AIRuntimeDescriptor["configOptions"];
}

interface QueuedMessageEditState {
    item: QueuedChatMessage;
    originalIndex: number;
    previousItemId: string | null;
    nextItemId: string | null;
    previousComposerParts: AIComposerPart[];
    previousAttachments: AIChatAttachment[];
}

function loadAiPreferences(): AiPreferences {
    try {
        const raw = localStorage.getItem(AI_PREFS_KEY);
        return raw ? (JSON.parse(raw) as AiPreferences) : {};
    } catch {
        return {};
    }
}

function saveAiPreferences(patch: Partial<AiPreferences>) {
    try {
        const current = loadAiPreferences();
        localStorage.setItem(
            AI_PREFS_KEY,
            JSON.stringify({ ...current, ...patch }),
        );
    } catch {
        // ignore
    }
}

function saveConfigOptionPreference(optionId: string, value: string) {
    const prefs = loadAiPreferences();
    saveAiPreferences({
        configOptions: { ...prefs.configOptions, [optionId]: value },
    });
}

function getNormalizedAiPreferences(): NormalizedAiPreferences {
    const prefs = loadAiPreferences();
    return {
        autoContextEnabled: prefs.autoContextEnabled !== false,
        requireCmdEnterToSend: prefs.requireCmdEnterToSend === true,
        composerFontSize: prefs.composerFontSize ?? 14,
        chatFontSize: prefs.chatFontSize ?? 20,
        composerFontFamily: normalizeEditorFontFamily(prefs.composerFontFamily),
        chatFontFamily: normalizeEditorFontFamily(prefs.chatFontFamily),
        editDiffZoom: prefs.editDiffZoom ?? 0.72,
        historyRetentionDays: prefs.historyRetentionDays ?? 0,
    };
}

function loadRuntimeCatalogCache(): Record<string, AIRuntimeCatalogSnapshot> {
    try {
        const raw = localStorage.getItem(AI_RUNTIME_CACHE_KEY);
        return raw
            ? (JSON.parse(raw) as Record<string, AIRuntimeCatalogSnapshot>)
            : {};
    } catch {
        return {};
    }
}

function saveRuntimeCatalogCache(
    runtimeId: string,
    snapshot: AIRuntimeCatalogSnapshot,
) {
    try {
        const current = loadRuntimeCatalogCache();
        localStorage.setItem(
            AI_RUNTIME_CACHE_KEY,
            JSON.stringify({
                ...current,
                [runtimeId]: snapshot,
            }),
        );
    } catch {
        // ignore
    }
}

function hasRuntimeCatalog(snapshot: AIRuntimeCatalogSnapshot) {
    return (
        snapshot.models.length > 0 ||
        snapshot.modes.length > 0 ||
        snapshot.configOptions.length > 0
    );
}

function getRuntimeCatalogSnapshot(
    session: Pick<AIChatSession, "models" | "modes" | "configOptions">,
): AIRuntimeCatalogSnapshot {
    return {
        models: session.models,
        modes: session.modes,
        configOptions: session.configOptions,
    };
}

function getModelConfigOption(session: Pick<AIChatSession, "configOptions">) {
    return session.configOptions.find((option) => option.category === "model");
}

function supportsModelSelection(
    session: Pick<AIChatSession, "models" | "configOptions">,
    modelId: string,
) {
    const modelConfig = getModelConfigOption(session);
    if (modelConfig) {
        return modelConfig.options.some((option) => option.value === modelId);
    }

    return session.models.some((model) => model.id === modelId);
}

function applyLocalModelSelection(
    session: AIChatSession,
    modelId: string,
): AIChatSession {
    return {
        ...session,
        modelId,
        configOptions: session.configOptions.map((option) =>
            option.category === "model"
                ? { ...option, value: modelId }
                : option,
        ),
    };
}

function mergeRuntimeCatalog(
    runtime: AIRuntimeDescriptor,
    snapshot: AIRuntimeCatalogSnapshot | undefined,
): AIRuntimeDescriptor {
    if (!snapshot || !hasRuntimeCatalog(snapshot)) {
        return runtime;
    }

    return {
        ...runtime,
        models: snapshot.models,
        modes: snapshot.modes,
        configOptions: snapshot.configOptions,
    };
}

function hydrateRuntimesFromCache(runtimes: AIRuntimeDescriptor[]) {
    const cache = loadRuntimeCatalogCache();
    return runtimes.map((runtime) =>
        mergeRuntimeCatalog(runtime, cache[runtime.runtime.id]),
    );
}

function hydrateRuntimesFromSessions(
    runtimes: AIRuntimeDescriptor[],
    sessions: AIChatSession[],
) {
    return sessions.reduce((currentRuntimes, session) => {
        const snapshot = getRuntimeCatalogSnapshot(session);
        if (!hasRuntimeCatalog(snapshot)) {
            return currentRuntimes;
        }

        saveRuntimeCatalogCache(session.runtimeId, snapshot);

        return currentRuntimes.map((runtime) =>
            runtime.runtime.id === session.runtimeId
                ? mergeRuntimeCatalog(runtime, snapshot)
                : runtime,
        );
    }, runtimes);
}

interface ChatStore {
    runtimeConnection: AIRuntimeConnectionState;
    setupStatus: AIRuntimeSetupStatus | null;
    runtimes: AIRuntimeDescriptor[];
    sessionsById: Record<string, AIChatSession>;
    sessionOrder: string[];
    activeSessionId: string | null;
    notePickerOpen: boolean;
    autoContextEnabled: boolean;
    requireCmdEnterToSend: boolean;
    composerFontSize: number;
    chatFontSize: number;
    composerFontFamily: EditorFontFamily;
    chatFontFamily: EditorFontFamily;
    editDiffZoom: number;
    historyRetentionDays: number;
    composerPartsBySessionId: Record<string, AIComposerPart[]>;
    queuedMessagesBySessionId: Record<string, QueuedChatMessage[]>;
    queuedMessageEditBySessionId: Record<string, QueuedMessageEditState>;
    initialize: () => Promise<void>;
    refreshSetupStatus: () => Promise<void>;
    saveSetup: (input: {
        customBinaryPath?: string;
        codexApiKey?: string;
        openaiApiKey?: string;
    }) => Promise<void>;
    startAuth: (input: {
        methodId: string;
        customBinaryPath?: string;
        codexApiKey?: string;
        openaiApiKey?: string;
    }) => Promise<void>;
    upsertSession: (session: AIChatSession, activate?: boolean) => void;
    applySessionError: (payload: AISessionErrorPayload) => void;
    applyMessageStarted: (payload: {
        session_id: string;
        message_id: string;
    }) => void;
    applyMessageDelta: (payload: {
        session_id: string;
        message_id: string;
        delta: string;
    }) => void;
    applyMessageCompleted: (payload: {
        session_id: string;
        message_id: string;
    }) => void;
    applyThinkingStarted: (payload: {
        session_id: string;
        message_id: string;
    }) => void;
    applyThinkingDelta: (payload: {
        session_id: string;
        message_id: string;
        delta: string;
    }) => void;
    applyThinkingCompleted: (payload: {
        session_id: string;
        message_id: string;
    }) => void;
    applyToolActivity: (payload: AIToolActivityPayload) => void;
    applyStatusEvent: (payload: AIStatusEventPayload) => void;
    applyPlanUpdate: (payload: AIPlanUpdatePayload) => void;
    applyPermissionRequest: (payload: AIPermissionRequestPayload) => void;
    applyUserInputRequest: (payload: AIUserInputRequestPayload) => void;
    setActiveSession: (sessionId: string) => void;
    resumeSession: (sessionId: string) => Promise<string | null>;
    loadSession: (sessionId: string) => Promise<void>;
    setModel: (modelId: string) => Promise<void>;
    setMode: (modeId: string) => Promise<void>;
    setConfigOption: (optionId: string, value: string) => Promise<void>;
    setComposerParts: (parts: AIComposerPart[]) => void;
    sendMessage: () => Promise<void>;
    enqueueMessage: (sessionId: string, item: QueuedChatMessage) => void;
    removeQueuedMessage: (sessionId: string, messageId: string) => void;
    markQueuedMessageStatus: (
        sessionId: string,
        messageId: string,
        status: QueuedChatMessageStatus,
    ) => void;
    clearSessionQueue: (sessionId: string) => void;
    editQueuedMessage: (sessionId: string, messageId: string) => void;
    cancelQueuedMessageEdit: (sessionId: string) => void;
    retryQueuedMessage: (sessionId: string, messageId: string) => Promise<void>;
    sendQueuedMessageNow: (
        sessionId: string,
        messageId: string,
    ) => Promise<void>;
    tryDrainQueue: (sessionId: string) => Promise<void>;
    stopStreaming: () => Promise<void>;
    respondPermission: (requestId: string, optionId?: string) => Promise<void>;
    respondUserInput: (
        requestId: string,
        answers: Record<string, string[]>,
    ) => Promise<void>;
    rejectEditedFile: (sessionId: string, identityKey: string) => Promise<void>;
    resolveEditedFileWithMergedText: (
        sessionId: string,
        identityKey: string,
        mergedText: string,
    ) => Promise<void>;
    rejectAllEditedFiles: (sessionId: string) => Promise<void>;
    keepEditedFile: (sessionId: string, identityKey: string) => void;
    keepAllEditedFiles: (sessionId: string) => void;
    newSession: (runtimeId?: string) => Promise<void>;
    deleteSession: (sessionId: string) => Promise<void>;
    deleteAllSessions: () => Promise<void>;
    attachNote: (note: AIChatNoteSummary) => void;
    attachFolder: (folderPath: string, name: string) => void;
    attachCurrentNote: (note: AIChatNoteSummary | null) => void;
    attachSelectionFromEditor: () => void;
    attachAudio: (filePath: string, fileName: string) => void;
    attachFile: (filePath: string, fileName: string, mimeType: string) => void;
    updateAttachment: (
        attachmentId: string,
        patch: Partial<AIChatAttachment>,
    ) => void;
    removeAttachment: (attachmentId: string) => void;
    clearAttachments: () => void;
    toggleAutoContext: () => void;
    toggleRequireCmdEnterToSend: () => void;
    setComposerFontSize: (size: number) => void;
    setChatFontSize: (size: number) => void;
    setComposerFontFamily: (fontFamily: EditorFontFamily) => void;
    setChatFontFamily: (fontFamily: EditorFontFamily) => void;
    setEditDiffZoom: (size: number) => void;
    setHistoryRetentionDays: (days: number) => Promise<void>;
    openNotePicker: () => void;
    closeNotePicker: () => void;
}

const INITIAL_RUNTIME_CONNECTION: AIRuntimeConnectionState = {
    status: "idle",
    message: null,
};

function isAuthenticationErrorMessage(message: string) {
    const normalized = message.trim().toLowerCase();
    return (
        normalized.includes("auth_required") ||
        normalized.includes("authentication required")
    );
}

function isContextTooLargeErrorMessage(message: string) {
    const normalized = message.trim().toLowerCase();
    return (
        normalized.includes("string_above_max_length") ||
        normalized.includes("largestringparam") ||
        (normalized.includes("invalid_request_error") &&
            normalized.includes("too long")) ||
        (normalized.includes("remote compact task") &&
            normalized.includes("too long"))
    );
}

function normalizeAiErrorMessage(message: string) {
    if (message.includes("No hay vault abierto")) {
        return "Open a vault before starting a chat.";
    }

    if (isContextTooLargeErrorMessage(message)) {
        return "This chat context grew too large to continue. Start a new chat and resend your last message.";
    }

    if (isAuthenticationErrorMessage(message)) {
        return "You were signed out. Reconnect in AI setup to continue chatting.";
    }

    return message;
}

function getAiErrorMessage(error: unknown, fallback: string) {
    if (error instanceof Error && error.message.trim()) {
        return normalizeAiErrorMessage(error.message);
    }

    if (typeof error === "string" && error.trim()) {
        return normalizeAiErrorMessage(error);
    }

    if (
        typeof error === "object" &&
        error !== null &&
        "message" in error &&
        typeof error.message === "string" &&
        error.message.trim()
    ) {
        return normalizeAiErrorMessage(error.message);
    }

    return fallback;
}

function createTextMessage(
    role: AIChatMessage["role"],
    content: string,
    title?: string,
): AIChatMessage {
    return {
        id: crypto.randomUUID(),
        role,
        kind: "text",
        content,
        title,
        timestamp: Date.now(),
    };
}

function createErrorMessage(content: string): AIChatMessage {
    return {
        id: crypto.randomUUID(),
        role: "assistant",
        kind: "error",
        content,
        title: "Runtime error",
        timestamp: Date.now(),
    };
}

/**
 * Find the latest turn_started message that doesn't already have elapsed_ms
 * and stamp it with the elapsed duration.
 */
function stampElapsedOnTurnStarted(
    messages: AIChatMessage[],
    completedAt: number,
): AIChatMessage[] {
    let latestIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (
            messages[i].kind === "status" &&
            messages[i].meta?.status_event === "turn_started"
        ) {
            latestIdx = i;
            break;
        }
    }
    if (latestIdx === -1) return messages;
    const msg = messages[latestIdx];
    if (msg.meta?.elapsed_ms != null) return messages;

    const elapsed = completedAt - msg.timestamp;
    const updated = [...messages];
    updated[latestIdx] = {
        ...msg,
        meta: { ...msg.meta, elapsed_ms: elapsed },
    };
    return updated;
}

function createStatusMessage(payload: AIStatusEventPayload): AIChatMessage {
    return {
        id: `status:${payload.event_id}`,
        role: "system",
        kind: "status",
        title: payload.title,
        content: payload.detail ?? payload.title,
        timestamp: Date.now(),
        meta: {
            status_event: payload.kind,
            status: payload.status,
            emphasis: payload.emphasis,
        },
    };
}

function createPlanMessage(payload: AIPlanUpdatePayload): AIChatMessage {
    const detail = payload.detail?.trim() || undefined;
    const stepsContent = payload.entries
        .map((entry) => entry.content)
        .join("\n");
    const content = [detail, stepsContent].filter(Boolean).join("\n\n");
    const inProgress = payload.entries.some(
        (entry) => entry.status === "in_progress",
    );
    const completedCount = payload.entries.filter(
        (entry) => entry.status === "completed",
    ).length;

    return {
        id: `plan:${payload.plan_id}`,
        role: "assistant",
        kind: "plan",
        title: payload.title?.trim() || "Plan",
        content,
        timestamp: Date.now(),
        inProgress,
        planEntries: payload.entries,
        planDetail: detail,
        meta: {
            status: inProgress ? "in_progress" : "updated",
            completed_count: completedCount,
            total_count: payload.entries.length,
        },
    };
}

function createAttachment(
    type: AIChatAttachment["type"],
    note: AIChatNoteSummary,
): AIChatAttachment {
    return {
        id: crypto.randomUUID(),
        type,
        noteId: note.id,
        label: note.title,
        path: note.path,
    };
}

function getSessionSortTimestamp(session: AIChatSession) {
    return session.messages.at(-1)?.timestamp ?? 0;
}

function sortSessionIdsByRecency(sessionsById: Record<string, AIChatSession>) {
    return Object.values(sessionsById)
        .sort((left, right) => {
            const diff =
                getSessionSortTimestamp(right) - getSessionSortTimestamp(left);
            if (diff !== 0) return diff;
            return right.sessionId.localeCompare(left.sessionId);
        })
        .map((session) => session.sessionId);
}

function hasManualAttachment(
    attachments: AIChatAttachment[],
    type: AIChatAttachment["type"],
    noteId: string,
) {
    return attachments.some(
        (attachment) =>
            attachment.type === type && attachment.noteId === noteId,
    );
}

function getAutoContextAttachments(baseAttachments: AIChatAttachment[]) {
    if (!useChatStore.getState().autoContextEnabled) return [];

    const { tabs, activeTabId, currentSelection } = useEditorStore.getState();
    const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
    const activeNoteId =
        activeTab && isNoteTab(activeTab) ? activeTab.noteId : null;
    const notes = useVaultStore.getState().notes;
    const activeNote = activeNoteId
        ? (notes.find((note) => note.id === activeNoteId) ?? null)
        : null;

    const autoAttachments: AIChatAttachment[] = [];

    if (
        activeNote &&
        !hasManualAttachment(baseAttachments, "current_note", activeNote.id) &&
        !hasManualAttachment(baseAttachments, "note", activeNote.id)
    ) {
        autoAttachments.push({
            ...createAttachment("current_note", activeNote),
            id: `auto:current_note:${activeNote.id}`,
        });
    }

    if (
        currentSelection &&
        currentSelection.text.trim() &&
        activeNote &&
        currentSelection.noteId === activeNote.id &&
        !hasManualAttachment(
            baseAttachments,
            "selection",
            currentSelection.noteId,
        )
    ) {
        autoAttachments.push({
            id: `auto:selection:${currentSelection.noteId}`,
            type: "selection",
            noteId: currentSelection.noteId,
            label: buildSelectionLabel(
                currentSelection.text,
                currentSelection.startLine,
                currentSelection.endLine,
            ),
            path: activeNote.path,
            content: currentSelection.text,
            startLine: currentSelection.startLine,
            endLine: currentSelection.endLine,
        });
    }

    return autoAttachments;
}

function buildPromptWithResumeContext(session: AIChatSession, prompt: string) {
    if (!session.resumeContextPending) {
        return prompt;
    }

    const history = session.messages
        .filter((message) => !message.inProgress)
        .filter(
            (message) =>
                message.kind !== "permission" &&
                message.kind !== "plan" &&
                message.kind !== "user_input_request" &&
                message.kind !== "status",
        )
        .map((message) => {
            const role =
                message.role === "assistant"
                    ? "Assistant"
                    : message.role === "system"
                      ? "System"
                      : "User";
            const label =
                message.kind === "text"
                    ? role
                    : `${role} (${message.kind.replaceAll("_", " ")})`;
            return `${label}: ${message.content}`.trim();
        })
        .filter(Boolean)
        .join("\n\n");

    if (!history) {
        return prompt;
    }

    return [
        "Continue this conversation from the saved transcript below.",
        "Treat it as prior context for this resumed session.",
        "",
        history,
        "",
        `User: ${prompt}`,
    ].join("\n");
}

function cloneAttachment(attachment: AIChatAttachment): AIChatAttachment {
    return { ...attachment };
}

function cloneComposerPart(part: AIComposerPart): AIComposerPart {
    return { ...part };
}

function cloneComposerParts(parts: AIComposerPart[]): AIComposerPart[] {
    return parts.map(cloneComposerPart);
}

function buildQueuedMessage(
    session: AIChatSession,
    composerParts: AIComposerPart[],
): QueuedChatMessage | null {
    const composerPartsSnapshot = cloneComposerParts(composerParts);
    const content = serializeComposerParts(composerParts).trim();
    const prompt = serializeComposerPartsForAI(composerPartsSnapshot).trim();
    if (!content || !prompt) {
        return null;
    }

    const selectionAttachments: AIChatAttachment[] = composerPartsSnapshot
        .filter(
            (p): p is Extract<AIComposerPart, { type: "selection_mention" }> =>
                p.type === "selection_mention",
        )
        .map((p) => ({
            id: crypto.randomUUID(),
            type: "selection" as const,
            noteId: p.noteId,
            label: p.label,
            path: p.path,
            content: p.selectedText,
            startLine: p.startLine,
            endLine: p.endLine,
        }));

    const attachments = [
        ...session.attachments,
        ...selectionAttachments,
        ...getAutoContextAttachments(session.attachments),
    ].map(cloneAttachment);

    return {
        id: crypto.randomUUID(),
        content,
        prompt: buildPromptWithResumeContext(session, prompt),
        composerParts: composerPartsSnapshot,
        attachments,
        createdAt: Date.now(),
        status: "queued",
        modelId: session.modelId ?? null,
        modeId: session.modeId ?? null,
        optionsSnapshot: Object.fromEntries(
            session.configOptions.map((option) => [option.id, option.value]),
        ),
    };
}

function insertQueuedMessageAtIndex(
    queue: QueuedChatMessage[],
    index: number,
    item: QueuedChatMessage,
) {
    const nextQueue = queue.slice();
    const safeIndex = Math.max(0, Math.min(index, nextQueue.length));
    nextQueue.splice(safeIndex, 0, item);
    return nextQueue;
}

function restoreQueuedMessagePosition(
    queue: QueuedChatMessage[],
    editState: Pick<
        QueuedMessageEditState,
        "originalIndex" | "previousItemId" | "nextItemId"
    >,
    item: QueuedChatMessage,
) {
    if (editState.nextItemId) {
        const nextIndex = queue.findIndex(
            (queuedItem) => queuedItem.id === editState.nextItemId,
        );
        if (nextIndex >= 0) {
            return insertQueuedMessageAtIndex(queue, nextIndex, item);
        }
    }

    if (editState.previousItemId) {
        const previousIndex = queue.findIndex(
            (queuedItem) => queuedItem.id === editState.previousItemId,
        );
        if (previousIndex >= 0) {
            return insertQueuedMessageAtIndex(queue, previousIndex + 1, item);
        }
    }

    return insertQueuedMessageAtIndex(queue, editState.originalIndex, item);
}

function prioritizeQueuedMessage(
    queue: QueuedChatMessage[],
    messageId: string,
) {
    const currentIndex = queue.findIndex((item) => item.id === messageId);
    if (currentIndex <= 0) {
        return queue;
    }

    const item = queue[currentIndex];
    if (!item || item.status === "sending") {
        return queue;
    }

    const nextQueue = queue.filter((queuedItem) => queuedItem.id !== messageId);
    const insertionIndex = nextQueue.findIndex(
        (queuedItem) => queuedItem.status !== "sending",
    );
    if (insertionIndex === -1) {
        nextQueue.push(item);
        return nextQueue;
    }

    nextQueue.splice(insertionIndex, 0, {
        ...item,
        status: "queued",
    });
    return nextQueue;
}

function isSessionBusy(session: AIChatSession) {
    return (
        session.status === "streaming" ||
        session.status === "waiting_permission" ||
        session.status === "waiting_user_input"
    );
}

function cleanupQueuedMessagesBySessionId(
    queuedMessagesBySessionId: Record<string, QueuedChatMessage[]>,
    sessionId: string,
    nextQueue: QueuedChatMessage[],
) {
    if (nextQueue.length > 0) {
        return {
            ...queuedMessagesBySessionId,
            [sessionId]: nextQueue,
        };
    }

    const nextQueuedMessagesBySessionId = { ...queuedMessagesBySessionId };
    delete nextQueuedMessagesBySessionId[sessionId];
    return nextQueuedMessagesBySessionId;
}

function updateQueuedMessage(
    queuedMessagesBySessionId: Record<string, QueuedChatMessage[]>,
    sessionId: string,
    messageId: string,
    updater: (item: QueuedChatMessage) => QueuedChatMessage,
) {
    const queue = queuedMessagesBySessionId[sessionId];
    if (!queue) return queuedMessagesBySessionId;

    let changed = false;
    const nextQueue = queue.map((item) => {
        if (item.id !== messageId) {
            return item;
        }

        changed = true;
        return updater(item);
    });

    return changed
        ? {
              ...queuedMessagesBySessionId,
              [sessionId]: nextQueue,
          }
        : queuedMessagesBySessionId;
}

function updatePermissionMessageState(
    session: AIChatSession,
    requestId: string,
    patch: Record<string, string | number | boolean | null>,
) {
    const messageId = `permission:${requestId}`;
    return {
        ...session,
        messages: session.messages.map((message) =>
            message.id === messageId
                ? {
                      ...message,
                      meta: {
                          ...message.meta,
                          ...patch,
                      },
                  }
                : message,
        ),
    };
}

function updateUserInputMessageState(
    session: AIChatSession,
    requestId: string,
    patch: Record<string, string | number | boolean | null>,
) {
    const messageId = `user-input:${requestId}`;
    return {
        ...session,
        messages: session.messages.map((message) =>
            message.id === messageId
                ? {
                      ...message,
                      meta: {
                          ...message.meta,
                          ...patch,
                      },
                  }
                : message,
        ),
    };
}

interface RestoreConflictCheckResult {
    conflict: boolean;
    currentHash: string | null;
}

async function hasSafeRestoreTarget(
    vaultPath: string,
    entry: AIEditedFileBufferEntry,
) {
    const currentHash = await aiGetTextFileHash(vaultPath, entry.path);
    if (currentHash !== entry.appliedHash) {
        return {
            conflict: true,
            currentHash,
        } satisfies RestoreConflictCheckResult;
    }

    if (entry.originPath !== entry.path) {
        const originHash = await aiGetTextFileHash(vaultPath, entry.originPath);
        if (originHash !== null) {
            return {
                conflict: true,
                currentHash: originHash,
            } satisfies RestoreConflictCheckResult;
        }
    }

    return {
        conflict: false,
        currentHash,
    } satisfies RestoreConflictCheckResult;
}

async function restoreEditedFileEntry(
    vaultPath: string,
    entry: AIEditedFileBufferEntry,
) {
    await aiRestoreTextFile({
        vaultPath,
        path: entry.path,
        previousPath: entry.originPath !== entry.path ? entry.originPath : null,
        content: entry.baseText ?? null,
    });
}

function createPersistedSession(
    history: PersistedSessionHistory,
    runtimes: AIRuntimeDescriptor[],
): AIChatSession | null {
    const runtime = runtimes[0];
    if (!runtime) return null;

    return {
        sessionId: `persisted:${history.session_id}`,
        historySessionId: history.session_id,
        runtimeId: runtime.runtime.id,
        modelId: history.model_id,
        modeId: history.mode_id,
        status: "idle",
        activeWorkCycleId: null,
        visibleWorkCycleId: null,
        editedFilesBuffer: [],
        editedFilesBufferByWorkCycleId: {},
        isResumingSession: false,
        effortsByModel: {},
        models: runtime.models,
        modes: runtime.modes,
        configOptions: runtime.configOptions.map((option) =>
            option.category === "model"
                ? { ...option, value: history.model_id }
                : option.category === "mode"
                  ? { ...option, value: history.mode_id }
                  : option,
        ),
        messages: restoreMessagesFromHistory(history),
        attachments: [],
        isPersistedSession: true,
        resumeContextPending: true,
    };
}

function withUniqueAttachment(
    attachments: AIChatAttachment[],
    next: AIChatAttachment,
) {
    if (next.noteId) {
        const duplicate = attachments.some(
            (attachment) =>
                attachment.type === next.type &&
                attachment.noteId === next.noteId,
        );
        if (duplicate) return attachments;
    }

    return [...attachments, next];
}

function mergeSession(
    existing: AIChatSession | undefined,
    incoming: AIChatSession,
): AIChatSession {
    if (!existing) {
        return normalizeSessionState({
            ...incoming,
            historySessionId: incoming.historySessionId ?? incoming.sessionId,
            isPersistedSession: incoming.isPersistedSession ?? false,
            resumeContextPending: incoming.resumeContextPending ?? false,
            activeWorkCycleId: incoming.activeWorkCycleId ?? null,
            visibleWorkCycleId: incoming.visibleWorkCycleId ?? null,
            editedFilesBuffer: incoming.editedFilesBuffer ?? [],
            editedFilesBufferByWorkCycleId:
                incoming.editedFilesBufferByWorkCycleId ?? {},
            // The backend never resets session status to "idle" after streaming,
            // so cap stale "streaming" for freshly loaded sessions.
            status: incoming.status === "streaming" ? "idle" : incoming.status,
            messages: incoming.messages ?? [],
            attachments: incoming.attachments ?? [],
        });
    }

    // Never let upsertSession set status to "streaming".
    // The backend session status stays "streaming" forever after a prompt starts
    // (it's never reset to "idle"). So "streaming" from the backend is always stale.
    // All legitimate "streaming" transitions happen through direct event handlers:
    // sendMessage (optimistic), respondPermission (optimistic),
    // applyMessageStarted, applyThinkingStarted.
    const status =
        incoming.status === "streaming" ? existing.status : incoming.status;

    return normalizeSessionState({
        ...existing,
        ...incoming,
        historySessionId:
            existing.historySessionId ?? incoming.historySessionId,
        isPersistedSession:
            incoming.isPersistedSession ?? existing.isPersistedSession,
        resumeContextPending:
            incoming.resumeContextPending ?? existing.resumeContextPending,
        activeWorkCycleId:
            incoming.activeWorkCycleId ?? existing.activeWorkCycleId ?? null,
        visibleWorkCycleId:
            incoming.visibleWorkCycleId ?? existing.visibleWorkCycleId ?? null,
        editedFilesBuffer:
            incoming.editedFilesBuffer ?? existing.editedFilesBuffer ?? [],
        editedFilesBufferByWorkCycleId:
            incoming.editedFilesBufferByWorkCycleId ??
            existing.editedFilesBufferByWorkCycleId ??
            {},
        effortsByModel:
            incoming.effortsByModel &&
            Object.keys(incoming.effortsByModel).length > 0
                ? incoming.effortsByModel
                : (existing.effortsByModel ?? incoming.effortsByModel ?? {}),
        status,
        messages: existing.messages,
        attachments: existing.attachments,
    });
}

function normalizeSessionState(session: AIChatSession): AIChatSession {
    // Only applyMessageCompleted should transition streaming → idle.
    // This function now just passes through; the stale-streaming timer
    // acts as the safety net for truly stuck sessions.
    const editedFilesBufferByWorkCycleId =
        session.editedFilesBufferByWorkCycleId ??
        (session.editedFilesBuffer?.length
            ? {
                  [session.visibleWorkCycleId ??
                  session.activeWorkCycleId ??
                  "legacy"]: session.editedFilesBuffer,
              }
            : {});

    return syncEditedFilesBufferState({
        ...session,
        editedFilesBufferByWorkCycleId,
    });
}

function getDefaultRuntimeId(runtimes: AIRuntimeDescriptor[]) {
    return runtimes[0]?.runtime.id ?? null;
}

function getRuntimeConnectionPatchForSetup(
    setupStatus: AIRuntimeSetupStatus,
): Partial<Pick<ChatStore, "runtimeConnection">> {
    if (setupStatus.onboardingRequired || !setupStatus.authReady) {
        return {};
    }

    return {
        runtimeConnection: {
            status: "ready",
            message: null,
        },
    };
}

function touchSessionOrder(sessionOrder: string[], sessionId: string) {
    if (!sessionOrder.includes(sessionId)) {
        return [sessionId, ...sessionOrder];
    }

    return [sessionId, ...sessionOrder.filter((id) => id !== sessionId)];
}

function updateActiveSession(
    state: Pick<ChatStore, "activeSessionId" | "sessionsById">,
    updater: (session: AIChatSession) => AIChatSession,
) {
    const activeSessionId = state.activeSessionId;
    if (!activeSessionId) return state.sessionsById;

    const session = state.sessionsById[activeSessionId];
    if (!session) return state.sessionsById;

    return {
        ...state.sessionsById,
        [activeSessionId]: updater(session),
    };
}

function toPersistedHistory(session: AIChatSession): PersistedSessionHistory {
    // The edits buffer is intentionally excluded from persisted history.
    // It represents pending local review state, not durable chat history.
    const messages = session.messages
        .filter((m) => !m.inProgress)
        .filter((m) => m.kind !== "permission")
        .map((m) => ({
            id: m.id,
            role: m.role,
            kind: m.kind,
            content: m.content,
            timestamp: m.timestamp,
            title: m.title,
            meta: m.meta,
            permission_request_id: m.permissionRequestId,
            permission_options: m.permissionOptions,
            diffs: m.diffs,
            user_input_request_id: m.userInputRequestId,
            user_input_questions: m.userInputQuestions,
            plan_entries: m.planEntries,
            plan_detail: m.planDetail,
        }));

    const timestamps = messages.map((m) => m.timestamp);

    return {
        version: 1,
        session_id: session.historySessionId || session.sessionId,
        model_id: session.modelId,
        mode_id: session.modeId,
        created_at: timestamps.length ? Math.min(...timestamps) : Date.now(),
        updated_at: timestamps.length ? Math.max(...timestamps) : Date.now(),
        messages,
    };
}

function hasPersistableSessionContent(session: AIChatSession) {
    return toPersistedHistory(session).messages.length > 0;
}

function hasPersistedHistoryContent(history: PersistedSessionHistory) {
    return history.messages.length > 0;
}

// ---------------------------------------------------------------------------
// Stale-streaming safety net
// ---------------------------------------------------------------------------
// When the backend's `message_completed` event fires too early (before the
// agent actually finishes) or never fires at all, the session stays stuck in
// "streaming".  We schedule a debounced check after every streaming event.
// If no new events arrive within STALE_STREAMING_MS, and there is no
// genuinely active work, the session is forced back to "idle".
// ---------------------------------------------------------------------------
// Safety net: if the backend dies and never sends message-completed,
// force idle after a long silence so the UI doesn't stay stuck forever.
const STALE_STREAMING_MS = 120_000;
const _staleTimers = new Map<string, ReturnType<typeof setTimeout>>();
const _queueDrainLocks = new Set<string>();

function scheduleStaleStreamingCheck(sessionId: string) {
    clearStaleStreamingCheck(sessionId);
    _staleTimers.set(
        sessionId,
        setTimeout(() => {
            _staleTimers.delete(sessionId);
            const staleAt = Date.now();
            useChatStore.setState((s) => {
                const sess = s.sessionsById[sessionId];
                if (!sess || sess.status !== "streaming") return s;
                return {
                    sessionsById: {
                        ...s.sessionsById,
                        [sessionId]: {
                            ...sess,
                            status: "idle",
                            messages: stampElapsedOnTurnStarted(
                                sess.messages.map((m) =>
                                    m.inProgress
                                        ? { ...m, inProgress: false }
                                        : m,
                                ),
                                staleAt,
                            ),
                        },
                    },
                };
            });

            const updated = useChatStore.getState().sessionsById[sessionId];
            if (updated) persistSession(updated);
            void useChatStore.getState().tryDrainQueue(sessionId);
        }, STALE_STREAMING_MS),
    );
}

function clearStaleStreamingCheck(sessionId: string) {
    const timer = _staleTimers.get(sessionId);
    if (timer) {
        clearTimeout(timer);
        _staleTimers.delete(sessionId);
    }
}

// ---------------------------------------------------------------------------
// Delta buffering: accumulate rapid deltas and flush to Zustand on rAF
// ---------------------------------------------------------------------------
interface DeltaBuffer {
    messageDelta: Map<string, { message_id: string; text: string }>;
    thinkingDelta: Map<string, Map<string, string>>;
    rafId: number | null;
}

const _deltaBuffer: DeltaBuffer = {
    messageDelta: new Map(),
    thinkingDelta: new Map(),
    rafId: null,
};

function flushDeltas() {
    _deltaBuffer.rafId = null;
    const { messageDelta, thinkingDelta } = _deltaBuffer;

    if (messageDelta.size === 0 && thinkingDelta.size === 0) return;

    const msgEntries = new Map(messageDelta);
    const thinkEntries = new Map(thinkingDelta);
    messageDelta.clear();
    thinkingDelta.clear();

    useChatStore.setState((state) => {
        let sessionsById = state.sessionsById;
        let changed = false;

        // Apply message deltas
        for (const [sessionId, { message_id, text }] of msgEntries) {
            const session = sessionsById[sessionId];
            if (!session) continue;
            const workCycleId =
                session.activeWorkCycleId ?? session.visibleWorkCycleId ?? null;

            const messages = session.messages;
            const lastMsg = messages[messages.length - 1];

            let newMessages: typeof messages;
            if (
                lastMsg &&
                lastMsg.role === "assistant" &&
                lastMsg.kind === "text" &&
                lastMsg.inProgress
            ) {
                newMessages = messages.slice();
                newMessages[newMessages.length - 1] = {
                    ...lastMsg,
                    content: lastMsg.content + text,
                };
            } else {
                const idTaken = messages.some((m) => m.id === message_id);
                newMessages = [
                    ...messages,
                    {
                        id: idTaken
                            ? `${message_id}:${Date.now()}`
                            : message_id,
                        role: "assistant" as const,
                        kind: "text" as const,
                        content: text,
                        workCycleId,
                        title: "Assistant",
                        timestamp: Date.now(),
                        inProgress: true,
                    },
                ];
            }

            sessionsById = {
                ...sessionsById,
                [sessionId]: { ...session, messages: newMessages },
            };
            changed = true;
        }

        // Apply thinking deltas
        for (const [sessionId, msgMap] of thinkEntries) {
            const session = sessionsById[sessionId];
            if (!session) continue;

            const messages = session.messages.slice();
            for (const [messageId, text] of msgMap) {
                const idx = messages.findIndex((m) => m.id === messageId);
                if (idx !== -1) {
                    const msg = messages[idx];
                    messages[idx] = {
                        ...msg,
                        content: msg.content + text,
                        inProgress: true,
                    };
                }
            }

            sessionsById = {
                ...sessionsById,
                [sessionId]: { ...session, messages },
            };
            changed = true;
        }

        if (!changed) return state;

        // Touch sessionOrder for all affected sessions
        let sessionOrder = state.sessionOrder;
        for (const sid of new Set([
            ...msgEntries.keys(),
            ...thinkEntries.keys(),
        ])) {
            sessionOrder = touchSessionOrder(sessionOrder, sid);
        }

        return { sessionsById, sessionOrder };
    });
}

function scheduleDeltaFlush() {
    if (_deltaBuffer.rafId === null) {
        _deltaBuffer.rafId = requestAnimationFrame(flushDeltas);
    }
}

function bufferMessageDelta(
    session_id: string,
    message_id: string,
    delta: string,
) {
    const existing = _deltaBuffer.messageDelta.get(session_id);
    if (existing) {
        existing.text += delta;
    } else {
        _deltaBuffer.messageDelta.set(session_id, { message_id, text: delta });
    }
    scheduleDeltaFlush();
}

function bufferThinkingDelta(
    session_id: string,
    message_id: string,
    delta: string,
) {
    let sessionMap = _deltaBuffer.thinkingDelta.get(session_id);
    if (!sessionMap) {
        sessionMap = new Map();
        _deltaBuffer.thinkingDelta.set(session_id, sessionMap);
    }
    const existing = sessionMap.get(message_id);
    sessionMap.set(message_id, existing ? existing + delta : delta);
    scheduleDeltaFlush();
}

function flushDeltasSync() {
    if (_deltaBuffer.rafId !== null) {
        cancelAnimationFrame(_deltaBuffer.rafId);
        _deltaBuffer.rafId = null;
    }
    flushDeltas();
}

async function persistSession(session: AIChatSession) {
    const vaultPath = useVaultStore.getState().vaultPath;
    if (!vaultPath) return;
    if (!hasPersistableSessionContent(session)) return;

    const historyRetentionDays = useChatStore.getState().historyRetentionDays;
    try {
        await aiSaveSessionHistory(vaultPath, toPersistedHistory(session));
        if (historyRetentionDays > 0) {
            await aiPruneSessionHistories(vaultPath, historyRetentionDays);
        }
    } catch (error) {
        console.warn("Failed to persist session history:", error);
    }
}

async function pruneSessionHistoriesForCurrentVault(maxAgeDays: number) {
    const vaultPath = useVaultStore.getState().vaultPath;
    if (!vaultPath || maxAgeDays <= 0) return 0;
    return aiPruneSessionHistories(vaultPath, maxAgeDays);
}

function restoreMessagesFromHistory(
    history: PersistedSessionHistory,
): AIChatMessage[] {
    return history.messages.map((m) => ({
        id: m.id,
        role: m.role as AIChatRole,
        kind: m.kind as AIChatMessageKind,
        content: m.content,
        timestamp: m.timestamp,
        title: m.title,
        meta: m.meta,
        permissionRequestId: m.permission_request_id,
        permissionOptions: m.permission_options,
        diffs: m.diffs,
        userInputRequestId: m.user_input_request_id,
        userInputQuestions: m.user_input_questions,
        planEntries: m.plan_entries,
        planDetail: m.plan_detail,
    }));
}

export const useChatStore = create<ChatStore>((set, get) => {
    const initialPreferences = getNormalizedAiPreferences();

    function patchQueuedMessage(
        sessionId: string,
        messageId: string,
        patch: Partial<QueuedChatMessage>,
    ) {
        set((state) => {
            const nextQueuedMessagesBySessionId = updateQueuedMessage(
                state.queuedMessagesBySessionId,
                sessionId,
                messageId,
                (item) => ({ ...item, ...patch }),
            );
            return nextQueuedMessagesBySessionId ===
                state.queuedMessagesBySessionId
                ? state
                : {
                      queuedMessagesBySessionId: nextQueuedMessagesBySessionId,
                  };
        });
    }

    async function syncQueuedMessageConfig(
        sessionId: string,
        queuedItem: QueuedChatMessage,
    ) {
        let session = get().sessionsById[sessionId];
        if (!session) return null;

        const selectedModelId =
            getModelConfigOption(session)?.value ?? session.modelId;
        if (
            queuedItem.modelId &&
            queuedItem.modelId !== selectedModelId &&
            supportsModelSelection(session, queuedItem.modelId)
        ) {
            const modelConfig = getModelConfigOption(session);
            session =
                modelConfig &&
                modelConfig.options.some(
                    (option) => option.value === queuedItem.modelId,
                )
                    ? await aiSetConfigOption(
                          sessionId,
                          modelConfig.id,
                          queuedItem.modelId,
                      )
                    : await aiSetModel(sessionId, queuedItem.modelId);
            get().upsertSession(session);
        }

        session = get().sessionsById[sessionId] ?? session;
        if (!session) return null;

        if (
            queuedItem.modeId &&
            queuedItem.modeId !== session.modeId &&
            session.modes.some(
                (mode) => mode.id === queuedItem.modeId && !mode.disabled,
            )
        ) {
            session = await aiSetMode(sessionId, queuedItem.modeId);
            get().upsertSession(session);
        }

        session = get().sessionsById[sessionId] ?? session;
        if (!session) return null;

        const modelOptionId = getModelConfigOption(session)?.id ?? null;
        for (const option of session.configOptions) {
            if (
                option.category === "mode" ||
                option.id === modelOptionId ||
                !(option.id in queuedItem.optionsSnapshot)
            ) {
                continue;
            }

            const nextValue = queuedItem.optionsSnapshot[option.id];
            if (
                nextValue === option.value ||
                !option.options.some(
                    (candidate) => candidate.value === nextValue,
                )
            ) {
                continue;
            }

            session = await aiSetConfigOption(sessionId, option.id, nextValue);
            get().upsertSession(session);
            session = get().sessionsById[sessionId] ?? session;
            if (!session) return null;
        }

        return session;
    }

    async function dispatchMessage(
        sessionId: string,
        queuedItem: QueuedChatMessage,
        source: "immediate" | "queue",
    ) {
        let activeSessionId = sessionId;
        let currentItem = queuedItem;
        let session = get().sessionsById[activeSessionId];
        if (!session || session.isResumingSession) {
            return;
        }

        if (session.isPersistedSession) {
            const resumedSessionId = await get().resumeSession(activeSessionId);
            if (!resumedSessionId) {
                if (source === "queue") {
                    patchQueuedMessage(activeSessionId, currentItem.id, {
                        status: "failed",
                    });
                }
                return;
            }

            activeSessionId = resumedSessionId;
            session = get().sessionsById[activeSessionId];
            if (!session) {
                return;
            }
        }

        if (source === "queue") {
            const queuedStateItem = get().queuedMessagesBySessionId[
                activeSessionId
            ]?.find((item) => item.id === currentItem.id);
            if (!queuedStateItem) {
                return;
            }

            currentItem = queuedStateItem;
            patchQueuedMessage(activeSessionId, currentItem.id, {
                status: "sending",
            });
            currentItem = get().queuedMessagesBySessionId[
                activeSessionId
            ]?.find((item) => item.id === currentItem.id) ?? {
                ...currentItem,
                status: "sending",
            };
        }

        if (!session || isSessionBusy(session)) {
            if (source === "queue") {
                patchQueuedMessage(activeSessionId, currentItem.id, {
                    status: "queued",
                });
            }
            return;
        }

        try {
            session =
                (await syncQueuedMessageConfig(activeSessionId, currentItem)) ??
                session;
            if (!session) return;

            const userMessageId =
                currentItem.optimisticMessageId ?? crypto.randomUUID();
            if (
                source === "queue" &&
                currentItem.optimisticMessageId !== userMessageId
            ) {
                patchQueuedMessage(activeSessionId, currentItem.id, {
                    optimisticMessageId: userMessageId,
                });
            }

            set((state) => {
                const targetSession = state.sessionsById[activeSessionId];
                if (!targetSession) return state;
                const nextSession = startNewWorkCycle(targetSession);
                const userMessage: AIChatMessage = {
                    ...createTextMessage("user", currentItem.content),
                    id: userMessageId,
                    workCycleId: nextSession.activeWorkCycleId,
                };

                const hasUserMessage = nextSession.messages.some(
                    (message) => message.id === userMessageId,
                );

                return {
                    sessionsById: {
                        ...state.sessionsById,
                        [activeSessionId]: {
                            ...nextSession,
                            status: "streaming",
                            attachments:
                                source === "immediate"
                                    ? []
                                    : nextSession.attachments,
                            messages: hasUserMessage
                                ? nextSession.messages
                                : [...nextSession.messages, userMessage],
                        },
                    },
                    sessionOrder: touchSessionOrder(
                        state.sessionOrder,
                        activeSessionId,
                    ),
                    ...(source === "immediate"
                        ? {
                              composerPartsBySessionId: {
                                  ...state.composerPartsBySessionId,
                                  [activeSessionId]: createEmptyComposerParts(),
                              },
                          }
                        : {}),
                };
            });

            const afterSend = get().sessionsById[activeSessionId];
            if (afterSend) {
                void persistSession(afterSend);
            }

            const nextSession = await aiSendMessage(
                activeSessionId,
                currentItem.prompt,
                currentItem.attachments,
            );
            get().upsertSession({
                ...nextSession,
                historySessionId: session.historySessionId,
                resumeContextPending: false,
            });

            if (source === "queue") {
                get().removeQueuedMessage(activeSessionId, currentItem.id);
            }
        } catch (error) {
            const message = getAiErrorMessage(
                error,
                "Failed to send the message.",
            );
            get().applySessionError({
                session_id: activeSessionId,
                message,
            });
            if (source === "queue") {
                patchQueuedMessage(activeSessionId, currentItem.id, {
                    status: "failed",
                });
            }
            if (isAuthenticationErrorMessage(message)) {
                await get().refreshSetupStatus();
            }
        }
    }

    return {
        runtimeConnection: INITIAL_RUNTIME_CONNECTION,
        setupStatus: null,
        runtimes: [],
        sessionsById: {},
        sessionOrder: [],
        activeSessionId: null,
        notePickerOpen: false,
        autoContextEnabled: initialPreferences.autoContextEnabled,
        requireCmdEnterToSend: initialPreferences.requireCmdEnterToSend,
        composerFontSize: initialPreferences.composerFontSize,
        chatFontSize: initialPreferences.chatFontSize,
        composerFontFamily: initialPreferences.composerFontFamily,
        chatFontFamily: initialPreferences.chatFontFamily,
        editDiffZoom: initialPreferences.editDiffZoom,
        historyRetentionDays: initialPreferences.historyRetentionDays,
        composerPartsBySessionId: {},
        queuedMessagesBySessionId: {},
        queuedMessageEditBySessionId: {},

        initialize: async () => {
            const current = get().runtimeConnection.status;
            if (current === "loading" || current === "ready") return;

            set({
                runtimeConnection: {
                    status: "loading",
                    message: null,
                },
            });

            try {
                const runtimes = hydrateRuntimesFromCache(
                    await aiListRuntimes(),
                );

                set({
                    runtimes,
                    runtimeConnection: {
                        status: "ready",
                        message: null,
                    },
                });

                const setupStatus = await aiGetSetupStatus();
                set({ setupStatus });
                if (setupStatus.onboardingRequired) {
                    return;
                }

                const vaultPath = useVaultStore.getState().vaultPath;
                const sessions = await aiListSessions(vaultPath);
                const hydratedRuntimes = hydrateRuntimesFromSessions(
                    runtimes,
                    sessions,
                );

                let histories: PersistedSessionHistory[] = [];
                let persistedBySessionId = new Map<
                    string,
                    PersistedSessionHistory
                >();
                if (vaultPath) {
                    try {
                        const retentionDays = get().historyRetentionDays;
                        if (retentionDays > 0) {
                            await aiPruneSessionHistories(
                                vaultPath,
                                retentionDays,
                            );
                        }
                        histories = (
                            await aiLoadSessionHistories(vaultPath)
                        ).filter(hasPersistedHistoryContent);
                        persistedBySessionId = new Map(
                            histories.map((h) => [h.session_id, h]),
                        );
                    } catch {
                        // Disk histories unavailable, continue without them
                    }
                }

                if (sessions.length || histories.length) {
                    set((state) => {
                        const nextSessionsById = sessions.reduce<
                            Record<string, AIChatSession>
                        >((accumulator, session) => {
                            const existing =
                                state.sessionsById[session.sessionId];
                            const merged = mergeSession(existing, session);
                            const persisted = persistedBySessionId.get(
                                merged.historySessionId,
                            );

                            if (merged.messages.length === 0 && persisted) {
                                merged.messages =
                                    restoreMessagesFromHistory(persisted);
                            }

                            accumulator[session.sessionId] = merged;
                            return accumulator;
                        }, {});

                        const liveHistoryIds = new Set(
                            Object.values(nextSessionsById).map(
                                (session) => session.historySessionId,
                            ),
                        );

                        for (const history of histories) {
                            if (liveHistoryIds.has(history.session_id))
                                continue;
                            const restored = createPersistedSession(
                                history,
                                hydratedRuntimes,
                            );
                            if (!restored) continue;
                            nextSessionsById[restored.sessionId] = restored;
                        }

                        const nextSessionOrder =
                            sortSessionIdsByRecency(nextSessionsById);
                        const nextActiveSessionId =
                            state.activeSessionId &&
                            nextSessionsById[state.activeSessionId]
                                ? state.activeSessionId
                                : (nextSessionOrder[0] ?? null);

                        return {
                            runtimes: hydratedRuntimes,
                            sessionsById: nextSessionsById,
                            sessionOrder: nextSessionOrder,
                            activeSessionId: nextActiveSessionId,
                            composerPartsBySessionId: nextSessionOrder.reduce<
                                Record<string, AIComposerPart[]>
                            >(
                                (accumulator, sessionId) => {
                                    accumulator[sessionId] =
                                        state.composerPartsBySessionId[
                                            sessionId
                                        ] ?? createEmptyComposerParts();
                                    return accumulator;
                                },
                                { ...state.composerPartsBySessionId },
                            ),
                        };
                    });

                    const nextActiveSessionId = get().activeSessionId;
                    if (
                        nextActiveSessionId &&
                        get().sessionsById[nextActiveSessionId]
                            ?.isPersistedSession
                    ) {
                        await get().resumeSession(nextActiveSessionId);
                    }
                    return;
                }

                if (!get().activeSessionId) {
                    const runtimeId = getDefaultRuntimeId(runtimes);
                    if (runtimeId) {
                        await get().newSession(runtimeId);
                    }
                }
            } catch (error) {
                set({
                    runtimeConnection: {
                        status: "error",
                        message: getAiErrorMessage(
                            error,
                            "Failed to load AI runtimes.",
                        ),
                    },
                });
            }
        },

        refreshSetupStatus: async () => {
            try {
                const setupStatus = await aiGetSetupStatus();
                set({
                    setupStatus,
                    ...getRuntimeConnectionPatchForSetup(setupStatus),
                });
            } catch (error) {
                set({
                    runtimeConnection: {
                        status: "error",
                        message: getAiErrorMessage(
                            error,
                            "Failed to check the AI setup.",
                        ),
                    },
                });
            }
        },

        saveSetup: async (input) => {
            try {
                const setupStatus = await aiUpdateSetup(input);
                set({
                    setupStatus,
                    ...getRuntimeConnectionPatchForSetup(setupStatus),
                });

                if (!setupStatus.onboardingRequired) {
                    const state = get();
                    if (!state.activeSessionId && state.runtimes.length) {
                        await state.newSession(
                            getDefaultRuntimeId(state.runtimes) ?? undefined,
                        );
                    }
                }
            } catch (error) {
                set({
                    runtimeConnection: {
                        status: "error",
                        message: getAiErrorMessage(
                            error,
                            "Failed to save the AI setup.",
                        ),
                    },
                });
            }
        },

        startAuth: async (input) => {
            try {
                if (
                    input.customBinaryPath ||
                    input.codexApiKey ||
                    input.openaiApiKey
                ) {
                    const setupStatus = await aiUpdateSetup({
                        customBinaryPath: input.customBinaryPath,
                        codexApiKey: input.codexApiKey,
                        openaiApiKey: input.openaiApiKey,
                    });
                    set({
                        setupStatus,
                        ...getRuntimeConnectionPatchForSetup(setupStatus),
                    });
                }

                const setupStatus = await aiStartAuth(
                    input.methodId,
                    useVaultStore.getState().vaultPath,
                );
                set({
                    setupStatus,
                    ...getRuntimeConnectionPatchForSetup(setupStatus),
                });

                if (!setupStatus.onboardingRequired) {
                    const state = get();
                    if (!state.activeSessionId && state.runtimes.length) {
                        await state.newSession(
                            getDefaultRuntimeId(state.runtimes) ?? undefined,
                        );
                    }
                }
            } catch (error) {
                set({
                    runtimeConnection: {
                        status: "error",
                        message: getAiErrorMessage(
                            error,
                            "Failed to authenticate the AI runtime.",
                        ),
                    },
                });
            }
        },

        upsertSession: (session, activate = false) => {
            let shouldDrainQueue = false;
            set((state) => {
                const existing = state.sessionsById[session.sessionId];
                const isKnown = state.sessionOrder.includes(session.sessionId);

                // Ignore sessions from other vaults — only update known sessions
                // or explicitly activated ones (e.g. just created by this window).
                if (!isKnown && !activate) return state;

                const nextRuntimes = session.isPersistedSession
                    ? state.runtimes
                    : hydrateRuntimesFromSessions(state.runtimes, [session]);
                const nextSession = mergeSession(existing, session);
                shouldDrainQueue =
                    nextSession.status === "idle" &&
                    existing?.status !== "idle" &&
                    !nextSession.isResumingSession;

                return {
                    runtimes: nextRuntimes,
                    sessionsById: {
                        ...state.sessionsById,
                        [session.sessionId]: nextSession,
                    },
                    sessionOrder: activate
                        ? touchSessionOrder(
                              state.sessionOrder,
                              session.sessionId,
                          )
                        : state.sessionOrder,
                    activeSessionId:
                        activate || !state.activeSessionId
                            ? session.sessionId
                            : state.activeSessionId,
                    composerPartsBySessionId: state.composerPartsBySessionId[
                        session.sessionId
                    ]
                        ? state.composerPartsBySessionId
                        : {
                              ...state.composerPartsBySessionId,
                              [session.sessionId]: createEmptyComposerParts(),
                          },
                };
            });

            if (shouldDrainQueue) {
                void get().tryDrainQueue(session.sessionId);
            }
        },

        applySessionError: ({ session_id, message }) => {
            if (session_id) clearStaleStreamingCheck(session_id);
            set((state) => {
                const nextSetupStatus =
                    state.setupStatus && isAuthenticationErrorMessage(message)
                        ? {
                              ...state.setupStatus,
                              authReady: false,
                              authMethod: undefined,
                              onboardingRequired: true,
                              message:
                                  "You were signed out. Connect your ChatGPT account or add an API key to continue.",
                          }
                        : state.setupStatus;

                if (!session_id || !state.sessionsById[session_id]) {
                    return {
                        setupStatus: nextSetupStatus,
                        runtimeConnection: {
                            status: "error",
                            message,
                        },
                    };
                }

                const session = state.sessionsById[session_id];
                const revertedSession = {
                    ...session,
                    isResumingSession: false,
                    messages: session.messages.map((item) =>
                        item.kind === "permission" &&
                        item.meta?.status === "responding"
                            ? {
                                  ...item,
                                  meta: {
                                      ...item.meta,
                                      status: "pending",
                                  },
                              }
                            : item.kind === "user_input_request" &&
                                item.meta?.status === "responding"
                              ? {
                                    ...item,
                                    meta: {
                                        ...item.meta,
                                        status: "pending",
                                    },
                                }
                              : item,
                    ),
                };
                return {
                    setupStatus: nextSetupStatus,
                    sessionsById: {
                        ...state.sessionsById,
                        [session_id]: {
                            ...revertedSession,
                            status: "error",
                            messages: [
                                ...revertedSession.messages,
                                createErrorMessage(message),
                            ],
                        },
                    },
                    sessionOrder: touchSessionOrder(
                        state.sessionOrder,
                        session_id,
                    ),
                };
            });

            if (session_id) {
                const updatedSession = get().sessionsById[session_id];
                if (updatedSession) persistSession(updatedSession);
            }
        },

        applyMessageStarted: ({ session_id }) => {
            scheduleStaleStreamingCheck(session_id);
            set((state) => {
                const session = state.sessionsById[session_id];
                if (!session) return state;
                const nextSession = ensureSessionWorkCycle(session);

                // Don't create the message yet — it will be created lazily
                // on the first delta so it appears in chronological order
                // (after thinking and tool messages).
                return {
                    sessionsById: {
                        ...state.sessionsById,
                        [session_id]: {
                            ...nextSession,
                            status: "streaming",
                        },
                    },
                    sessionOrder: touchSessionOrder(
                        state.sessionOrder,
                        session_id,
                    ),
                };
            });
        },

        applyMessageDelta: ({ session_id, message_id, delta }) => {
            scheduleStaleStreamingCheck(session_id);
            bufferMessageDelta(session_id, message_id, delta);
        },

        applyMessageCompleted: ({ session_id }) => {
            clearStaleStreamingCheck(session_id);
            flushDeltasSync();
            const completedAt = Date.now();
            set((state) => {
                const session = state.sessionsById[session_id];
                if (!session) return state;

                return {
                    sessionsById: {
                        ...state.sessionsById,
                        [session_id]: {
                            ...session,
                            status: "idle",
                            // Mark ALL in-progress messages as done (text, thinking, etc.)
                            // Also stamp elapsed_ms on the latest turn_started message.
                            messages: stampElapsedOnTurnStarted(
                                session.messages.map((message) =>
                                    message.inProgress
                                        ? { ...message, inProgress: false }
                                        : message,
                                ),
                                completedAt,
                            ),
                        },
                    },
                    sessionOrder: touchSessionOrder(
                        state.sessionOrder,
                        session_id,
                    ),
                };
            });

            const updatedSession = get().sessionsById[session_id];
            if (updatedSession) persistSession(updatedSession);
            void get().tryDrainQueue(session_id);
        },

        applyThinkingStarted: ({ session_id, message_id }) => {
            scheduleStaleStreamingCheck(session_id);
            flushDeltasSync();
            set((state) => {
                const session = state.sessionsById[session_id];
                if (!session) return state;
                const nextSession = ensureSessionWorkCycle(session);

                const exists = nextSession.messages.some(
                    (message) => message.id === message_id,
                );
                if (exists) return state;

                return {
                    sessionsById: {
                        ...state.sessionsById,
                        [session_id]: {
                            ...nextSession,
                            status: "streaming",
                            messages: [
                                ...nextSession.messages,
                                {
                                    id: message_id,
                                    role: "assistant",
                                    kind: "thinking",
                                    content: "",
                                    workCycleId: nextSession.activeWorkCycleId,
                                    title: "Thinking",
                                    timestamp: Date.now(),
                                    inProgress: true,
                                },
                            ],
                        },
                    },
                    sessionOrder: touchSessionOrder(
                        state.sessionOrder,
                        session_id,
                    ),
                };
            });
        },

        applyThinkingDelta: ({ session_id, message_id, delta }) => {
            scheduleStaleStreamingCheck(session_id);
            bufferThinkingDelta(session_id, message_id, delta);
        },

        applyThinkingCompleted: ({ session_id, message_id }) => {
            scheduleStaleStreamingCheck(session_id);
            flushDeltasSync();
            set((state) => {
                const session = state.sessionsById[session_id];
                if (!session) return state;

                return {
                    sessionsById: {
                        ...state.sessionsById,
                        [session_id]: {
                            ...session,
                            messages: session.messages.map((message) =>
                                message.id === message_id
                                    ? {
                                          ...message,
                                          inProgress: false,
                                      }
                                    : message,
                            ),
                        },
                    },
                    sessionOrder: touchSessionOrder(
                        state.sessionOrder,
                        session_id,
                    ),
                };
            });
        },

        applyToolActivity: (payload) => {
            scheduleStaleStreamingCheck(payload.session_id);
            set((state) => {
                const session = state.sessionsById[payload.session_id];
                if (!session) return state;
                const nextSession = ensureSessionWorkCycle(session);
                const workCycleId = nextSession.activeWorkCycleId;
                const shouldConsolidate =
                    payload.status === "completed" &&
                    (payload.diffs?.length ?? 0) > 0 &&
                    Boolean(workCycleId);

                const messageId = `tool:${payload.tool_call_id}`;
                const nextMessage: AIChatMessage = {
                    id: messageId,
                    role: "assistant",
                    kind: "tool",
                    title: payload.title,
                    content: payload.summary ?? payload.title,
                    timestamp: Date.now(),
                    workCycleId: nextSession.activeWorkCycleId,
                    diffs: payload.diffs,
                    meta: {
                        tool: payload.kind,
                        status: payload.status,
                        target: payload.target ?? null,
                    },
                };

                const existingMessage = nextSession.messages.find(
                    (message) => message.id === messageId,
                );

                return {
                    sessionsById: {
                        ...state.sessionsById,
                        [payload.session_id]: {
                            ...(shouldConsolidate
                                ? setActiveEditedFilesBuffer(
                                      nextSession,
                                      consolidateEditedFilesBuffer(
                                          getActiveEditedFilesBuffer(
                                              nextSession,
                                          ),
                                          payload.diffs ?? [],
                                          Date.now(),
                                      ),
                                  )
                                : nextSession),
                            messages: existingMessage
                                ? nextSession.messages.map((message) =>
                                      message.id === messageId
                                          ? {
                                                ...nextMessage,
                                                workCycleId:
                                                    message.workCycleId ??
                                                    nextMessage.workCycleId,
                                                timestamp: message.timestamp,
                                            }
                                          : message,
                                  )
                                : [...nextSession.messages, nextMessage],
                        },
                    },
                    sessionOrder: touchSessionOrder(
                        state.sessionOrder,
                        payload.session_id,
                    ),
                };
            });
        },

        applyStatusEvent: (payload) => {
            scheduleStaleStreamingCheck(payload.session_id);
            set((state) => {
                const session = state.sessionsById[payload.session_id];
                if (!session) return state;
                const nextSession = ensureSessionWorkCycle(session);

                const messageId = `status:${payload.event_id}`;
                const nextMessage = {
                    ...createStatusMessage(payload),
                    workCycleId: nextSession.activeWorkCycleId,
                };
                const exists = nextSession.messages.some(
                    (message) => message.id === messageId,
                );

                return {
                    sessionsById: {
                        ...state.sessionsById,
                        [payload.session_id]: {
                            ...nextSession,
                            messages: exists
                                ? nextSession.messages.map((message) =>
                                      message.id === messageId
                                          ? {
                                                ...nextMessage,
                                                workCycleId:
                                                    message.workCycleId ??
                                                    nextMessage.workCycleId,
                                            }
                                          : message,
                                  )
                                : [...nextSession.messages, nextMessage],
                        },
                    },
                    sessionOrder: touchSessionOrder(
                        state.sessionOrder,
                        payload.session_id,
                    ),
                };
            });
        },

        applyPlanUpdate: (payload) => {
            scheduleStaleStreamingCheck(payload.session_id);
            set((state) => {
                const session = state.sessionsById[payload.session_id];
                if (!session) return state;
                const nextSession = ensureSessionWorkCycle(session);

                const nextMessage = {
                    ...createPlanMessage(payload),
                    workCycleId: nextSession.activeWorkCycleId,
                };
                const exists = nextSession.messages.some(
                    (message) => message.id === nextMessage.id,
                );

                return {
                    sessionsById: {
                        ...state.sessionsById,
                        [payload.session_id]: {
                            ...nextSession,
                            messages: exists
                                ? nextSession.messages.map((message) =>
                                      message.id === nextMessage.id
                                          ? {
                                                ...nextMessage,
                                                workCycleId:
                                                    message.workCycleId ??
                                                    nextMessage.workCycleId,
                                                timestamp: message.timestamp,
                                            }
                                          : message,
                                  )
                                : [...nextSession.messages, nextMessage],
                        },
                    },
                    sessionOrder: touchSessionOrder(
                        state.sessionOrder,
                        payload.session_id,
                    ),
                };
            });
        },

        applyPermissionRequest: (payload) =>
            set((state) => {
                const session = state.sessionsById[payload.session_id];
                if (!session) return state;
                const nextSession = ensureSessionWorkCycle(session);

                // Consolidate buffer when diffs arrive with the permission request
                const workCycleId = nextSession.activeWorkCycleId;
                const hasDiffs =
                    payload.diffs.length > 0 && Boolean(workCycleId);
                const sessionWithBuffer = hasDiffs
                    ? setActiveEditedFilesBuffer(
                          nextSession,
                          consolidateEditedFilesBuffer(
                              getActiveEditedFilesBuffer(nextSession),
                              payload.diffs,
                              Date.now(),
                          ),
                      )
                    : nextSession;

                const messageId = `permission:${payload.request_id}`;
                const nextMessage: AIChatMessage = {
                    id: messageId,
                    role: "assistant",
                    kind: "permission",
                    title: "Permission request",
                    content: payload.title,
                    timestamp: Date.now(),
                    workCycleId: nextSession.activeWorkCycleId,
                    permissionRequestId: payload.request_id,
                    permissionOptions: payload.options,
                    diffs: payload.diffs.length > 0 ? payload.diffs : undefined,
                    meta: {
                        status: "pending",
                        target: payload.target ?? null,
                    },
                };

                const exists = sessionWithBuffer.messages.some(
                    (message) => message.id === messageId,
                );

                return {
                    sessionsById: {
                        ...state.sessionsById,
                        [payload.session_id]: {
                            ...sessionWithBuffer,
                            status: "waiting_permission",
                            messages: exists
                                ? sessionWithBuffer.messages.map((message) =>
                                      message.id === messageId
                                          ? {
                                                ...nextMessage,
                                                workCycleId:
                                                    message.workCycleId ??
                                                    nextMessage.workCycleId,
                                            }
                                          : message,
                                  )
                                : [...sessionWithBuffer.messages, nextMessage],
                        },
                    },
                    sessionOrder: touchSessionOrder(
                        state.sessionOrder,
                        payload.session_id,
                    ),
                };
            }),

        applyUserInputRequest: (payload) =>
            set((state) => {
                const session = state.sessionsById[payload.session_id];
                if (!session) return state;
                const nextSession = ensureSessionWorkCycle(session);

                const messageId = `user-input:${payload.request_id}`;
                const nextMessage: AIChatMessage = {
                    id: messageId,
                    role: "assistant",
                    kind: "user_input_request",
                    title: payload.title,
                    content: payload.questions
                        .map((question) => question.question.trim())
                        .filter(Boolean)
                        .join("\n"),
                    timestamp: Date.now(),
                    workCycleId: nextSession.activeWorkCycleId,
                    userInputRequestId: payload.request_id,
                    userInputQuestions: payload.questions,
                    meta: {
                        status: "pending",
                    },
                };

                const exists = nextSession.messages.some(
                    (message) => message.id === messageId,
                );

                return {
                    sessionsById: {
                        ...state.sessionsById,
                        [payload.session_id]: {
                            ...nextSession,
                            status: "waiting_user_input",
                            messages: exists
                                ? nextSession.messages.map((message) =>
                                      message.id === messageId
                                          ? {
                                                ...nextMessage,
                                                workCycleId:
                                                    message.workCycleId ??
                                                    nextMessage.workCycleId,
                                            }
                                          : message,
                                  )
                                : [...nextSession.messages, nextMessage],
                        },
                    },
                    sessionOrder: touchSessionOrder(
                        state.sessionOrder,
                        payload.session_id,
                    ),
                };
            }),

        setActiveSession: (sessionId) =>
            set((state) =>
                state.sessionsById[sessionId]
                    ? { activeSessionId: sessionId }
                    : state,
            ),

        resumeSession: async (sessionId) => {
            const state = get();
            const session = state.sessionsById[sessionId];
            if (!session) return null;
            if (!session.isPersistedSession) return sessionId;
            if (session.isResumingSession) return sessionId;

            set((currentState) => {
                const currentSession = currentState.sessionsById[sessionId];
                if (!currentSession || !currentSession.isPersistedSession) {
                    return currentState;
                }

                return {
                    sessionsById: {
                        ...currentState.sessionsById,
                        [sessionId]: {
                            ...currentSession,
                            isResumingSession: true,
                        },
                    },
                };
            });

            try {
                const latestSession = get().sessionsById[sessionId];
                if (!latestSession || !latestSession.isPersistedSession) {
                    return get().activeSessionId;
                }

                let resumedSession = await aiCreateSession(
                    latestSession.runtimeId,
                    useVaultStore.getState().vaultPath,
                );
                const resumedModelConfig = getModelConfigOption(resumedSession);

                if (
                    resumedSession.modelId !== latestSession.modelId &&
                    supportsModelSelection(
                        resumedSession,
                        latestSession.modelId,
                    )
                ) {
                    resumedSession = resumedModelConfig
                        ? await aiSetConfigOption(
                              resumedSession.sessionId,
                              resumedModelConfig.id,
                              latestSession.modelId,
                          )
                        : await aiSetModel(
                              resumedSession.sessionId,
                              latestSession.modelId,
                          );
                }

                if (
                    resumedSession.modeId !== latestSession.modeId &&
                    resumedSession.modes.some(
                        (mode) =>
                            mode.id === latestSession.modeId && !mode.disabled,
                    )
                ) {
                    resumedSession = await aiSetMode(
                        resumedSession.sessionId,
                        latestSession.modeId,
                    );
                }

                for (const option of latestSession.configOptions) {
                    const current = resumedSession.configOptions.find(
                        (candidate) => candidate.id === option.id,
                    );
                    if (
                        current &&
                        current.value !== option.value &&
                        current.options.some(
                            (candidate) => candidate.value === option.value,
                        )
                    ) {
                        resumedSession = await aiSetConfigOption(
                            resumedSession.sessionId,
                            option.id,
                            option.value,
                        );
                    }
                }

                const migratedSession = startNewWorkCycle({
                    ...resumedSession,
                    historySessionId: latestSession.historySessionId,
                    messages: latestSession.messages,
                    attachments: latestSession.attachments,
                    editedFilesBuffer:
                        latestSession.editedFilesBuffer ??
                        deriveEditedFilesBufferFromLegacy(latestSession),
                    editedFilesBufferByWorkCycleId:
                        latestSession.editedFilesBufferByWorkCycleId ?? {},
                    effortsByModel:
                        resumedSession.effortsByModel ??
                        latestSession.effortsByModel ??
                        {},
                    isPersistedSession: false,
                    isResumingSession: false,
                    resumeContextPending: latestSession.messages.length > 0,
                });

                set((currentState) => {
                    const previousParts =
                        currentState.composerPartsBySessionId[sessionId] ??
                        createEmptyComposerParts();
                    const previousQueue =
                        currentState.queuedMessagesBySessionId[sessionId] ?? [];
                    const previousQueuedMessageEdit =
                        currentState.queuedMessageEditBySessionId[sessionId];
                    const nextSessionsById = { ...currentState.sessionsById };
                    delete nextSessionsById[sessionId];

                    const nextComposerParts = {
                        ...currentState.composerPartsBySessionId,
                    };
                    delete nextComposerParts[sessionId];
                    nextComposerParts[migratedSession.sessionId] =
                        previousParts;

                    const nextQueuedMessagesBySessionId = {
                        ...currentState.queuedMessagesBySessionId,
                    };
                    delete nextQueuedMessagesBySessionId[sessionId];
                    if (previousQueue.length > 0) {
                        nextQueuedMessagesBySessionId[
                            migratedSession.sessionId
                        ] = previousQueue;
                    }

                    const nextQueuedMessageEditBySessionId = {
                        ...currentState.queuedMessageEditBySessionId,
                    };
                    delete nextQueuedMessageEditBySessionId[sessionId];
                    if (previousQueuedMessageEdit) {
                        nextQueuedMessageEditBySessionId[
                            migratedSession.sessionId
                        ] = previousQueuedMessageEdit;
                    }

                    return {
                        runtimes: hydrateRuntimesFromSessions(
                            currentState.runtimes,
                            [migratedSession],
                        ),
                        sessionsById: {
                            ...nextSessionsById,
                            [migratedSession.sessionId]: migratedSession,
                        },
                        sessionOrder: touchSessionOrder(
                            currentState.sessionOrder.filter(
                                (id) => id !== sessionId,
                            ),
                            migratedSession.sessionId,
                        ),
                        activeSessionId:
                            currentState.activeSessionId === sessionId
                                ? migratedSession.sessionId
                                : currentState.activeSessionId,
                        composerPartsBySessionId: nextComposerParts,
                        queuedMessagesBySessionId:
                            nextQueuedMessagesBySessionId,
                        queuedMessageEditBySessionId:
                            nextQueuedMessageEditBySessionId,
                    };
                });
                _queueDrainLocks.delete(sessionId);
                useChatTabsStore
                    .getState()
                    .replaceSessionId(
                        sessionId,
                        migratedSession.sessionId,
                        migratedSession.historySessionId,
                    );

                return migratedSession.sessionId;
            } catch (error) {
                const message = getAiErrorMessage(
                    error,
                    "Failed to resume the saved chat.",
                );
                get().applySessionError({ session_id: sessionId, message });
                if (isAuthenticationErrorMessage(message)) {
                    await get().refreshSetupStatus();
                }
                return null;
            }
        },

        loadSession: async (sessionId) => {
            const existing = get().sessionsById[sessionId];
            if (existing) {
                set((state) => ({
                    activeSessionId: sessionId,
                    sessionOrder: touchSessionOrder(
                        state.sessionOrder,
                        sessionId,
                    ),
                }));
                if (existing.isPersistedSession) {
                    await get().resumeSession(sessionId);
                    return;
                }
            }

            try {
                const session = await aiLoadSession(sessionId);
                get().upsertSession(session, true);
            } catch (error) {
                get().applySessionError({
                    session_id: sessionId,
                    message: getAiErrorMessage(
                        error,
                        "Failed to load the session.",
                    ),
                });
            }
        },

        setModel: async (modelId) => {
            const { activeSessionId, sessionsById } = get();
            if (!activeSessionId) return;
            const session = sessionsById[activeSessionId];
            if (!session) return;
            if (
                session.status === "streaming" ||
                session.status === "waiting_permission" ||
                session.status === "waiting_user_input" ||
                session.isResumingSession
            ) {
                return;
            }

            if (session.isPersistedSession) {
                set((state) => ({
                    sessionsById: {
                        ...state.sessionsById,
                        [activeSessionId]: applyLocalModelSelection(
                            state.sessionsById[activeSessionId]!,
                            modelId,
                        ),
                    },
                }));
                saveAiPreferences({ modelId });
                return;
            }

            try {
                const modelConfig = getModelConfigOption(session);
                const updatedSession =
                    modelConfig &&
                    modelConfig.options.some(
                        (option) => option.value === modelId,
                    )
                        ? await aiSetConfigOption(
                              activeSessionId,
                              modelConfig.id,
                              modelId,
                          )
                        : await aiSetModel(activeSessionId, modelId);
                get().upsertSession(updatedSession);
                saveAiPreferences({ modelId });
            } catch (error) {
                get().applySessionError({
                    session_id: activeSessionId,
                    message: getAiErrorMessage(
                        error,
                        "Failed to update the model.",
                    ),
                });
            }
        },

        setMode: async (modeId) => {
            const { activeSessionId, sessionsById } = get();
            if (!activeSessionId) return;
            const session = sessionsById[activeSessionId];
            if (!session) return;
            if (
                session.status === "streaming" ||
                session.status === "waiting_permission" ||
                session.status === "waiting_user_input" ||
                session.isResumingSession
            ) {
                return;
            }

            if (session.isPersistedSession) {
                set((state) => ({
                    sessionsById: {
                        ...state.sessionsById,
                        [activeSessionId]: {
                            ...state.sessionsById[activeSessionId]!,
                            modeId,
                        },
                    },
                }));
                saveAiPreferences({ modeId });
                return;
            }

            try {
                const updatedSession = await aiSetMode(activeSessionId, modeId);
                get().upsertSession(updatedSession);
                saveAiPreferences({ modeId });
            } catch (error) {
                get().applySessionError({
                    session_id: activeSessionId,
                    message: getAiErrorMessage(
                        error,
                        "Failed to update the mode.",
                    ),
                });
            }
        },

        setConfigOption: async (optionId, value) => {
            const { activeSessionId, sessionsById } = get();
            if (!activeSessionId) return;
            const session = sessionsById[activeSessionId];
            if (!session) return;
            if (
                session.status === "streaming" ||
                session.status === "waiting_permission" ||
                session.status === "waiting_user_input" ||
                session.isResumingSession
            ) {
                return;
            }

            if (session.isPersistedSession) {
                set((state) => {
                    const currentSession = state.sessionsById[activeSessionId]!;
                    const nextSession =
                        optionId === "model"
                            ? applyLocalModelSelection(currentSession, value)
                            : {
                                  ...currentSession,
                                  configOptions:
                                      currentSession.configOptions.map(
                                          (option) =>
                                              option.id === optionId
                                                  ? { ...option, value }
                                                  : option,
                                      ),
                              };

                    return {
                        sessionsById: {
                            ...state.sessionsById,
                            [activeSessionId]: nextSession,
                        },
                    };
                });
                if (optionId === "model") {
                    saveAiPreferences({ modelId: value });
                } else {
                    saveConfigOptionPreference(optionId, value);
                }
                return;
            }

            try {
                const updatedSession = await aiSetConfigOption(
                    activeSessionId,
                    optionId,
                    value,
                );
                get().upsertSession(updatedSession);
                if (optionId === "model") {
                    saveAiPreferences({ modelId: value });
                } else {
                    saveConfigOptionPreference(optionId, value);
                }
            } catch (error) {
                get().applySessionError({
                    session_id: activeSessionId,
                    message: getAiErrorMessage(
                        error,
                        "Failed to update the session option.",
                    ),
                });
            }
        },

        setComposerParts: (parts) =>
            set((state) => {
                const activeSessionId = state.activeSessionId;
                if (!activeSessionId) return state;

                const session = state.sessionsById[activeSessionId];
                const mentionIds = new Set(
                    parts
                        .filter(
                            (
                                p,
                            ): p is Extract<
                                AIComposerPart,
                                { type: "mention" }
                            > => p.type === "mention",
                        )
                        .map((p) => p.noteId),
                );
                const folderPaths = new Set(
                    parts
                        .filter(
                            (
                                p,
                            ): p is Extract<
                                AIComposerPart,
                                { type: "folder_mention" }
                            > => p.type === "folder_mention",
                        )
                        .map((p) => p.folderPath),
                );

                const prunedAttachments = session
                    ? session.attachments.filter((a) => {
                          if (a.type === "note")
                              return mentionIds.has(a.noteId!);
                          if (a.type === "folder")
                              return folderPaths.has(a.noteId!);
                          return true;
                      })
                    : [];

                return {
                    composerPartsBySessionId: {
                        ...state.composerPartsBySessionId,
                        [activeSessionId]: parts,
                    },
                    ...(session &&
                    prunedAttachments.length !== session.attachments.length
                        ? {
                              sessionsById: {
                                  ...state.sessionsById,
                                  [activeSessionId]: {
                                      ...session,
                                      attachments: prunedAttachments,
                                  },
                              },
                          }
                        : {}),
                };
            }),

        enqueueMessage: (sessionId, item) =>
            set((state) => ({
                queuedMessagesBySessionId: {
                    ...state.queuedMessagesBySessionId,
                    [sessionId]: [
                        ...(state.queuedMessagesBySessionId[sessionId] ?? []),
                        item,
                    ],
                },
                sessionOrder: touchSessionOrder(state.sessionOrder, sessionId),
            })),

        removeQueuedMessage: (sessionId, messageId) => {
            let removed = false;
            set((state) => {
                const queue = state.queuedMessagesBySessionId[sessionId];
                if (!queue) return state;

                const nextQueue = queue.filter((item) => item.id !== messageId);
                if (nextQueue.length === queue.length) {
                    return state;
                }
                removed = true;

                return {
                    queuedMessagesBySessionId: cleanupQueuedMessagesBySessionId(
                        state.queuedMessagesBySessionId,
                        sessionId,
                        nextQueue,
                    ),
                };
            });

            if (
                removed &&
                get().sessionsById[sessionId]?.status === "idle" &&
                !get().queuedMessageEditBySessionId[sessionId]
            ) {
                void get().tryDrainQueue(sessionId);
            }
        },

        markQueuedMessageStatus: (sessionId, messageId, status) =>
            set((state) => {
                const nextQueuedMessagesBySessionId = updateQueuedMessage(
                    state.queuedMessagesBySessionId,
                    sessionId,
                    messageId,
                    (item) => ({ ...item, status }),
                );
                return nextQueuedMessagesBySessionId ===
                    state.queuedMessagesBySessionId
                    ? state
                    : {
                          queuedMessagesBySessionId:
                              nextQueuedMessagesBySessionId,
                      };
            }),

        clearSessionQueue: (sessionId) => {
            _queueDrainLocks.delete(sessionId);
            set((state) => {
                if (!(sessionId in state.queuedMessagesBySessionId)) {
                    return state;
                }

                const nextQueuedMessageEditBySessionId = {
                    ...state.queuedMessageEditBySessionId,
                };
                delete nextQueuedMessageEditBySessionId[sessionId];

                return {
                    queuedMessagesBySessionId: cleanupQueuedMessagesBySessionId(
                        state.queuedMessagesBySessionId,
                        sessionId,
                        [],
                    ),
                    queuedMessageEditBySessionId:
                        nextQueuedMessageEditBySessionId,
                };
            });
        },

        editQueuedMessage: (sessionId, messageId) =>
            set((state) => {
                if (state.queuedMessageEditBySessionId[sessionId]) {
                    return state;
                }

                const session = state.sessionsById[sessionId];
                const queue = state.queuedMessagesBySessionId[sessionId];
                if (!session || !queue) return state;

                const originalIndex = queue.findIndex(
                    (item) => item.id === messageId,
                );
                const queuedItem =
                    originalIndex >= 0 ? queue[originalIndex] : undefined;
                if (!queuedItem || queuedItem.status === "sending") {
                    return state;
                }

                const nextQueue = queue.filter((item) => item.id !== messageId);
                return {
                    sessionsById: {
                        ...state.sessionsById,
                        [sessionId]: {
                            ...session,
                            attachments:
                                queuedItem.attachments.map(cloneAttachment),
                        },
                    },
                    composerPartsBySessionId: {
                        ...state.composerPartsBySessionId,
                        [sessionId]: cloneComposerParts(
                            queuedItem.composerParts,
                        ),
                    },
                    queuedMessagesBySessionId: cleanupQueuedMessagesBySessionId(
                        state.queuedMessagesBySessionId,
                        sessionId,
                        nextQueue,
                    ),
                    queuedMessageEditBySessionId: {
                        ...state.queuedMessageEditBySessionId,
                        [sessionId]: {
                            item: queuedItem,
                            originalIndex,
                            previousItemId:
                                originalIndex > 0
                                    ? (queue[originalIndex - 1]?.id ?? null)
                                    : null,
                            nextItemId: queue[originalIndex + 1]?.id ?? null,
                            previousComposerParts: cloneComposerParts(
                                state.composerPartsBySessionId[sessionId] ??
                                    createEmptyComposerParts(),
                            ),
                            previousAttachments:
                                session.attachments.map(cloneAttachment),
                        },
                    },
                };
            }),

        cancelQueuedMessageEdit: (sessionId) => {
            let shouldDrainQueue = false;
            set((state) => {
                const session = state.sessionsById[sessionId];
                const editState = state.queuedMessageEditBySessionId[sessionId];
                if (!session || !editState) {
                    return state;
                }

                const nextQueue = restoreQueuedMessagePosition(
                    state.queuedMessagesBySessionId[sessionId] ?? [],
                    editState,
                    editState.item,
                );
                const nextQueuedMessageEditBySessionId = {
                    ...state.queuedMessageEditBySessionId,
                };
                delete nextQueuedMessageEditBySessionId[sessionId];
                shouldDrainQueue = session.status === "idle";

                return {
                    sessionsById: {
                        ...state.sessionsById,
                        [sessionId]: {
                            ...session,
                            attachments:
                                editState.previousAttachments.map(
                                    cloneAttachment,
                                ),
                        },
                    },
                    composerPartsBySessionId: {
                        ...state.composerPartsBySessionId,
                        [sessionId]: cloneComposerParts(
                            editState.previousComposerParts,
                        ),
                    },
                    queuedMessagesBySessionId: {
                        ...state.queuedMessagesBySessionId,
                        [sessionId]: nextQueue,
                    },
                    queuedMessageEditBySessionId:
                        nextQueuedMessageEditBySessionId,
                };
            });

            if (shouldDrainQueue) {
                void get().tryDrainQueue(sessionId);
            }
        },

        sendMessage: async () => {
            const { activeSessionId, sessionsById, composerPartsBySessionId } =
                get();
            if (!activeSessionId) return;

            const session = sessionsById[activeSessionId];
            if (!session || session.isResumingSession) {
                return;
            }

            const composerParts =
                composerPartsBySessionId[activeSessionId] ??
                createEmptyComposerParts();
            const queuedItem = buildQueuedMessage(session, composerParts);
            if (!queuedItem) return;

            const queuedMessageEdit =
                get().queuedMessageEditBySessionId[activeSessionId];
            if (queuedMessageEdit) {
                const updatedQueuedItem: QueuedChatMessage = {
                    ...queuedMessageEdit.item,
                    ...queuedItem,
                    id: queuedMessageEdit.item.id,
                    status: "queued",
                    optimisticMessageId: undefined,
                };

                set((state) => {
                    const targetSession = state.sessionsById[activeSessionId];
                    const currentEdit =
                        state.queuedMessageEditBySessionId[activeSessionId];
                    if (!targetSession || !currentEdit) {
                        return state;
                    }

                    const nextQueuedMessageEditBySessionId = {
                        ...state.queuedMessageEditBySessionId,
                    };
                    delete nextQueuedMessageEditBySessionId[activeSessionId];

                    return {
                        sessionsById: {
                            ...state.sessionsById,
                            [activeSessionId]: {
                                ...targetSession,
                                attachments:
                                    currentEdit.previousAttachments.map(
                                        cloneAttachment,
                                    ),
                            },
                        },
                        composerPartsBySessionId: {
                            ...state.composerPartsBySessionId,
                            [activeSessionId]: cloneComposerParts(
                                currentEdit.previousComposerParts,
                            ),
                        },
                        queuedMessagesBySessionId: {
                            ...state.queuedMessagesBySessionId,
                            [activeSessionId]: restoreQueuedMessagePosition(
                                state.queuedMessagesBySessionId[
                                    activeSessionId
                                ] ?? [],
                                currentEdit,
                                updatedQueuedItem,
                            ),
                        },
                        queuedMessageEditBySessionId:
                            nextQueuedMessageEditBySessionId,
                        sessionOrder: touchSessionOrder(
                            state.sessionOrder,
                            activeSessionId,
                        ),
                    };
                });

                if (get().sessionsById[activeSessionId]?.status === "idle") {
                    void get().tryDrainQueue(activeSessionId);
                }
                return;
            }

            if (isSessionBusy(session)) {
                get().enqueueMessage(activeSessionId, queuedItem);
                set((state) => {
                    const targetSession = state.sessionsById[activeSessionId];
                    if (!targetSession) return state;

                    return {
                        sessionsById: {
                            ...state.sessionsById,
                            [activeSessionId]: {
                                ...targetSession,
                                attachments: [],
                            },
                        },
                        composerPartsBySessionId: {
                            ...state.composerPartsBySessionId,
                            [activeSessionId]: createEmptyComposerParts(),
                        },
                    };
                });
                return;
            }

            await dispatchMessage(activeSessionId, queuedItem, "immediate");
        },

        retryQueuedMessage: async (sessionId, messageId) => {
            if (get().queuedMessageEditBySessionId[sessionId]) {
                return;
            }

            get().markQueuedMessageStatus(sessionId, messageId, "queued");

            const session = get().sessionsById[sessionId];
            if (
                !session ||
                session.isResumingSession ||
                isSessionBusy(session)
            ) {
                return;
            }

            const nextItem = get().queuedMessagesBySessionId[sessionId]?.find(
                (item) => item.status === "queued",
            );
            if (!nextItem || nextItem.id !== messageId) {
                return;
            }

            if (session.status === "idle") {
                await get().tryDrainQueue(sessionId);
                return;
            }

            if (_queueDrainLocks.has(sessionId)) {
                return;
            }

            _queueDrainLocks.add(sessionId);
            try {
                await dispatchMessage(sessionId, nextItem, "queue");
            } finally {
                _queueDrainLocks.delete(sessionId);
            }
        },

        sendQueuedMessageNow: async (sessionId, messageId) => {
            if (get().queuedMessageEditBySessionId[sessionId]) {
                return;
            }

            let shouldDrain = false;
            set((state) => {
                const queue = state.queuedMessagesBySessionId[sessionId];
                const session = state.sessionsById[sessionId];
                if (!queue || !session) {
                    return state;
                }

                const currentItem = queue.find((item) => item.id === messageId);
                if (!currentItem || currentItem.status === "sending") {
                    return state;
                }

                const nextQueue = prioritizeQueuedMessage(queue, messageId);
                shouldDrain =
                    session.status === "idle" &&
                    nextQueue[0]?.id === messageId &&
                    !_queueDrainLocks.has(sessionId);

                return nextQueue === queue
                    ? {
                          queuedMessagesBySessionId: updateQueuedMessage(
                              state.queuedMessagesBySessionId,
                              sessionId,
                              messageId,
                              (item) => ({ ...item, status: "queued" }),
                          ),
                      }
                    : {
                          queuedMessagesBySessionId: {
                              ...state.queuedMessagesBySessionId,
                              [sessionId]: nextQueue,
                          },
                      };
            });

            if (shouldDrain) {
                await get().tryDrainQueue(sessionId);
            }
        },

        tryDrainQueue: async (sessionId) => {
            const session = get().sessionsById[sessionId];
            if (
                !session ||
                session.status !== "idle" ||
                session.isResumingSession ||
                Boolean(get().queuedMessageEditBySessionId[sessionId])
            ) {
                return;
            }

            if (_queueDrainLocks.has(sessionId)) {
                return;
            }

            const nextItem = get().queuedMessagesBySessionId[sessionId]?.find(
                (item) => item.status === "queued",
            );
            if (!nextItem) {
                return;
            }

            _queueDrainLocks.add(sessionId);
            try {
                await dispatchMessage(sessionId, nextItem, "queue");
            } finally {
                _queueDrainLocks.delete(sessionId);
            }
        },

        stopStreaming: async () => {
            const { activeSessionId } = get();
            if (!activeSessionId) return;

            clearStaleStreamingCheck(activeSessionId);

            try {
                const session = await aiCancelTurn(activeSessionId);
                get().upsertSession(session);
            } catch (error) {
                get().applySessionError({
                    session_id: activeSessionId,
                    message: getAiErrorMessage(
                        error,
                        "Failed to stop the current turn.",
                    ),
                });
            }

            // Explicitly transition to idle — same as applyMessageCompleted.
            const stoppedAt = Date.now();
            set((state) => {
                const sess = state.sessionsById[activeSessionId];
                if (!sess || sess.status === "idle") return state;
                return {
                    sessionsById: {
                        ...state.sessionsById,
                        [activeSessionId]: {
                            ...sess,
                            status: "idle",
                            messages: stampElapsedOnTurnStarted(
                                sess.messages.map((m) =>
                                    m.inProgress
                                        ? { ...m, inProgress: false }
                                        : m,
                                ),
                                stoppedAt,
                            ),
                        },
                    },
                };
            });
            void get().tryDrainQueue(activeSessionId);
        },

        respondPermission: async (requestId, optionId) => {
            const { activeSessionId } = get();
            if (!activeSessionId) return;

            // Optimistically mark as streaming since the agent will resume
            set((state) => {
                const session = state.sessionsById[activeSessionId];
                if (!session) return state;
                return {
                    sessionsById: {
                        ...state.sessionsById,
                        [activeSessionId]: updatePermissionMessageState(
                            { ...session, status: "streaming" },
                            requestId,
                            {
                                status: "responding",
                                resolved_option: optionId ?? null,
                            },
                        ),
                    },
                };
            });

            try {
                const session = await aiRespondPermission(
                    activeSessionId,
                    requestId,
                    optionId,
                );
                get().upsertSession(session);
                set((state) => {
                    const currentSession = state.sessionsById[activeSessionId];
                    if (!currentSession) return state;
                    return {
                        sessionsById: {
                            ...state.sessionsById,
                            [activeSessionId]: updatePermissionMessageState(
                                currentSession,
                                requestId,
                                {
                                    status: "resolved",
                                    resolved_option: optionId ?? null,
                                },
                            ),
                        },
                    };
                });
            } catch (error) {
                get().applySessionError({
                    session_id: activeSessionId,
                    message: getAiErrorMessage(
                        error,
                        "Failed to resolve the permission request.",
                    ),
                });
            }
        },

        respondUserInput: async (requestId, answers) => {
            const { activeSessionId } = get();
            if (!activeSessionId) return;

            set((state) => {
                const session = state.sessionsById[activeSessionId];
                if (!session) return state;
                return {
                    sessionsById: {
                        ...state.sessionsById,
                        [activeSessionId]: updateUserInputMessageState(
                            { ...session, status: "streaming" },
                            requestId,
                            {
                                status: "responding",
                                answered: true,
                            },
                        ),
                    },
                };
            });

            try {
                const session = await aiRespondUserInput(
                    activeSessionId,
                    requestId,
                    answers,
                );
                get().upsertSession(session);
                set((state) => {
                    const currentSession = state.sessionsById[activeSessionId];
                    if (!currentSession) return state;
                    return {
                        sessionsById: {
                            ...state.sessionsById,
                            [activeSessionId]: updateUserInputMessageState(
                                currentSession,
                                requestId,
                                {
                                    status: "resolved",
                                    answered: true,
                                },
                            ),
                        },
                    };
                });
            } catch (error) {
                get().applySessionError({
                    session_id: activeSessionId,
                    message: getAiErrorMessage(
                        error,
                        "Failed to respond to the input request.",
                    ),
                });
            }
        },

        rejectEditedFile: async (sessionId, identityKey) => {
            const { sessionsById } = get();
            const vaultPath = useVaultStore.getState().vaultPath;
            if (!vaultPath) return;

            const session = sessionsById[sessionId];
            if (!session) return;

            const entry =
                getSessionEditedFilesBuffer(session).find(
                    (item) => item.identityKey === identityKey,
                ) ?? null;
            if (!entry || !entry.supported) {
                return;
            }

            try {
                const restoreCheck = await hasSafeRestoreTarget(
                    vaultPath,
                    entry,
                );

                if (restoreCheck.conflict) {
                    set((state) => {
                        const currentSession = state.sessionsById[sessionId];
                        if (!currentSession) return state;

                        return {
                            sessionsById: {
                                ...state.sessionsById,
                                [sessionId]: markEditedFileEntryConflict(
                                    currentSession,
                                    identityKey,
                                    restoreCheck.currentHash,
                                ),
                            },
                        };
                    });

                    const updatedSession = get().sessionsById[sessionId];
                    if (updatedSession) {
                        void persistSession(updatedSession);
                    }
                    return;
                }

                await restoreEditedFileEntry(vaultPath, entry);

                set((state) => {
                    const currentSession = state.sessionsById[sessionId];
                    if (!currentSession) return state;

                    return {
                        sessionsById: {
                            ...state.sessionsById,
                            [sessionId]: removeEditedFilesBufferEntry(
                                currentSession,
                                identityKey,
                            ),
                        },
                    };
                });

                const updatedSession = get().sessionsById[sessionId];
                if (updatedSession) {
                    void persistSession(updatedSession);
                }
            } catch (error) {
                get().applySessionError({
                    session_id: sessionId,
                    message: getAiErrorMessage(
                        error,
                        "Failed to reject the file changes.",
                    ),
                });
            }
        },

        resolveEditedFileWithMergedText: async (
            sessionId,
            identityKey,
            mergedText,
        ) => {
            const { sessionsById } = get();
            const vaultPath = useVaultStore.getState().vaultPath;
            if (!vaultPath) return;

            const session = sessionsById[sessionId];
            if (!session) return;

            const entry =
                getSessionEditedFilesBuffer(session).find(
                    (item) => item.identityKey === identityKey,
                ) ?? null;
            if (!entry || !entry.supported || entry.isText === false) {
                return;
            }

            try {
                const restoreCheck = await hasSafeRestoreTarget(
                    vaultPath,
                    entry,
                );

                if (restoreCheck.conflict) {
                    set((state) => {
                        const currentSession = state.sessionsById[sessionId];
                        if (!currentSession) return state;

                        return {
                            sessionsById: {
                                ...state.sessionsById,
                                [sessionId]: markEditedFileEntryConflict(
                                    currentSession,
                                    identityKey,
                                    restoreCheck.currentHash,
                                ),
                            },
                        };
                    });

                    const updatedSession = get().sessionsById[sessionId];
                    if (updatedSession) {
                        void persistSession(updatedSession);
                    }
                    return;
                }

                await aiRestoreTextFile({
                    vaultPath,
                    path: entry.path,
                    previousPath:
                        entry.originPath !== entry.path
                            ? entry.originPath
                            : null,
                    content: mergedText,
                });

                set((state) => {
                    const currentSession = state.sessionsById[sessionId];
                    if (!currentSession) return state;

                    return {
                        sessionsById: {
                            ...state.sessionsById,
                            [sessionId]: removeEditedFilesBufferEntry(
                                currentSession,
                                identityKey,
                            ),
                        },
                    };
                });

                const updatedSession = get().sessionsById[sessionId];
                if (updatedSession) {
                    void persistSession(updatedSession);
                }
            } catch (error) {
                get().applySessionError({
                    session_id: sessionId,
                    message: getAiErrorMessage(
                        error,
                        "Failed to resolve the file hunks.",
                    ),
                });
            }
        },

        rejectAllEditedFiles: async (sessionId) => {
            const { sessionsById } = get();
            const vaultPath = useVaultStore.getState().vaultPath;
            if (!vaultPath) return;

            const session = sessionsById[sessionId];
            if (!session) return;

            const entries = getSessionEditedFilesBuffer(session);

            for (const entry of entries) {
                if (!entry.supported) {
                    continue;
                }

                try {
                    const restoreCheck = await hasSafeRestoreTarget(
                        vaultPath,
                        entry,
                    );

                    if (restoreCheck.conflict) {
                        set((state) => {
                            const currentSession =
                                state.sessionsById[sessionId];
                            if (!currentSession) return state;

                            return {
                                sessionsById: {
                                    ...state.sessionsById,
                                    [sessionId]: markEditedFileEntryConflict(
                                        currentSession,
                                        entry.identityKey,
                                        restoreCheck.currentHash,
                                    ),
                                },
                            };
                        });
                        continue;
                    }

                    await restoreEditedFileEntry(vaultPath, entry);

                    set((state) => {
                        const currentSession = state.sessionsById[sessionId];
                        if (!currentSession) return state;

                        return {
                            sessionsById: {
                                ...state.sessionsById,
                                [sessionId]: removeEditedFilesBufferEntry(
                                    currentSession,
                                    entry.identityKey,
                                ),
                            },
                        };
                    });
                } catch (error) {
                    get().applySessionError({
                        session_id: sessionId,
                        message: getAiErrorMessage(
                            error,
                            "Failed to reject all file changes.",
                        ),
                    });
                    return;
                }
            }

            const updatedSession = get().sessionsById[sessionId];
            if (updatedSession) {
                void persistSession(updatedSession);
            }
        },

        keepEditedFile: (sessionId, identityKey) => {
            set((state) => {
                const session = state.sessionsById[sessionId];
                if (!session) return state;

                return {
                    sessionsById: {
                        ...state.sessionsById,
                        [sessionId]: removeEditedFilesBufferEntry(
                            session,
                            identityKey,
                        ),
                    },
                };
            });

            const updatedSession = get().sessionsById[sessionId];
            if (updatedSession) {
                void persistSession(updatedSession);
            }
        },

        keepAllEditedFiles: (sessionId) => {
            set((state) => {
                const session = state.sessionsById[sessionId];
                if (!session) return state;

                return {
                    sessionsById: {
                        ...state.sessionsById,
                        [sessionId]: clearVisibleEditedFilesBuffer(session),
                    },
                };
            });

            const updatedSession = get().sessionsById[sessionId];
            if (updatedSession) {
                void persistSession(updatedSession);
            }
        },

        newSession: async (runtimeId) => {
            const runtimes = get().runtimes;
            const nextRuntimeId = runtimeId ?? getDefaultRuntimeId(runtimes);
            if (!nextRuntimeId) return;

            try {
                const session = await aiCreateSession(
                    nextRuntimeId,
                    useVaultStore.getState().vaultPath,
                );
                get().upsertSession(session, true);
                await persistSession(session);

                // Restore saved preferences
                const prefs = loadAiPreferences();
                const sid = session.sessionId;
                const availableModels =
                    getModelConfigOption(session)?.options.map(
                        (option) => option.value,
                    ) ?? session.models.map((model) => model.id);
                const availableModes = session.modes
                    .filter((m) => !m.disabled)
                    .map((m) => m.id);
                const modelConfig = getModelConfigOption(session);

                if (
                    prefs.modelId &&
                    prefs.modelId !== session.modelId &&
                    availableModels.includes(prefs.modelId)
                ) {
                    const updateModel = modelConfig
                        ? aiSetConfigOption(sid, modelConfig.id, prefs.modelId)
                        : aiSetModel(sid, prefs.modelId);

                    updateModel
                        .then((s) => get().upsertSession(s))
                        .catch(() => {});
                }
                if (
                    prefs.modeId &&
                    prefs.modeId !== session.modeId &&
                    availableModes.includes(prefs.modeId)
                ) {
                    aiSetMode(sid, prefs.modeId)
                        .then((s) => get().upsertSession(s))
                        .catch(() => {});
                }
                if (prefs.configOptions) {
                    for (const [optionId, value] of Object.entries(
                        prefs.configOptions,
                    )) {
                        const option = session.configOptions.find(
                            (o) => o.id === optionId,
                        );
                        if (
                            option &&
                            option.value !== value &&
                            option.options.some((o) => o.value === value)
                        ) {
                            aiSetConfigOption(sid, optionId, value)
                                .then((s) => get().upsertSession(s))
                                .catch(() => {});
                        }
                    }
                }
            } catch (error) {
                const message = getAiErrorMessage(
                    error,
                    "Failed to create a new session.",
                );
                get().applySessionError({
                    message,
                });
                if (isAuthenticationErrorMessage(message)) {
                    await get().refreshSetupStatus();
                }
            }
        },

        deleteSession: async (sessionId) => {
            const vaultPath = useVaultStore.getState().vaultPath;
            const historySessionId =
                get().sessionsById[sessionId]?.historySessionId ?? sessionId;
            if (vaultPath) {
                await aiDeleteSessionHistory(vaultPath, historySessionId).catch(
                    () => {},
                );
            }
            useChatTabsStore.getState().removeTabsForSession(sessionId);
            _queueDrainLocks.delete(sessionId);
            const state = get();
            const nextSessionsById = { ...state.sessionsById };
            delete nextSessionsById[sessionId];
            const nextComposerPartsBySessionId = {
                ...state.composerPartsBySessionId,
            };
            delete nextComposerPartsBySessionId[sessionId];
            const nextQueuedMessageEditBySessionId = {
                ...state.queuedMessageEditBySessionId,
            };
            delete nextQueuedMessageEditBySessionId[sessionId];
            const remainingIds = sortSessionIdsByRecency(nextSessionsById);
            const nextActiveId =
                state.activeSessionId === sessionId
                    ? (remainingIds[0] ?? null)
                    : state.activeSessionId;
            set({
                sessionsById: nextSessionsById,
                sessionOrder: remainingIds,
                activeSessionId: nextActiveId,
                composerPartsBySessionId: nextComposerPartsBySessionId,
                queuedMessagesBySessionId: cleanupQueuedMessagesBySessionId(
                    state.queuedMessagesBySessionId,
                    sessionId,
                    [],
                ),
                queuedMessageEditBySessionId: nextQueuedMessageEditBySessionId,
            });
            if (nextActiveId && !nextSessionsById[nextActiveId]) {
                await get().newSession();
            } else if (Object.keys(nextSessionsById).length === 0) {
                await get().newSession();
            }
        },

        deleteAllSessions: async () => {
            const vaultPath = useVaultStore.getState().vaultPath;
            if (vaultPath) {
                await aiDeleteAllSessionHistories(vaultPath).catch(() => {});
            }
            useChatTabsStore.getState().reset();
            _queueDrainLocks.clear();
            set({
                sessionsById: {},
                sessionOrder: [],
                activeSessionId: null,
                composerPartsBySessionId: {},
                queuedMessagesBySessionId: {},
                queuedMessageEditBySessionId: {},
            });
            await get().newSession();
        },

        attachNote: (note) =>
            set((state) => ({
                sessionsById: updateActiveSession(state, (session) => ({
                    ...session,
                    attachments: withUniqueAttachment(
                        session.attachments,
                        createAttachment("note", note),
                    ),
                })),
                notePickerOpen: false,
            })),

        attachFolder: (folderPath, name) =>
            set((state) => ({
                sessionsById: updateActiveSession(state, (session) => ({
                    ...session,
                    attachments: withUniqueAttachment(session.attachments, {
                        id: crypto.randomUUID(),
                        type: "folder",
                        noteId: folderPath,
                        label: name,
                        path: null,
                    }),
                })),
            })),

        attachCurrentNote: (note) => {
            if (!note) return;

            set((state) => ({
                sessionsById: updateActiveSession(state, (session) => ({
                    ...session,
                    attachments: withUniqueAttachment(
                        session.attachments,
                        createAttachment("current_note", note),
                    ),
                })),
            }));
        },

        attachSelectionFromEditor: () => {
            const { currentSelection } = useEditorStore.getState();
            if (!currentSelection || !currentSelection.text.trim()) return;

            const notes = useVaultStore.getState().notes;
            const note = notes.find((n) => n.id === currentSelection.noteId);
            if (!note) return;

            const state = get();
            const activeSessionId = state.activeSessionId;
            if (!activeSessionId) return;

            const { startLine, endLine } = currentSelection;
            const currentParts =
                state.composerPartsBySessionId[activeSessionId] ??
                createEmptyComposerParts();

            const isDuplicate = currentParts.some(
                (p) =>
                    p.type === "selection_mention" &&
                    p.noteId === note.id &&
                    p.startLine === startLine &&
                    p.endLine === endLine,
            );
            if (isDuplicate) return;

            const nextParts = appendSelectionMentionPart(currentParts, {
                noteId: note.id,
                label: buildSelectionLabel(
                    currentSelection.text,
                    startLine,
                    endLine,
                ),
                path: note.path,
                selectedText: currentSelection.text,
                startLine,
                endLine,
            });

            set({
                composerPartsBySessionId: {
                    ...state.composerPartsBySessionId,
                    [activeSessionId]: nextParts,
                },
            });
        },

        attachAudio: (filePath, fileName) => {
            const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
            const mimeMap: Record<string, string> = {
                mp3: "audio/mpeg",
                wav: "audio/wav",
                ogg: "audio/ogg",
                flac: "audio/flac",
            };
            const mimeType = mimeMap[ext] ?? "audio/*";
            set((state) => ({
                sessionsById: updateActiveSession(state, (session) => ({
                    ...session,
                    attachments: [
                        ...session.attachments,
                        {
                            id: crypto.randomUUID(),
                            type: "audio",
                            noteId: null,
                            label: fileName,
                            path: null,
                            filePath,
                            mimeType,
                            status: "pending",
                        },
                    ],
                })),
            }));
        },

        attachFile: (filePath, fileName, mimeType) =>
            set((state) => ({
                sessionsById: updateActiveSession(state, (session) => ({
                    ...session,
                    attachments: [
                        ...session.attachments,
                        {
                            id: crypto.randomUUID(),
                            type: "file",
                            noteId: null,
                            label: fileName,
                            path: null,
                            filePath,
                            mimeType,
                            status: "ready",
                        },
                    ],
                })),
            })),

        updateAttachment: (attachmentId, patch) =>
            set((state) => ({
                sessionsById: updateActiveSession(state, (session) => ({
                    ...session,
                    attachments: session.attachments.map((a) =>
                        a.id === attachmentId ? { ...a, ...patch } : a,
                    ),
                })),
            })),

        removeAttachment: (attachmentId) =>
            set((state) => ({
                sessionsById: updateActiveSession(state, (session) => ({
                    ...session,
                    attachments: session.attachments.filter(
                        (attachment) => attachment.id !== attachmentId,
                    ),
                })),
            })),

        clearAttachments: () =>
            set((state) => ({
                sessionsById: updateActiveSession(state, (session) => ({
                    ...session,
                    attachments: [],
                })),
            })),

        toggleAutoContext: () => {
            const next = !get().autoContextEnabled;
            set({ autoContextEnabled: next });
            saveAiPreferences({ autoContextEnabled: next });
        },

        toggleRequireCmdEnterToSend: () => {
            const next = !get().requireCmdEnterToSend;
            set({ requireCmdEnterToSend: next });
            saveAiPreferences({ requireCmdEnterToSend: next });
        },

        setComposerFontSize: (size: number) => {
            set({ composerFontSize: size });
            saveAiPreferences({ composerFontSize: size });
        },

        setChatFontSize: (size: number) => {
            set({ chatFontSize: size });
            saveAiPreferences({ chatFontSize: size });
        },

        setComposerFontFamily: (fontFamily: EditorFontFamily) => {
            const next = normalizeEditorFontFamily(fontFamily);
            set({ composerFontFamily: next });
            saveAiPreferences({ composerFontFamily: next });
        },

        setChatFontFamily: (fontFamily: EditorFontFamily) => {
            const next = normalizeEditorFontFamily(fontFamily);
            set({ chatFontFamily: next });
            saveAiPreferences({ chatFontFamily: next });
        },

        setEditDiffZoom: (size: number) => {
            const next = Math.round(size * 100) / 100;
            set({ editDiffZoom: next });
            saveAiPreferences({ editDiffZoom: next });
        },

        setHistoryRetentionDays: async (days) => {
            const next = Math.max(0, Math.round(days));
            set({ historyRetentionDays: next });
            saveAiPreferences({ historyRetentionDays: next });

            if (next <= 0) return;
            try {
                await pruneSessionHistoriesForCurrentVault(next);
                await get().initialize();
            } catch (error) {
                console.warn(
                    "Failed to prune expired session histories:",
                    error,
                );
            }
        },

        openNotePicker: () => set({ notePickerOpen: true }),

        closeNotePicker: () => set({ notePickerOpen: false }),
    };
});

// Sync AI preferences when another window (e.g. standalone Settings) updates localStorage
if (typeof window !== "undefined") {
    window.addEventListener("storage", (event) => {
        if (event.key === AI_PREFS_KEY) {
            const prefs = getNormalizedAiPreferences();
            useChatStore.setState({
                autoContextEnabled: prefs.autoContextEnabled,
                requireCmdEnterToSend: prefs.requireCmdEnterToSend,
                composerFontSize: prefs.composerFontSize,
                chatFontSize: prefs.chatFontSize,
                composerFontFamily: prefs.composerFontFamily,
                chatFontFamily: prefs.chatFontFamily,
                editDiffZoom: prefs.editDiffZoom,
                historyRetentionDays: prefs.historyRetentionDays,
            });
        }
    });
}

/** Flush any buffered message/thinking deltas synchronously (useful in tests). */
export { flushDeltasSync };

export function resetChatStore() {
    try {
        localStorage.removeItem(AI_RUNTIME_CACHE_KEY);
    } catch {
        // ignore
    }
    const prefs = getNormalizedAiPreferences();
    _queueDrainLocks.clear();
    useChatStore.setState({
        runtimeConnection: INITIAL_RUNTIME_CONNECTION,
        setupStatus: null,
        runtimes: [],
        sessionsById: {},
        sessionOrder: [],
        activeSessionId: null,
        notePickerOpen: false,
        autoContextEnabled: prefs.autoContextEnabled,
        requireCmdEnterToSend: prefs.requireCmdEnterToSend,
        composerFontSize: prefs.composerFontSize,
        chatFontSize: prefs.chatFontSize,
        composerFontFamily: prefs.composerFontFamily,
        chatFontFamily: prefs.chatFontFamily,
        editDiffZoom: prefs.editDiffZoom,
        historyRetentionDays: prefs.historyRetentionDays,
        composerPartsBySessionId: {},
        queuedMessagesBySessionId: {},
        queuedMessageEditBySessionId: {},
    });
}
