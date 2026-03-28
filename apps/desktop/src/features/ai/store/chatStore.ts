import { create } from "zustand";
import {
    normalizeEditorFontFamily,
    type EditorFontFamily,
} from "../../../app/store/settingsStore";
import {
    aiCancelTurn,
    aiCreateSession,
    aiDeleteRuntimeSession,
    aiDeleteRuntimeSessionsForVault,
    aiDeleteSessionHistory,
    aiDeleteAllSessionHistories,
    aiGetTextFileHash,
    aiGetSetupStatus,
    aiListSessions,
    aiListRuntimes,
    aiResumeRuntimeSession,
    aiLoadSession,
    aiLoadSessionHistoryPage,
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
    aiRegisterFileBaseline,
} from "../api";
import { isNoteTab, useEditorStore } from "../../../app/store/editorStore";
import {
    useVaultStore,
    type VaultNoteChange,
} from "../../../app/store/vaultStore";
import { vaultInvoke } from "../../../app/utils/vaultInvoke";
import {
    appendSelectionMentionPart,
    createEmptyComposerParts,
    serializeComposerParts,
    serializeComposerPartsForAI,
} from "../composerParts";
import {
    ensureSessionWorkCycle,
    startNewWorkCycle,
} from "./editedFilesBufferModel";
import {
    applyNonConflictingEdits,
    computeRestoreAction,
    consolidateTrackedFiles,
    emptyActionLogState,
    finalizeTrackedFiles,
    getTrackedFileReviewState,
    getTrackedFilesForSession,
    hashTextContent,
    keepEditsInRange,
    keepReviewHunks,
    patchIsEmpty,
    rejectAllEdits as actionLogRejectAll,
    rejectEditsInRanges,
    rejectReviewHunks,
    setTrackedFilesForWorkCycle,
    type RestoreAction,
} from "./actionLogModel";
import type { LastRejectUndo, TrackedFile } from "../diff/actionLogTypes";
import {
    buildReviewProjection,
    expandReviewHunksToOverlapClosure,
    type ReviewHunkId,
} from "../diff/reviewProjection";
import {
    type EditorTarget,
    resolveEditorTargetForTrackedPath,
    resolveFileTargetForPath,
    resolveNoteTargetForPath,
} from "../../editor/editorTargetResolver";
import { useChatTabsStore } from "./chatTabsStore";
import {
    clearChatRowUiSession,
    replaceChatRowUiSessionId,
    resetChatRowUiStore,
} from "./chatRowUiStore";
import {
    buildSelectionLabel,
    type AIChatAttachment,
    type AIAvailableCommandsPayload,
    type AIChatMessage,
    type AIChatMessageKind,
    type AIFileDiff,
    type AIChatNoteSummary,
    type AIChatRole,
    type AIChatSession,
    type AIComposerPart,
    type AIPermissionRequestPayload,
    type AIPlanUpdatePayload,
    type AIStatusEventPayload,
    type AIToolActivityPayload,
    type AIUserInputRequestPayload,
    type AIRuntimeConnectionPayload,
    type AIRuntimeConnectionState,
    type AIRuntimeDescriptor,
    type AIRuntimeSetupStatus,
    type AISessionErrorPayload,
    type PersistedSessionHistory,
    type PersistedSessionHistoryPage,
    type QueuedChatMessage,
    type QueuedChatMessageStatus,
} from "../types";
import {
    getLastTranscriptMessage,
    getSessionTranscriptLength,
    getSessionTranscriptMessages,
    isAssistantTextMessage,
    isIncompletePlanMessage,
    isTurnStartedStatusMessage,
    normalizeSessionTranscript,
    replaceSessionTranscript,
} from "../transcriptModel";
import { getSessionPreview, getSessionTitle } from "../sessionPresentation";

const AI_PREFS_KEY = "vaultai.ai.preferences";
const AI_RUNTIME_CACHE_KEY = "vaultai.ai.runtime-catalog";
const AI_AUTO_CONTEXT_KEY_PREFIX = "vaultai.ai.auto-context:";
const AI_AUTO_CONTEXT_GLOBAL_SCOPE = "__global__";
const TRANSCRIPT_PAGE_SIZE = 60;

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
    screenshotRetentionSeconds?: number;
}

interface NormalizedAiPreferences {
    requireCmdEnterToSend: boolean;
    composerFontSize: number;
    chatFontSize: number;
    composerFontFamily: EditorFontFamily;
    chatFontFamily: EditorFontFamily;
    editDiffZoom: number;
    historyRetentionDays: number;
    screenshotRetentionSeconds: number;
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

function aiPrefsEqual(
    left: Pick<
        ChatStore,
        | "requireCmdEnterToSend"
        | "composerFontSize"
        | "chatFontSize"
        | "composerFontFamily"
        | "chatFontFamily"
        | "editDiffZoom"
        | "historyRetentionDays"
        | "screenshotRetentionSeconds"
    >,
    right: NormalizedAiPreferences,
) {
    return (
        left.requireCmdEnterToSend === right.requireCmdEnterToSend &&
        left.composerFontSize === right.composerFontSize &&
        left.chatFontSize === right.chatFontSize &&
        left.composerFontFamily === right.composerFontFamily &&
        left.chatFontFamily === right.chatFontFamily &&
        left.editDiffZoom === right.editDiffZoom &&
        left.historyRetentionDays === right.historyRetentionDays &&
        left.screenshotRetentionSeconds === right.screenshotRetentionSeconds
    );
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

function getAutoContextStorageKey(vaultPath: string | null) {
    return `${AI_AUTO_CONTEXT_KEY_PREFIX}${
        vaultPath ?? AI_AUTO_CONTEXT_GLOBAL_SCOPE
    }`;
}

function loadAutoContextPreference(vaultPath: string | null) {
    try {
        const raw = localStorage.getItem(getAutoContextStorageKey(vaultPath));
        if (raw === "true") return true;
        if (raw === "false") return false;
    } catch {
        return true;
    }

    const legacyPrefs = loadAiPreferences();
    return legacyPrefs.autoContextEnabled !== false;
}

function saveAutoContextPreference(
    vaultPath: string | null,
    autoContextEnabled: boolean,
) {
    try {
        localStorage.setItem(
            getAutoContextStorageKey(vaultPath),
            String(autoContextEnabled),
        );
    } catch {
        // ignore
    }
}

function getNormalizedAiPreferences(): NormalizedAiPreferences {
    const prefs = loadAiPreferences();
    return {
        requireCmdEnterToSend: prefs.requireCmdEnterToSend === true,
        composerFontSize: prefs.composerFontSize ?? 14,
        chatFontSize: prefs.chatFontSize ?? 20,
        composerFontFamily: normalizeEditorFontFamily(prefs.composerFontFamily),
        chatFontFamily: normalizeEditorFontFamily(prefs.chatFontFamily),
        editDiffZoom: prefs.editDiffZoom ?? 0.72,
        historyRetentionDays: prefs.historyRetentionDays ?? 0,
        screenshotRetentionSeconds: prefs.screenshotRetentionSeconds ?? 0,
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
    runtimeConnectionByRuntimeId: Record<string, AIRuntimeConnectionState>;
    setupStatusByRuntimeId: Record<string, AIRuntimeSetupStatus>;
    runtimes: AIRuntimeDescriptor[];
    sessionsById: Record<string, AIChatSession>;
    sessionOrder: string[];
    activeSessionId: string | null;
    selectedRuntimeId: string | null;
    isInitializing: boolean;
    notePickerOpen: boolean;
    autoContextEnabled: boolean;
    requireCmdEnterToSend: boolean;
    composerFontSize: number;
    chatFontSize: number;
    composerFontFamily: EditorFontFamily;
    chatFontFamily: EditorFontFamily;
    editDiffZoom: number;
    historyRetentionDays: number;
    screenshotRetentionSeconds: number;
    composerPartsBySessionId: Record<string, AIComposerPart[]>;
    queuedMessagesBySessionId: Record<string, QueuedChatMessage[]>;
    queuedMessageEditBySessionId: Record<string, QueuedMessageEditState>;
    initialize: () => Promise<void>;
    syncAutoContextForVault: (vaultPath: string | null) => void;
    setSelectedRuntime: (runtimeId: string | null) => void;
    refreshSetupStatus: (runtimeId?: string) => Promise<void>;
    saveSetup: (input: {
        runtimeId?: string;
        customBinaryPath?: string;
        codexApiKey?: string;
        openaiApiKey?: string;
        geminiApiKey?: string;
        googleApiKey?: string;
        googleCloudProject?: string;
        googleCloudLocation?: string;
        gatewayBaseUrl?: string;
        gatewayHeaders?: string;
        anthropicBaseUrl?: string;
        anthropicCustomHeaders?: string;
        anthropicAuthToken?: string;
    }) => Promise<void>;
    startAuth: (input: {
        runtimeId?: string;
        methodId: string;
        customBinaryPath?: string;
        codexApiKey?: string;
        openaiApiKey?: string;
        geminiApiKey?: string;
        googleApiKey?: string;
        googleCloudProject?: string;
        googleCloudLocation?: string;
        gatewayBaseUrl?: string;
        gatewayHeaders?: string;
        anthropicBaseUrl?: string;
        anthropicCustomHeaders?: string;
        anthropicAuthToken?: string;
    }) => Promise<void>;
    upsertSession: (session: AIChatSession, activate?: boolean) => void;
    applySessionError: (payload: AISessionErrorPayload) => void;
    applyRuntimeConnection: (payload: AIRuntimeConnectionPayload) => void;
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
    applyAvailableCommandsUpdate: (payload: AIAvailableCommandsPayload) => void;
    applyPermissionRequest: (payload: AIPermissionRequestPayload) => void;
    applyUserInputRequest: (payload: AIUserInputRequestPayload) => void;
    setActiveSession: (sessionId: string) => void;
    ensureSessionTranscriptLoaded: (
        sessionId: string,
        mode?: "latest" | "full",
    ) => Promise<boolean>;
    loadOlderMessages: (sessionId: string) => Promise<boolean>;
    resumeSession: (sessionId: string) => Promise<string | null>;
    loadSession: (sessionId: string) => Promise<void>;
    setModel: (modelId: string, sessionId?: string) => Promise<void>;
    setMode: (modeId: string, sessionId?: string) => Promise<void>;
    setConfigOption: (
        optionId: string,
        value: string,
        sessionId?: string,
    ) => Promise<void>;
    setComposerParts: (parts: AIComposerPart[], sessionId?: string) => void;
    sendMessage: (sessionId?: string) => Promise<void>;
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
    stopStreaming: (sessionId?: string) => Promise<void>;
    respondPermission: (requestId: string, optionId?: string) => Promise<void>;
    respondPermissionForSession: (
        sessionId: string,
        requestId: string,
        optionId?: string,
    ) => Promise<void>;
    respondUserInput: (
        requestId: string,
        answers: Record<string, string[]>,
        sessionId?: string,
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
    resolveHunkEdits: (
        sessionId: string,
        identityKey: string,
        decision: "accepted" | "rejected",
        hunkNewStart: number,
        hunkNewEnd: number,
    ) => Promise<void>;
    resolveReviewHunks: (
        sessionId: string,
        identityKey: string,
        decision: "accepted" | "rejected",
        trackedVersion: number,
        hunkIds: ReviewHunkId[],
    ) => Promise<void>;
    undoLastReject: (sessionId: string) => Promise<void>;
    notifyUserEditOnFile: (
        fileId: string,
        userEdits: import("../diff/actionLogTypes").TextEdit[],
        newFullText: string,
    ) => void;
    newSession: (runtimeId?: string) => Promise<void>;
    deleteSession: (sessionId: string) => Promise<void>;
    deleteAllSessions: () => Promise<void>;
    attachNote: (note: AIChatNoteSummary, sessionId?: string) => void;
    attachFolder: (
        folderPath: string,
        name: string,
        sessionId?: string,
    ) => void;
    attachCurrentNote: (note: AIChatNoteSummary | null) => void;
    attachSelectionFromEditor: () => void;
    attachAudio: (filePath: string, fileName: string) => void;
    attachFile: (filePath: string, fileName: string, mimeType: string) => void;
    updateAttachment: (
        attachmentId: string,
        patch: Partial<AIChatAttachment>,
        sessionId?: string,
    ) => void;
    removeAttachment: (attachmentId: string, sessionId?: string) => void;
    clearAttachments: (sessionId?: string) => void;
    toggleAutoContext: () => void;
    toggleRequireCmdEnterToSend: () => void;
    setComposerFontSize: (size: number) => void;
    setChatFontSize: (size: number) => void;
    setComposerFontFamily: (fontFamily: EditorFontFamily) => void;
    setChatFontFamily: (fontFamily: EditorFontFamily) => void;
    setEditDiffZoom: (size: number) => void;
    setHistoryRetentionDays: (days: number) => Promise<void>;
    setScreenshotRetentionSeconds: (seconds: number) => void;
    openNotePicker: () => void;
    closeNotePicker: () => void;
}

const INITIAL_RUNTIME_CONNECTION: AIRuntimeConnectionState = {
    status: "idle",
    message: null,
};

function cloneInitialRuntimeConnection(): AIRuntimeConnectionState {
    return { ...INITIAL_RUNTIME_CONNECTION };
}

function setRuntimeConnectionState(
    state: Record<string, AIRuntimeConnectionState>,
    runtimeId: string,
    connection: AIRuntimeConnectionState,
) {
    return {
        ...state,
        [runtimeId]: connection,
    };
}

function buildRuntimeConnectionMap(
    runtimes: AIRuntimeDescriptor[],
    existing: Record<string, AIRuntimeConnectionState> = {},
) {
    return runtimes.reduce<Record<string, AIRuntimeConnectionState>>(
        (accumulator, runtime) => {
            accumulator[runtime.runtime.id] =
                existing[runtime.runtime.id] ?? cloneInitialRuntimeConnection();
            return accumulator;
        },
        { ...existing },
    );
}

function buildSetupStatusMap(statuses: AIRuntimeSetupStatus[]) {
    return Object.fromEntries(
        statuses.map((status) => [status.runtimeId, status]),
    ) as Record<string, AIRuntimeSetupStatus>;
}

function getRuntimeConnectionForSetup(
    setupStatus: AIRuntimeSetupStatus,
): AIRuntimeConnectionState {
    if (setupStatus.onboardingRequired || !setupStatus.authReady) {
        return cloneInitialRuntimeConnection();
    }

    return {
        status: "ready",
        message: null,
    };
}

function applyRuntimeSetupStatusPatch(
    state: Pick<
        ChatStore,
        "setupStatusByRuntimeId" | "runtimeConnectionByRuntimeId"
    >,
    setupStatus: AIRuntimeSetupStatus,
) {
    return {
        setupStatusByRuntimeId: {
            ...state.setupStatusByRuntimeId,
            [setupStatus.runtimeId]: setupStatus,
        },
        runtimeConnectionByRuntimeId: setRuntimeConnectionState(
            state.runtimeConnectionByRuntimeId,
            setupStatus.runtimeId,
            getRuntimeConnectionForSetup(setupStatus),
        ),
    };
}

function isAuthenticationErrorMessage(message: string) {
    const normalized = message.trim().toLowerCase();
    return (
        normalized.includes("auth_required") ||
        normalized.includes("authentication required") ||
        normalized.includes("you were signed out") ||
        normalized.includes("reconnect in ai setup") ||
        normalized.includes("reconnect codex") ||
        normalized.includes("reconnect claude")
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

function recomputeActivePlanMessageId(session: AIChatSession) {
    const normalized = normalizeSessionTranscript(session);

    for (let i = normalized.messageOrder!.length - 1; i >= 0; i -= 1) {
        const messageId = normalized.messageOrder![i];
        const message = normalized.messagesById![messageId];
        if (message && isIncompletePlanMessage(message)) {
            return messageId;
        }
    }

    return null;
}

function replaceSessionMessage(
    session: AIChatSession,
    messageId: string,
    updater: (message: AIChatMessage) => AIChatMessage,
) {
    const normalized = normalizeSessionTranscript(session);
    const index = normalized.messageIndexById![messageId];
    if (index == null) {
        return normalized;
    }

    const currentMessage = normalized.messages[index];
    const nextMessage = updater(currentMessage);
    if (nextMessage === currentMessage) {
        return normalized;
    }

    const nextMessages = normalized.messages.slice();
    nextMessages[index] = nextMessage;
    const nextMessagesById = {
        ...normalized.messagesById!,
        [messageId]: nextMessage,
    };

    return {
        ...normalized,
        messages: nextMessages,
        messagesById: nextMessagesById,
        activePlanMessageId:
            currentMessage.kind === "plan" || nextMessage.kind === "plan"
                ? recomputeActivePlanMessageId({
                      ...normalized,
                      messages: nextMessages,
                      messagesById: nextMessagesById,
                  })
                : (normalized.activePlanMessageId ?? null),
    };
}

function appendSessionMessage(session: AIChatSession, message: AIChatMessage) {
    const normalized = ensurePersistedTranscriptWindowAnchor(
        normalizeSessionTranscript(session),
    );
    const nextMessages = [...normalized.messages, message];

    return {
        ...normalized,
        messages: nextMessages,
        messageOrder: [...normalized.messageOrder!, message.id],
        messagesById: {
            ...normalized.messagesById!,
            [message.id]: message,
        },
        messageIndexById: {
            ...normalized.messageIndexById!,
            [message.id]: nextMessages.length - 1,
        },
        lastAssistantMessageId: isAssistantTextMessage(message)
            ? message.id
            : (normalized.lastAssistantMessageId ?? null),
        lastTurnStartedMessageId: isTurnStartedStatusMessage(message)
            ? message.id
            : (normalized.lastTurnStartedMessageId ?? null),
        activePlanMessageId: isIncompletePlanMessage(message)
            ? message.id
            : (normalized.activePlanMessageId ?? null),
    };
}

function upsertSessionMessage(
    session: AIChatSession,
    message: AIChatMessage,
    options?: {
        preserveTimestamp?: boolean;
        preserveWorkCycleId?: boolean;
    },
) {
    const normalized = normalizeSessionTranscript(session);
    const index = normalized.messageIndexById![message.id];

    if (index == null) {
        return appendSessionMessage(normalized, message);
    }

    return replaceSessionMessage(normalized, message.id, (currentMessage) => ({
        ...message,
        timestamp: options?.preserveTimestamp
            ? currentMessage.timestamp
            : message.timestamp,
        workCycleId: options?.preserveWorkCycleId
            ? (currentMessage.workCycleId ?? message.workCycleId)
            : message.workCycleId,
    }));
}

function appendSessionError(session: AIChatSession, content: string) {
    return appendSessionMessage(session, createErrorMessage(content));
}

function stampElapsedOnTurnStartedSession(
    session: AIChatSession,
    completedAt: number,
) {
    const normalized = normalizeSessionTranscript(session);
    const messageId = normalized.lastTurnStartedMessageId;
    if (!messageId) {
        return normalized;
    }

    return replaceSessionMessage(normalized, messageId, (message) => {
        if (message.meta?.elapsed_ms != null) {
            return message;
        }

        return {
            ...message,
            meta: {
                ...message.meta,
                elapsed_ms: completedAt - message.timestamp,
            },
        };
    });
}

function setMessageInProgressState(
    session: AIChatSession,
    messageId: string,
    inProgress: boolean,
) {
    return replaceSessionMessage(session, messageId, (message) =>
        message.inProgress === inProgress
            ? message
            : {
                  ...message,
                  inProgress,
              },
    );
}

function appendToMessageContent(
    session: AIChatSession,
    messageId: string,
    text: string,
) {
    return replaceSessionMessage(session, messageId, (message) => ({
        ...message,
        content: message.content + text,
    }));
}

function markPendingInteractionMessagesIdle(session: AIChatSession) {
    const normalized = normalizeSessionTranscript(session);
    let changed = false;
    const nextMessages = normalized.messages.slice();
    const nextMessagesById = { ...normalized.messagesById! };

    for (let index = 0; index < nextMessages.length; index += 1) {
        const message = nextMessages[index];
        let nextMessage = message;

        if (
            message.kind === "permission" &&
            message.meta?.status === "responding"
        ) {
            nextMessage = {
                ...message,
                meta: {
                    ...message.meta,
                    status: "pending",
                },
            };
        } else if (
            message.kind === "user_input_request" &&
            message.meta?.status === "responding"
        ) {
            nextMessage = {
                ...message,
                meta: {
                    ...message.meta,
                    status: "pending",
                },
            };
        } else if (message.inProgress) {
            nextMessage = {
                ...message,
                inProgress: false,
            };
        }

        if (nextMessage !== message) {
            nextMessages[index] = nextMessage;
            nextMessagesById[message.id] = nextMessage;
            changed = true;
        }
    }

    if (!changed) {
        return normalized;
    }

    return {
        ...normalized,
        messages: nextMessages,
        messagesById: nextMessagesById,
    };
}

function markAllMessagesComplete(session: AIChatSession) {
    const normalized = normalizeSessionTranscript(session);
    let changed = false;
    const nextMessages = normalized.messages.slice();
    const nextMessagesById = { ...normalized.messagesById! };

    for (let index = 0; index < nextMessages.length; index += 1) {
        const message = nextMessages[index];
        if (!message.inProgress) continue;

        const nextMessage = {
            ...message,
            inProgress: false,
        };
        nextMessages[index] = nextMessage;
        nextMessagesById[message.id] = nextMessage;
        changed = true;
    }

    if (!changed) {
        return normalized;
    }

    return {
        ...normalized,
        messages: nextMessages,
        messagesById: nextMessagesById,
    };
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
    return (
        getLastTranscriptMessage(session)?.timestamp ??
        session.persistedUpdatedAt ??
        0
    );
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

function findMostRecentSessionIdForRuntime(
    sessionsById: Record<string, AIChatSession>,
    sessionOrder: string[],
    runtimeId: string,
) {
    return sessionOrder.find(
        (sessionId) => sessionsById[sessionId]?.runtimeId === runtimeId,
    );
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

    const { tabs, activeTabId } = useEditorStore.getState();
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

    return autoAttachments;
}

function buildPromptWithResumeContext(session: AIChatSession, prompt: string) {
    if (!session.resumeContextPending) {
        return prompt;
    }

    const history = getSessionTranscriptMessages(session)
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
    const prompt = serializeComposerPartsForAI(composerPartsSnapshot, {
        vaultPath: useVaultStore.getState().vaultPath,
    }).trim();
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

    const screenshotAttachments: AIChatAttachment[] = composerPartsSnapshot
        .filter(
            (p): p is Extract<AIComposerPart, { type: "screenshot" }> =>
                p.type === "screenshot",
        )
        .map((p) => ({
            id: crypto.randomUUID(),
            type: "file" as const,
            noteId: null,
            label: p.label,
            path: null,
            filePath: p.filePath,
            mimeType: p.mimeType,
        }));

    const fileAttachments: AIChatAttachment[] = composerPartsSnapshot
        .filter(
            (p): p is Extract<AIComposerPart, { type: "file_attachment" }> =>
                p.type === "file_attachment",
        )
        .map((p) => ({
            id: crypto.randomUUID(),
            type: "file" as const,
            noteId: null,
            label: p.label,
            path: null,
            filePath: p.filePath,
            mimeType: p.mimeType,
        }));

    const attachments = [
        ...session.attachments,
        ...selectionAttachments,
        ...screenshotAttachments,
        ...fileAttachments,
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
    return replaceSessionMessage(session, messageId, (message) => ({
        ...message,
        meta: {
            ...message.meta,
            ...patch,
        },
    }));
}

function updateUserInputMessageState(
    session: AIChatSession,
    requestId: string,
    patch: Record<string, string | number | boolean | null>,
) {
    const messageId = `user-input:${requestId}`;
    return replaceSessionMessage(session, messageId, (message) => ({
        ...message,
        meta: {
            ...message.meta,
            ...patch,
        },
    }));
}

interface RestoreConflictCheckResult {
    conflict: boolean;
    currentHash: string | null;
}

async function hasConflict(
    vaultPath: string,
    tracked: TrackedFile,
): Promise<RestoreConflictCheckResult> {
    const currentHash = await aiGetTextFileHash(vaultPath, tracked.path);
    const appliedHash = hashTextContent(tracked.currentText);

    if (currentHash !== appliedHash) {
        // For deleted files, the expected on-disk state is "file doesn't exist"
        // (currentHash=null) and currentText="" (appliedHash=hash of "").
        // This is not a conflict — the file was deleted as expected.
        const isExpectedDeletion =
            tracked.status.kind === "deleted" && currentHash === null;
        if (!isExpectedDeletion) {
            return { conflict: true, currentHash };
        }
    }

    if (tracked.originPath !== tracked.path) {
        const originHash = await aiGetTextFileHash(
            vaultPath,
            tracked.originPath,
        );
        if (originHash !== null) {
            return { conflict: true, currentHash: originHash };
        }
    }

    return { conflict: false, currentHash };
}

/**
 * Mark a tracked file as conflicted in the ActionLog.
 */
function markTrackedConflict(
    session: AIChatSession,
    identityKey: string,
    currentHash: string | null,
): AIChatSession {
    const files = {
        ...getAccumulatedTrackedFiles(session),
    };
    const file = files[identityKey];
    if (!file) return session;
    files[identityKey] = { ...file, conflictHash: currentHash };
    return {
        ...replaceTrackedFilesInActionLog(session, files),
    };
}

// ---------------------------------------------------------------------------
// ActionLog helpers
// ---------------------------------------------------------------------------

function ensureActionLog(session: AIChatSession): AIChatSession {
    if (session.actionLog) return session;
    return { ...session, actionLog: emptyActionLogState() };
}

function diffCanBeTracked(diff: AIFileDiff) {
    return diff.is_text !== false && diff.reversible !== false;
}

function summarizeTrackedFileForDebug(file: TrackedFile | null | undefined) {
    if (!file) {
        return null;
    }

    return {
        identityKey: file.identityKey,
        path: file.path,
        originPath: file.originPath,
        previousPath: file.previousPath,
        reviewState: getTrackedFileReviewState(file),
        version: file.version,
        updatedAt: file.updatedAt,
        diffBaseLength: file.diffBase.length,
        currentTextLength: file.currentText.length,
        editCount: file.unreviewedEdits.edits.length,
        edits: file.unreviewedEdits.edits,
        spanCount: file.unreviewedRanges?.spans.length ?? null,
        spans: file.unreviewedRanges?.spans ?? null,
    };
}

function matchesTrackedFileForDebug(file: TrackedFile, diff: AIFileDiff) {
    return (
        file.identityKey === diff.path ||
        file.path === diff.path ||
        file.originPath === diff.path ||
        file.previousPath === diff.path ||
        (diff.previous_path != null &&
            (file.identityKey === diff.previous_path ||
                file.path === diff.previous_path ||
                file.originPath === diff.previous_path ||
                file.previousPath === diff.previous_path))
    );
}

function summarizeRelevantTrackedFilesForDebug(
    files: Record<string, TrackedFile>,
    diffs: AIFileDiff[],
) {
    const relevant = Object.values(files).filter((file) =>
        diffs.some((diff) => matchesTrackedFileForDebug(file, diff)),
    );

    return relevant.map((file) => summarizeTrackedFileForDebug(file));
}

function consolidateActionLogDiffs(
    session: AIChatSession,
    diffs: AIFileDiff[],
    workCycleId: string | null | undefined,
    timestamp = Date.now(),
): AIChatSession {
    if (!workCycleId || diffs.length === 0) return session;
    const actionLog = session.actionLog ?? emptyActionLogState();
    const currentFiles = getTrackedFilesForSession(actionLog);
    const relevantBefore = summarizeRelevantTrackedFilesForDebug(
        currentFiles,
        diffs,
    );
    const nextFiles = consolidateTrackedFiles(currentFiles, diffs, timestamp);
    const relevantAfter = summarizeRelevantTrackedFilesForDebug(
        nextFiles,
        diffs,
    );
    if (relevantBefore.length > 0 || relevantAfter.length > 0) {
        console.debug("[tracked-review] consolidate agent diffs", {
            sessionId: session.sessionId,
            workCycleId,
            diffs: diffs.map((diff) => ({
                path: diff.path,
                previousPath: diff.previous_path ?? null,
                kind: diff.kind,
                oldTextLength:
                    diff.kind === "add" ? 0 : (diff.old_text ?? "").length,
                newTextLength:
                    diff.kind === "delete" ? 0 : (diff.new_text ?? "").length,
            })),
            relevantBefore,
            relevantAfter,
        });
    }
    const nextActionLog = replaceTrackedFilesInActionLogState(
        actionLog,
        workCycleId,
        nextFiles,
    );
    // Clear undo when new agent edits arrive — undo is no longer valid
    return {
        ...session,
        actionLog: { ...nextActionLog, lastRejectUndo: null },
    };
}

function finalizeActionLogForWorkCycle(
    session: AIChatSession,
    workCycleId?: string | null,
): AIChatSession {
    const actionLog = session.actionLog;
    const targetWorkCycleId =
        workCycleId ?? session.activeWorkCycleId ?? session.visibleWorkCycleId;
    if (!actionLog || !targetWorkCycleId) {
        return session;
    }

    const files = getTrackedFilesForSession(actionLog);
    const finalizedFiles = finalizeTrackedFiles(files);
    if (finalizedFiles === files) {
        return session;
    }

    console.debug("[tracked-review] finalize work cycle", {
        sessionId: session.sessionId,
        workCycleId: targetWorkCycleId,
        before: Object.values(files).map((file) =>
            summarizeTrackedFileForDebug(file),
        ),
        after: Object.values(finalizedFiles).map((file) =>
            summarizeTrackedFileForDebug(file),
        ),
    });

    return {
        ...session,
        actionLog: replaceTrackedFilesInActionLogState(
            actionLog,
            targetWorkCycleId,
            finalizedFiles,
        ),
    };
}

function getAccumulatedTrackedFiles(
    session: AIChatSession,
): Record<string, TrackedFile> {
    return getTrackedFilesForSession(session.actionLog);
}

function getAccumulatedTrackedWorkCycleId(
    session: AIChatSession,
): string | null | undefined {
    return session.activeWorkCycleId ?? session.visibleWorkCycleId;
}

function replaceTrackedFilesInActionLogState(
    actionLog: ReturnType<typeof emptyActionLogState>,
    workCycleId: string,
    files: Record<string, TrackedFile>,
) {
    let nextActionLog: ReturnType<typeof emptyActionLogState> = {
        ...actionLog,
        trackedFilesByIdentityKey: {},
        trackedFileIdsByWorkCycleId: {},
        trackedFilesByWorkCycleId: {},
    };
    if (Object.keys(files).length > 0) {
        nextActionLog = setTrackedFilesForWorkCycle(
            nextActionLog,
            workCycleId,
            files,
        );
    }
    return nextActionLog;
}

function replaceTrackedFilesInActionLog(
    session: AIChatSession,
    files: Record<string, TrackedFile>,
    workCycleId: string | null | undefined = getAccumulatedTrackedWorkCycleId(
        session,
    ),
): AIChatSession {
    const actionLog = session.actionLog;
    if (!actionLog || !workCycleId) {
        return session;
    }

    return {
        ...session,
        actionLog: replaceTrackedFilesInActionLogState(
            actionLog,
            workCycleId,
            files,
        ),
    };
}

function findTrackedFileInAccumulatedSession(
    session: AIChatSession,
    identityKey: string,
): TrackedFile | null {
    return getAccumulatedTrackedFiles(session)[identityKey] ?? null;
}

function removeTrackedFileFromActionLog(
    session: AIChatSession,
    identityKey: string,
): AIChatSession {
    const files = {
        ...getAccumulatedTrackedFiles(session),
    };
    const matchingKey =
        Object.keys(files).find(
            (key) =>
                key === identityKey || files[key]?.identityKey === identityKey,
        ) ?? null;

    if (!matchingKey) {
        return session;
    }

    delete files[matchingKey];
    return replaceTrackedFilesInActionLog(session, files);
}

function setActionLogUndo(
    session: AIChatSession,
    undo: LastRejectUndo | null,
): AIChatSession {
    if (!session.actionLog) return session;
    return {
        ...session,
        actionLog: { ...session.actionLog, lastRejectUndo: undo },
    };
}

async function readTrackedFileLiveText(
    tracked: TrackedFile,
): Promise<string | null | undefined> {
    const noteTarget = resolveNoteTargetForPath(tracked.path);
    if (noteTarget) {
        if (noteTarget.openTab) {
            return noteTarget.openTab.content;
        }

        try {
            const detail = await vaultInvoke<{ content: string }>("read_note", {
                noteId: noteTarget.noteId,
            });
            return detail.content;
        } catch {
            // Fall through to the generic reader below. For newly-created files,
            // treating a failed read as "unknown" is safer than deleting.
        }
    }

    const fileTarget = resolveFileTargetForPath(tracked.path);
    if (fileTarget) {
        if (fileTarget.openTab) {
            return fileTarget.openTab.content;
        }

        try {
            const detail = await vaultInvoke<{ content: string }>(
                "read_vault_file",
                {
                    relativePath: fileTarget.relativePath,
                },
            );
            return detail.content;
        } catch {
            return null;
        }
    }

    return null;
}

/**
 * Execute a lifecycle-aware file restore action on disk.
 * For "created from nothing" → deletes the file.
 * For "modified" or "deleted" → writes diffBase back.
 */
async function executeRestoreAction(
    vaultPath: string,
    tracked: TrackedFile,
    liveText?: string | null,
) {
    const action = computeRestoreAction(tracked, liveText);
    if (action.kind === "skip") {
        return { action, change: null as VaultNoteChange | null };
    }

    let change: VaultNoteChange | null = null;
    if (action.kind === "delete") {
        change = await aiRestoreTextFile({
            vaultPath,
            path: tracked.path,
            content: null,
        });
    } else {
        change = await aiRestoreTextFile({
            vaultPath,
            path:
                tracked.originPath !== tracked.path
                    ? tracked.originPath
                    : tracked.path,
            previousPath:
                action.previousPath ??
                (tracked.originPath !== tracked.path ? tracked.path : null),
            content: action.content,
        });
    }

    return { action, change };
}

/**
 * After a reject/undo writes content to disk, force-reload the open editor tab
 * so CodeMirror reflects the new content immediately.
 */
function forceReloadResolvedEditorTarget(
    target: EditorTarget | null,
    content: string,
    change?: VaultNoteChange | null,
) {
    if (!target?.openTab) {
        return;
    }

    useEditorStore.getState().forceReloadEditorTarget(target, {
        content,
        title: target.openTab.title ?? target.absolutePath,
        origin: change?.origin ?? "agent",
        opId: change?.op_id ?? null,
        revision: change?.revision ?? 0,
        contentHash: change?.content_hash ?? null,
    });
}

function reloadOpenEditorContent(
    path: string,
    content: string,
    change?: VaultNoteChange | null,
) {
    forceReloadResolvedEditorTarget(
        resolveEditorTargetForTrackedPath(path),
        content,
        change,
    );
}

/**
 * After rejecting a tracked file, reload the editor (or close the tab if the
 * file was deleted).
 */
function reloadEditorAfterRestore(
    tracked: TrackedFile,
    action: RestoreAction,
    change?: VaultNoteChange | null,
) {
    const restoredPath =
        action.kind === "write" && tracked.originPath !== tracked.path
            ? tracked.originPath
            : tracked.path;
    const noteId = resolveNoteTargetForPath(restoredPath)?.noteId ?? null;
    const fileRelativePath =
        resolveFileTargetForPath(restoredPath)?.relativePath ?? null;
    if (action.kind === "skip") {
        return;
    }

    if (action.kind === "delete") {
        if (noteId) {
            useEditorStore.getState().handleNoteDeleted(noteId);
            return;
        }
        if (fileRelativePath) {
            useEditorStore.getState().handleFileDeleted(fileRelativePath);
        }
    } else {
        reloadOpenEditorContent(restoredPath, action.content, change);
    }
}

function applyUserEditToTrackedFileInSession(
    sessionId: string,
    fileId: string,
    userEdits: import("../diff/actionLogTypes").TextEdit[],
    newFullText: string,
) {
    useChatStore.setState((state) => {
        const session = state.sessionsById[sessionId];
        if (!session?.actionLog) return state;

        const files = {
            ...getAccumulatedTrackedFiles(session),
        };
        let trackedKey = fileId;
        let tracked = files[fileId] ?? null;

        if (!tracked) {
            for (const [key, file] of Object.entries(files)) {
                if (file.path === fileId) {
                    tracked = file;
                    trackedKey = key;
                    break;
                }
            }
        }
        if (!tracked) return state;

        const updated = applyNonConflictingEdits(
            tracked,
            userEdits,
            newFullText,
        );

        console.debug("[tracked-review] apply user edit to tracked file", {
            sessionId,
            fileId,
            trackedKey,
            userEdits,
            newFullTextLength: newFullText.length,
            before: summarizeTrackedFileForDebug(tracked),
            after: summarizeTrackedFileForDebug(updated),
            removed:
                patchIsEmpty(updated.unreviewedEdits) &&
                updated.path === updated.originPath,
        });

        const nextFiles = { ...files };
        if (
            patchIsEmpty(updated.unreviewedEdits) &&
            updated.path === updated.originPath
        ) {
            delete nextFiles[trackedKey];
        } else {
            nextFiles[trackedKey] = updated;
        }

        return {
            sessionsById: {
                ...state.sessionsById,
                [sessionId]: replaceTrackedFilesInActionLog(session, nextFiles),
            },
        };
    });
}

function getPersistedHistoryMessageCount(history: PersistedSessionHistory) {
    return history.message_count ?? history.messages.length;
}

function getSessionPersistedMessageCount(session: AIChatSession) {
    return Math.max(
        session.persistedMessageCount ?? 0,
        (session.loadedPersistedMessageStart ?? 0) + session.messages.length,
    );
}

function getSessionPersistedWindowStart(session: AIChatSession) {
    if (session.loadedPersistedMessageStart != null) {
        return session.loadedPersistedMessageStart;
    }

    if (
        (session.persistedMessageCount ?? 0) > 0 &&
        session.messages.length > 0
    ) {
        return session.persistedMessageCount ?? 0;
    }

    return 0;
}

function hasFullPersistedTranscriptLoaded(session: AIChatSession) {
    const persistedCount = session.persistedMessageCount ?? 0;
    if (persistedCount === 0) {
        return true;
    }

    if (getSessionTranscriptLength(session) < persistedCount) {
        return false;
    }

    return (
        session.loadedPersistedMessageStart === 0 ||
        session.runtimeState !== "live"
    );
}

function hasPersistedHistoryContent(history: PersistedSessionHistory) {
    return getPersistedHistoryMessageCount(history) > 0;
}

function hasOlderPersistedMessages(session: AIChatSession) {
    return (session.loadedPersistedMessageStart ?? 0) > 0;
}

function ensurePersistedTranscriptWindowAnchor(session: AIChatSession) {
    if (
        session.loadedPersistedMessageStart != null ||
        session.messages.length > 0 ||
        (session.persistedMessageCount ?? 0) === 0
    ) {
        return session;
    }

    return {
        ...session,
        loadedPersistedMessageStart: session.persistedMessageCount ?? 0,
    };
}

function applyPersistedHistoryMetadata(
    session: AIChatSession,
    history: PersistedSessionHistory,
) {
    return {
        ...session,
        persistedCreatedAt: history.created_at,
        persistedUpdatedAt: history.updated_at,
        persistedTitle: history.title ?? null,
        persistedPreview: history.preview ?? null,
        persistedMessageCount: getPersistedHistoryMessageCount(history),
        loadedPersistedMessageStart:
            getPersistedHistoryMessageCount(history) === 0
                ? 0
                : (session.loadedPersistedMessageStart ?? null),
    };
}

function applyPersistedHistoryPage(
    session: AIChatSession,
    page: PersistedSessionHistoryPage,
    mode: "replace" | "prepend",
) {
    const currentMessages = getSessionTranscriptMessages(session);
    const currentWindowStart = getSessionPersistedWindowStart(session);
    const currentPersistedWindowLength = Math.max(
        0,
        (session.persistedMessageCount ?? 0) - currentWindowStart,
    );
    const liveTail = currentMessages.slice(currentPersistedWindowLength);
    const pageMessages = restoreMessagesFromHistory({
        version: 1,
        session_id: page.session_id,
        runtime_id: session.runtimeId,
        model_id: session.modelId,
        mode_id: session.modeId,
        created_at: session.persistedCreatedAt ?? 0,
        updated_at: session.persistedUpdatedAt ?? 0,
        start_index: page.start_index,
        message_count: page.total_messages,
        title: session.persistedTitle ?? undefined,
        preview: session.persistedPreview ?? undefined,
        messages: page.messages,
    });

    const nextSession = {
        ...session,
        persistedMessageCount: page.total_messages,
        loadedPersistedMessageStart: page.start_index,
        isLoadingPersistedMessages: false,
    };

    return replaceSessionTranscript(
        nextSession,
        mode === "prepend"
            ? [...pageMessages, ...currentMessages]
            : [...pageMessages, ...liveTail],
    );
}

function isPersistedHistoryPage(
    payload: unknown,
): payload is PersistedSessionHistoryPage {
    if (typeof payload !== "object" || payload === null) {
        return false;
    }

    const candidate = payload as Partial<PersistedSessionHistoryPage>;
    return (
        typeof candidate.session_id === "string" &&
        typeof candidate.total_messages === "number" &&
        typeof candidate.start_index === "number" &&
        typeof candidate.end_index === "number" &&
        Array.isArray(candidate.messages)
    );
}

function createPersistedSession(
    history: PersistedSessionHistory,
    runtimes: AIRuntimeDescriptor[],
    vaultPath: string | null,
): AIChatSession | null {
    const runtime =
        (history.runtime_id
            ? runtimes.find(
                  (candidate) => candidate.runtime.id === history.runtime_id,
              )
            : null) ?? runtimes[0];
    if (!runtime) return null;
    const runtimeId = history.runtime_id ?? runtime.runtime.id;
    const persistedMessageCount = getPersistedHistoryMessageCount(history);
    const baseSession: AIChatSession = {
        sessionId: `persisted:${history.session_id}`,
        historySessionId: history.session_id,
        vaultPath,
        runtimeId,
        modelId: history.model_id,
        modeId: history.mode_id,
        status: "idle",
        activeWorkCycleId: null,
        visibleWorkCycleId: null,
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
        messages: [],
        attachments: [],
        isPersistedSession: true,
        resumeContextPending: persistedMessageCount > 0,
        runtimeState: "persisted_only",
        persistedCreatedAt: history.created_at,
        persistedUpdatedAt: history.updated_at,
        persistedTitle: history.title ?? null,
        persistedPreview: history.preview ?? null,
        persistedMessageCount,
        loadedPersistedMessageStart:
            persistedMessageCount === 0
                ? 0
                : history.messages.length > 0
                  ? Math.max(0, persistedMessageCount - history.messages.length)
                  : null,
        isLoadingPersistedMessages: false,
    };

    if (history.messages.length === 0) {
        return replaceSessionTranscript(baseSession, []);
    }

    return replaceSessionTranscript(
        baseSession,
        restoreMessagesFromHistory(history),
    );
}

function stampSessionVaultPath(
    session: AIChatSession,
    vaultPath: string | null,
): AIChatSession {
    if (session.vaultPath === vaultPath) {
        return session;
    }

    return {
        ...session,
        vaultPath,
    };
}

function sessionMatchesVaultPath(
    session: AIChatSession | undefined,
    vaultPath: string | null,
) {
    if (!session) {
        return false;
    }

    return (session.vaultPath ?? null) === vaultPath;
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
        return replaceSessionTranscript(
            {
                ...incoming,
                historySessionId:
                    incoming.historySessionId ?? incoming.sessionId,
                vaultPath: incoming.vaultPath ?? null,
                isPersistedSession: incoming.isPersistedSession ?? false,
                resumeContextPending: incoming.resumeContextPending ?? false,
                activeWorkCycleId: incoming.activeWorkCycleId ?? null,
                visibleWorkCycleId: incoming.visibleWorkCycleId ?? null,
                // The backend never resets session status to "idle" after streaming,
                // so cap stale "streaming" for freshly loaded sessions.
                status:
                    incoming.status === "streaming" ? "idle" : incoming.status,
                messages: [],
                attachments: incoming.attachments ?? [],
                persistedCreatedAt: incoming.persistedCreatedAt ?? null,
                persistedUpdatedAt: incoming.persistedUpdatedAt ?? null,
                persistedTitle: incoming.persistedTitle ?? null,
                persistedPreview: incoming.persistedPreview ?? null,
                persistedMessageCount:
                    incoming.persistedMessageCount ?? incoming.messages.length,
                loadedPersistedMessageStart:
                    incoming.loadedPersistedMessageStart ??
                    (incoming.messages.length > 0 ? 0 : null),
                isLoadingPersistedMessages:
                    incoming.isLoadingPersistedMessages ?? false,
                runtimeState:
                    incoming.runtimeState ??
                    (incoming.isPersistedSession ? "persisted_only" : "live"),
            },
            incoming.messages ?? [],
        );
    }

    const normalizedExisting = normalizeSessionTranscript(existing);
    const incomingMessages = incoming.messages ?? [];

    // Never let upsertSession set status to "streaming".
    // The backend session status stays "streaming" forever after a prompt starts
    // (it's never reset to "idle"). So "streaming" from the backend is always stale.
    // All legitimate "streaming" transitions happen through direct event handlers:
    // sendMessage (optimistic), respondPermission (optimistic),
    // applyMessageStarted, applyThinkingStarted.
    const status =
        incoming.status === "streaming" ? existing.status : incoming.status;

    const merged = {
        ...normalizedExisting,
        ...incoming,
        historySessionId:
            normalizedExisting.historySessionId ?? incoming.historySessionId,
        vaultPath: incoming.vaultPath ?? normalizedExisting.vaultPath ?? null,
        isPersistedSession:
            incoming.isPersistedSession ??
            normalizedExisting.isPersistedSession,
        resumeContextPending:
            incoming.resumeContextPending ??
            normalizedExisting.resumeContextPending,
        activeWorkCycleId:
            incoming.activeWorkCycleId ??
            normalizedExisting.activeWorkCycleId ??
            null,
        visibleWorkCycleId:
            incoming.visibleWorkCycleId ??
            normalizedExisting.visibleWorkCycleId ??
            null,
        effortsByModel:
            incoming.effortsByModel &&
            Object.keys(incoming.effortsByModel).length > 0
                ? incoming.effortsByModel
                : (normalizedExisting.effortsByModel ??
                  incoming.effortsByModel ??
                  {}),
        availableCommands:
            incoming.availableCommands && incoming.availableCommands.length > 0
                ? incoming.availableCommands
                : (normalizedExisting.availableCommands ??
                  incoming.availableCommands),
        persistedCreatedAt:
            incoming.persistedCreatedAt ??
            normalizedExisting.persistedCreatedAt ??
            null,
        persistedUpdatedAt:
            incoming.persistedUpdatedAt ??
            normalizedExisting.persistedUpdatedAt ??
            null,
        persistedTitle:
            incoming.persistedTitle ??
            normalizedExisting.persistedTitle ??
            null,
        persistedPreview:
            incoming.persistedPreview ??
            normalizedExisting.persistedPreview ??
            null,
        persistedMessageCount:
            incoming.persistedMessageCount ??
            normalizedExisting.persistedMessageCount ??
            incomingMessages.length,
        loadedPersistedMessageStart:
            incoming.loadedPersistedMessageStart ??
            normalizedExisting.loadedPersistedMessageStart ??
            (incomingMessages.length > 0 ? 0 : null),
        isLoadingPersistedMessages:
            incoming.isLoadingPersistedMessages ??
            normalizedExisting.isLoadingPersistedMessages ??
            false,
        runtimeState:
            incoming.runtimeState ?? normalizedExisting.runtimeState ?? "live",
        status,
        attachments: normalizedExisting.attachments,
    };

    return replaceSessionTranscript(
        merged,
        normalizedExisting.messageOrder?.length
            ? normalizedExisting.messages
            : incomingMessages,
    );
}

function getDefaultRuntimeId(runtimes: AIRuntimeDescriptor[]) {
    return runtimes[0]?.runtime.id ?? null;
}

function runtimeSupportsCapability(
    runtimes: AIRuntimeDescriptor[],
    runtimeId: string,
    capability: string,
) {
    return runtimes
        .find((runtime) => runtime.runtime.id === runtimeId)
        ?.runtime.capabilities.includes(capability);
}

function getRuntimeReadyButDisabledMessage(
    runtimes: AIRuntimeDescriptor[],
    runtimeId: string,
) {
    const name =
        runtimes.find((runtime) => runtime.runtime.id === runtimeId)?.runtime
            .name ?? "This runtime";
    return `${name} setup is ready, but chat sessions are not enabled yet in this build.`;
}

function getRuntimeNameForUi(
    runtimes: AIRuntimeDescriptor[],
    runtimeId?: string | null,
) {
    if (!runtimeId) return "this runtime";

    return (
        runtimes.find((runtime) => runtime.runtime.id === runtimeId)?.runtime
            .name ?? runtimeId
    ).replace(/ ACP$/, "");
}

function getAuthenticationReconnectMessage(
    runtimeId: string,
    runtimes: AIRuntimeDescriptor[],
) {
    const runtimeName = getRuntimeNameForUi(runtimes, runtimeId);
    return `You were signed out. Reconnect ${runtimeName} to continue.`;
}

function getSessionRuntimeId(
    state: Pick<ChatStore, "activeSessionId" | "sessionsById">,
) {
    const activeSessionId = state.activeSessionId;
    if (!activeSessionId) return null;
    return state.sessionsById[activeSessionId]?.runtimeId ?? null;
}

function getEffectiveRuntimeId(
    state: Pick<
        ChatStore,
        "activeSessionId" | "sessionsById" | "selectedRuntimeId" | "runtimes"
    >,
) {
    return (
        getSessionRuntimeId(state) ??
        state.selectedRuntimeId ??
        getDefaultRuntimeId(state.runtimes)
    );
}

function getSetupStatusForRuntime(
    setupStatusByRuntimeId: Record<string, AIRuntimeSetupStatus>,
    runtimeId?: string | null,
) {
    if (!runtimeId) return null;
    return setupStatusByRuntimeId[runtimeId] ?? null;
}

function touchSessionOrder(sessionOrder: string[], sessionId: string) {
    if (!sessionOrder.includes(sessionId)) {
        return [sessionId, ...sessionOrder];
    }

    return [sessionId, ...sessionOrder.filter((id) => id !== sessionId)];
}

function updateSessionById(
    state: Pick<ChatStore, "sessionsById">,
    sessionId: string,
    updater: (session: AIChatSession) => AIChatSession,
) {
    const session = state.sessionsById[sessionId];
    if (!session) return state.sessionsById;

    return {
        ...state.sessionsById,
        [sessionId]: updater(session),
    };
}

function toPersistedHistory(session: AIChatSession): PersistedSessionHistory {
    // The edits buffer is intentionally excluded from persisted history.
    // It represents pending local review state, not durable chat history.
    const messages = getSessionTranscriptMessages(session)
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
    const startIndex = getSessionPersistedWindowStart(session);
    const messageCount = startIndex + messages.length;
    const createdAt =
        session.persistedCreatedAt ??
        (timestamps.length ? Math.min(...timestamps) : Date.now());
    const updatedAt =
        timestamps.length > 0
            ? Math.max(session.persistedUpdatedAt ?? 0, ...timestamps)
            : (session.persistedUpdatedAt ?? Date.now());

    return {
        version: 1,
        session_id: session.historySessionId || session.sessionId,
        runtime_id: session.runtimeId,
        model_id: session.modelId,
        mode_id: session.modeId,
        created_at: createdAt,
        updated_at: updatedAt,
        start_index: startIndex,
        message_count: messageCount,
        title: getSessionTitle(session),
        preview: getSessionPreview(session),
        messages,
    };
}

function hasPersistableSessionContent(session: AIChatSession) {
    return toPersistedHistory(session).messages.length > 0;
}

const _queueDrainLocks = new Set<string>();
const _pendingSessionPersistence = new Map<string, AIChatSession>();
let _sessionPersistenceFlushScheduled = false;
let _sessionPersistenceEpoch = 0;

function getSessionPersistenceKey(session: AIChatSession) {
    return session.historySessionId || session.sessionId;
}

async function persistSessionNow(session: AIChatSession) {
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

async function flushPendingSessionPersistence(epoch: number) {
    if (epoch !== _sessionPersistenceEpoch) {
        return;
    }

    _sessionPersistenceFlushScheduled = false;
    const pendingSessions = [..._pendingSessionPersistence.values()];
    _pendingSessionPersistence.clear();

    await Promise.all(
        pendingSessions.map((session) => persistSessionNow(session)),
    );
}

function scheduleSessionPersistence(session: AIChatSession) {
    if (!hasPersistableSessionContent(session)) return;

    _pendingSessionPersistence.set(getSessionPersistenceKey(session), session);
    if (_sessionPersistenceFlushScheduled) {
        return;
    }

    _sessionPersistenceFlushScheduled = true;
    const scheduledEpoch = _sessionPersistenceEpoch;
    queueMicrotask(() => {
        void flushPendingSessionPersistence(scheduledEpoch);
    });
}

function scheduleStaleStreamingCheck(_: string) {}

function clearStaleStreamingCheck(_: string) {}

function markSessionStreamingIfLive(session: AIChatSession): AIChatSession {
    if (session.runtimeState != null && session.runtimeState !== "live") {
        return session;
    }

    if (
        session.status === "streaming" ||
        session.status === "waiting_permission" ||
        session.status === "waiting_user_input"
    ) {
        return session;
    }

    return {
        ...session,
        status: "streaming",
    };
}

function toolActivityKeepsSessionStreaming(status: string) {
    return status === "pending" || status === "in_progress";
}

function statusEventKeepsSessionStreaming(status: string) {
    return status === "pending" || status === "in_progress";
}

function planUpdateKeepsSessionStreaming(payload: AIPlanUpdatePayload) {
    return payload.entries.some((entry) => entry.status === "in_progress");
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
            const normalizedSession = normalizeSessionTranscript(session);
            const workCycleId =
                normalizedSession.activeWorkCycleId ??
                normalizedSession.visibleWorkCycleId ??
                null;
            const lastMessageId =
                normalizedSession.messageOrder?.at(-1) ?? null;
            const lastMsg = lastMessageId
                ? normalizedSession.messagesById?.[lastMessageId]
                : null;

            let nextSession: AIChatSession;
            if (
                lastMsg &&
                lastMsg.role === "assistant" &&
                lastMsg.kind === "text" &&
                lastMsg.inProgress
            ) {
                nextSession = appendToMessageContent(
                    normalizedSession,
                    lastMsg.id,
                    text,
                );
            } else {
                const idTaken =
                    normalizedSession.messagesById?.[message_id] != null;
                nextSession = appendSessionMessage(normalizedSession, {
                    id: idTaken ? `${message_id}:${Date.now()}` : message_id,
                    role: "assistant" as const,
                    kind: "text" as const,
                    content: text,
                    workCycleId,
                    title: "Assistant",
                    timestamp: Date.now(),
                    inProgress: true,
                });
            }

            sessionsById = {
                ...sessionsById,
                [sessionId]: nextSession,
            };
            changed = true;
        }

        // Apply thinking deltas
        for (const [sessionId, msgMap] of thinkEntries) {
            const session = sessionsById[sessionId];
            if (!session) continue;
            let nextSession = normalizeSessionTranscript(session);
            let sessionChanged = false;
            for (const [messageId, text] of msgMap) {
                if (nextSession.messageIndexById?.[messageId] != null) {
                    nextSession = replaceSessionMessage(
                        nextSession,
                        messageId,
                        (message) => ({
                            ...message,
                            content: message.content + text,
                            inProgress: true,
                        }),
                    );
                    sessionChanged = true;
                }
            }

            if (!sessionChanged) continue;

            sessionsById = {
                ...sessionsById,
                [sessionId]: nextSession,
            };
            changed = true;
        }

        if (!changed) return state;

        return { sessionsById };
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
    scheduleSessionPersistence(session);
}

async function pruneSessionHistoriesForCurrentVault(maxAgeDays: number) {
    const vaultPath = useVaultStore.getState().vaultPath;
    if (!vaultPath || maxAgeDays <= 0) return 0;
    return aiPruneSessionHistories(vaultPath, maxAgeDays);
}

async function waitForPersistedTranscriptIdle(sessionId: string) {
    while (true) {
        const session = useChatStore.getState().sessionsById[sessionId];
        if (!session || !session.isLoadingPersistedMessages) {
            return;
        }

        await new Promise((resolve) => window.setTimeout(resolve, 16));
    }
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
    const initialAutoContextEnabled = loadAutoContextPreference(
        useVaultStore.getState().vaultPath,
    );

    async function loadPersistedTranscript(
        sessionId: string,
        mode: "latest" | "full" | "older",
    ): Promise<boolean> {
        const session = get().sessionsById[sessionId];
        if (!session) return false;
        const expectedHistorySessionId =
            session.historySessionId || session.sessionId;

        const persistedCount = session.persistedMessageCount ?? 0;
        if (persistedCount === 0) {
            set((state) => ({
                sessionsById: updateSessionById(
                    state,
                    sessionId,
                    (current) => ({
                        ...current,
                        loadedPersistedMessageStart: 0,
                        isLoadingPersistedMessages: false,
                    }),
                ),
            }));
            return true;
        }

        if (session.isLoadingPersistedMessages) {
            await waitForPersistedTranscriptIdle(sessionId);
            return loadPersistedTranscript(sessionId, mode);
        }

        if (
            (mode === "latest" || mode === "full") &&
            hasFullPersistedTranscriptLoaded(session)
        ) {
            return true;
        }

        if (
            mode === "latest" &&
            session.loadedPersistedMessageStart != null &&
            session.loadedPersistedMessageStart < persistedCount
        ) {
            return true;
        }

        if (mode === "older" && !hasOlderPersistedMessages(session)) {
            return true;
        }

        const currentStart =
            session.loadedPersistedMessageStart ?? persistedCount;
        const startIndex =
            mode === "full"
                ? 0
                : mode === "older"
                  ? Math.max(0, currentStart - TRANSCRIPT_PAGE_SIZE)
                  : Math.max(0, persistedCount - TRANSCRIPT_PAGE_SIZE);
        const limit =
            mode === "full"
                ? persistedCount
                : mode === "older"
                  ? currentStart - startIndex
                  : persistedCount - startIndex;

        if (limit <= 0) return true;

        const vaultPath = useVaultStore.getState().vaultPath;
        if (!vaultPath) return false;

        set((state) => ({
            sessionsById: updateSessionById(state, sessionId, (current) => ({
                ...current,
                isLoadingPersistedMessages: true,
            })),
        }));

        try {
            const payload: unknown = await aiLoadSessionHistoryPage(
                vaultPath,
                session.historySessionId || session.sessionId,
                startIndex,
                limit,
            );
            if (!isPersistedHistoryPage(payload)) {
                throw new Error(
                    "Persisted transcript page payload is invalid.",
                );
            }
            const page = payload;
            if (page.session_id !== expectedHistorySessionId) {
                throw new Error("Persisted transcript page session mismatch.");
            }

            set((state) => ({
                sessionsById: updateSessionById(state, sessionId, (current) => {
                    const currentSession = normalizeSessionTranscript(current);
                    const shouldPrepend =
                        mode === "older" ||
                        (mode !== "older" &&
                            currentSession.messages.length > 0 &&
                            (currentSession.loadedPersistedMessageStart ==
                                null ||
                                currentSession.loadedPersistedMessageStart >=
                                    (currentSession.persistedMessageCount ??
                                        0)));

                    return applyPersistedHistoryPage(
                        currentSession,
                        page,
                        shouldPrepend ? "prepend" : "replace",
                    );
                }),
            }));
            return true;
        } catch (error) {
            set((state) => ({
                sessionsById: updateSessionById(
                    state,
                    sessionId,
                    (current) => ({
                        ...current,
                        isLoadingPersistedMessages: false,
                    }),
                ),
            }));
            console.warn(
                "Failed to load persisted session transcript page:",
                error,
            );
            return false;
        }
    }

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

    async function ensureRuntimeVisibleAfterOnboarding(runtimeId: string) {
        const state = get();
        const activeRuntimeId = state.activeSessionId
            ? state.sessionsById[state.activeSessionId]?.runtimeId
            : null;
        if (activeRuntimeId === runtimeId) {
            return;
        }

        const existingSessionId = findMostRecentSessionIdForRuntime(
            state.sessionsById,
            state.sessionOrder,
            runtimeId,
        );
        if (existingSessionId) {
            state.setActiveSession(existingSessionId);
            return;
        }

        if (
            runtimeSupportsCapability(
                state.runtimes,
                runtimeId,
                "create_session",
            )
        ) {
            await state.newSession(runtimeId);
        }
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

        if (session.runtimeState !== "live") {
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

                return {
                    sessionsById: {
                        ...state.sessionsById,
                        [activeSessionId]: upsertSessionMessage(
                            {
                                ...nextSession,
                                status: "streaming",
                                attachments:
                                    source === "immediate"
                                        ? []
                                        : nextSession.attachments,
                            },
                            userMessage,
                            {
                                preserveTimestamp: true,
                                preserveWorkCycleId: true,
                            },
                        ),
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
                await get().refreshSetupStatus(session.runtimeId);
            }
        }
    }

    return {
        runtimeConnectionByRuntimeId: {},
        setupStatusByRuntimeId: {},
        runtimes: [],
        sessionsById: {},
        sessionOrder: [],
        activeSessionId: null,
        selectedRuntimeId: null,
        isInitializing: false,
        notePickerOpen: false,
        autoContextEnabled: initialAutoContextEnabled,
        requireCmdEnterToSend: initialPreferences.requireCmdEnterToSend,
        composerFontSize: initialPreferences.composerFontSize,
        chatFontSize: initialPreferences.chatFontSize,
        composerFontFamily: initialPreferences.composerFontFamily,
        chatFontFamily: initialPreferences.chatFontFamily,
        editDiffZoom: initialPreferences.editDiffZoom,
        historyRetentionDays: initialPreferences.historyRetentionDays,
        screenshotRetentionSeconds:
            initialPreferences.screenshotRetentionSeconds,
        composerPartsBySessionId: {},
        queuedMessagesBySessionId: {},
        queuedMessageEditBySessionId: {},

        syncAutoContextForVault: (vaultPath) => {
            const next = loadAutoContextPreference(vaultPath);
            set((state) =>
                state.autoContextEnabled === next
                    ? state
                    : { autoContextEnabled: next },
            );
        },

        setSelectedRuntime: (runtimeId) => {
            set({ selectedRuntimeId: runtimeId });
        },

        initialize: async () => {
            if (get().isInitializing) return;

            set({ isInitializing: true });

            try {
                const runtimes = hydrateRuntimesFromCache(
                    await aiListRuntimes(),
                );
                const runtimeIds = runtimes.map(
                    (descriptor) => descriptor.runtime.id,
                );
                const setupResults = await Promise.allSettled(
                    runtimeIds.map((runtimeId) => aiGetSetupStatus(runtimeId)),
                );
                const runtimeConnectionByRuntimeId = buildRuntimeConnectionMap(
                    runtimes,
                    get().runtimeConnectionByRuntimeId,
                );
                const setupStatuses: AIRuntimeSetupStatus[] = [];
                setupResults.forEach((result, index) => {
                    const runtimeId = runtimeIds[index];
                    if (result.status === "fulfilled") {
                        setupStatuses.push(result.value);
                        runtimeConnectionByRuntimeId[runtimeId] =
                            getRuntimeConnectionForSetup(result.value);
                        return;
                    }

                    runtimeConnectionByRuntimeId[runtimeId] = {
                        status: "error",
                        message: getAiErrorMessage(
                            result.reason,
                            "Failed to check the AI setup.",
                        ),
                    };
                });
                const setupStatusByRuntimeId =
                    buildSetupStatusMap(setupStatuses);
                const defaultRuntimeId =
                    get().selectedRuntimeId ?? getDefaultRuntimeId(runtimes);

                set({
                    runtimes,
                    selectedRuntimeId: defaultRuntimeId,
                    setupStatusByRuntimeId,
                    runtimeConnectionByRuntimeId,
                });

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
                            await aiLoadSessionHistories(vaultPath, {
                                includeMessages: false,
                            })
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
                            const scopedSession = stampSessionVaultPath(
                                session,
                                vaultPath,
                            );
                            const existing =
                                state.sessionsById[scopedSession.sessionId];
                            let merged = mergeSession(existing, scopedSession);
                            const persisted = persistedBySessionId.get(
                                merged.historySessionId,
                            );

                            if (persisted) {
                                merged = applyPersistedHistoryMetadata(
                                    merged,
                                    persisted,
                                );
                            }

                            if (
                                getSessionTranscriptLength(merged) === 0 &&
                                persisted &&
                                persisted.messages.length > 0
                            ) {
                                merged = replaceSessionTranscript(
                                    {
                                        ...merged,
                                        loadedPersistedMessageStart: Math.max(
                                            0,
                                            getPersistedHistoryMessageCount(
                                                persisted,
                                            ) - persisted.messages.length,
                                        ),
                                    },
                                    restoreMessagesFromHistory(persisted),
                                );
                            }

                            accumulator[scopedSession.sessionId] = merged;
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
                                vaultPath,
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
                        const nextSelectedRuntimeId =
                            (nextActiveSessionId
                                ? nextSessionsById[nextActiveSessionId]
                                      ?.runtimeId
                                : null) ??
                            state.selectedRuntimeId ??
                            getDefaultRuntimeId(hydratedRuntimes);

                        return {
                            runtimes: hydratedRuntimes,
                            sessionsById: nextSessionsById,
                            sessionOrder: nextSessionOrder,
                            activeSessionId: nextActiveSessionId,
                            selectedRuntimeId: nextSelectedRuntimeId,
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
                        get().sessionsById[nextActiveSessionId] &&
                        get().sessionsById[nextActiveSessionId]!
                            .runtimeState !== "live"
                    ) {
                        await get().resumeSession(nextActiveSessionId);
                    } else if (nextActiveSessionId) {
                        await get().ensureSessionTranscriptLoaded(
                            nextActiveSessionId,
                            "latest",
                        );
                    }
                    return;
                }

                if (!get().activeSessionId) {
                    const runtimeId = defaultRuntimeId;
                    const setupStatus = getSetupStatusForRuntime(
                        setupStatusByRuntimeId,
                        runtimeId,
                    );
                    if (runtimeId) {
                        if (setupStatus?.onboardingRequired) {
                            return;
                        }
                        await get().newSession(runtimeId);
                    }
                }
            } catch (error) {
                const runtimeId =
                    get().selectedRuntimeId ??
                    getDefaultRuntimeId(get().runtimes);
                if (runtimeId) {
                    set((state) => ({
                        runtimeConnectionByRuntimeId: setRuntimeConnectionState(
                            state.runtimeConnectionByRuntimeId,
                            runtimeId,
                            {
                                status: "error",
                                message: getAiErrorMessage(
                                    error,
                                    "Failed to load AI runtimes.",
                                ),
                            },
                        ),
                    }));
                }
            } finally {
                set({ isInitializing: false });
            }
        },

        refreshSetupStatus: async (runtimeId) => {
            const nextRuntimeId = runtimeId ?? getEffectiveRuntimeId(get());
            if (!nextRuntimeId) return;
            try {
                const previousSetupStatus = getSetupStatusForRuntime(
                    get().setupStatusByRuntimeId,
                    nextRuntimeId,
                );
                const setupStatus = await aiGetSetupStatus(nextRuntimeId);
                set((state) => ({
                    selectedRuntimeId: nextRuntimeId,
                    ...applyRuntimeSetupStatusPatch(state, setupStatus),
                }));
                if (
                    previousSetupStatus?.onboardingRequired &&
                    !setupStatus.onboardingRequired
                ) {
                    await ensureRuntimeVisibleAfterOnboarding(nextRuntimeId);
                }
            } catch (error) {
                set((state) => ({
                    runtimeConnectionByRuntimeId: setRuntimeConnectionState(
                        state.runtimeConnectionByRuntimeId,
                        nextRuntimeId,
                        {
                            status: "error",
                            message: getAiErrorMessage(
                                error,
                                "Failed to check the AI setup.",
                            ),
                        },
                    ),
                }));
            }
        },

        saveSetup: async (input) => {
            const targetRuntimeId =
                input.runtimeId ?? getEffectiveRuntimeId(get());
            if (!targetRuntimeId) return;
            try {
                const previousSetupStatus = getSetupStatusForRuntime(
                    get().setupStatusByRuntimeId,
                    targetRuntimeId,
                );
                const setupStatus = await aiUpdateSetup({
                    ...input,
                    runtimeId: targetRuntimeId,
                });
                set((state) => ({
                    selectedRuntimeId: targetRuntimeId,
                    ...applyRuntimeSetupStatusPatch(state, setupStatus),
                }));

                if (!setupStatus.onboardingRequired) {
                    const state = get();
                    if (previousSetupStatus?.onboardingRequired) {
                        await ensureRuntimeVisibleAfterOnboarding(
                            setupStatus.runtimeId,
                        );
                    } else if (
                        !runtimeSupportsCapability(
                            state.runtimes,
                            setupStatus.runtimeId,
                            "create_session",
                        )
                    ) {
                        set((currentState) => ({
                            runtimeConnectionByRuntimeId:
                                setRuntimeConnectionState(
                                    currentState.runtimeConnectionByRuntimeId,
                                    setupStatus.runtimeId,
                                    {
                                        status: "ready",
                                        message:
                                            getRuntimeReadyButDisabledMessage(
                                                state.runtimes,
                                                setupStatus.runtimeId,
                                            ),
                                    },
                                ),
                        }));
                    }
                }
            } catch (error) {
                set((state) => ({
                    runtimeConnectionByRuntimeId: setRuntimeConnectionState(
                        state.runtimeConnectionByRuntimeId,
                        targetRuntimeId,
                        {
                            status: "error",
                            message: getAiErrorMessage(
                                error,
                                "Failed to save the AI setup.",
                            ),
                        },
                    ),
                }));
            }
        },

        startAuth: async (input) => {
            const targetRuntimeId =
                input.runtimeId ?? getEffectiveRuntimeId(get());
            if (!targetRuntimeId) return;
            try {
                const previousSetupStatus = getSetupStatusForRuntime(
                    get().setupStatusByRuntimeId,
                    targetRuntimeId,
                );
                if (
                    input.customBinaryPath ||
                    input.codexApiKey ||
                    input.openaiApiKey ||
                    input.geminiApiKey ||
                    input.googleApiKey ||
                    input.googleCloudProject ||
                    input.googleCloudLocation ||
                    input.gatewayBaseUrl ||
                    input.gatewayHeaders ||
                    input.anthropicBaseUrl ||
                    input.anthropicCustomHeaders ||
                    input.anthropicAuthToken
                ) {
                    const setupStatus = await aiUpdateSetup({
                        runtimeId: targetRuntimeId,
                        customBinaryPath: input.customBinaryPath,
                        codexApiKey: input.codexApiKey,
                        openaiApiKey: input.openaiApiKey,
                        geminiApiKey: input.geminiApiKey,
                        googleApiKey: input.googleApiKey,
                        googleCloudProject: input.googleCloudProject,
                        googleCloudLocation: input.googleCloudLocation,
                        gatewayBaseUrl: input.gatewayBaseUrl,
                        gatewayHeaders: input.gatewayHeaders,
                        anthropicBaseUrl: input.anthropicBaseUrl,
                        anthropicCustomHeaders: input.anthropicCustomHeaders,
                        anthropicAuthToken: input.anthropicAuthToken,
                    });
                    set((state) => ({
                        selectedRuntimeId: targetRuntimeId,
                        ...applyRuntimeSetupStatusPatch(state, setupStatus),
                    }));
                }

                const setupStatus = await aiStartAuth(
                    {
                        methodId: input.methodId,
                        runtimeId: targetRuntimeId,
                    },
                    useVaultStore.getState().vaultPath,
                );
                set((state) => ({
                    selectedRuntimeId: targetRuntimeId,
                    ...applyRuntimeSetupStatusPatch(state, setupStatus),
                }));

                if (!setupStatus.onboardingRequired) {
                    const state = get();
                    if (previousSetupStatus?.onboardingRequired) {
                        await ensureRuntimeVisibleAfterOnboarding(
                            setupStatus.runtimeId,
                        );
                    } else if (
                        !runtimeSupportsCapability(
                            state.runtimes,
                            setupStatus.runtimeId,
                            "create_session",
                        )
                    ) {
                        set((currentState) => ({
                            runtimeConnectionByRuntimeId:
                                setRuntimeConnectionState(
                                    currentState.runtimeConnectionByRuntimeId,
                                    setupStatus.runtimeId,
                                    {
                                        status: "ready",
                                        message:
                                            getRuntimeReadyButDisabledMessage(
                                                state.runtimes,
                                                setupStatus.runtimeId,
                                            ),
                                    },
                                ),
                        }));
                    }
                }
            } catch (error) {
                set((state) => ({
                    runtimeConnectionByRuntimeId: setRuntimeConnectionState(
                        state.runtimeConnectionByRuntimeId,
                        targetRuntimeId,
                        {
                            status: "error",
                            message: getAiErrorMessage(
                                error,
                                "Failed to authenticate the AI runtime.",
                            ),
                        },
                    ),
                }));
            }
        },

        upsertSession: (session, activate = false) => {
            let shouldDrainQueue = false;
            set((state) => {
                const currentVaultPath = useVaultStore.getState().vaultPath;
                const scopedSession = stampSessionVaultPath(
                    session,
                    currentVaultPath,
                );
                const existing = state.sessionsById[scopedSession.sessionId];
                const isKnown = state.sessionOrder.includes(
                    scopedSession.sessionId,
                );

                if (
                    !activate &&
                    ((existing &&
                        !sessionMatchesVaultPath(existing, currentVaultPath)) ||
                        !sessionMatchesVaultPath(
                            scopedSession,
                            currentVaultPath,
                        ))
                ) {
                    return state;
                }

                // Ignore unexpected sessions unless explicitly activated by
                // this vault/window lifecycle.
                if (!isKnown && !activate) return state;

                const nextRuntimes = scopedSession.isPersistedSession
                    ? state.runtimes
                    : hydrateRuntimesFromSessions(state.runtimes, [
                          scopedSession,
                      ]);
                const nextSession = mergeSession(existing, scopedSession);
                shouldDrainQueue =
                    nextSession.status === "idle" &&
                    existing?.status !== "idle" &&
                    !nextSession.isResumingSession;

                return {
                    runtimes: nextRuntimes,
                    sessionsById: {
                        ...state.sessionsById,
                        [scopedSession.sessionId]: nextSession,
                    },
                    sessionOrder: activate
                        ? touchSessionOrder(
                              state.sessionOrder,
                              scopedSession.sessionId,
                          )
                        : state.sessionOrder,
                    activeSessionId:
                        activate || !state.activeSessionId
                            ? scopedSession.sessionId
                            : state.activeSessionId,
                    selectedRuntimeId:
                        activate || !state.activeSessionId
                            ? nextSession.runtimeId
                            : state.selectedRuntimeId,
                    composerPartsBySessionId: state.composerPartsBySessionId[
                        scopedSession.sessionId
                    ]
                        ? state.composerPartsBySessionId
                        : {
                              ...state.composerPartsBySessionId,
                              [scopedSession.sessionId]:
                                  createEmptyComposerParts(),
                          },
                };
            });

            if (shouldDrainQueue) {
                void get().tryDrainQueue(session.sessionId);
            }
        },

        applyRuntimeConnection: ({ runtime_id, status, message }) => {
            const affectedSessionIds: string[] = [];
            set((state) => {
                const runtimeConnectionByRuntimeId = setRuntimeConnectionState(
                    state.runtimeConnectionByRuntimeId,
                    runtime_id,
                    {
                        status,
                        message: message ?? null,
                    },
                );

                if (status !== "error") {
                    return { runtimeConnectionByRuntimeId };
                }

                const nextSessionsById = { ...state.sessionsById };
                const failedAt = Date.now();
                let changed = false;

                for (const [sessionId, session] of Object.entries(
                    state.sessionsById,
                )) {
                    if (
                        session.runtimeId !== runtime_id ||
                        session.runtimeState !== "live"
                    ) {
                        continue;
                    }

                    clearStaleStreamingCheck(sessionId);
                    affectedSessionIds.push(sessionId);
                    changed = true;
                    const revertedSession = finalizeActionLogForWorkCycle(
                        stampElapsedOnTurnStartedSession(
                            appendSessionError(
                                {
                                    ...markPendingInteractionMessagesIdle(
                                        session,
                                    ),
                                    isPersistedSession: true,
                                    isResumingSession: false,
                                    runtimeState: "detached" as const,
                                    status: "error" as const,
                                    resumeContextPending: true,
                                },
                                message ??
                                    "The AI runtime disconnected unexpectedly.",
                            ),
                            failedAt,
                        ),
                    );
                    nextSessionsById[sessionId] = revertedSession;
                }

                return changed
                    ? {
                          runtimeConnectionByRuntimeId,
                          sessionsById: nextSessionsById,
                      }
                    : { runtimeConnectionByRuntimeId };
            });

            for (const sessionId of affectedSessionIds) {
                const session = get().sessionsById[sessionId];
                if (session) {
                    void persistSession(session);
                }
            }
        },

        applySessionError: ({ session_id, message }) => {
            if (session_id) clearStaleStreamingCheck(session_id);
            set((state) => {
                const sessionRuntimeId = session_id
                    ? state.sessionsById[session_id]?.runtimeId
                    : null;
                const effectiveRuntimeId =
                    sessionRuntimeId ?? getEffectiveRuntimeId(state);
                const runtimeSetupStatus = getSetupStatusForRuntime(
                    state.setupStatusByRuntimeId,
                    effectiveRuntimeId,
                );
                const nextSetupStatusByRuntimeId =
                    runtimeSetupStatus && isAuthenticationErrorMessage(message)
                        ? {
                              ...state.setupStatusByRuntimeId,
                              [runtimeSetupStatus.runtimeId]: {
                                  ...runtimeSetupStatus,
                                  authReady: false,
                                  authMethod: undefined,
                                  onboardingRequired: true,
                                  message: getAuthenticationReconnectMessage(
                                      runtimeSetupStatus.runtimeId,
                                      state.runtimes,
                                  ),
                              },
                          }
                        : state.setupStatusByRuntimeId;
                const nextRuntimeConnectionByRuntimeId =
                    effectiveRuntimeId != null
                        ? setRuntimeConnectionState(
                              state.runtimeConnectionByRuntimeId,
                              effectiveRuntimeId,
                              {
                                  status: "error",
                                  message,
                              },
                          )
                        : state.runtimeConnectionByRuntimeId;

                if (!session_id || !state.sessionsById[session_id]) {
                    return {
                        setupStatusByRuntimeId: nextSetupStatusByRuntimeId,
                        runtimeConnectionByRuntimeId:
                            nextRuntimeConnectionByRuntimeId,
                    };
                }

                const session = state.sessionsById[session_id];
                const failedAt = Date.now();
                const revertedSession = finalizeActionLogForWorkCycle({
                    ...markPendingInteractionMessagesIdle(session),
                    isResumingSession: false,
                });
                return {
                    setupStatusByRuntimeId: nextSetupStatusByRuntimeId,
                    runtimeConnectionByRuntimeId:
                        nextRuntimeConnectionByRuntimeId,
                    sessionsById: {
                        ...state.sessionsById,
                        [session_id]: stampElapsedOnTurnStartedSession(
                            appendSessionError(
                                {
                                    ...revertedSession,
                                    status: "error",
                                    runtimeState:
                                        revertedSession.runtimeState ?? "live",
                                },
                                message,
                            ),
                            failedAt,
                        ),
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
            set((state) => {
                const session = state.sessionsById[session_id];
                if (!session) return state;
                const nextSession = markSessionStreamingIfLive(session);
                if (nextSession === session) return state;
                return {
                    sessionsById: {
                        ...state.sessionsById,
                        [session_id]: nextSession,
                    },
                };
            });
            bufferMessageDelta(session_id, message_id, delta);
        },

        applyMessageCompleted: ({ session_id }) => {
            clearStaleStreamingCheck(session_id);
            flushDeltasSync();
            const completedAt = Date.now();
            set((state) => {
                const session = state.sessionsById[session_id];
                if (!session) return state;
                const nextSession = finalizeActionLogForWorkCycle(
                    stampElapsedOnTurnStartedSession(
                        {
                            ...markAllMessagesComplete(session),
                            status: "idle",
                        },
                        completedAt,
                    ),
                );

                return {
                    sessionsById: {
                        ...state.sessionsById,
                        [session_id]: nextSession,
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
                const nextSession = normalizeSessionTranscript(
                    ensureSessionWorkCycle(session),
                );
                const exists =
                    nextSession.messageIndexById?.[message_id] != null;
                if (exists) return state;

                return {
                    sessionsById: {
                        ...state.sessionsById,
                        [session_id]: appendSessionMessage(
                            {
                                ...nextSession,
                                status: "streaming",
                            },
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
                        ),
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
            set((state) => {
                const session = state.sessionsById[session_id];
                if (!session) return state;
                const nextSession = markSessionStreamingIfLive(session);
                if (nextSession === session) return state;
                return {
                    sessionsById: {
                        ...state.sessionsById,
                        [session_id]: nextSession,
                    },
                };
            });
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
                        [session_id]: setMessageInProgressState(
                            session,
                            message_id,
                            false,
                        ),
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
            const eventTimestamp = Date.now();
            let workCycleId: string | null | undefined = null;

            set((state) => {
                const session = state.sessionsById[payload.session_id];
                if (!session) return state;
                const baseSession = ensureSessionWorkCycle(session);
                const nextSession = toolActivityKeepsSessionStreaming(
                    payload.status,
                )
                    ? markSessionStreamingIfLive(baseSession)
                    : baseSession;
                workCycleId = nextSession.activeWorkCycleId;
                const shouldConsolidate =
                    payload.status === "completed" &&
                    (payload.diffs?.some(diffCanBeTracked) ?? false) &&
                    Boolean(workCycleId);

                const messageId = `tool:${payload.tool_call_id}`;
                const nextMessage: AIChatMessage = {
                    id: messageId,
                    role: "assistant",
                    kind: "tool",
                    title: payload.title,
                    content: payload.summary ?? payload.title,
                    timestamp: eventTimestamp,
                    workCycleId: nextSession.activeWorkCycleId,
                    diffs: payload.diffs,
                    meta: {
                        tool: payload.kind,
                        status: payload.status,
                        target: payload.target ?? null,
                    },
                };

                // Consolidate diffs into ActionLog synchronously from the
                // accumulated tracked-file state. Delayed precomputed patches
                // are not allowed to rewrite the domain state.
                let consolidated = nextSession;
                if (shouldConsolidate) {
                    consolidated = ensureActionLog(consolidated);
                    consolidated = consolidateActionLogDiffs(
                        consolidated,
                        payload.diffs ?? [],
                        workCycleId,
                        eventTimestamp,
                    );
                    if (!isSessionBusy(nextSession)) {
                        consolidated = finalizeActionLogForWorkCycle(
                            consolidated,
                            workCycleId,
                        );
                    }
                }

                return {
                    sessionsById: {
                        ...state.sessionsById,
                        [payload.session_id]: upsertSessionMessage(
                            consolidated,
                            nextMessage,
                            {
                                preserveTimestamp: true,
                                preserveWorkCycleId: true,
                            },
                        ),
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
                const baseSession = ensureSessionWorkCycle(session);
                const nextSession = statusEventKeepsSessionStreaming(
                    payload.status,
                )
                    ? markSessionStreamingIfLive(baseSession)
                    : baseSession;

                const messageId = `status:${payload.event_id}`;
                const nextMessage = {
                    ...createStatusMessage(payload),
                    workCycleId: nextSession.activeWorkCycleId,
                };

                return {
                    sessionsById: {
                        ...state.sessionsById,
                        [payload.session_id]: upsertSessionMessage(
                            nextSession,
                            {
                                ...nextMessage,
                                id: messageId,
                            },
                            {
                                preserveWorkCycleId: true,
                            },
                        ),
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
                const baseSession = ensureSessionWorkCycle(session);
                const nextSession = planUpdateKeepsSessionStreaming(payload)
                    ? markSessionStreamingIfLive(baseSession)
                    : baseSession;

                const nextMessage = {
                    ...createPlanMessage(payload),
                    workCycleId: nextSession.activeWorkCycleId,
                };

                return {
                    sessionsById: {
                        ...state.sessionsById,
                        [payload.session_id]: upsertSessionMessage(
                            nextSession,
                            nextMessage,
                            {
                                preserveTimestamp: true,
                                preserveWorkCycleId: true,
                            },
                        ),
                    },
                    sessionOrder: touchSessionOrder(
                        state.sessionOrder,
                        payload.session_id,
                    ),
                };
            });
        },

        applyAvailableCommandsUpdate: (payload) => {
            set((state) => {
                const session = state.sessionsById[payload.session_id];
                if (!session) return state;

                return {
                    sessionsById: {
                        ...state.sessionsById,
                        [payload.session_id]: {
                            ...session,
                            availableCommands: payload.commands,
                        },
                    },
                };
            });
        },

        applyPermissionRequest: (payload) => {
            const eventTimestamp = Date.now();
            let workCycleId: string | null | undefined = null;

            set((state) => {
                const session = state.sessionsById[payload.session_id];
                if (!session) return state;
                const nextSession = ensureSessionWorkCycle(session);

                // Consolidate diffs into ActionLog
                workCycleId = nextSession.activeWorkCycleId;
                const hasDiffs =
                    payload.diffs.some(diffCanBeTracked) &&
                    Boolean(workCycleId);
                let sessionWithBuffer = nextSession;
                if (hasDiffs) {
                    sessionWithBuffer = ensureActionLog(sessionWithBuffer);
                    sessionWithBuffer = consolidateActionLogDiffs(
                        sessionWithBuffer,
                        payload.diffs,
                        workCycleId,
                        eventTimestamp,
                    );
                }

                const messageId = `permission:${payload.request_id}`;
                const nextMessage: AIChatMessage = {
                    id: messageId,
                    role: "assistant",
                    kind: "permission",
                    title: "Permission request",
                    content: payload.title,
                    timestamp: eventTimestamp,
                    workCycleId: nextSession.activeWorkCycleId,
                    permissionRequestId: payload.request_id,
                    permissionOptions: payload.options,
                    diffs: payload.diffs.length > 0 ? payload.diffs : undefined,
                    meta: {
                        status: "pending",
                        target: payload.target ?? null,
                    },
                };

                return {
                    sessionsById: {
                        ...state.sessionsById,
                        [payload.session_id]: upsertSessionMessage(
                            {
                                ...sessionWithBuffer,
                                status: "waiting_permission",
                            },
                            nextMessage,
                            {
                                preserveWorkCycleId: true,
                            },
                        ),
                    },
                    sessionOrder: touchSessionOrder(
                        state.sessionOrder,
                        payload.session_id,
                    ),
                };
            });
        },

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

                return {
                    sessionsById: {
                        ...state.sessionsById,
                        [payload.session_id]: upsertSessionMessage(
                            {
                                ...nextSession,
                                status: "waiting_user_input",
                            },
                            nextMessage,
                            {
                                preserveWorkCycleId: true,
                            },
                        ),
                    },
                    sessionOrder: touchSessionOrder(
                        state.sessionOrder,
                        payload.session_id,
                    ),
                };
            }),

        ensureSessionTranscriptLoaded: async (sessionId, mode = "latest") => {
            return loadPersistedTranscript(
                sessionId,
                mode === "full" ? "full" : "latest",
            );
        },

        loadOlderMessages: async (sessionId) => {
            return loadPersistedTranscript(sessionId, "older");
        },

        setActiveSession: (sessionId) =>
            set((state) =>
                state.sessionsById[sessionId]
                    ? {
                          activeSessionId: sessionId,
                          selectedRuntimeId:
                              state.sessionsById[sessionId]?.runtimeId ??
                              state.selectedRuntimeId,
                      }
                    : state,
            ),

        resumeSession: async (sessionId) => {
            const state = get();
            const session = state.sessionsById[sessionId];
            if (!session) return null;
            if (session.runtimeState === "live") return sessionId;
            if (session.isResumingSession) return sessionId;

            set((currentState) => {
                const currentSession = currentState.sessionsById[sessionId];
                if (!currentSession || currentSession.runtimeState === "live") {
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
                const currentSession = get().sessionsById[sessionId];
                if (!currentSession || currentSession.runtimeState === "live") {
                    return get().activeSessionId;
                }

                const vaultPath = useVaultStore.getState().vaultPath;
                const supportsNativeResume = runtimeSupportsCapability(
                    get().runtimes,
                    currentSession.runtimeId,
                    "resume_session",
                );
                const transcriptLoaded = supportsNativeResume
                    ? await loadPersistedTranscript(sessionId, "latest")
                    : await loadPersistedTranscript(sessionId, "full");
                if (!transcriptLoaded) {
                    throw new Error(
                        supportsNativeResume
                            ? "Failed to load the latest saved transcript before resuming."
                            : "Failed to load the full saved transcript before resuming.",
                    );
                }

                const latestSession =
                    get().sessionsById[sessionId] ?? currentSession;
                const historySessionId =
                    latestSession.historySessionId || latestSession.sessionId;

                let resumedSession: AIChatSession;
                let resumeContextPending = false;

                if (supportsNativeResume) {
                    resumedSession = await aiResumeRuntimeSession(
                        latestSession.runtimeId,
                        historySessionId,
                        vaultPath,
                    );
                } else {
                    resumedSession = await aiCreateSession(
                        latestSession.runtimeId,
                        vaultPath,
                    );
                    const resumedModelConfig =
                        getModelConfigOption(resumedSession);

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
                                mode.id === latestSession.modeId &&
                                !mode.disabled,
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

                    resumeContextPending =
                        getSessionTranscriptLength(latestSession) > 0;
                }

                // Register baselines for all open editor tabs
                const resumedTabs = useEditorStore.getState().tabs;
                for (const tab of resumedTabs) {
                    if (isNoteTab(tab) && tab.content != null) {
                        aiRegisterFileBaseline(
                            resumedSession.sessionId,
                            `${tab.noteId}.md`,
                            tab.content,
                        ).catch(() => {});
                    }
                }

                const migratedSession = startNewWorkCycle(
                    replaceSessionTranscript(
                        {
                            ...resumedSession,
                            historySessionId,
                            messages: [],
                            attachments: latestSession.attachments,
                            effortsByModel:
                                resumedSession.effortsByModel ??
                                latestSession.effortsByModel ??
                                {},
                            isPersistedSession: false,
                            isResumingSession: false,
                            resumeContextPending,
                            runtimeState: "live",
                            persistedCreatedAt:
                                latestSession.persistedCreatedAt ?? null,
                            persistedUpdatedAt:
                                latestSession.persistedUpdatedAt ?? null,
                            persistedTitle:
                                latestSession.persistedTitle ?? null,
                            persistedPreview:
                                latestSession.persistedPreview ?? null,
                            persistedMessageCount:
                                getSessionPersistedMessageCount(latestSession),
                            loadedPersistedMessageStart:
                                latestSession.loadedPersistedMessageStart ?? 0,
                            isLoadingPersistedMessages: false,
                        },
                        getSessionTranscriptMessages(latestSession),
                    ),
                );

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
                replaceChatRowUiSessionId(sessionId, migratedSession.sessionId);
                useChatTabsStore
                    .getState()
                    .replaceSessionId(
                        sessionId,
                        migratedSession.sessionId,
                        migratedSession.historySessionId,
                        migratedSession.runtimeId,
                    );

                return migratedSession.sessionId;
            } catch (error) {
                const message = getAiErrorMessage(
                    error,
                    "Failed to resume the saved chat.",
                );
                get().applySessionError({ session_id: sessionId, message });
                if (isAuthenticationErrorMessage(message)) {
                    await get().refreshSetupStatus(
                        get().sessionsById[sessionId]?.runtimeId,
                    );
                }
                return null;
            }
        },

        loadSession: async (sessionId) => {
            const existing = get().sessionsById[sessionId];
            if (existing) {
                set((state) => ({
                    activeSessionId: sessionId,
                    selectedRuntimeId:
                        state.sessionsById[sessionId]?.runtimeId ??
                        state.selectedRuntimeId,
                    sessionOrder: touchSessionOrder(
                        state.sessionOrder,
                        sessionId,
                    ),
                }));
                if (existing.runtimeState !== "live") {
                    await get().resumeSession(sessionId);
                    return;
                }

                await get().ensureSessionTranscriptLoaded(sessionId, "latest");
                return;
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

        setModel: async (modelId, sessionId) => {
            const resolvedSessionId = sessionId ?? get().activeSessionId;
            if (!resolvedSessionId) return;
            const { sessionsById } = get();
            const session = sessionsById[resolvedSessionId];
            if (!session) return;
            if (
                session.status === "streaming" ||
                session.status === "waiting_permission" ||
                session.status === "waiting_user_input" ||
                session.isResumingSession
            ) {
                return;
            }

            if (session.runtimeState !== "live") {
                set((state) => ({
                    sessionsById: {
                        ...state.sessionsById,
                        [resolvedSessionId]: applyLocalModelSelection(
                            state.sessionsById[resolvedSessionId]!,
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
                              resolvedSessionId,
                              modelConfig.id,
                              modelId,
                          )
                        : await aiSetModel(resolvedSessionId, modelId);
                get().upsertSession(updatedSession);
                saveAiPreferences({ modelId });
            } catch (error) {
                get().applySessionError({
                    session_id: resolvedSessionId,
                    message: getAiErrorMessage(
                        error,
                        "Failed to update the model.",
                    ),
                });
            }
        },

        setMode: async (modeId, sessionId) => {
            const resolvedSessionId = sessionId ?? get().activeSessionId;
            if (!resolvedSessionId) return;
            const { sessionsById } = get();
            const session = sessionsById[resolvedSessionId];
            if (!session) return;
            if (
                session.status === "streaming" ||
                session.status === "waiting_permission" ||
                session.status === "waiting_user_input" ||
                session.isResumingSession
            ) {
                return;
            }

            if (session.runtimeState !== "live") {
                set((state) => ({
                    sessionsById: {
                        ...state.sessionsById,
                        [resolvedSessionId]: {
                            ...state.sessionsById[resolvedSessionId]!,
                            modeId,
                        },
                    },
                }));
                saveAiPreferences({ modeId });
                return;
            }

            try {
                const updatedSession = await aiSetMode(
                    resolvedSessionId,
                    modeId,
                );
                get().upsertSession(updatedSession);
                saveAiPreferences({ modeId });
            } catch (error) {
                get().applySessionError({
                    session_id: resolvedSessionId,
                    message: getAiErrorMessage(
                        error,
                        "Failed to update the mode.",
                    ),
                });
            }
        },

        setConfigOption: async (optionId, value, sessionId) => {
            const resolvedSessionId = sessionId ?? get().activeSessionId;
            if (!resolvedSessionId) return;
            const { sessionsById } = get();
            const session = sessionsById[resolvedSessionId];
            if (!session) return;
            if (
                session.status === "streaming" ||
                session.status === "waiting_permission" ||
                session.status === "waiting_user_input" ||
                session.isResumingSession
            ) {
                return;
            }

            if (session.runtimeState !== "live") {
                set((state) => {
                    const currentSession =
                        state.sessionsById[resolvedSessionId]!;
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
                            [resolvedSessionId]: nextSession,
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
                    resolvedSessionId,
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
                    session_id: resolvedSessionId,
                    message: getAiErrorMessage(
                        error,
                        "Failed to update the session option.",
                    ),
                });
            }
        },

        setComposerParts: (parts, sessionId) => {
            const resolvedSessionId = sessionId ?? get().activeSessionId;
            if (!resolvedSessionId) return;
            set((state) => {
                const session = state.sessionsById[resolvedSessionId];
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
                        [resolvedSessionId]: parts,
                    },
                    ...(session &&
                    prunedAttachments.length !== session.attachments.length
                        ? {
                              sessionsById: {
                                  ...state.sessionsById,
                                  [resolvedSessionId]: {
                                      ...session,
                                      attachments: prunedAttachments,
                                  },
                              },
                          }
                        : {}),
                };
            });
        },

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

        sendMessage: async (sessionId) => {
            const resolvedSessionId = sessionId ?? get().activeSessionId;
            if (!resolvedSessionId) return;
            const { sessionsById, composerPartsBySessionId } = get();
            const session = sessionsById[resolvedSessionId];
            if (!session || session.isResumingSession) {
                return;
            }

            const composerParts =
                composerPartsBySessionId[resolvedSessionId] ??
                createEmptyComposerParts();
            const queuedItem = buildQueuedMessage(session, composerParts);
            if (!queuedItem) return;

            const queuedMessageEdit =
                get().queuedMessageEditBySessionId[resolvedSessionId];
            if (queuedMessageEdit) {
                const updatedQueuedItem: QueuedChatMessage = {
                    ...queuedMessageEdit.item,
                    ...queuedItem,
                    id: queuedMessageEdit.item.id,
                    status: "queued",
                    optimisticMessageId: undefined,
                };

                set((state) => {
                    const targetSession = state.sessionsById[resolvedSessionId];
                    const currentEdit =
                        state.queuedMessageEditBySessionId[resolvedSessionId];
                    if (!targetSession || !currentEdit) {
                        return state;
                    }

                    const nextQueuedMessageEditBySessionId = {
                        ...state.queuedMessageEditBySessionId,
                    };
                    delete nextQueuedMessageEditBySessionId[resolvedSessionId];

                    return {
                        sessionsById: {
                            ...state.sessionsById,
                            [resolvedSessionId]: {
                                ...targetSession,
                                attachments:
                                    currentEdit.previousAttachments.map(
                                        cloneAttachment,
                                    ),
                            },
                        },
                        composerPartsBySessionId: {
                            ...state.composerPartsBySessionId,
                            [resolvedSessionId]: cloneComposerParts(
                                currentEdit.previousComposerParts,
                            ),
                        },
                        queuedMessagesBySessionId: {
                            ...state.queuedMessagesBySessionId,
                            [resolvedSessionId]: restoreQueuedMessagePosition(
                                state.queuedMessagesBySessionId[
                                    resolvedSessionId
                                ] ?? [],
                                currentEdit,
                                updatedQueuedItem,
                            ),
                        },
                        queuedMessageEditBySessionId:
                            nextQueuedMessageEditBySessionId,
                        sessionOrder: touchSessionOrder(
                            state.sessionOrder,
                            resolvedSessionId,
                        ),
                    };
                });

                if (get().sessionsById[resolvedSessionId]?.status === "idle") {
                    void get().tryDrainQueue(resolvedSessionId);
                }
                return;
            }

            if (isSessionBusy(session)) {
                get().enqueueMessage(resolvedSessionId, queuedItem);
                set((state) => {
                    const targetSession = state.sessionsById[resolvedSessionId];
                    if (!targetSession) return state;

                    return {
                        sessionsById: {
                            ...state.sessionsById,
                            [resolvedSessionId]: {
                                ...targetSession,
                                attachments: [],
                            },
                        },
                        composerPartsBySessionId: {
                            ...state.composerPartsBySessionId,
                            [resolvedSessionId]: createEmptyComposerParts(),
                        },
                    };
                });
                return;
            }

            await dispatchMessage(resolvedSessionId, queuedItem, "immediate");
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

                if (
                    session.status === "idle" &&
                    nextQueue[0]?.id === messageId &&
                    !_queueDrainLocks.has(sessionId)
                ) {
                    _queueDrainLocks.add(sessionId);
                    shouldDrain = true;
                }

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
                try {
                    const nextItem = get().queuedMessagesBySessionId[
                        sessionId
                    ]?.find((item) => item.status === "queued");
                    if (nextItem) {
                        await dispatchMessage(sessionId, nextItem, "queue");
                    }
                } finally {
                    _queueDrainLocks.delete(sessionId);
                }
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

        stopStreaming: async (sessionId) => {
            const resolvedSessionId = sessionId ?? get().activeSessionId;
            if (!resolvedSessionId) return;
            clearStaleStreamingCheck(resolvedSessionId);

            try {
                const session = await aiCancelTurn(resolvedSessionId);
                get().upsertSession(session);
            } catch (error) {
                get().applySessionError({
                    session_id: resolvedSessionId,
                    message: getAiErrorMessage(
                        error,
                        "Failed to stop the current turn.",
                    ),
                });
            }

            // Explicitly transition to idle — same as applyMessageCompleted.
            const stoppedAt = Date.now();
            set((state) => {
                const sess = state.sessionsById[resolvedSessionId];
                if (!sess || sess.status === "idle") return state;
                return {
                    sessionsById: {
                        ...state.sessionsById,
                        [resolvedSessionId]: stampElapsedOnTurnStartedSession(
                            {
                                ...markAllMessagesComplete(sess),
                                status: "idle",
                            },
                            stoppedAt,
                        ),
                    },
                };
            });
            void get().tryDrainQueue(resolvedSessionId);
        },

        respondPermission: async (requestId, optionId) => {
            const activeSessionId = get().activeSessionId;
            if (!activeSessionId) return;
            await get().respondPermissionForSession(
                activeSessionId,
                requestId,
                optionId,
            );
        },

        respondPermissionForSession: async (sessionId, requestId, optionId) => {
            // Optimistically mark as streaming since the agent will resume
            set((state) => {
                const session = state.sessionsById[sessionId];
                if (!session) return state;
                return {
                    sessionsById: {
                        ...state.sessionsById,
                        [sessionId]: updatePermissionMessageState(
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
                    sessionId,
                    requestId,
                    optionId,
                );
                get().upsertSession(session);
                set((state) => {
                    const currentSession = state.sessionsById[sessionId];
                    if (!currentSession) return state;
                    return {
                        sessionsById: {
                            ...state.sessionsById,
                            [sessionId]: updatePermissionMessageState(
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
                const message = getAiErrorMessage(
                    error,
                    "Failed to resolve the permission request.",
                );
                set((state) => {
                    const currentSession = state.sessionsById[sessionId];
                    if (!currentSession) return state;
                    return {
                        sessionsById: {
                            ...state.sessionsById,
                            [sessionId]: updatePermissionMessageState(
                                {
                                    ...currentSession,
                                    status: "waiting_permission",
                                },
                                requestId,
                                {
                                    status: "pending",
                                    resolved_option: null,
                                },
                            ),
                        },
                        sessionOrder: touchSessionOrder(
                            state.sessionOrder,
                            sessionId,
                        ),
                    };
                });
                set((state) => {
                    const currentSession = state.sessionsById[sessionId];
                    if (!currentSession) return state;
                    return {
                        sessionsById: {
                            ...state.sessionsById,
                            [sessionId]: appendSessionError(
                                currentSession,
                                message,
                            ),
                        },
                        sessionOrder: touchSessionOrder(
                            state.sessionOrder,
                            sessionId,
                        ),
                    };
                });
            }
        },

        respondUserInput: async (requestId, answers, sessionId) => {
            const resolvedSessionId = sessionId ?? get().activeSessionId;
            if (!resolvedSessionId) return;
            const session = get().sessionsById[resolvedSessionId];
            if (!session) return;

            if (
                !runtimeSupportsCapability(
                    get().runtimes,
                    session.runtimeId,
                    "user_input",
                )
            ) {
                set((state) => {
                    const currentSession =
                        state.sessionsById[resolvedSessionId];
                    if (!currentSession) return state;
                    return {
                        sessionsById: {
                            ...state.sessionsById,
                            [resolvedSessionId]: appendSessionError(
                                currentSession,
                                "This runtime does not support interactive user input requests in this build.",
                            ),
                        },
                        sessionOrder: touchSessionOrder(
                            state.sessionOrder,
                            resolvedSessionId,
                        ),
                    };
                });
                return;
            }

            set((state) => {
                const currentSession = state.sessionsById[resolvedSessionId];
                if (!currentSession) return state;
                return {
                    sessionsById: {
                        ...state.sessionsById,
                        [resolvedSessionId]: updateUserInputMessageState(
                            { ...currentSession, status: "streaming" },
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
                    resolvedSessionId,
                    requestId,
                    answers,
                );
                get().upsertSession(session);
                set((state) => {
                    const currentSession =
                        state.sessionsById[resolvedSessionId];
                    if (!currentSession) return state;
                    return {
                        sessionsById: {
                            ...state.sessionsById,
                            [resolvedSessionId]: updateUserInputMessageState(
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
                const message = getAiErrorMessage(
                    error,
                    "Failed to respond to the input request.",
                );
                set((state) => {
                    const currentSession =
                        state.sessionsById[resolvedSessionId];
                    if (!currentSession) return state;
                    return {
                        sessionsById: {
                            ...state.sessionsById,
                            [resolvedSessionId]: updateUserInputMessageState(
                                {
                                    ...currentSession,
                                    status: "waiting_user_input",
                                },
                                requestId,
                                {
                                    status: "pending",
                                    answered: false,
                                },
                            ),
                        },
                        sessionOrder: touchSessionOrder(
                            state.sessionOrder,
                            resolvedSessionId,
                        ),
                    };
                });
                set((state) => {
                    const currentSession =
                        state.sessionsById[resolvedSessionId];
                    if (!currentSession) return state;
                    return {
                        sessionsById: {
                            ...state.sessionsById,
                            [resolvedSessionId]: appendSessionError(
                                currentSession,
                                message,
                            ),
                        },
                        sessionOrder: touchSessionOrder(
                            state.sessionOrder,
                            resolvedSessionId,
                        ),
                    };
                });
            }
        },

        rejectEditedFile: async (sessionId, identityKey) => {
            const { sessionsById } = get();
            const vaultPath = useVaultStore.getState().vaultPath;
            if (!vaultPath) return;

            const session = sessionsById[sessionId];
            if (!session) return;

            const tracked = findTrackedFileInAccumulatedSession(
                session,
                identityKey,
            );
            if (!tracked || !tracked.isText) return;
            if (getTrackedFileReviewState(tracked) === "pending") return;

            try {
                const restoreCheck = await hasConflict(vaultPath, tracked);

                if (restoreCheck.conflict) {
                    set((state) => {
                        const currentSession = state.sessionsById[sessionId];
                        if (!currentSession) return state;

                        return {
                            sessionsById: {
                                ...state.sessionsById,
                                [sessionId]: markTrackedConflict(
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

                const liveText = await readTrackedFileLiveText(tracked);
                const { action: restoreAction, change } =
                    await executeRestoreAction(vaultPath, tracked, liveText);
                reloadEditorAfterRestore(tracked, restoreAction, change);

                set((state) => {
                    const currentSession = state.sessionsById[sessionId];
                    if (!currentSession) return state;

                    // Re-read fresh tracked for the undo snapshot so we
                    // don't store a stale version if notifyUserEditOnFile
                    // ran between capture and this set().
                    const freshTracked =
                        findTrackedFileInAccumulatedSession(
                            currentSession,
                            identityKey,
                        ) ?? tracked;

                    const removed = removeTrackedFileFromActionLog(
                        currentSession,
                        identityKey,
                    );
                    const sessionAfterRemove =
                        restoreAction.kind === "skip"
                            ? setActionLogUndo(removed, null)
                            : (() => {
                                  const { undoData } =
                                      actionLogRejectAll(freshTracked);
                                  return setActionLogUndo(removed, {
                                      buffers: [undoData],
                                      snapshots: {
                                          [identityKey]: freshTracked,
                                      },
                                      timestamp: Date.now(),
                                  });
                              })();

                    return {
                        sessionsById: {
                            ...state.sessionsById,
                            [sessionId]: sessionAfterRemove,
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

            const tracked = findTrackedFileInAccumulatedSession(
                session,
                identityKey,
            );
            if (!tracked || !tracked.isText) {
                return;
            }

            try {
                const restoreCheck = await hasConflict(vaultPath, tracked);

                if (restoreCheck.conflict) {
                    set((state) => {
                        const currentSession = state.sessionsById[sessionId];
                        if (!currentSession) return state;

                        return {
                            sessionsById: {
                                ...state.sessionsById,
                                [sessionId]: markTrackedConflict(
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

                const change = await aiRestoreTextFile({
                    vaultPath,
                    path: tracked.path,
                    previousPath:
                        tracked.originPath !== tracked.path
                            ? tracked.originPath
                            : null,
                    content: mergedText,
                });
                reloadOpenEditorContent(tracked.path, mergedText, change);

                set((state) => {
                    const currentSession = state.sessionsById[sessionId];
                    if (!currentSession) return state;

                    const updated = removeTrackedFileFromActionLog(
                        currentSession,
                        identityKey,
                    );

                    return {
                        sessionsById: {
                            ...state.sessionsById,
                            [sessionId]: updated,
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

            const trackedFiles = getAccumulatedTrackedFiles(session);

            // Track which files need undo snapshots (fresh data is read
            // inside set() to avoid stale references).
            const undoIdentityKeys = new Set<string>();
            const removedIdentityKeys = new Set<string>();
            let caughtError: unknown = null;

            for (const [identityKey, tracked] of Object.entries(trackedFiles)) {
                if (!tracked.isText) {
                    continue;
                }

                try {
                    const restoreCheck = await hasConflict(vaultPath, tracked);

                    if (restoreCheck.conflict) {
                        set((state) => {
                            const currentSession =
                                state.sessionsById[sessionId];
                            if (!currentSession) return state;

                            return {
                                sessionsById: {
                                    ...state.sessionsById,
                                    [sessionId]: markTrackedConflict(
                                        currentSession,
                                        identityKey,
                                        restoreCheck.currentHash,
                                    ),
                                },
                            };
                        });
                        continue;
                    }

                    const liveText = await readTrackedFileLiveText(tracked);
                    const { action: restoreAction, change } =
                        await executeRestoreAction(
                            vaultPath,
                            tracked,
                            liveText,
                        );
                    reloadEditorAfterRestore(tracked, restoreAction, change);

                    removedIdentityKeys.add(identityKey);
                    if (restoreAction.kind !== "skip") {
                        undoIdentityKeys.add(identityKey);
                    }
                } catch (error) {
                    caughtError = error;
                    break;
                }
            }

            // Store combined undo and remove successfully-rejected files,
            // keeping conflict files visible.
            set((state) => {
                const currentSession = state.sessionsById[sessionId];
                if (!currentSession?.actionLog) return state;

                // Keep only files that weren't rejected (i.e. conflict files)
                const current = getAccumulatedTrackedFiles(currentSession);
                const remaining: Record<string, TrackedFile> = {};
                for (const [key, file] of Object.entries(current)) {
                    if (
                        !undoIdentityKeys.has(key) &&
                        !removedIdentityKeys.has(key)
                    ) {
                        remaining[key] = file;
                    }
                }

                // Build undo data from fresh tracked files so we don't
                // store stale versions if notifyUserEditOnFile ran between
                // capture and this set().
                const freshSnapshots: Record<string, TrackedFile> = {};
                const freshUndoBuffers: import("../diff/actionLogTypes").PerFileUndo[] =
                    [];
                for (const key of undoIdentityKeys) {
                    const fresh = current[key];
                    if (!fresh) continue;
                    freshSnapshots[key] = fresh;
                    const { undoData } = actionLogRejectAll(fresh);
                    freshUndoBuffers.push(undoData);
                }

                let updated: AIChatSession = replaceTrackedFilesInActionLog(
                    currentSession,
                    remaining,
                );

                if (freshUndoBuffers.length > 0) {
                    updated = setActionLogUndo(updated, {
                        buffers: freshUndoBuffers,
                        snapshots: freshSnapshots,
                        timestamp: Date.now(),
                    });
                } else if (removedIdentityKeys.size > 0) {
                    updated = setActionLogUndo(updated, null);
                }

                return {
                    sessionsById: {
                        ...state.sessionsById,
                        [sessionId]: updated,
                    },
                };
            });

            const updatedSession = get().sessionsById[sessionId];
            if (updatedSession) {
                void persistSession(updatedSession);
            }

            if (caughtError) {
                get().applySessionError({
                    session_id: sessionId,
                    message: getAiErrorMessage(
                        caughtError,
                        "Failed to reject all file changes.",
                    ),
                });
            }
        },

        keepEditedFile: (sessionId, identityKey) => {
            set((state) => {
                const session = state.sessionsById[sessionId];
                if (!session) return state;

                const updated = removeTrackedFileFromActionLog(
                    session,
                    identityKey,
                );

                return {
                    sessionsById: {
                        ...state.sessionsById,
                        [sessionId]: updated,
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

                let updated = session;
                if (session.actionLog) {
                    updated = replaceTrackedFilesInActionLog(session, {});
                    updated = setActionLogUndo(updated, null);
                }

                return {
                    sessionsById: {
                        ...state.sessionsById,
                        [sessionId]: updated,
                    },
                };
            });

            const updatedSession = get().sessionsById[sessionId];
            if (updatedSession) {
                void persistSession(updatedSession);
            }
        },

        resolveHunkEdits: async (
            sessionId,
            identityKey,
            decision,
            hunkNewStart,
            hunkNewEnd,
        ) => {
            const { sessionsById } = get();
            const session = sessionsById[sessionId];
            if (!session?.actionLog) {
                return;
            }

            const tracked = findTrackedFileInAccumulatedSession(
                session,
                identityKey,
            );
            if (!tracked) {
                return;
            }

            let updatedFile: TrackedFile;
            let hunkUndoSnapshot: {
                identityKey: string;
                snapshot: TrackedFile;
            } | null = null;

            if (decision === "accepted") {
                // Accept: absorb hunk into diffBase, no disk write needed
                updatedFile = keepEditsInRange(
                    tracked,
                    hunkNewStart,
                    hunkNewEnd,
                );
            } else {
                const vaultPath = useVaultStore.getState().vaultPath;
                if (vaultPath) {
                    const restoreCheck = await hasConflict(vaultPath, tracked);

                    if (restoreCheck.conflict) {
                        set((state) => {
                            const currentSession =
                                state.sessionsById[sessionId];
                            if (!currentSession) return state;

                            return {
                                sessionsById: {
                                    ...state.sessionsById,
                                    [sessionId]: markTrackedConflict(
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
                }

                // Reject: revert hunk in currentText, write to disk
                const { file } = rejectEditsInRanges(tracked, [
                    { start: hunkNewStart, end: hunkNewEnd },
                ]);
                updatedFile = file;
                // Store undo snapshot so the reject can be undone
                hunkUndoSnapshot = { identityKey, snapshot: tracked };

                if (vaultPath) {
                    const change = await aiRestoreTextFile({
                        vaultPath,
                        path: tracked.path,
                        previousPath:
                            tracked.originPath !== tracked.path
                                ? tracked.originPath
                                : null,
                        content: updatedFile.currentText,
                    });
                    reloadOpenEditorContent(
                        tracked.path,
                        updatedFile.currentText,
                        change,
                    );
                }
            }

            set((state) => {
                const currentSession = state.sessionsById[sessionId];
                if (!currentSession?.actionLog) return state;

                if (
                    patchIsEmpty(updatedFile.unreviewedEdits) &&
                    updatedFile.path === updatedFile.originPath
                ) {
                    // All hunks resolved and no move remains pending — remove from tracking
                    let cleaned = removeTrackedFileFromActionLog(
                        currentSession,
                        identityKey,
                    );
                    if (hunkUndoSnapshot) {
                        cleaned = setActionLogUndo(cleaned, {
                            buffers: [],
                            snapshots: {
                                [hunkUndoSnapshot.identityKey]:
                                    hunkUndoSnapshot.snapshot,
                            },
                            timestamp: Date.now(),
                        });
                    }
                    return {
                        sessionsById: {
                            ...state.sessionsById,
                            [sessionId]: cleaned,
                        },
                    };
                }

                // Partial resolution — update TrackedFile in ActionLog
                const files = {
                    ...getAccumulatedTrackedFiles(currentSession),
                };
                files[identityKey] = updatedFile;

                let updated: AIChatSession = replaceTrackedFilesInActionLog(
                    currentSession,
                    files,
                );

                if (hunkUndoSnapshot) {
                    updated = setActionLogUndo(updated, {
                        buffers: [],
                        snapshots: {
                            [hunkUndoSnapshot.identityKey]:
                                hunkUndoSnapshot.snapshot,
                        },
                        timestamp: Date.now(),
                    });
                }

                return {
                    sessionsById: {
                        ...state.sessionsById,
                        [sessionId]: updated,
                    },
                };
            });

            const updatedSession = get().sessionsById[sessionId];
            if (updatedSession) {
                void persistSession(updatedSession);
            }
        },

        resolveReviewHunks: async (
            sessionId,
            identityKey,
            decision,
            trackedVersion,
            hunkIds,
        ) => {
            const { sessionsById } = get();
            const session = sessionsById[sessionId];
            if (!session?.actionLog) {
                return;
            }

            const tracked = findTrackedFileInAccumulatedSession(
                session,
                identityKey,
            );
            if (!tracked) {
                return;
            }

            const projection = buildReviewProjection(tracked);
            if (projection.trackedVersion !== trackedVersion) {
                return;
            }

            const selectedReviewHunks = hunkIds
                .map((id) =>
                    projection.hunks.find(
                        (hunk) =>
                            hunk.id.trackedVersion === id.trackedVersion &&
                            hunk.id.key === id.key,
                    ),
                )
                .filter(
                    (hunk): hunk is (typeof projection.hunks)[number] => !!hunk,
                );

            if (selectedReviewHunks.length === 0) {
                return;
            }
            const resolvedReviewHunks = expandReviewHunksToOverlapClosure(
                projection,
                selectedReviewHunks,
            );
            if (resolvedReviewHunks.length === 0) {
                return;
            }

            let updatedFile: TrackedFile;
            let hunkUndoSnapshot: {
                identityKey: string;
                snapshot: TrackedFile;
            } | null = null;

            if (decision === "accepted") {
                updatedFile = keepReviewHunks(tracked, resolvedReviewHunks);
            } else {
                const vaultPath = useVaultStore.getState().vaultPath;
                if (vaultPath) {
                    const restoreCheck = await hasConflict(vaultPath, tracked);

                    if (restoreCheck.conflict) {
                        set((state) => {
                            const currentSession =
                                state.sessionsById[sessionId];
                            if (!currentSession) return state;

                            return {
                                sessionsById: {
                                    ...state.sessionsById,
                                    [sessionId]: markTrackedConflict(
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
                }

                const { file } = rejectReviewHunks(
                    tracked,
                    resolvedReviewHunks,
                );
                updatedFile = file;
                hunkUndoSnapshot = { identityKey, snapshot: tracked };

                if (vaultPath) {
                    const change = await aiRestoreTextFile({
                        vaultPath,
                        path: tracked.path,
                        previousPath:
                            tracked.originPath !== tracked.path
                                ? tracked.originPath
                                : null,
                        content: updatedFile.currentText,
                    });
                    reloadOpenEditorContent(
                        tracked.path,
                        updatedFile.currentText,
                        change,
                    );
                }
            }

            set((state) => {
                const currentSession = state.sessionsById[sessionId];
                if (!currentSession?.actionLog) return state;

                if (
                    patchIsEmpty(updatedFile.unreviewedEdits) &&
                    updatedFile.path === updatedFile.originPath
                ) {
                    let cleaned = removeTrackedFileFromActionLog(
                        currentSession,
                        identityKey,
                    );
                    if (hunkUndoSnapshot) {
                        cleaned = setActionLogUndo(cleaned, {
                            buffers: [],
                            snapshots: {
                                [hunkUndoSnapshot.identityKey]:
                                    hunkUndoSnapshot.snapshot,
                            },
                            timestamp: Date.now(),
                        });
                    }
                    return {
                        sessionsById: {
                            ...state.sessionsById,
                            [sessionId]: cleaned,
                        },
                    };
                }

                const files = {
                    ...getAccumulatedTrackedFiles(currentSession),
                };
                files[identityKey] = updatedFile;

                let updated: AIChatSession = replaceTrackedFilesInActionLog(
                    currentSession,
                    files,
                );

                if (hunkUndoSnapshot) {
                    updated = setActionLogUndo(updated, {
                        buffers: [],
                        snapshots: {
                            [hunkUndoSnapshot.identityKey]:
                                hunkUndoSnapshot.snapshot,
                        },
                        timestamp: Date.now(),
                    });
                }

                return {
                    sessionsById: {
                        ...state.sessionsById,
                        [sessionId]: updated,
                    },
                };
            });

            const updatedSession = get().sessionsById[sessionId];
            if (updatedSession) {
                void persistSession(updatedSession);
            }
        },

        undoLastReject: async (sessionId) => {
            const { sessionsById } = get();
            const vaultPath = useVaultStore.getState().vaultPath;
            if (!vaultPath) return;

            const session = sessionsById[sessionId];
            if (!session?.actionLog?.lastRejectUndo) return;

            const { lastRejectUndo } = session.actionLog;
            const { snapshots } = lastRejectUndo;
            const restoredSnapshots: Record<string, TrackedFile> = {};
            let caughtError: unknown = null;

            // Restore each file on disk from its pre-reject snapshot
            for (const [identityKey, snapshot] of Object.entries(snapshots)) {
                try {
                    // Verify the disk hasn't changed since the reject
                    const currentHash = await aiGetTextFileHash(
                        vaultPath,
                        snapshot.path,
                    );
                    if (
                        snapshot.status.kind === "created" &&
                        snapshot.status.existingFileContent === null
                    ) {
                        // Reject deleted this file. If it exists now, someone
                        // created a new file at the same path — skip to avoid
                        // overwriting.
                        if (currentHash !== null) continue;
                    } else {
                        // Reject restored diffBase (or existingFileContent).
                        // If the disk differs from what the reject wrote,
                        // someone edited it — skip.
                        const expectedContent =
                            snapshot.status.kind === "created"
                                ? (snapshot.status.existingFileContent ??
                                  snapshot.diffBase)
                                : snapshot.diffBase;
                        const expectedHash = hashTextContent(expectedContent);
                        if (currentHash !== expectedHash) continue;
                    }

                    // Write the agent's currentText back (undo the rejection)
                    if (
                        snapshot.status.kind === "created" &&
                        snapshot.status.existingFileContent === null
                    ) {
                        // File was created by agent — re-create it
                        const change = await aiRestoreTextFile({
                            vaultPath,
                            path: snapshot.path,
                            content: snapshot.currentText,
                        });
                        reloadOpenEditorContent(
                            snapshot.path,
                            snapshot.currentText,
                            change,
                        );
                    } else {
                        const change = await aiRestoreTextFile({
                            vaultPath,
                            path: snapshot.path,
                            previousPath:
                                snapshot.originPath !== snapshot.path
                                    ? snapshot.originPath
                                    : null,
                            content: snapshot.currentText,
                        });
                        reloadOpenEditorContent(
                            snapshot.path,
                            snapshot.currentText,
                            change,
                        );
                    }
                    restoredSnapshots[identityKey] = snapshot;
                } catch (error) {
                    caughtError = error;
                    break;
                }
            }

            if (Object.keys(restoredSnapshots).length > 0) {
                // Re-track successfully restored files and keep undo only for failures
                set((state) => {
                    const currentSession = state.sessionsById[sessionId];
                    if (!currentSession?.actionLog) return state;

                    // Restore tracked files
                    const existingFiles =
                        getAccumulatedTrackedFiles(currentSession);
                    const restoredFiles = {
                        ...existingFiles,
                        ...restoredSnapshots,
                    };
                    const restoredKeys = new Set(
                        Object.keys(restoredSnapshots),
                    );
                    const restoredPaths = new Set(
                        Object.values(restoredSnapshots).map(
                            (snapshot) => snapshot.path,
                        ),
                    );
                    const remainingSnapshots = Object.fromEntries(
                        Object.entries(lastRejectUndo.snapshots).filter(
                            ([identityKey]) => !restoredKeys.has(identityKey),
                        ),
                    );
                    let updated: AIChatSession = replaceTrackedFilesInActionLog(
                        currentSession,
                        restoredFiles,
                    );

                    updated = setActionLogUndo(
                        updated,
                        Object.keys(remainingSnapshots).length === 0
                            ? null
                            : {
                                  buffers: lastRejectUndo.buffers.filter(
                                      (buffer) =>
                                          !restoredPaths.has(buffer.path),
                                  ),
                                  snapshots: remainingSnapshots,
                                  timestamp: lastRejectUndo.timestamp,
                              },
                    );

                    return {
                        sessionsById: {
                            ...state.sessionsById,
                            [sessionId]: updated,
                        },
                    };
                });

                const updatedSession = get().sessionsById[sessionId];
                if (updatedSession) {
                    void persistSession(updatedSession);
                }
            }

            if (caughtError) {
                get().applySessionError({
                    session_id: sessionId,
                    message: getAiErrorMessage(
                        caughtError,
                        "Failed to undo the last reject.",
                    ),
                });
            }
        },

        notifyUserEditOnFile: (fileId, userEdits, newFullText) => {
            const sessionIds = Object.keys(get().sessionsById);

            for (const sessionId of sessionIds) {
                applyUserEditToTrackedFileInSession(
                    sessionId,
                    fileId,
                    userEdits,
                    newFullText,
                );
            }
        },

        newSession: async (runtimeId) => {
            const runtimes = get().runtimes;
            const nextRuntimeId =
                runtimeId ??
                get().selectedRuntimeId ??
                getDefaultRuntimeId(runtimes);
            if (!nextRuntimeId) return;

            try {
                set({ selectedRuntimeId: nextRuntimeId });
                const setupStatus = await aiGetSetupStatus(nextRuntimeId);
                set((state) => ({
                    selectedRuntimeId: nextRuntimeId,
                    ...applyRuntimeSetupStatusPatch(state, setupStatus),
                }));
                if (setupStatus.onboardingRequired) {
                    return;
                }

                if (
                    !runtimeSupportsCapability(
                        runtimes,
                        nextRuntimeId,
                        "create_session",
                    )
                ) {
                    set((state) => ({
                        runtimeConnectionByRuntimeId: setRuntimeConnectionState(
                            state.runtimeConnectionByRuntimeId,
                            nextRuntimeId,
                            {
                                status: "ready",
                                message: getRuntimeReadyButDisabledMessage(
                                    runtimes,
                                    nextRuntimeId,
                                ),
                            },
                        ),
                    }));
                    return;
                }

                const session = await aiCreateSession(
                    nextRuntimeId,
                    useVaultStore.getState().vaultPath,
                );
                get().upsertSession(session, true);
                await persistSessionNow(session);

                // Register baselines for all open editor tabs
                const tabs = useEditorStore.getState().tabs;
                for (const tab of tabs) {
                    if (isNoteTab(tab) && tab.content != null) {
                        aiRegisterFileBaseline(
                            session.sessionId,
                            `${tab.noteId}.md`,
                            tab.content,
                        ).catch(() => {});
                    }
                }

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
                    await get().refreshSetupStatus(nextRuntimeId);
                }
            }
        },

        deleteSession: async (sessionId) => {
            const vaultPath = useVaultStore.getState().vaultPath;
            const targetSession = get().sessionsById[sessionId];
            const historySessionId =
                targetSession?.historySessionId ?? sessionId;
            clearStaleStreamingCheck(sessionId);
            if (
                targetSession &&
                targetSession.runtimeState === "live" &&
                (targetSession.status === "streaming" ||
                    targetSession.status === "waiting_permission" ||
                    targetSession.status === "waiting_user_input")
            ) {
                await aiCancelTurn(sessionId).catch(() => {});
            }
            await aiDeleteRuntimeSession(sessionId).catch(() => {});
            if (vaultPath) {
                await aiDeleteSessionHistory(vaultPath, historySessionId).catch(
                    () => {},
                );
            }
            useEditorStore.getState().closeReview(sessionId);
            useChatTabsStore.getState().removeTabsForSession(sessionId);
            _queueDrainLocks.delete(sessionId);
            clearChatRowUiSession(sessionId);
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
            const nextSelectedRuntimeId =
                (nextActiveId
                    ? nextSessionsById[nextActiveId]?.runtimeId
                    : null) ?? state.selectedRuntimeId;
            set({
                sessionsById: nextSessionsById,
                sessionOrder: remainingIds,
                activeSessionId: nextActiveId,
                selectedRuntimeId: nextSelectedRuntimeId,
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
            const snapshotSessions = Object.values(get().sessionsById);
            await Promise.all(
                snapshotSessions.map(async (session) => {
                    clearStaleStreamingCheck(session.sessionId);
                    if (
                        session.runtimeState === "live" &&
                        (session.status === "streaming" ||
                            session.status === "waiting_permission" ||
                            session.status === "waiting_user_input")
                    ) {
                        await aiCancelTurn(session.sessionId).catch(() => {});
                    }
                }),
            );
            await aiDeleteRuntimeSessionsForVault(vaultPath).catch(() => {});
            if (vaultPath) {
                await aiDeleteAllSessionHistories(vaultPath).catch(() => {});
            }
            // Close all review tabs before clearing sessions
            const editor = useEditorStore.getState();
            for (const sessionId of Object.keys(get().sessionsById)) {
                editor.closeReview(sessionId);
            }
            useChatTabsStore.getState().reset();
            _queueDrainLocks.clear();
            resetChatRowUiStore();
            set({
                sessionsById: {},
                sessionOrder: [],
                activeSessionId: null,
                selectedRuntimeId: getDefaultRuntimeId(get().runtimes),
                composerPartsBySessionId: {},
                queuedMessagesBySessionId: {},
                queuedMessageEditBySessionId: {},
            });
            await get().newSession();
        },

        attachNote: (note, sessionId) => {
            const resolvedSessionId = sessionId ?? get().activeSessionId;
            if (!resolvedSessionId) return;
            set((state) => ({
                sessionsById: updateSessionById(
                    state,
                    resolvedSessionId,
                    (session) => ({
                        ...session,
                        attachments: withUniqueAttachment(
                            session.attachments,
                            createAttachment("note", note),
                        ),
                    }),
                ),
                notePickerOpen: false,
            }));
        },

        attachFolder: (folderPath, name, sessionId) => {
            const resolvedSessionId = sessionId ?? get().activeSessionId;
            if (!resolvedSessionId) return;
            set((state) => ({
                sessionsById: updateSessionById(
                    state,
                    resolvedSessionId,
                    (session) => ({
                        ...session,
                        attachments: withUniqueAttachment(session.attachments, {
                            id: crypto.randomUUID(),
                            type: "folder",
                            noteId: folderPath,
                            label: name,
                            path: null,
                        }),
                    }),
                ),
            }));
        },

        attachCurrentNote: (note) => {
            const activeSessionId = get().activeSessionId;
            if (!activeSessionId) return;
            if (!note) return;

            set((state) => ({
                sessionsById: updateSessionById(
                    state,
                    activeSessionId,
                    (session) => ({
                        ...session,
                        attachments: withUniqueAttachment(
                            session.attachments,
                            createAttachment("current_note", note),
                        ),
                    }),
                ),
            }));
        },

        attachSelectionFromEditor: () => {
            const { currentSelection } = useEditorStore.getState();
            if (!currentSelection || !currentSelection.text.trim()) return;

            const notes = useVaultStore.getState().notes;
            const note = currentSelection.noteId
                ? (notes.find((n) => n.id === currentSelection.noteId) ?? null)
                : null;
            const selectionPath = currentSelection.path ?? note?.path ?? null;
            if (!selectionPath) return;

            const state = get();
            const { tabs, activeTabId } = useChatTabsStore.getState();
            const activeSessionId =
                tabs.find((t) => t.id === activeTabId)?.sessionId ??
                state.activeSessionId;
            if (!activeSessionId) return;

            const { startLine, endLine } = currentSelection;
            const currentParts =
                state.composerPartsBySessionId[activeSessionId] ??
                createEmptyComposerParts();

            const isDuplicate = currentParts.some(
                (p) =>
                    p.type === "selection_mention" &&
                    p.path === selectionPath &&
                    p.startLine === startLine &&
                    p.endLine === endLine,
            );
            if (isDuplicate) return;

            const nextParts = appendSelectionMentionPart(currentParts, {
                noteId: currentSelection.noteId,
                label: buildSelectionLabel(
                    currentSelection.text,
                    startLine,
                    endLine,
                ),
                path: selectionPath,
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
            const activeSessionId = get().activeSessionId;
            if (!activeSessionId) return;
            const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
            const mimeMap: Record<string, string> = {
                mp3: "audio/mpeg",
                wav: "audio/wav",
                ogg: "audio/ogg",
                flac: "audio/flac",
            };
            const mimeType = mimeMap[ext] ?? "audio/*";
            set((state) => ({
                sessionsById: updateSessionById(
                    state,
                    activeSessionId,
                    (session) => ({
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
                    }),
                ),
            }));
        },

        attachFile: (filePath, fileName, mimeType) => {
            const activeSessionId = get().activeSessionId;
            if (!activeSessionId) return;
            set((state) => ({
                sessionsById: updateSessionById(
                    state,
                    activeSessionId,
                    (session) => ({
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
                    }),
                ),
            }));
        },

        updateAttachment: (attachmentId, patch, sessionId) => {
            const resolvedSessionId = sessionId ?? get().activeSessionId;
            if (!resolvedSessionId) return;
            set((state) => ({
                sessionsById: updateSessionById(
                    state,
                    resolvedSessionId,
                    (session) => ({
                        ...session,
                        attachments: session.attachments.map((a) =>
                            a.id === attachmentId ? { ...a, ...patch } : a,
                        ),
                    }),
                ),
            }));
        },

        removeAttachment: (attachmentId, sessionId) => {
            const resolvedSessionId = sessionId ?? get().activeSessionId;
            if (!resolvedSessionId) return;
            set((state) => ({
                sessionsById: updateSessionById(
                    state,
                    resolvedSessionId,
                    (session) => ({
                        ...session,
                        attachments: session.attachments.filter(
                            (attachment) => attachment.id !== attachmentId,
                        ),
                    }),
                ),
            }));
        },

        clearAttachments: (sessionId) => {
            const resolvedSessionId = sessionId ?? get().activeSessionId;
            if (!resolvedSessionId) return;
            set((state) => ({
                sessionsById: updateSessionById(
                    state,
                    resolvedSessionId,
                    (session) => ({
                        ...session,
                        attachments: [],
                    }),
                ),
            }));
        },

        toggleAutoContext: () => {
            const next = !get().autoContextEnabled;
            set({ autoContextEnabled: next });
            saveAutoContextPreference(useVaultStore.getState().vaultPath, next);
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

        setScreenshotRetentionSeconds: (seconds) => {
            const next = Math.max(0, Math.round(seconds));
            set({ screenshotRetentionSeconds: next });
            saveAiPreferences({ screenshotRetentionSeconds: next });
        },

        openNotePicker: () => set({ notePickerOpen: true }),

        closeNotePicker: () => set({ notePickerOpen: false }),
    };
});

// Sync AI preferences when another window (e.g. standalone Settings) updates localStorage
if (typeof window !== "undefined") {
    let aiPrefsSyncTimer: number | null = null;
    let autoContextSyncTimer: number | null = null;
    window.addEventListener("storage", (event) => {
        if (event.key === AI_PREFS_KEY) {
            if (aiPrefsSyncTimer != null) {
                window.clearTimeout(aiPrefsSyncTimer);
            }
            aiPrefsSyncTimer = window.setTimeout(() => {
                aiPrefsSyncTimer = null;
                const prefs = getNormalizedAiPreferences();
                useChatStore.setState((state) =>
                    aiPrefsEqual(state, prefs)
                        ? state
                        : {
                              requireCmdEnterToSend:
                                  prefs.requireCmdEnterToSend,
                              composerFontSize: prefs.composerFontSize,
                              chatFontSize: prefs.chatFontSize,
                              composerFontFamily: prefs.composerFontFamily,
                              chatFontFamily: prefs.chatFontFamily,
                              editDiffZoom: prefs.editDiffZoom,
                              historyRetentionDays: prefs.historyRetentionDays,
                              screenshotRetentionSeconds:
                                  prefs.screenshotRetentionSeconds,
                          },
                );
            }, 80);
            return;
        }

        if (
            event.key ===
            getAutoContextStorageKey(useVaultStore.getState().vaultPath)
        ) {
            if (autoContextSyncTimer != null) {
                window.clearTimeout(autoContextSyncTimer);
            }
            autoContextSyncTimer = window.setTimeout(() => {
                autoContextSyncTimer = null;
                useChatStore
                    .getState()
                    .syncAutoContextForVault(
                        useVaultStore.getState().vaultPath,
                    );
            }, 80);
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
    _pendingSessionPersistence.clear();
    _sessionPersistenceFlushScheduled = false;
    _sessionPersistenceEpoch += 1;
    resetChatRowUiStore();
    useChatStore.setState({
        runtimeConnectionByRuntimeId: {},
        setupStatusByRuntimeId: {},
        runtimes: [],
        sessionsById: {},
        sessionOrder: [],
        activeSessionId: null,
        selectedRuntimeId: null,
        isInitializing: false,
        notePickerOpen: false,
        autoContextEnabled: loadAutoContextPreference(
            useVaultStore.getState().vaultPath,
        ),
        requireCmdEnterToSend: prefs.requireCmdEnterToSend,
        composerFontSize: prefs.composerFontSize,
        chatFontSize: prefs.chatFontSize,
        composerFontFamily: prefs.composerFontFamily,
        chatFontFamily: prefs.chatFontFamily,
        editDiffZoom: prefs.editDiffZoom,
        historyRetentionDays: prefs.historyRetentionDays,
        screenshotRetentionSeconds: prefs.screenshotRetentionSeconds,
        composerPartsBySessionId: {},
        queuedMessagesBySessionId: {},
        queuedMessageEditBySessionId: {},
    });
}

useVaultStore.subscribe((state, prev) => {
    if (state.vaultPath === prev.vaultPath) {
        return;
    }

    useChatStore.getState().syncAutoContextForVault(state.vaultPath);
});
