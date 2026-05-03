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
    aiForkSessionHistory,
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
import {
    isFileTab,
    isChatTab,
    isNoteTab,
    selectEditorWorkspaceTabs,
    useEditorStore,
} from "../../../app/store/editorStore";
import { getPreferredWorkspaceChatSessionIdForSession } from "../chatWorkspaceSelectors";
import {
    useVaultStore,
    type VaultNoteChange,
} from "../../../app/store/vaultStore";
import { vaultInvoke } from "../../../app/utils/vaultInvoke";
import {
    canonicalizeVaultScopedPath,
    isAbsoluteVaultPath,
    normalizeVaultPath,
    normalizeVaultRoot,
    pathsMatchVaultScoped,
} from "../../../app/utils/vaultPaths";
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
    keepExactSpans,
    patchIsEmpty,
    rejectAllEdits as actionLogRejectAll,
    rejectExactSpans,
    replaceTrackedFileCurrentText,
    setTrackedFilesForWorkCycle,
    type RestoreAction,
} from "./actionLogModel";
import type { LastRejectUndo, TrackedFile } from "../diff/actionLogTypes";
import type { ResourceReloadMetadata } from "../../../app/store/editorResourceRegistry";
import {
    buildReviewProjectionIndex,
    expandReviewHunkIdsToOverlapClosure,
    type ReviewHunkId,
    resolveReviewHunkIdsToExactSpans,
} from "../diff/reviewProjectionIndex";
import {
    type EditorTarget,
    resolveEditorTargetForTrackedPath,
    resolveFileTargetForPath,
    resolveNoteTargetForPath,
} from "../../editor/editorTargetResolver";
import { getExternalReloadBaselineCandidate } from "../../editor/externalReloadBaselineCache";
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
    type AIChatFileSummary,
    type AIChatMessage,
    type AIChatMessageKind,
    type AIFileDiff,
    type AIChatNoteSummary,
    type AIChatRole,
    type AIChatSession,
    type AIComposerPart,
    type AIImageGenerationPayload,
    type AIPermissionRequestPayload,
    type AIPlanUpdatePayload,
    type AIStatusEventPayload,
    type AITokenUsage,
    type AITokenUsagePayload,
    type AIToolActivityPayload,
    type AIUserInputRequestPayload,
    type AIRuntimeConnectionPayload,
    type AIRuntimeConnectionState,
    type AIRuntimeDescriptor,
    type AISecretPatch,
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
import {
    safeStorageGetItem,
    safeStorageRemoveItem,
    safeStorageSetItem,
    subscribeSafeStorage,
} from "../../../app/utils/safeStorage";
import { logDebug, logError, logWarn } from "../../../app/utils/runtimeLog";

const AI_PREFS_KEY = "neverwrite.ai.preferences";
const AI_RUNTIME_CACHE_KEY = "neverwrite.ai.runtime-catalog";
type PersistedSessionHistorySummary = Omit<PersistedSessionHistory, "messages">;
let _persistedHistoryCacheVaultPath: string | null = null;
let _persistedHistoryCacheBySessionId = new Map<
    string,
    PersistedSessionHistorySummary
>();
const AI_AUTO_CONTEXT_KEY_PREFIX = "neverwrite.ai.auto-context:";
const AI_AUTO_CONTEXT_GLOBAL_SCOPE = "__global__";
const TRANSCRIPT_PAGE_SIZE = 60;
const TRACKED_PERSISTED_RECONCILE_DELAY_MS = 260;
const _pendingTrackedPersistedReconcileByKey = new Map<
    string,
    ReturnType<typeof setTimeout>
>();

function clearTrackedPersistedReconciliationTimers() {
    for (const timeoutId of _pendingTrackedPersistedReconcileByKey.values()) {
        clearTimeout(timeoutId);
    }
    _pendingTrackedPersistedReconcileByKey.clear();
}

interface AiPreferences {
    modelId?: string;
    modeId?: string;
    configOptions?: Record<string, string>;
    autoContextEnabled?: boolean;
    requireCmdEnterToSend?: boolean;
    contextUsageBarEnabled?: boolean;
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
    contextUsageBarEnabled: boolean;
    composerFontSize: number;
    chatFontSize: number;
    composerFontFamily: EditorFontFamily;
    chatFontFamily: EditorFontFamily;
    editDiffZoom: number;
    historyRetentionDays: number;
    screenshotRetentionSeconds: number;
}

const DEFAULT_AI_PREFERENCES: NormalizedAiPreferences = {
    requireCmdEnterToSend: false,
    contextUsageBarEnabled: true,
    composerFontSize: 14,
    chatFontSize: 14,
    composerFontFamily: "system",
    chatFontFamily: "system",
    editDiffZoom: 0.72,
    historyRetentionDays: 0,
    screenshotRetentionSeconds: 0,
};

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

interface DeferredQueuedMessage {
    item: QueuedChatMessage;
    originalIndex: number;
    previousItemId: string | null;
    nextItemId: string | null;
}

// Deferred queue entries are temporarily withheld while the session is busy.
// Paused queues remember which deferred items must be reinstated only after the
// next user-initiated send, so auto-resume does not reorder intent.
interface PausedQueueState {
    reinstateAfterNextManualSend: DeferredQueuedMessage[];
}

interface PendingInterruptedSend {
    item: QueuedChatMessage;
    preserveComposerState?: boolean;
}

interface InterruptedTurnState {
    isStopping: boolean;
    ignoreLateActivity: boolean;
    pendingManualSend?: PendingInterruptedSend;
}

function aiPrefsEqual(
    left: Pick<
        ChatStore,
        | "requireCmdEnterToSend"
        | "contextUsageBarEnabled"
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
        left.contextUsageBarEnabled === right.contextUsageBarEnabled &&
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
        const raw = safeStorageGetItem(AI_PREFS_KEY);
        return raw ? (JSON.parse(raw) as AiPreferences) : {};
    } catch {
        return {};
    }
}

function saveAiPreferences(patch: Partial<AiPreferences>) {
    try {
        const current = loadAiPreferences();
        safeStorageSetItem(
            AI_PREFS_KEY,
            JSON.stringify({ ...current, ...patch }),
        );
    } catch {
        // Preference writes are best-effort and should never break chat flows.
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
        const raw = safeStorageGetItem(getAutoContextStorageKey(vaultPath));
        if (raw === "true") return true;
        if (raw === "false") return false;
    } catch {
        return false;
    }

    const legacyPrefs = loadAiPreferences();
    return legacyPrefs.autoContextEnabled === true;
}

function saveAutoContextPreference(
    vaultPath: string | null,
    autoContextEnabled: boolean,
) {
    try {
        safeStorageSetItem(
            getAutoContextStorageKey(vaultPath),
            String(autoContextEnabled),
        );
    } catch {
        // Auto-context persistence is optional; keep the current session usable.
    }
}

function getNormalizedAiPreferences(): NormalizedAiPreferences {
    const prefs = loadAiPreferences();
    return {
        requireCmdEnterToSend: prefs.requireCmdEnterToSend === true,
        contextUsageBarEnabled: prefs.contextUsageBarEnabled !== false,
        composerFontSize: prefs.composerFontSize ?? 14,
        chatFontSize: prefs.chatFontSize ?? 14,
        composerFontFamily: normalizeEditorFontFamily(prefs.composerFontFamily),
        chatFontFamily: normalizeEditorFontFamily(prefs.chatFontFamily),
        editDiffZoom: prefs.editDiffZoom ?? 0.72,
        historyRetentionDays: prefs.historyRetentionDays ?? 0,
        screenshotRetentionSeconds: prefs.screenshotRetentionSeconds ?? 0,
    };
}

function loadRuntimeCatalogCache(): Record<string, AIRuntimeCatalogSnapshot> {
    try {
        const raw = safeStorageGetItem(AI_RUNTIME_CACHE_KEY);
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
        safeStorageSetItem(
            AI_RUNTIME_CACHE_KEY,
            JSON.stringify({
                ...current,
                [runtimeId]: snapshot,
            }),
        );
    } catch {
        // Cache misses are acceptable; the runtime can always refresh again.
    }
}

function setPersistedHistoryCache(
    vaultPath: string | null,
    histories: PersistedSessionHistory[],
) {
    _persistedHistoryCacheVaultPath = vaultPath ?? null;
    _persistedHistoryCacheBySessionId = new Map(
        histories.map((history) => [
            history.session_id,
            summarizePersistedHistory(history),
        ]),
    );
}

function upsertPersistedHistoryCache(
    vaultPath: string | null,
    history: PersistedSessionHistory,
) {
    const summary = summarizePersistedHistory(history);
    if (_persistedHistoryCacheVaultPath !== (vaultPath ?? null)) {
        setPersistedHistoryCache(vaultPath, [history]);
        return;
    }

    _persistedHistoryCacheBySessionId.set(summary.session_id, summary);
}

function deletePersistedHistoryCacheEntry(
    vaultPath: string | null,
    historySessionId: string | null | undefined,
) {
    if (!historySessionId) {
        return;
    }

    if (_persistedHistoryCacheVaultPath !== (vaultPath ?? null)) {
        return;
    }

    _persistedHistoryCacheBySessionId.delete(historySessionId);
}

function clearPersistedHistoryCache(vaultPath: string | null) {
    if (_persistedHistoryCacheVaultPath !== (vaultPath ?? null)) {
        return;
    }

    _persistedHistoryCacheBySessionId.clear();
}

function getPersistedHistoryFromCache(
    vaultPath: string | null,
    historySessionId: string | null | undefined,
) {
    if (!historySessionId) {
        return null;
    }

    if (_persistedHistoryCacheVaultPath !== (vaultPath ?? null)) {
        return null;
    }

    return _persistedHistoryCacheBySessionId.get(historySessionId) ?? null;
}

function getPersistedHistorySessionId(sessionId: string) {
    if (!sessionId.startsWith("persisted:")) {
        return null;
    }

    return sessionId.slice("persisted:".length) || null;
}

function getWorkspaceHistorySessionIdForSession(sessionId: string) {
    const tab = selectEditorWorkspaceTabs(useEditorStore.getState()).find(
        (candidate) => isChatTab(candidate) && candidate.sessionId === sessionId,
    );
    return tab && isChatTab(tab) ? (tab.historySessionId ?? null) : null;
}

function summarizePersistedHistory(
    history: PersistedSessionHistory,
): PersistedSessionHistorySummary {
    const { messages: _messages, ...summary } = history;
    return summary;
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

function secretPatchChanged(patch: AISecretPatch) {
    return patch.action !== "unchanged";
}

function getPersistedHistoryCatalogSnapshot(
    history: Pick<
        PersistedSessionHistory,
        "models" | "modes" | "config_options"
    >,
): AIRuntimeCatalogSnapshot {
    return {
        models: (history.models ?? []).map((model) => ({
            id: model.id,
            runtimeId: model.runtime_id,
            name: model.name,
            description: model.description,
        })),
        modes: (history.modes ?? []).map((mode) => ({
            id: mode.id,
            runtimeId: mode.runtime_id,
            name: mode.name,
            description: mode.description,
            disabled: mode.disabled,
        })),
        configOptions: (history.config_options ?? []).map((option) => ({
            id: option.id,
            runtimeId: option.runtime_id,
            category: option.category,
            label: option.label,
            description: option.description ?? undefined,
            type: option.type,
            value: option.value,
            options: option.options.map((item) => ({
                value: item.value,
                label: item.label,
                description: item.description ?? undefined,
            })),
        })),
    };
}

function hydrateSessionCatalogFromSnapshot(
    session: AIChatSession,
    snapshot: AIRuntimeCatalogSnapshot,
): AIChatSession {
    if (!hasRuntimeCatalog(snapshot)) {
        return session;
    }

    const optionValues = new Map(
        session.configOptions.map((option) => [option.id, option.value]),
    );
    const models = session.models.length > 0 ? session.models : snapshot.models;
    const modes = session.modes.length > 0 ? session.modes : snapshot.modes;
    const configOptions =
        session.configOptions.length > 0
            ? session.configOptions
            : snapshot.configOptions.map((option) => ({
                  ...option,
                  value:
                      optionValues.get(option.id) ??
                      (option.category === "model"
                          ? session.modelId
                          : option.category === "mode"
                            ? session.modeId
                            : option.value),
              }));

    if (
        models === session.models &&
        modes === session.modes &&
        configOptions === session.configOptions
    ) {
        return session;
    }

    return synchronizeSessionConfigSelections({
        ...session,
        models,
        modes,
        configOptions,
    });
}

function synchronizeSessionConfigSelections(
    session: AIChatSession,
): AIChatSession {
    if (session.configOptions.length === 0) {
        return session;
    }

    let changed = false;
    const configOptions = session.configOptions.map((option) => {
        const nextValue =
            option.category === "model"
                ? session.modelId
                : option.category === "mode"
                  ? session.modeId
                  : option.value;

        if (nextValue === option.value) {
            return option;
        }

        changed = true;
        return {
            ...option,
            value: nextValue,
        };
    });

    if (!changed) {
        return session;
    }

    return {
        ...session,
        configOptions,
    };
}

function hydrateSessionCatalogFromRuntime(
    session: AIChatSession,
    runtime: AIRuntimeDescriptor | undefined,
): AIChatSession {
    if (!runtime) {
        return session;
    }

    return hydrateSessionCatalogFromSnapshot(session, {
        models: runtime.models,
        modes: runtime.modes,
        configOptions: runtime.configOptions,
    });
}

async function ensureLiveSessionForAgentConfigChange(
    sessionId: string,
): Promise<string | null> {
    const session = useChatStore.getState().sessionsById[sessionId];
    if (!session) return null;
    if (session.runtimeState === "live") return sessionId;
    if (!session.isPersistedSession) return sessionId;

    const resumedSessionId = await useChatStore
        .getState()
        .resumeSession(sessionId);
    if (!resumedSessionId) {
        return null;
    }

    const resumedSession =
        useChatStore.getState().sessionsById[resumedSessionId] ?? null;
    return resumedSession?.runtimeState === "live" ? resumedSessionId : null;
}

function sessionHasAgentCatalog(
    session: Pick<AIChatSession, "models" | "modes" | "configOptions">,
) {
    return hasRuntimeCatalog(getRuntimeCatalogSnapshot(session));
}

async function ensureSessionAgentCatalogLoaded(
    sessionId: string,
): Promise<string | null> {
    let session = useChatStore.getState().sessionsById[sessionId] ?? null;
    if (!session) return null;

    if (!sessionHasAgentCatalog(session)) {
        const persisted = getPersistedHistoryFromCache(
            session.vaultPath ?? useVaultStore.getState().vaultPath,
            session.historySessionId,
        );
        if (persisted) {
            useChatStore
                .getState()
                .upsertSession(
                    applyPersistedHistoryMetadata(session, persisted),
                );
            session =
                useChatStore.getState().sessionsById[session.sessionId] ??
                session;
        }

        if (session.runtimeState !== "live") {
            const liveSessionId =
                await ensureLiveSessionForAgentConfigChange(sessionId);
            if (!liveSessionId) {
                return null;
            }
            session =
                useChatStore.getState().sessionsById[liveSessionId] ?? null;
            if (!session) {
                return null;
            }
        }

        if (!sessionHasAgentCatalog(session)) {
            try {
                const loaded = await aiLoadSession(session.sessionId);
                const latest =
                    useChatStore.getState().sessionsById[session.sessionId] ??
                    session;
                useChatStore.getState().upsertSession({
                    ...loaded,
                    historySessionId:
                        latest.historySessionId ?? loaded.historySessionId,
                    vaultPath: latest.vaultPath ?? loaded.vaultPath ?? null,
                    persistedCreatedAt:
                        latest.persistedCreatedAt ??
                        loaded.persistedCreatedAt ??
                        null,
                    persistedUpdatedAt:
                        latest.persistedUpdatedAt ??
                        loaded.persistedUpdatedAt ??
                        null,
                    persistedTitle:
                        latest.persistedTitle ?? loaded.persistedTitle ?? null,
                    customTitle:
                        latest.customTitle ?? loaded.customTitle ?? null,
                    persistedPreview:
                        latest.persistedPreview ??
                        loaded.persistedPreview ??
                        null,
                    persistedMessageCount:
                        latest.persistedMessageCount ??
                        loaded.persistedMessageCount ??
                        loaded.messages.length,
                    loadedPersistedMessageStart:
                        latest.loadedPersistedMessageStart ??
                        loaded.loadedPersistedMessageStart ??
                        null,
                    isLoadingPersistedMessages:
                        latest.isLoadingPersistedMessages ??
                        loaded.isLoadingPersistedMessages ??
                        false,
                });
            } catch {
                // Leave the session usable even if backend catalog refresh fails.
            }
        }
    }

    const resolved =
        useChatStore.getState().sessionsById[session.sessionId] ?? null;
    return resolved ? resolved.sessionId : null;
}

type PreparedAgentConfigSession =
    | { kind: "abort" }
    | { kind: "live"; session: AIChatSession }
    | { kind: "preference-only"; session: AIChatSession };

type AgentConfigMutationArgs = {
    requestedSessionId?: string;
    change: AgentSelectionChange;
    applyLocal(session: AIChatSession): AIChatSession;
    applyRemote(session: AIChatSession): Promise<AIChatSession>;
    persistPreference(): void;
    errorMessage: string;
};

async function prepareSessionForAgentConfigMutation(
    requestedSessionId?: string,
): Promise<PreparedAgentConfigSession> {
    const resolvedSessionId =
        requestedSessionId ?? useChatStore.getState().activeSessionId;
    if (!resolvedSessionId) {
        return { kind: "abort" };
    }

    let session = useChatStore.getState().sessionsById[resolvedSessionId];
    if (!session || session.isResumingSession) {
        return { kind: "abort" };
    }

    if (session.runtimeState !== "live") {
        const liveSessionId =
            await ensureLiveSessionForAgentConfigChange(resolvedSessionId);
        if (
            liveSessionId &&
            liveSessionId !== resolvedSessionId &&
            useChatStore.getState().sessionsById[liveSessionId]
        ) {
            session = useChatStore.getState().sessionsById[liveSessionId]!;
        } else if (session.isPersistedSession) {
            return { kind: "abort" };
        }
    }

    if (session.runtimeState === "live" && !sessionHasAgentCatalog(session)) {
        await ensureSessionAgentCatalogLoaded(session.sessionId);
        session =
            useChatStore.getState().sessionsById[session.sessionId] ?? session;
    }

    if (session.runtimeState !== "live") {
        return { kind: "preference-only", session };
    }

    return { kind: "live", session };
}

function getModelConfigOption(session: Pick<AIChatSession, "configOptions">) {
    return session.configOptions.find((option) => option.category === "model");
}

function getModeConfigOption(session: Pick<AIChatSession, "configOptions">) {
    return session.configOptions.find(
        (option) => option.category === "mode" || option.id === "mode",
    );
}

function getConfigOptionValue(
    session: Pick<AIChatSession, "configOptions">,
    optionId: string,
) {
    return session.configOptions.find((option) => option.id === optionId)
        ?.value;
}

function removeSessionMapEntry<T>(
    map: Record<string, T>,
    sessionId: string,
): Record<string, T> {
    if (!(sessionId in map)) {
        return map;
    }

    const next = { ...map };
    delete next[sessionId];
    return next;
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

type AgentSelectionChange =
    | { kind: "model"; value: string }
    | { kind: "mode"; value: string }
    | { kind: "config"; optionId: string; value: string };

function applyLocalModeSelection(
    session: AIChatSession,
    modeId: string,
): AIChatSession {
    return {
        ...session,
        modeId,
    };
}

function applyLocalConfigOptionSelection(
    session: AIChatSession,
    optionId: string,
    value: string,
): AIChatSession {
    if (optionId === "model") {
        return applyLocalModelSelection(session, value);
    }

    return {
        ...session,
        configOptions: session.configOptions.map((option) =>
            option.id === optionId ? { ...option, value } : option,
        ),
    };
}

function persistModelPreference(modelId: string) {
    saveAiPreferences({ modelId });
}

function persistModePreference(modeId: string) {
    saveAiPreferences({ modeId });
}

function persistConfigOptionSelectionPreference(
    optionId: string,
    value: string,
) {
    if (optionId === "model") {
        persistModelPreference(value);
        return;
    }

    saveConfigOptionPreference(optionId, value);
}

function sessionReflectsAgentSelectionChange(
    session: AIChatSession,
    change: AgentSelectionChange,
) {
    switch (change.kind) {
        case "model":
            return (
                session.modelId === change.value ||
                getModelConfigOption(session)?.value === change.value
            );
        case "mode":
            return (
                session.modeId === change.value ||
                getModeConfigOption(session)?.value === change.value
            );
        case "config":
            if (change.optionId === "model") {
                return (
                    session.modelId === change.value ||
                    getConfigOptionValue(session, "model") === change.value
                );
            }

            if (change.optionId === "mode") {
                return (
                    session.modeId === change.value ||
                    getConfigOptionValue(session, "mode") === change.value
                );
            }

            return (
                getConfigOptionValue(session, change.optionId) === change.value
            );
    }
}

function resolveAgentSelectionMutationResult(
    latestSession: AIChatSession | null | undefined,
    returnedSession: AIChatSession,
    change: AgentSelectionChange,
) {
    if (!latestSession) {
        return returnedSession;
    }

    const latestMatches = sessionReflectsAgentSelectionChange(
        latestSession,
        change,
    );
    const returnedMatches = sessionReflectsAgentSelectionChange(
        returnedSession,
        change,
    );

    if (!latestMatches || returnedMatches) {
        return returnedSession;
    }

    // The mutation response may arrive after a newer optimistic selection has
    // already updated the live session. In that race, preserve the newer local
    // choice instead of letting the stale response roll it back.
    return synchronizeSessionConfigSelections({
        ...returnedSession,
        modelId: latestSession.modelId,
        modeId: latestSession.modeId,
        configOptions: latestSession.configOptions,
        models:
            latestSession.models.length > 0
                ? latestSession.models
                : returnedSession.models,
        modes:
            latestSession.modes.length > 0
                ? latestSession.modes
                : returnedSession.modes,
        effortsByModel:
            latestSession.effortsByModel &&
            Object.keys(latestSession.effortsByModel).length > 0
                ? latestSession.effortsByModel
                : returnedSession.effortsByModel,
    });
}

async function applyAgentConfigMutation({
    requestedSessionId,
    change,
    applyLocal,
    applyRemote,
    persistPreference,
    errorMessage,
}: AgentConfigMutationArgs): Promise<void> {
    const preparedSession =
        await prepareSessionForAgentConfigMutation(requestedSessionId);
    if (preparedSession.kind === "abort") {
        return;
    }

    if (preparedSession.kind === "preference-only") {
        const { session } = preparedSession;
        useChatStore.setState((state) => {
            const currentSession = state.sessionsById[session.sessionId];
            if (!currentSession) {
                return {};
            }

            const hydratedSession = hydrateSessionCatalogFromRuntime(
                currentSession,
                state.runtimes.find(
                    (runtime) =>
                        runtime.runtime.id === currentSession.runtimeId,
                ),
            );
            const nextSession = applyLocal(hydratedSession);

            return {
                sessionsById: {
                    ...state.sessionsById,
                    [session.sessionId]: nextSession,
                },
                tokenUsageBySessionId:
                    currentSession.modelId !== nextSession.modelId
                        ? removeSessionMapEntry(
                              state.tokenUsageBySessionId,
                              session.sessionId,
                          )
                        : state.tokenUsageBySessionId,
            };
        });
        persistPreference();
        return;
    }

    const { session } = preparedSession;
    try {
        const updatedSession = await applyRemote(session);
        useChatStore
            .getState()
            .upsertSession(
                resolveAgentSelectionMutationResult(
                    useChatStore.getState().sessionsById[session.sessionId],
                    updatedSession,
                    change,
                ),
            );
        persistPreference();
    } catch (error) {
        useChatStore.getState().applySessionError({
            session_id: session.sessionId,
            message: getAiErrorMessage(error, errorMessage),
        });
    }
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
    lastFocusedSessionId: string | null;
    selectedRuntimeId: string | null;
    isInitializing: boolean;
    notePickerOpen: boolean;
    autoContextEnabled: boolean;
    requireCmdEnterToSend: boolean;
    contextUsageBarEnabled: boolean;
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
    activeQueuedMessageBySessionId: Record<string, DeferredQueuedMessage>;
    pausedQueueBySessionId: Record<string, PausedQueueState>;
    interruptedTurnStateBySessionId: Record<string, InterruptedTurnState>;
    tokenUsageBySessionId: Record<string, AITokenUsage>;
    initialize: (
        options?: { createDefaultSession?: boolean },
    ) => Promise<ChatInitializationResult>;
    reconcileRestoredWorkspaceTabs: (
        tabs: Array<{
            id: string;
            sessionId: string;
            historySessionId?: string | null;
            runtimeId?: string | null;
        }>,
        activeTabId?: string | null,
    ) => Promise<void>;
    syncAutoContextForVault: (vaultPath: string | null) => void;
    setSelectedRuntime: (runtimeId: string | null) => void;
    refreshSetupStatus: (runtimeId?: string) => Promise<void>;
    saveSetup: (input: {
        runtimeId?: string;
        customBinaryPath?: string;
        codexApiKey: AISecretPatch;
        openaiApiKey: AISecretPatch;
        geminiApiKey: AISecretPatch;
        googleApiKey: AISecretPatch;
        googleCloudProject?: string;
        googleCloudLocation?: string;
        gatewayBaseUrl?: string;
        gatewayHeaders: AISecretPatch;
        anthropicBaseUrl?: string;
        anthropicCustomHeaders: AISecretPatch;
        anthropicAuthToken: AISecretPatch;
        anthropicApiKey?: AISecretPatch;
    }) => Promise<void>;
    startAuth: (input: {
        runtimeId?: string;
        methodId: string;
        customBinaryPath?: string;
        codexApiKey: AISecretPatch;
        openaiApiKey: AISecretPatch;
        geminiApiKey: AISecretPatch;
        googleApiKey: AISecretPatch;
        googleCloudProject?: string;
        googleCloudLocation?: string;
        gatewayBaseUrl?: string;
        gatewayHeaders: AISecretPatch;
        anthropicBaseUrl?: string;
        anthropicCustomHeaders: AISecretPatch;
        anthropicAuthToken: AISecretPatch;
        anthropicApiKey?: AISecretPatch;
    }) => Promise<void>;
    upsertSession: (session: AIChatSession, activate?: boolean) => void;
    applySessionError: (payload: AISessionErrorPayload) => void;
    applyRuntimeConnection: (payload: AIRuntimeConnectionPayload) => void;
    applyTokenUsage: (payload: AITokenUsagePayload) => void;
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
    applyImageGeneration: (payload: AIImageGenerationPayload) => void;
    applyPlanUpdate: (payload: AIPlanUpdatePayload) => void;
    applyAvailableCommandsUpdate: (payload: AIAvailableCommandsPayload) => void;
    applyPermissionRequest: (payload: AIPermissionRequestPayload) => void;
    applyUserInputRequest: (payload: AIUserInputRequestPayload) => void;
    reconcileTrackedFilesFromVaultChange: (
        change: VaultNoteChange,
    ) => Promise<void>;
    setActiveSession: (sessionId: string) => void;
    markSessionFocused: (sessionId: string) => void;
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
    rejectAllEditedFiles: (sessionId: string) => Promise<void>;
    keepEditedFile: (sessionId: string, identityKey: string) => void;
    keepAllEditedFiles: (sessionId: string) => void;
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
    newSession: (
        runtimeId?: string,
        provisionalSessionId?: string,
    ) => Promise<string | null>;
    deleteSession: (sessionId: string) => Promise<void>;
    deleteAllSessions: () => Promise<void>;
    renameSession: (sessionId: string, newTitle: string | null) => void;
    attachNote: (note: AIChatNoteSummary, sessionId?: string) => void;
    attachVaultFile: (file: AIChatFileSummary, sessionId?: string) => void;
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
    setContextUsageBarEnabled: (enabled: boolean) => void;
    setComposerFontSize: (size: number) => void;
    setChatFontSize: (size: number) => void;
    setComposerFontFamily: (fontFamily: EditorFontFamily) => void;
    setChatFontFamily: (fontFamily: EditorFontFamily) => void;
    setEditDiffZoom: (size: number) => void;
    setHistoryRetentionDays: (days: number) => Promise<void>;
    setScreenshotRetentionSeconds: (seconds: number) => void;
    openNotePicker: () => void;
    closeNotePicker: () => void;
    forkSession: (sessionId: string) => Promise<void>;
}

export interface ChatInitializationResult {
    sessionInventoryLoaded: boolean;
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
        toolAction: payload.tool_action ?? null,
    };
}

function isFailedImageGenerationStatus(status: string) {
    return status === "failed" || status === "error" || status === "cancelled";
}

function createImageGenerationMessage(
    payload: AIImageGenerationPayload,
): AIChatMessage {
    const status = payload.status || "completed";
    const failed = isFailedImageGenerationStatus(status);
    const inProgress = status === "pending" || status === "in_progress";

    return {
        id: `image:${payload.image_id}`,
        role: "assistant",
        kind: "image",
        title:
            payload.title ||
            (failed ? "Image generation failed" : "Generated image"),
        content: inProgress
            ? "Generating image..."
            : failed
              ? (payload.error ?? "Image generation failed")
              : "Generated image",
        timestamp: Date.now(),
        inProgress,
        meta: {
            image_status: status,
            image_path: payload.path ?? null,
            image_mime_type: payload.mime_type ?? null,
            revised_prompt: payload.revised_prompt ?? null,
            result: payload.result ?? null,
            error: payload.error ?? null,
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
        "Use the saved transcript below as prior conversation context for this session.",
        "",
        "Important:",
        "- The transcript is historical context only and may not reflect the current workspace state.",
        "- If the transcript conflicts with the current files, current environment, or the user's latest message, trust the current state.",
        "- Do not assume prior pending tasks, approvals, permissions, or unfinished plans are still valid; verify when needed.",
        "- Continue naturally from this context without repeating the transcript unless it is useful.",
        "",
        "Saved transcript:",
        history,
        "",
        `New user message: ${prompt}`,
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

function normalizeComparablePath(path: string) {
    return normalizeVaultPath(path).replace(/\/+$/, "");
}

function isPathInsideRoot(path: string, root: string) {
    const normalizedPath = normalizeComparablePath(path);
    const normalizedRoot = normalizeVaultRoot(root);
    if (!normalizedRoot) {
        return false;
    }

    return (
        normalizedPath === normalizedRoot ||
        normalizedPath.startsWith(`${normalizedRoot}/`)
    );
}

function getParentDirectory(path: string) {
    const normalizedPath = normalizeComparablePath(path);
    if (!normalizedPath) {
        return null;
    }

    const lastSlashIndex = normalizedPath.lastIndexOf("/");
    if (lastSlashIndex < 0) {
        return null;
    }

    if (lastSlashIndex === 0) {
        return "/";
    }

    return normalizedPath.slice(0, lastSlashIndex);
}

function getAdditionalRootCandidateForAttachment(
    attachment: AIChatAttachment,
): string | null {
    if (attachment.type === "folder") {
        const folderPath = attachment.noteId ?? attachment.path;
        if (!folderPath || !isAbsoluteVaultPath(folderPath)) {
            return null;
        }

        return normalizeComparablePath(folderPath);
    }

    const filePath = attachment.filePath ?? attachment.path;
    if (!filePath || !isAbsoluteVaultPath(filePath)) {
        return null;
    }

    return getParentDirectory(filePath);
}

function collectExternalAdditionalRoots(
    attachments: AIChatAttachment[],
    vaultPath: string | null,
) {
    const roots = new Set<string>();

    for (const attachment of attachments) {
        const candidateRoot =
            getAdditionalRootCandidateForAttachment(attachment);
        if (!candidateRoot) {
            continue;
        }

        if (vaultPath && isPathInsideRoot(candidateRoot, vaultPath)) {
            continue;
        }

        roots.add(candidateRoot);
    }

    return [...roots];
}

function canRecreateSessionForAdditionalRoots(
    session: AIChatSession,
    sessionId: string,
    state: Pick<
        ChatStore,
        | "queuedMessagesBySessionId"
        | "queuedMessageEditBySessionId"
        | "sessionsById"
    >,
) {
    if (session.runtimeId !== "claude-acp") {
        return false;
    }

    if (
        session.isResumingSession ||
        session.runtimeState !== "live" ||
        session.status !== "idle" ||
        session.messages.length > 0
    ) {
        return false;
    }

    if ((state.queuedMessagesBySessionId[sessionId]?.length ?? 0) > 0) {
        return false;
    }

    return !state.queuedMessageEditBySessionId[sessionId];
}

type SessionLocalStateSnapshot = {
    composerParts: AIComposerPart[];
    queuedMessages: QueuedChatMessage[];
    queuedMessageEdit: QueuedMessageEditState | undefined;
    activeQueuedMessage: DeferredQueuedMessage | undefined;
    pausedQueue: PausedQueueState | undefined;
};

function snapshotSessionLocalState(
    state: Pick<
        ChatStore,
        | "composerPartsBySessionId"
        | "queuedMessagesBySessionId"
        | "queuedMessageEditBySessionId"
        | "activeQueuedMessageBySessionId"
        | "pausedQueueBySessionId"
    >,
    sessionId: string,
): SessionLocalStateSnapshot {
    return {
        composerParts:
            state.composerPartsBySessionId[sessionId] ??
            createEmptyComposerParts(),
        queuedMessages: state.queuedMessagesBySessionId[sessionId] ?? [],
        queuedMessageEdit: state.queuedMessageEditBySessionId[sessionId],
        activeQueuedMessage: state.activeQueuedMessageBySessionId[sessionId],
        pausedQueue: state.pausedQueueBySessionId[sessionId],
    };
}

function migrateSessionLocalState(
    fromSessionId: string,
    toSession: AIChatSession,
    shouldApply?: (state: ChatStore) => boolean,
): boolean {
    let migrated = false;

    useChatStore.setState((state) => {
        if (shouldApply && !shouldApply(state)) {
            return state;
        }

        const localState = snapshotSessionLocalState(state, fromSessionId);
        const nextSessionsById = { ...state.sessionsById };
        delete nextSessionsById[fromSessionId];

        const nextComposerParts = {
            ...state.composerPartsBySessionId,
        };
        delete nextComposerParts[fromSessionId];
        nextComposerParts[toSession.sessionId] = localState.composerParts;

        const nextQueuedMessagesBySessionId = {
            ...state.queuedMessagesBySessionId,
        };
        delete nextQueuedMessagesBySessionId[fromSessionId];
        if (localState.queuedMessages.length > 0) {
            nextQueuedMessagesBySessionId[toSession.sessionId] =
                localState.queuedMessages;
        }

        const nextQueuedMessageEditBySessionId = {
            ...state.queuedMessageEditBySessionId,
        };
        delete nextQueuedMessageEditBySessionId[fromSessionId];
        if (localState.queuedMessageEdit) {
            nextQueuedMessageEditBySessionId[toSession.sessionId] =
                localState.queuedMessageEdit;
        }

        const nextActiveQueuedMessageBySessionId = {
            ...state.activeQueuedMessageBySessionId,
        };
        delete nextActiveQueuedMessageBySessionId[fromSessionId];
        if (localState.activeQueuedMessage) {
            nextActiveQueuedMessageBySessionId[toSession.sessionId] =
                localState.activeQueuedMessage;
        }

        const nextPausedQueueBySessionId = {
            ...state.pausedQueueBySessionId,
        };
        delete nextPausedQueueBySessionId[fromSessionId];
        if (localState.pausedQueue) {
            nextPausedQueueBySessionId[toSession.sessionId] =
                localState.pausedQueue;
        }

        migrated = true;

        return {
            runtimes: hydrateRuntimesFromSessions(state.runtimes, [toSession]),
            sessionsById: {
                ...nextSessionsById,
                [toSession.sessionId]: toSession,
            },
            sessionOrder: touchSessionOrder(
                state.sessionOrder.filter((id) => id !== fromSessionId),
                toSession.sessionId,
            ),
            activeSessionId:
                state.activeSessionId === fromSessionId
                    ? toSession.sessionId
                    : state.activeSessionId,
            composerPartsBySessionId: nextComposerParts,
            queuedMessagesBySessionId: nextQueuedMessagesBySessionId,
            queuedMessageEditBySessionId: nextQueuedMessageEditBySessionId,
            activeQueuedMessageBySessionId: nextActiveQueuedMessageBySessionId,
            pausedQueueBySessionId: nextPausedQueueBySessionId,
        };
    });

    if (!migrated) {
        return false;
    }

    clearStaleStreamingCheck(fromSessionId);
    _queueDrainLocks.delete(fromSessionId);
    replaceChatRowUiSessionId(fromSessionId, toSession.sessionId);
    useChatTabsStore
        .getState()
        .replaceSessionId(
            fromSessionId,
            toSession.sessionId,
            toSession.historySessionId,
            toSession.runtimeId,
        );
    useEditorStore
        .getState()
        .replaceAiSessionId(
            fromSessionId,
            toSession.sessionId,
            toSession.historySessionId,
        );
    registerOpenEditorBaselines(toSession.sessionId);

    return true;
}

function registerOpenEditorBaselines(sessionId: string) {
    const session = useChatStore.getState().sessionsById[sessionId];
    if (!session || session.runtimeState !== "live") {
        return;
    }

    const tabs = selectEditorWorkspaceTabs(useEditorStore.getState());
    for (const tab of tabs) {
        if (isNoteTab(tab) && tab.content != null) {
            aiRegisterFileBaseline(
                sessionId,
                `${tab.noteId}.md`,
                tab.content,
            ).catch(() => {});
            continue;
        }

        if (isFileTab(tab) && tab.content != null) {
            aiRegisterFileBaseline(sessionId, tab.path, tab.content).catch(
                () => {},
            );
        }
    }
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
    const nextQueue = queue.filter((queuedItem) => queuedItem.id !== item.id);
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

function finalizeQueuedMessageEditState(
    state: Pick<
        ChatStore,
        | "sessionsById"
        | "composerPartsBySessionId"
        | "queuedMessagesBySessionId"
        | "queuedMessageEditBySessionId"
    >,
    sessionId: string,
    restoredItem?: QueuedChatMessage,
) {
    const session = state.sessionsById[sessionId];
    const editState = state.queuedMessageEditBySessionId[sessionId];
    if (!session || !editState) {
        return null;
    }

    const sanitizedQueue = (
        state.queuedMessagesBySessionId[sessionId] ?? []
    ).filter((queuedItem) => queuedItem.id !== editState.item.id);

    const nextQueuedMessageEditBySessionId = {
        ...state.queuedMessageEditBySessionId,
    };
    delete nextQueuedMessageEditBySessionId[sessionId];

    const nextQueuedMessagesBySessionId = cleanupQueuedMessagesBySessionId(
        state.queuedMessagesBySessionId,
        sessionId,
        restoredItem
            ? restoreQueuedMessagePosition(
                  sanitizedQueue,
                  editState,
                  restoredItem,
              )
            : sanitizedQueue,
    );

    return {
        nextSession: {
            ...session,
            attachments: editState.previousAttachments.map(cloneAttachment),
        },
        nextComposerPartsBySessionId: {
            ...state.composerPartsBySessionId,
            [sessionId]: cloneComposerParts(editState.previousComposerParts),
        },
        nextQueuedMessagesBySessionId,
        nextQueuedMessageEditBySessionId,
    };
}

function createDeferredQueuedMessage(
    queue: QueuedChatMessage[],
    item: QueuedChatMessage,
): DeferredQueuedMessage {
    const originalIndex = queue.findIndex(
        (queuedItem) => queuedItem.id === item.id,
    );
    return {
        item,
        originalIndex: Math.max(0, originalIndex),
        previousItemId:
            originalIndex > 0 ? (queue[originalIndex - 1]?.id ?? null) : null,
        nextItemId:
            originalIndex >= 0 ? (queue[originalIndex + 1]?.id ?? null) : null,
    };
}

function restoreDeferredQueuedMessages(
    queue: QueuedChatMessage[],
    deferredMessages: DeferredQueuedMessage[],
) {
    return deferredMessages.reduce(
        (nextQueue, deferredMessage) =>
            restoreQueuedMessagePosition(nextQueue, deferredMessage, {
                ...deferredMessage.item,
                status: "queued",
            }),
        queue,
    );
}

function mergeDeferredQueuedMessage(
    deferredMessages: DeferredQueuedMessage[],
    deferredMessage: DeferredQueuedMessage,
) {
    const nextDeferredMessages = deferredMessages.filter(
        (candidate) => candidate.item.id !== deferredMessage.item.id,
    );
    nextDeferredMessages.push({
        ...deferredMessage,
        item: {
            ...deferredMessage.item,
            status: "queued",
        },
    });
    return nextDeferredMessages;
}

async function replaceEmptySessionForAdditionalRoots(
    sessionId: string,
    queuedItem: QueuedChatMessage,
) {
    const state = useChatStore.getState();
    const session = state.sessionsById[sessionId];
    if (!session) {
        return sessionId;
    }

    const vaultPath = session.vaultPath ?? useVaultStore.getState().vaultPath;
    const additionalRoots = collectExternalAdditionalRoots(
        queuedItem.attachments,
        vaultPath ?? null,
    );
    if (
        additionalRoots.length === 0 ||
        !canRecreateSessionForAdditionalRoots(session, sessionId, state)
    ) {
        return sessionId;
    }

    const replacementSession = await aiCreateSession(
        session.runtimeId,
        vaultPath ?? null,
        additionalRoots,
    );

    const latestState = useChatStore.getState();
    const latestSession = latestState.sessionsById[sessionId];
    if (
        !latestSession ||
        !canRecreateSessionForAdditionalRoots(
            latestSession,
            sessionId,
            latestState,
        )
    ) {
        await aiDeleteRuntimeSession(replacementSession.sessionId).catch(
            () => {},
        );
        if (vaultPath) {
            await aiDeleteSessionHistory(
                vaultPath,
                replacementSession.historySessionId,
            ).catch(() => {});
        }
        return sessionId;
    }

    const migratedSession: AIChatSession = {
        ...replacementSession,
        attachments: latestSession.attachments.map(cloneAttachment),
        resumeContextPending: latestSession.resumeContextPending ?? false,
    };

    const migrated = migrateSessionLocalState(
        sessionId,
        migratedSession,
        (currentState) => {
            const currentSession = currentState.sessionsById[sessionId];
            return Boolean(
                currentSession &&
                canRecreateSessionForAdditionalRoots(
                    currentSession,
                    sessionId,
                    currentState,
                ),
            );
        },
    );
    if (!migrated) {
        await aiDeleteRuntimeSession(migratedSession.sessionId).catch(() => {});
        if (vaultPath) {
            await aiDeleteSessionHistory(
                vaultPath,
                migratedSession.historySessionId,
            ).catch(() => {});
        }
        return sessionId;
    }

    await persistSessionNow(migratedSession);
    await aiDeleteRuntimeSession(sessionId).catch(() => {});
    if (vaultPath) {
        await aiDeleteSessionHistory(
            vaultPath,
            latestSession.historySessionId,
        ).catch(() => {});
    }

    return migratedSession.sessionId;
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

function cleanupDeferredQueuedMessagesBySessionId(
    deferredQueuedMessagesBySessionId: Record<string, DeferredQueuedMessage>,
    sessionId: string,
    nextDeferredMessage?: DeferredQueuedMessage | null,
) {
    if (nextDeferredMessage) {
        return {
            ...deferredQueuedMessagesBySessionId,
            [sessionId]: nextDeferredMessage,
        };
    }

    if (!(sessionId in deferredQueuedMessagesBySessionId)) {
        return deferredQueuedMessagesBySessionId;
    }

    const nextDeferredQueuedMessagesBySessionId = {
        ...deferredQueuedMessagesBySessionId,
    };
    delete nextDeferredQueuedMessagesBySessionId[sessionId];
    return nextDeferredQueuedMessagesBySessionId;
}

function cleanupPausedQueueBySessionId(
    pausedQueueBySessionId: Record<string, PausedQueueState>,
    sessionId: string,
    nextPausedQueueState?: PausedQueueState | null,
) {
    if (nextPausedQueueState) {
        return {
            ...pausedQueueBySessionId,
            [sessionId]: nextPausedQueueState,
        };
    }

    if (!(sessionId in pausedQueueBySessionId)) {
        return pausedQueueBySessionId;
    }

    const nextPausedQueueBySessionId = { ...pausedQueueBySessionId };
    delete nextPausedQueueBySessionId[sessionId];
    return nextPausedQueueBySessionId;
}

function cleanupInterruptedTurnStateBySessionId(
    interruptedTurnStateBySessionId: Record<string, InterruptedTurnState>,
    sessionId: string,
    nextInterruptedTurnState?: InterruptedTurnState | null,
) {
    if (
        nextInterruptedTurnState &&
        (nextInterruptedTurnState.isStopping ||
            nextInterruptedTurnState.ignoreLateActivity ||
            nextInterruptedTurnState.pendingManualSend)
    ) {
        return {
            ...interruptedTurnStateBySessionId,
            [sessionId]: nextInterruptedTurnState,
        };
    }

    if (!(sessionId in interruptedTurnStateBySessionId)) {
        return interruptedTurnStateBySessionId;
    }

    const nextInterruptedTurnStateBySessionId = {
        ...interruptedTurnStateBySessionId,
    };
    delete nextInterruptedTurnStateBySessionId[sessionId];
    return nextInterruptedTurnStateBySessionId;
}

function restoreDeferredQueuedMessage(
    queue: QueuedChatMessage[],
    deferredMessage: DeferredQueuedMessage,
) {
    return restoreQueuedMessagePosition(queue, deferredMessage, {
        ...deferredMessage.item,
    });
}

// Idle sessions cannot legitimately keep queue entries marked as "sending".
// When that happens, the completion cleanup was missed, so heal the queue
// eagerly to avoid stale UI and blocked follow-up dispatches.
function reconcileIdleQueuedState(
    state: Pick<
        ChatStore,
        "queuedMessagesBySessionId" | "activeQueuedMessageBySessionId"
    >,
    sessionId: string,
) {
    const queue = state.queuedMessagesBySessionId[sessionId] ?? [];
    const activeQueuedMessage =
        state.activeQueuedMessageBySessionId[sessionId] ?? null;

    const sendingIds = new Set<string>();
    for (const item of queue) {
        if (item.status === "sending") {
            sendingIds.add(item.id);
        }
    }

    const activeQueuedMessageIsSending =
        activeQueuedMessage?.item.status === "sending" ||
        (activeQueuedMessage != null &&
            queue.some(
                (item) =>
                    item.id === activeQueuedMessage.item.id &&
                    item.status === "sending",
            ));

    if (activeQueuedMessageIsSending && activeQueuedMessage) {
        sendingIds.add(activeQueuedMessage.item.id);
    }

    if (sendingIds.size === 0 && !activeQueuedMessageIsSending) {
        return null;
    }

    return {
        queuedMessagesBySessionId: cleanupQueuedMessagesBySessionId(
            state.queuedMessagesBySessionId,
            sessionId,
            queue.filter((item) => !sendingIds.has(item.id)),
        ),
        activeQueuedMessageBySessionId: activeQueuedMessageIsSending
            ? cleanupDeferredQueuedMessagesBySessionId(
                  state.activeQueuedMessageBySessionId,
                  sessionId,
                  null,
              )
            : state.activeQueuedMessageBySessionId,
    };
}

function healIdleQueuedState(sessionId: string) {
    let healed = false;
    useChatStore.setState((state) => {
        const session = state.sessionsById[sessionId];
        if (!session || session.status !== "idle") {
            return state;
        }

        const reconciledQueueState = reconcileIdleQueuedState(state, sessionId);
        if (!reconciledQueueState) {
            return state;
        }

        healed = true;
        return reconciledQueueState;
    });
    return healed;
}

async function waitForPendingStop(sessionId: string) {
    const pendingStop = _pendingStopBySessionId.get(sessionId);
    if (!pendingStop) {
        return;
    }

    await pendingStop.catch(() => {});
}

async function stabilizeQueueSession(sessionId: string) {
    await waitForPendingStop(sessionId);
    healIdleQueuedState(sessionId);
}

function shouldIgnoreLateActivityForSession(
    state: Pick<ChatStore, "interruptedTurnStateBySessionId">,
    sessionId: string,
) {
    return (
        state.interruptedTurnStateBySessionId[sessionId]?.ignoreLateActivity ===
        true
    );
}

function markSessionStopping(sessionId: string) {
    useChatStore.setState((state) => {
        const current = state.interruptedTurnStateBySessionId[sessionId];
        return {
            interruptedTurnStateBySessionId:
                cleanupInterruptedTurnStateBySessionId(
                    state.interruptedTurnStateBySessionId,
                    sessionId,
                    {
                        isStopping: true,
                        ignoreLateActivity: true,
                        pendingManualSend: current?.pendingManualSend,
                    },
                ),
        };
    });
}

function finalizeSessionStopping(sessionId: string) {
    useChatStore.setState((state) => {
        const current = state.interruptedTurnStateBySessionId[sessionId];
        if (!current) {
            return state;
        }
        const currentState: InterruptedTurnState = current;

        return {
            interruptedTurnStateBySessionId:
                cleanupInterruptedTurnStateBySessionId(
                    state.interruptedTurnStateBySessionId,
                    sessionId,
                    {
                        isStopping: false,
                        ignoreLateActivity: true,
                        pendingManualSend: currentState.pendingManualSend,
                    },
                ),
        };
    });
}

function clearInterruptedTurnState(sessionId: string) {
    useChatStore.setState((state) => ({
        interruptedTurnStateBySessionId: cleanupInterruptedTurnStateBySessionId(
            state.interruptedTurnStateBySessionId,
            sessionId,
            null,
        ),
    }));
}

function queuePendingInterruptedSend(
    sessionId: string,
    pending: PendingInterruptedSend,
) {
    let queued = false;
    useChatStore.setState((state) => {
        const currentSession = state.sessionsById[sessionId];
        if (!currentSession) {
            return state;
        }

        const existing = state.interruptedTurnStateBySessionId[sessionId];
        if (existing?.pendingManualSend) {
            return state;
        }

        queued = true;

        return {
            sessionsById: {
                ...state.sessionsById,
                [sessionId]: pending.preserveComposerState
                    ? currentSession
                    : {
                          ...currentSession,
                          attachments: [],
                      },
            },
            composerPartsBySessionId: pending.preserveComposerState
                ? state.composerPartsBySessionId
                : {
                      ...state.composerPartsBySessionId,
                      [sessionId]: createEmptyComposerParts(),
                  },
            interruptedTurnStateBySessionId:
                cleanupInterruptedTurnStateBySessionId(
                    state.interruptedTurnStateBySessionId,
                    sessionId,
                    {
                        isStopping: true,
                        ignoreLateActivity: true,
                        pendingManualSend: pending,
                    },
                ),
            sessionOrder: touchSessionOrder(state.sessionOrder, sessionId),
        };
    });
    return queued;
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
    reason:
        | "applied-content-mismatch"
        | "origin-path-reused"
        | "disk-write-failed"
        | null;
    conflictingPath: string | null;
    appliedHash: string;
    pathHash: string | null;
    originHash: string | null;
}

const APPLIED_CONFLICT_SETTLE_DELAYS_MS = [80, 180] as const;

async function hasConflict(
    vaultPath: string,
    tracked: TrackedFile,
): Promise<RestoreConflictCheckResult> {
    const pathHash = await aiGetTextFileHash(vaultPath, tracked.path);
    const appliedHash: string = hashTextContent(tracked.currentText) ?? "";

    if (pathHash !== appliedHash) {
        // For deleted files, the expected on-disk state is "file doesn't exist"
        // (currentHash=null) and currentText="" (appliedHash=hash of "").
        // This is not a conflict — the file was deleted as expected.
        const isExpectedDeletion =
            tracked.status.kind === "deleted" && pathHash === null;
        if (!isExpectedDeletion) {
            return {
                conflict: true,
                currentHash: pathHash,
                reason: "applied-content-mismatch",
                conflictingPath: tracked.path,
                appliedHash,
                pathHash,
                originHash: null,
            };
        }
    }

    if (tracked.originPath !== tracked.path) {
        const originHash = await aiGetTextFileHash(
            vaultPath,
            tracked.originPath,
        );
        if (originHash !== null) {
            return {
                conflict: true,
                currentHash: originHash,
                reason: "origin-path-reused",
                conflictingPath: tracked.originPath,
                appliedHash,
                pathHash,
                originHash,
            };
        }
    }

    return {
        conflict: false,
        currentHash: pathHash,
        reason: null,
        conflictingPath: null,
        appliedHash,
        pathHash,
        originHash: null,
    };
}

function waitForTrackedConflictSettle(delayMs: number) {
    return new Promise<void>((resolve) => {
        setTimeout(resolve, delayMs);
    });
}

type ReviewHunkConflictSource = "resolve-review-hunks";

/**
 * Run the settle-aware conflict check and, on applied-content mismatch, try to
 * reconcile against the persisted file content. Returns the effective tracked
 * file (reconciled when available) plus the final conflict outcome. Callers
 * decide whether to proceed, abort, or surface the conflict to the review
 * panel — this helper intentionally performs no mutations beyond reconcile.
 */
async function detectAndReconcileReviewHunkConflict(
    sessionId: string,
    identityKey: string,
    tracked: TrackedFile,
    vaultPath: string,
    source: ReviewHunkConflictSource,
): Promise<{
    tracked: TrackedFile;
    check: RestoreConflictCheckResult;
}> {
    let activeTracked = tracked;
    let restoreCheck = await hasConflictAfterSettle(vaultPath, tracked, {
        sessionId,
        identityKey,
        source,
    });

    if (
        restoreCheck.conflict &&
        restoreCheck.reason === "applied-content-mismatch"
    ) {
        const reconciled = await reconcileTrackedFileWithPersistedContentIfSafe(
            sessionId,
            identityKey,
            tracked,
            source,
            {
                expectedHash: restoreCheck.currentHash,
            },
        );
        if (reconciled) {
            activeTracked = reconciled;
            restoreCheck = await hasConflictAfterSettle(vaultPath, reconciled, {
                sessionId,
                identityKey,
                source,
            });
        }
    }

    return { tracked: activeTracked, check: restoreCheck };
}

async function hasConflictAfterSettle(
    vaultPath: string,
    tracked: TrackedFile,
    context: {
        sessionId: string;
        identityKey: string;
        source:
            | "prepare-tracked-file-mutation"
            | "reject-all-edited-files"
            | "resolve-review-hunks";
    },
): Promise<RestoreConflictCheckResult> {
    let restoreCheck = await hasConflict(vaultPath, tracked);
    if (
        !restoreCheck.conflict ||
        restoreCheck.reason !== "applied-content-mismatch"
    ) {
        return restoreCheck;
    }

    const initialHash = restoreCheck.currentHash;

    for (const delayMs of APPLIED_CONFLICT_SETTLE_DELAYS_MS) {
        await waitForTrackedConflictSettle(delayMs);
        restoreCheck = await hasConflict(vaultPath, tracked);
        if (
            !restoreCheck.conflict ||
            restoreCheck.reason !== "applied-content-mismatch"
        ) {
            logDebug(
                "tracked-review",
                "applied-content mismatch settled before restore conflict",
                {
                    sessionId: context.sessionId,
                    identityKey: context.identityKey,
                    source: context.source,
                    trackedVersion: tracked.version,
                    initialHash,
                    settledHash: restoreCheck.currentHash,
                    appliedHash: restoreCheck.appliedHash,
                    delayMs,
                },
            );
            return restoreCheck;
        }
    }

    return restoreCheck;
}

function getTrackedResourceReloadMetadata(
    tracked: TrackedFile,
): ResourceReloadMetadata | null {
    const editorState = useEditorStore.getState();
    const noteTarget = resolveNoteTargetForPath(tracked.path);
    if (noteTarget) {
        return editorState._noteReloadMetadata[noteTarget.noteId] ?? null;
    }

    const fileTarget = resolveFileTargetForPath(tracked.path);
    if (fileTarget) {
        return editorState._fileReloadMetadata[fileTarget.relativePath] ?? null;
    }

    return null;
}

async function readTrackedFilePersistedText(
    tracked: TrackedFile,
): Promise<string | null | undefined> {
    const noteTarget = resolveNoteTargetForPath(tracked.path);
    if (noteTarget) {
        try {
            const detail = await vaultInvoke<{ content: string }>("read_note", {
                noteId: noteTarget.noteId,
            });
            return detail.content;
        } catch {
            return null;
        }
    }

    const fileTarget = resolveFileTargetForPath(tracked.path);
    if (fileTarget) {
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

function reconcileTrackedFileCurrentTextInSession(
    sessionId: string,
    identityKey: string,
    nextCurrentText: string,
): TrackedFile | null {
    let updatedTracked: TrackedFile | null = null;
    let updatedSession: AIChatSession | null = null;

    useChatStore.setState((state) => {
        const session = state.sessionsById[sessionId];
        if (!session?.actionLog) {
            return state;
        }

        const tracked = findTrackedFileInAccumulatedSession(
            session,
            identityKey,
        );
        if (!isTextTrackedFile(tracked)) {
            return state;
        }

        const nextTracked = replaceTrackedFileCurrentText(
            tracked,
            nextCurrentText,
            Date.now(),
        );
        updatedTracked = nextTracked;
        if (
            nextTracked === tracked &&
            nextTracked.currentText === tracked.currentText &&
            nextTracked.conflictHash === tracked.conflictHash
        ) {
            return state;
        }

        const files = {
            ...getAccumulatedTrackedFiles(session),
            [identityKey]: nextTracked,
        };
        updatedTracked = nextTracked;
        updatedSession = replaceTrackedFilesInActionLog(session, files);

        return {
            sessionsById: {
                ...state.sessionsById,
                [sessionId]: updatedSession,
            },
        };
    });

    if (updatedSession) {
        void persistSession(updatedSession);
    }

    return updatedTracked;
}

async function reconcileTrackedFileWithPersistedContentIfSafe(
    sessionId: string,
    identityKey: string,
    tracked: TrackedFile,
    source:
        | "tool-activity"
        | "prepare-tracked-file-mutation"
        | "reject-all-edited-files"
        | "resolve-review-hunks",
    options?: {
        expectedHash?: string | null;
    },
): Promise<TrackedFile | null> {
    const reloadMetadata = getTrackedResourceReloadMetadata(tracked);
    if (reloadMetadata?.origin !== "agent") {
        return null;
    }

    const persistedText = await readTrackedFilePersistedText(tracked);
    if (typeof persistedText !== "string") {
        return null;
    }

    const persistedHash = hashTextContent(persistedText);
    if (
        options?.expectedHash != null &&
        persistedHash !== options.expectedHash
    ) {
        return null;
    }
    if (
        reloadMetadata.contentHash != null &&
        persistedHash !== reloadMetadata.contentHash
    ) {
        return null;
    }
    if (persistedText === tracked.currentText && tracked.conflictHash == null) {
        return tracked;
    }

    const reconciled = reconcileTrackedFileCurrentTextInSession(
        sessionId,
        identityKey,
        persistedText,
    );
    if (!reconciled) {
        return null;
    }

    logDebug(
        "tracked-review",
        "reconciled tracked file to persisted agent content",
        {
            sessionId,
            identityKey,
            source,
            trackedVersion: tracked.version,
            reconciledVersion: reconciled.version,
            previousTrackedHash: hashTextContent(tracked.currentText),
            persistedHash,
            reloadContentHash: reloadMetadata.contentHash,
        },
    );

    return reconciled;
}

function scheduleTrackedPersistedContentReconciliation(
    sessionId: string,
    identityKey: string,
    trackedVersion: number,
) {
    const key = `${sessionId}:${identityKey}`;
    const existing = _pendingTrackedPersistedReconcileByKey.get(key);
    if (existing) {
        clearTimeout(existing);
    }

    const timeoutId = setTimeout(() => {
        _pendingTrackedPersistedReconcileByKey.delete(key);

        const session = useChatStore.getState().sessionsById[sessionId];
        if (!session) {
            return;
        }

        const tracked = findTrackedFileInAccumulatedSession(
            session,
            identityKey,
        );
        if (!isTextTrackedFile(tracked) || tracked.version !== trackedVersion) {
            return;
        }

        void reconcileTrackedFileWithPersistedContentIfSafe(
            sessionId,
            identityKey,
            tracked,
            "tool-activity",
        );
    }, TRACKED_PERSISTED_RECONCILE_DELAY_MS);

    _pendingTrackedPersistedReconcileByKey.set(key, timeoutId);
}

function getVaultChangeTrackedPathCandidates(
    change: VaultNoteChange,
): string[] {
    const candidates: string[] = [];
    const pushCandidate = (value: string | null | undefined) => {
        if (typeof value !== "string" || value.length === 0) {
            return;
        }
        if (!candidates.includes(value)) {
            candidates.push(value);
        }
    };

    pushCandidate(change.note?.path ?? null);
    pushCandidate(change.note_id);
    if (typeof change.note_id === "string" && !change.note_id.endsWith(".md")) {
        pushCandidate(`${change.note_id}.md`);
    }
    pushCandidate(change.relative_path);

    return candidates;
}

function trackedFileMatchesPersistedPathCandidate(
    file: TrackedFile,
    candidatePath: string,
    vaultPath: string | null,
) {
    return (
        pathsMatchVaultScoped(file.path, candidatePath, vaultPath, {
            includeLegacyLeadingSlashRelative: true,
        }) ||
        pathsMatchVaultScoped(file.identityKey, candidatePath, vaultPath, {
            includeLegacyLeadingSlashRelative: true,
        })
    );
}

async function readVaultChangePersistedContent(
    change: VaultNoteChange,
): Promise<string | null> {
    if (change.kind !== "upsert") {
        return null;
    }

    if (change.note_id) {
        try {
            const detail = await vaultInvoke<{ content: string }>("read_note", {
                noteId: change.note_id,
            });
            return detail.content;
        } catch {
            return null;
        }
    }

    if (change.entry?.kind === "file" && change.relative_path) {
        try {
            const detail = await vaultInvoke<{ content: string }>(
                "read_vault_file",
                {
                    relativePath: change.relative_path,
                },
            );
            return detail.content;
        } catch {
            return null;
        }
    }

    return null;
}

function logTrackedFileConflict(
    sessionId: string,
    identityKey: string,
    tracked: TrackedFile,
    restoreCheck: RestoreConflictCheckResult,
    source:
        | "prepare-tracked-file-mutation"
        | "reject-all-edited-files"
        | "resolve-review-hunks",
    extra?: {
        scope?: TrackedFileMutationScope;
    },
) {
    if (!restoreCheck.conflict || !restoreCheck.reason) {
        return;
    }

    logWarn(
        "tracked-review",
        "tracked file entered conflict state",
        {
            sessionId,
            identityKey,
            source,
            scope: extra?.scope ?? null,
            reason: restoreCheck.reason,
            conflictingPath: restoreCheck.conflictingPath,
            conflictHash: restoreCheck.currentHash,
            appliedHash: restoreCheck.appliedHash,
            pathHash: restoreCheck.pathHash,
            originHash: restoreCheck.originHash,
            tracked: summarizeTrackedFileForDebug(tracked),
        },
        {
            onceKey: [
                sessionId,
                identityKey,
                tracked.version,
                source,
                restoreCheck.reason,
                restoreCheck.currentHash ?? "null",
            ].join(":"),
        },
    );
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

function markTrackedFileConflict(
    sessionId: string,
    identityKey: string,
    currentHash: string | null,
) {
    useChatStore.setState((state) => {
        const currentSession = state.sessionsById[sessionId];
        if (!currentSession) return state;

        return {
            sessionsById: {
                ...state.sessionsById,
                [sessionId]: markTrackedConflict(
                    currentSession,
                    identityKey,
                    currentHash,
                ),
            },
        };
    });
}

function markTrackedFileConflictAndPersist(
    sessionId: string,
    identityKey: string,
    currentHash: string | null,
) {
    markTrackedFileConflict(sessionId, identityKey, currentHash);
    const updatedSession = useChatStore.getState().sessionsById[sessionId];
    if (updatedSession) {
        void persistSession(updatedSession);
    }
}

function isTextTrackedFile(
    tracked: TrackedFile | null | undefined,
): tracked is TrackedFile & { isText: true } {
    return tracked?.isText === true;
}

type ReadyTrackedFileMutation = {
    session: AIChatSession;
    tracked: TrackedFile & { isText: true };
    vaultPath: string;
};

type PreparedTrackedFileMutation =
    | { kind: "abort" }
    | { kind: "conflict" }
    | { kind: "ready"; ctx: ReadyTrackedFileMutation };

type TrackedFileMutationScope = "text" | "rejectable-text";

async function prepareTrackedFileMutation(
    sessionId: string,
    identityKey: string,
    scope: TrackedFileMutationScope,
): Promise<PreparedTrackedFileMutation> {
    const session = useChatStore.getState().sessionsById[sessionId];
    if (!session) {
        return { kind: "abort" };
    }
    const vaultPath = getSessionVaultPath(session);
    if (!vaultPath) {
        return { kind: "abort" };
    }

    const tracked = findTrackedFileInAccumulatedSession(session, identityKey);
    if (!isTextTrackedFile(tracked)) {
        return { kind: "abort" };
    }

    if (
        scope === "rejectable-text" &&
        getTrackedFileReviewState(tracked) === "pending"
    ) {
        return { kind: "abort" };
    }

    let resolvedTracked: TrackedFile & { isText: true } = tracked;
    let restoreCheck = await hasConflictAfterSettle(vaultPath, tracked, {
        sessionId,
        identityKey,
        source: "prepare-tracked-file-mutation",
    });
    if (
        restoreCheck.conflict &&
        restoreCheck.reason === "applied-content-mismatch"
    ) {
        const reconciled = await reconcileTrackedFileWithPersistedContentIfSafe(
            sessionId,
            identityKey,
            tracked,
            "prepare-tracked-file-mutation",
            {
                expectedHash: restoreCheck.currentHash,
            },
        );
        if (isTextTrackedFile(reconciled)) {
            resolvedTracked = reconciled;
            restoreCheck = await hasConflictAfterSettle(vaultPath, reconciled, {
                sessionId,
                identityKey,
                source: "prepare-tracked-file-mutation",
            });
        }
    }
    if (restoreCheck.conflict) {
        logTrackedFileConflict(
            sessionId,
            identityKey,
            tracked,
            restoreCheck,
            "prepare-tracked-file-mutation",
            {
                scope,
            },
        );
        markTrackedFileConflictAndPersist(
            sessionId,
            identityKey,
            restoreCheck.currentHash,
        );
        return { kind: "conflict" };
    }

    return {
        kind: "ready",
        ctx: {
            session,
            tracked: resolvedTracked,
            vaultPath,
        },
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

function replaceTextExactlyOnce(
    source: string,
    oldText: string,
    newText: string,
) {
    if (oldText.length === 0) {
        return null;
    }

    const firstIndex = source.indexOf(oldText);
    if (firstIndex === -1) {
        return null;
    }

    if (source.indexOf(oldText, firstIndex + oldText.length) !== -1) {
        return null;
    }

    return (
        source.slice(0, firstIndex) +
        newText +
        source.slice(firstIndex + oldText.length)
    );
}

function findTrackedFileForIncomingDiff(
    files: Record<string, TrackedFile>,
    diff: AIFileDiff,
    vaultPath: string | null,
) {
    return (
        Object.values(files).find((file) =>
            matchesTrackedFileForDebug(file, diff, vaultPath),
        ) ?? null
    );
}

function getDiffNormalizationCandidates(
    diff: AIFileDiff,
    currentFiles: Record<string, TrackedFile>,
    vaultPath: string | null,
) {
    const candidates: string[] = [];
    const pushCandidate = (value: string | null | undefined) => {
        if (typeof value !== "string") {
            return;
        }
        if (!candidates.includes(value)) {
            candidates.push(value);
        }
    };

    const tracked = findTrackedFileForIncomingDiff(
        currentFiles,
        diff,
        vaultPath,
    );
    pushCandidate(tracked?.currentText);
    pushCandidate(tracked?.diffBase);

    const targetPaths =
        diff.previous_path && diff.previous_path !== diff.path
            ? [diff.path, diff.previous_path]
            : [diff.path];
    for (const path of targetPaths) {
        const target = resolveEditorTargetForTrackedPath(path);
        pushCandidate(target?.openTab?.content);

        if (
            target?.kind === "file" &&
            target.openTab &&
            typeof target.openTab.content === "string"
        ) {
            pushCandidate(
                getExternalReloadBaselineCandidate(
                    target.relativePath,
                    target.openTab.content,
                ),
            );
        }
    }

    return candidates;
}

function normalizeIncomingTrackedDiff(
    diff: AIFileDiff,
    currentFiles: Record<string, TrackedFile>,
    vaultPath: string | null,
) {
    const canonicalDiff = {
        ...diff,
        path: canonicalizeVaultScopedPath(diff.path, vaultPath),
        previous_path:
            typeof diff.previous_path === "string"
                ? canonicalizeVaultScopedPath(diff.previous_path, vaultPath)
                : (diff.previous_path ?? null),
    } satisfies AIFileDiff;

    if (
        canonicalDiff.kind === "add" ||
        canonicalDiff.kind === "move" ||
        typeof canonicalDiff.old_text !== "string"
    ) {
        return canonicalDiff;
    }

    const nextFragment =
        canonicalDiff.kind === "delete" ? "" : (canonicalDiff.new_text ?? "");
    for (const candidate of getDiffNormalizationCandidates(
        canonicalDiff,
        currentFiles,
        vaultPath,
    )) {
        if (
            candidate === canonicalDiff.old_text ||
            candidate === nextFragment
        ) {
            continue;
        }

        const reconstructed = replaceTextExactlyOnce(
            candidate,
            canonicalDiff.old_text,
            nextFragment,
        );
        if (reconstructed === null || reconstructed === nextFragment) {
            continue;
        }

        return {
            ...canonicalDiff,
            old_text: candidate,
            kind:
                canonicalDiff.kind === "delete" && reconstructed.length > 0
                    ? "update"
                    : canonicalDiff.kind,
            new_text:
                canonicalDiff.kind === "delete" && reconstructed.length > 0
                    ? reconstructed
                    : canonicalDiff.kind === "delete"
                      ? ""
                      : reconstructed,
            reversible: true,
        };
    }

    return canonicalDiff;
}

function normalizeIncomingTrackedDiffs(
    currentFiles: Record<string, TrackedFile>,
    diffs: AIFileDiff[],
    vaultPath: string | null,
) {
    return diffs.map((diff) =>
        normalizeIncomingTrackedDiff(diff, currentFiles, vaultPath),
    );
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

function matchesTrackedFileForDebug(
    file: TrackedFile,
    diff: AIFileDiff,
    vaultPath: string | null,
) {
    return (
        pathsMatchVaultScoped(file.identityKey, diff.path, vaultPath, {
            includeLegacyLeadingSlashRelative: true,
        }) ||
        pathsMatchVaultScoped(file.path, diff.path, vaultPath, {
            includeLegacyLeadingSlashRelative: true,
        }) ||
        pathsMatchVaultScoped(file.originPath, diff.path, vaultPath, {
            includeLegacyLeadingSlashRelative: true,
        }) ||
        (file.previousPath != null &&
            pathsMatchVaultScoped(file.previousPath, diff.path, vaultPath, {
                includeLegacyLeadingSlashRelative: true,
            })) ||
        (diff.previous_path != null &&
            (pathsMatchVaultScoped(
                file.identityKey,
                diff.previous_path,
                vaultPath,
                {
                    includeLegacyLeadingSlashRelative: true,
                },
            ) ||
                pathsMatchVaultScoped(
                    file.path,
                    diff.previous_path,
                    vaultPath,
                    {
                        includeLegacyLeadingSlashRelative: true,
                    },
                ) ||
                pathsMatchVaultScoped(
                    file.originPath,
                    diff.previous_path,
                    vaultPath,
                    {
                        includeLegacyLeadingSlashRelative: true,
                    },
                ) ||
                (file.previousPath != null &&
                    pathsMatchVaultScoped(
                        file.previousPath,
                        diff.previous_path,
                        vaultPath,
                        {
                            includeLegacyLeadingSlashRelative: true,
                        },
                    ))))
    );
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
    const vaultPath = session.vaultPath ?? useVaultStore.getState().vaultPath;
    const normalizedDiffs = normalizeIncomingTrackedDiffs(
        currentFiles,
        diffs,
        vaultPath,
    );
    const nextFiles = consolidateTrackedFiles(
        currentFiles,
        normalizedDiffs,
        timestamp,
        {
            vaultPath,
        },
    );
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

function closeReviewIfSessionHasNoPendingEdits(
    sessionId: string,
    session: AIChatSession | null | undefined,
) {
    if (!session?.actionLog) {
        return;
    }

    if (Object.keys(getTrackedFilesForSession(session.actionLog)).length > 0) {
        return;
    }

    useEditorStore.getState().closeReview(sessionId);
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

async function rejectTrackedFileAndReload(
    vaultPath: string,
    tracked: TrackedFile,
): Promise<RestoreAction> {
    const liveText = await readTrackedFileLiveText(tracked);
    const { action: restoreAction, change } = await executeRestoreAction(
        vaultPath,
        tracked,
        liveText,
    );
    reloadEditorAfterRestore(tracked, restoreAction, change);
    return restoreAction;
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

function canRestoreRejectUndoSnapshot(
    snapshot: TrackedFile,
    currentHash: string | null,
) {
    if (
        snapshot.status.kind === "created" &&
        snapshot.status.existingFileContent === null
    ) {
        return currentHash === null;
    }

    const expectedContent =
        snapshot.status.kind === "created"
            ? (snapshot.status.existingFileContent ?? snapshot.diffBase)
            : snapshot.diffBase;
    return currentHash === hashTextContent(expectedContent);
}

async function restoreRejectUndoSnapshotAndReload(
    vaultPath: string,
    snapshot: TrackedFile,
) {
    const change = await aiRestoreTextFile({
        vaultPath,
        path: snapshot.path,
        previousPath:
            snapshot.status.kind === "created" &&
            snapshot.status.existingFileContent === null
                ? undefined
                : snapshot.originPath !== snapshot.path
                  ? snapshot.originPath
                  : null,
        content: snapshot.currentText,
    });
    reloadOpenEditorContent(snapshot.path, snapshot.currentText, change);
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
        const vaultPath =
            session.vaultPath ?? useVaultStore.getState().vaultPath;

        const files = {
            ...getAccumulatedTrackedFiles(session),
        };
        let trackedKey = fileId;
        let tracked = files[fileId] ?? null;

        if (!tracked) {
            for (const [key, file] of Object.entries(files)) {
                if (
                    pathsMatchVaultScoped(file.path, fileId, vaultPath, {
                        includeLegacyLeadingSlashRelative: true,
                    }) ||
                    pathsMatchVaultScoped(file.identityKey, fileId, vaultPath, {
                        includeLegacyLeadingSlashRelative: true,
                    })
                ) {
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

        logDebug("tracked-review", "apply user edit to tracked file", {
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

function getPersistedHistoryMessageCount(
    history: PersistedSessionHistory | PersistedSessionHistorySummary,
) {
    return (
        history.message_count ??
        ("messages" in history ? history.messages.length : 0)
    );
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
    history: PersistedSessionHistorySummary,
) {
    const persistedCatalog = getPersistedHistoryCatalogSnapshot(history);
    if (hasRuntimeCatalog(persistedCatalog)) {
        saveRuntimeCatalogCache(session.runtimeId, persistedCatalog);
    }

    return hydrateSessionCatalogFromSnapshot(
        {
            ...session,
            parentSessionId:
                history.parent_session_id ?? session.parentSessionId ?? null,
            persistedCreatedAt: history.created_at,
            persistedUpdatedAt: history.updated_at,
            persistedTitle: history.title ?? null,
            customTitle: history.custom_title ?? null,
            persistedPreview: history.preview ?? null,
            persistedMessageCount: getPersistedHistoryMessageCount(history),
            loadedPersistedMessageStart:
                getPersistedHistoryMessageCount(history) === 0
                    ? 0
                    : (session.loadedPersistedMessageStart ?? null),
        },
        persistedCatalog,
    );
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
        parent_session_id: session.parentSessionId ?? undefined,
        runtime_id: session.runtimeId,
        model_id: session.modelId,
        mode_id: session.modeId,
        created_at: session.persistedCreatedAt ?? 0,
        updated_at: session.persistedUpdatedAt ?? 0,
        start_index: page.start_index,
        message_count: page.total_messages,
        title: session.persistedTitle ?? undefined,
        custom_title: session.customTitle ?? undefined,
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
    const persistedCatalog = getPersistedHistoryCatalogSnapshot(history);
    const catalogSource = hasRuntimeCatalog(persistedCatalog)
        ? persistedCatalog
        : {
              models: runtime.models,
              modes: runtime.modes,
              configOptions: runtime.configOptions,
          };

    if (hasRuntimeCatalog(persistedCatalog)) {
        saveRuntimeCatalogCache(runtimeId, persistedCatalog);
    }

    const baseSession = hydrateSessionCatalogFromRuntime(
        {
            sessionId: `persisted:${history.session_id}`,
            historySessionId: history.session_id,
            parentSessionId: history.parent_session_id ?? null,
            runtimeSessionId: null,
            vaultPath,
            runtimeId,
            modelId: history.model_id,
            modeId: history.mode_id,
            status: "idle",
            activeWorkCycleId: null,
            visibleWorkCycleId: null,
            isResumingSession: false,
            effortsByModel: {},
            models: catalogSource.models,
            modes: catalogSource.modes,
            configOptions: catalogSource.configOptions.map((option) =>
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
            customTitle: history.custom_title ?? null,
            persistedPreview: history.preview ?? null,
            persistedMessageCount,
            loadedPersistedMessageStart:
                persistedMessageCount === 0
                    ? 0
                    : history.messages.length > 0
                      ? Math.max(
                            0,
                            persistedMessageCount - history.messages.length,
                        )
                      : null,
            isLoadingPersistedMessages: false,
        },
        runtime,
    );

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

function getSessionVaultPath(session: AIChatSession | null | undefined) {
    return session?.vaultPath ?? useVaultStore.getState().vaultPath;
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

function normalizeSessionRef(value: string | null | undefined) {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
}

function sessionMatchesRef(session: AIChatSession, ref: string) {
    return (
        session.sessionId === ref ||
        session.historySessionId === ref ||
        session.runtimeSessionId === ref
    );
}

function findParentSessionForIncomingChild(
    sessionsById: Record<string, AIChatSession>,
    session: AIChatSession,
) {
    const parentRef = normalizeSessionRef(session.parentSessionId);
    if (!parentRef || parentRef === session.sessionId) {
        return null;
    }

    return (
        Object.values(sessionsById).find((candidate) =>
            sessionMatchesRef(candidate, parentRef),
        ) ?? null
    );
}

function insertSessionAfterParent(
    sessionOrder: string[],
    sessionId: string,
    parentSessionId: string | null,
) {
    if (!parentSessionId) {
        return [...sessionOrder, sessionId];
    }

    const parentIndex = sessionOrder.indexOf(parentSessionId);
    if (parentIndex < 0) {
        return [...sessionOrder, sessionId];
    }

    return [
        ...sessionOrder.slice(0, parentIndex + 1),
        sessionId,
        ...sessionOrder.slice(parentIndex + 1),
    ];
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

    if (next.path) {
        const duplicate = attachments.some(
            (attachment) =>
                attachment.type === next.type && attachment.path === next.path,
        );
        if (duplicate) return attachments;
    }

    return [...attachments, next];
}

function mergeSession(
    existing: AIChatSession | undefined,
    incoming: AIChatSession,
): AIChatSession {
    const canAcceptBackendStreaming =
        incoming.status === "streaming" &&
        incoming.parentSessionId != null &&
        (incoming.runtimeState ?? existing?.runtimeState ?? "live") === "live";

    if (!existing) {
        return synchronizeSessionConfigSelections(
            replaceSessionTranscript(
                {
                    ...incoming,
                    historySessionId:
                        incoming.historySessionId ?? incoming.sessionId,
                    vaultPath: incoming.vaultPath ?? null,
                    isPersistedSession: incoming.isPersistedSession ?? false,
                    resumeContextPending:
                        incoming.resumeContextPending ?? false,
                    activeWorkCycleId: incoming.activeWorkCycleId ?? null,
                    visibleWorkCycleId: incoming.visibleWorkCycleId ?? null,
                    // The backend never resets session status to "idle" after streaming,
                    // so cap stale "streaming" for freshly loaded sessions.
                    status:
                        incoming.status === "streaming" &&
                        !canAcceptBackendStreaming
                            ? "idle"
                            : incoming.status,
                    messages: [],
                    attachments: incoming.attachments ?? [],
                    persistedCreatedAt: incoming.persistedCreatedAt ?? null,
                    persistedUpdatedAt: incoming.persistedUpdatedAt ?? null,
                    persistedTitle: incoming.persistedTitle ?? null,
                    customTitle: incoming.customTitle ?? null,
                    persistedPreview: incoming.persistedPreview ?? null,
                    parentSessionId: incoming.parentSessionId ?? null,
                    persistedMessageCount:
                        incoming.persistedMessageCount ??
                        incoming.messages.length,
                    loadedPersistedMessageStart:
                        incoming.loadedPersistedMessageStart ??
                        (incoming.messages.length > 0 ? 0 : null),
                    isLoadingPersistedMessages:
                        incoming.isLoadingPersistedMessages ?? false,
                    isPendingSessionCreation:
                        incoming.isPendingSessionCreation ?? false,
                    pendingSessionError:
                        incoming.pendingSessionError ?? null,
                    runtimeState:
                        incoming.runtimeState ??
                        (incoming.isPersistedSession
                            ? "persisted_only"
                            : "live"),
                },
                incoming.messages ?? [],
            ),
        );
    }

    const normalizedExisting = normalizeSessionTranscript(existing);
    const incomingMessages = incoming.messages ?? [];

    // Never let root upserts set status to "streaming".
    // The backend session status stays "streaming" forever after a prompt starts
    // (it's never reset to "idle"). So "streaming" from the backend is always stale.
    // All legitimate "streaming" transitions happen through direct event handlers:
    // sendMessage (optimistic), respondPermission (optimistic),
    // applyMessageStarted, applyThinkingStarted. Child sessions are different:
    // Codex ACP projects turn_started as a backend session update, and that is
    // the only reliable signal when the parent reactivates a background agent.
    const status =
        incoming.status === "streaming" && !canAcceptBackendStreaming
            ? existing.status
            : incoming.status;

    const merged = {
        ...normalizedExisting,
        ...incoming,
        models:
            incoming.models.length > 0
                ? incoming.models
                : normalizedExisting.models,
        modes:
            incoming.modes.length > 0
                ? incoming.modes
                : normalizedExisting.modes,
        configOptions:
            incoming.configOptions.length > 0
                ? incoming.configOptions
                : normalizedExisting.configOptions,
        historySessionId:
            normalizedExisting.historySessionId ?? incoming.historySessionId,
        parentSessionId:
            incoming.parentSessionId ??
            normalizedExisting.parentSessionId ??
            null,
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
        customTitle:
            incoming.customTitle ?? normalizedExisting.customTitle ?? null,
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
        isPendingSessionCreation:
            incoming.isPendingSessionCreation ??
            normalizedExisting.isPendingSessionCreation ??
            false,
        pendingSessionError:
            incoming.pendingSessionError ??
            normalizedExisting.pendingSessionError ??
            null,
        runtimeState:
            incoming.runtimeState ?? normalizedExisting.runtimeState ?? "live",
        status,
        attachments: normalizedExisting.attachments,
    };

    return synchronizeSessionConfigSelections(
        replaceSessionTranscript(
            merged,
            normalizedExisting.messageOrder?.length
                ? normalizedExisting.messages
                : incomingMessages,
        ),
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
    const runtimeCatalog = getRuntimeCatalogSnapshot(session);
    const hasCatalog = hasRuntimeCatalog(runtimeCatalog);
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
            tool_action: m.toolAction,
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
        parent_session_id: session.parentSessionId ?? undefined,
        runtime_id: session.runtimeId,
        model_id: session.modelId,
        mode_id: session.modeId,
        models: hasCatalog
            ? session.models.map((model) => ({
                  id: model.id,
                  runtime_id: model.runtimeId,
                  name: model.name,
                  description: model.description,
              }))
            : undefined,
        modes: hasCatalog
            ? session.modes.map((mode) => ({
                  id: mode.id,
                  runtime_id: mode.runtimeId,
                  name: mode.name,
                  description: mode.description,
                  disabled: mode.disabled ?? false,
              }))
            : undefined,
        config_options: hasCatalog
            ? session.configOptions.map((option) => ({
                  id: option.id,
                  runtime_id: option.runtimeId,
                  category: option.category,
                  label: option.label,
                  description: option.description ?? null,
                  type: option.type,
                  value: option.value,
                  options: option.options.map((item) => ({
                      value: item.value,
                      label: item.label,
                      description: item.description ?? null,
                  })),
              }))
            : undefined,
        created_at: createdAt,
        updated_at: updatedAt,
        start_index: startIndex,
        message_count: messageCount,
        title: getSessionTitle(session),
        custom_title: session.customTitle ?? undefined,
        preview: getSessionPreview(session),
        messages,
    };
}

function hasPersistableSessionContent(session: AIChatSession) {
    const history = toPersistedHistory(session);
    return history.messages.length > 0 || history.parent_session_id != null;
}

const _queueDrainLocks = new Set<string>();
const _pendingStopBySessionId = new Map<string, Promise<void>>();
const _pendingSessionPersistence = new Map<string, AIChatSession>();
let _sessionPersistenceFlushScheduled = false;
let _sessionPersistenceEpoch = 0;

function getSessionPersistenceKey(session: AIChatSession) {
    return session.historySessionId || session.sessionId;
}

async function persistSessionNow(session: AIChatSession) {
    const vaultPath = getSessionVaultPath(session);
    if (!vaultPath) return;
    if (!hasPersistableSessionContent(session)) return;

    const historyRetentionDays = useChatStore.getState().historyRetentionDays;
    try {
        const history = toPersistedHistory(session);
        await aiSaveSessionHistory(vaultPath, history);
        upsertPersistedHistoryCache(vaultPath, history);
        if (historyRetentionDays > 0) {
            await aiPruneSessionHistories(vaultPath, historyRetentionDays);
        }
    } catch (error) {
        logWarn("chat-store", "Failed to persist session history", error);
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

function scheduleStaleStreamingCheck(_sessionId: string) {}

function clearStaleStreamingCheck(_sessionId: string) {}

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

function imageGenerationKeepsSessionStreaming(status: string) {
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
    flushTimeoutId: number | null;
}

const _deltaBuffer: DeltaBuffer = {
    messageDelta: new Map(),
    thinkingDelta: new Map(),
    flushTimeoutId: null,
};

function flushDeltas() {
    _deltaBuffer.flushTimeoutId = null;
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
    if (_deltaBuffer.flushTimeoutId === null) {
        _deltaBuffer.flushTimeoutId = window.setTimeout(flushDeltas, 0);
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
    if (_deltaBuffer.flushTimeoutId !== null) {
        window.clearTimeout(_deltaBuffer.flushTimeoutId);
        _deltaBuffer.flushTimeoutId = null;
    }
    flushDeltas();
}

function clearBufferedDeltasForSession(sessionId: string) {
    _deltaBuffer.messageDelta.delete(sessionId);
    _deltaBuffer.thinkingDelta.delete(sessionId);

    if (
        _deltaBuffer.flushTimeoutId !== null &&
        _deltaBuffer.messageDelta.size === 0 &&
        _deltaBuffer.thinkingDelta.size === 0
    ) {
        window.clearTimeout(_deltaBuffer.flushTimeoutId);
        _deltaBuffer.flushTimeoutId = null;
    }
}

async function persistSession(session: AIChatSession) {
    scheduleSessionPersistence(session);
}

function persistCurrentSession(sessionId: string) {
    const session = useChatStore.getState().sessionsById[sessionId];
    if (session) {
        void persistSession(session);
    }
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
        toolAction: m.tool_action,
    }));
}

export const useChatStore = create<ChatStore>((set, get) => {
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
            if (
                session.loadedPersistedMessageStart === 0 &&
                !session.isLoadingPersistedMessages
            ) {
                return true;
            }

            set((state) => {
                const current = state.sessionsById[sessionId];
                if (!current) {
                    return state;
                }
                const currentSession: AIChatSession = current;

                if (
                    currentSession.loadedPersistedMessageStart === 0 &&
                    !currentSession.isLoadingPersistedMessages
                ) {
                    return state;
                }

                return {
                    sessionsById: updateSessionById(
                        state,
                        sessionId,
                        (nextSession) => {
                            if (
                                nextSession.loadedPersistedMessageStart === 0 &&
                                !nextSession.isLoadingPersistedMessages
                            ) {
                                return nextSession;
                            }

                            return {
                                ...nextSession,
                                loadedPersistedMessageStart: 0,
                                isLoadingPersistedMessages: false,
                            };
                        },
                    ),
                };
            });
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
                        (currentSession.messages.length > 0 &&
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
            logWarn(
                "chat-store",
                "Failed to load persisted session transcript page",
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

    function setActiveQueuedMessage(
        sessionId: string,
        deferredMessage: DeferredQueuedMessage | null,
    ) {
        set((state) => {
            const nextActiveQueuedMessageBySessionId =
                cleanupDeferredQueuedMessagesBySessionId(
                    state.activeQueuedMessageBySessionId,
                    sessionId,
                    deferredMessage,
                );
            return nextActiveQueuedMessageBySessionId ===
                state.activeQueuedMessageBySessionId
                ? state
                : {
                      activeQueuedMessageBySessionId:
                          nextActiveQueuedMessageBySessionId,
                  };
        });
    }

    function updateActiveQueuedMessage(
        sessionId: string,
        updater: (
            deferredMessage: DeferredQueuedMessage,
        ) => DeferredQueuedMessage,
    ) {
        set((state) => {
            const deferredMessage =
                state.activeQueuedMessageBySessionId[sessionId];
            if (!deferredMessage) {
                return state;
            }

            return {
                activeQueuedMessageBySessionId: {
                    ...state.activeQueuedMessageBySessionId,
                    [sessionId]: updater(deferredMessage),
                },
            };
        });
    }

    function activateQueuedMessage(
        sessionId: string,
        messageId: string,
    ): DeferredQueuedMessage | null {
        let nextDeferredMessage: DeferredQueuedMessage | null = null;

        set((state) => {
            const queue = state.queuedMessagesBySessionId[sessionId] ?? [];
            const queuedStateItem = queue.find((item) => item.id === messageId);
            if (!queuedStateItem) {
                return state;
            }

            nextDeferredMessage = {
                ...createDeferredQueuedMessage(queue, queuedStateItem),
                item: {
                    ...queuedStateItem,
                    status: "sending",
                },
            };

            return {
                queuedMessagesBySessionId: cleanupQueuedMessagesBySessionId(
                    state.queuedMessagesBySessionId,
                    sessionId,
                    queue.filter((item) => item.id !== messageId),
                ),
                activeQueuedMessageBySessionId: {
                    ...state.activeQueuedMessageBySessionId,
                    [sessionId]: nextDeferredMessage,
                },
            };
        });

        return nextDeferredMessage;
    }

    function takeQueuedMessage(
        sessionId: string,
        messageId: string,
    ): QueuedChatMessage | null {
        let nextQueuedItem: QueuedChatMessage | null = null;

        set((state) => {
            const queue = state.queuedMessagesBySessionId[sessionId] ?? [];
            const queuedStateItem = queue.find((item) => item.id === messageId);
            if (!queuedStateItem) {
                return state;
            }

            nextQueuedItem = {
                ...queuedStateItem,
                status: "queued",
            };

            return {
                queuedMessagesBySessionId: cleanupQueuedMessagesBySessionId(
                    state.queuedMessagesBySessionId,
                    sessionId,
                    queue.filter((item) => item.id !== messageId),
                ),
            };
        });

        return nextQueuedItem;
    }

    function restoreActiveQueuedMessage(
        sessionId: string,
        updater: (item: QueuedChatMessage) => QueuedChatMessage,
    ) {
        set((state) => {
            const deferredMessage =
                state.activeQueuedMessageBySessionId[sessionId];
            if (!deferredMessage) {
                return state;
            }

            const currentQueue =
                state.queuedMessagesBySessionId[sessionId] ?? [];
            const restoredQueue = restoreDeferredQueuedMessage(currentQueue, {
                ...deferredMessage,
                item: updater(deferredMessage.item),
            });

            return {
                queuedMessagesBySessionId: cleanupQueuedMessagesBySessionId(
                    state.queuedMessagesBySessionId,
                    sessionId,
                    restoredQueue,
                ),
                activeQueuedMessageBySessionId:
                    cleanupDeferredQueuedMessagesBySessionId(
                        state.activeQueuedMessageBySessionId,
                        sessionId,
                        null,
                    ),
            };
        });
    }

    function pauseQueueForCancellation(
        sessionId: string,
        deferredMessage: DeferredQueuedMessage | null,
    ) {
        set((state) => {
            const currentPausedQueue = state.pausedQueueBySessionId[sessionId];
            const nextDeferredMessages = deferredMessage
                ? mergeDeferredQueuedMessage(
                      currentPausedQueue?.reinstateAfterNextManualSend ?? [],
                      deferredMessage,
                  )
                : (currentPausedQueue?.reinstateAfterNextManualSend ?? []);

            return {
                pausedQueueBySessionId: {
                    ...state.pausedQueueBySessionId,
                    [sessionId]: {
                        reinstateAfterNextManualSend: nextDeferredMessages,
                    },
                },
                activeQueuedMessageBySessionId:
                    cleanupDeferredQueuedMessagesBySessionId(
                        state.activeQueuedMessageBySessionId,
                        sessionId,
                        null,
                    ),
            };
        });
    }

    function releasePausedQueueForManualSend(sessionId: string) {
        set((state) => {
            const pausedQueue = state.pausedQueueBySessionId[sessionId];
            if (!pausedQueue) {
                return state;
            }

            const currentQueue =
                state.queuedMessagesBySessionId[sessionId] ?? [];
            const nextQueue = restoreDeferredQueuedMessages(
                currentQueue,
                pausedQueue.reinstateAfterNextManualSend,
            );

            return {
                queuedMessagesBySessionId: cleanupQueuedMessagesBySessionId(
                    state.queuedMessagesBySessionId,
                    sessionId,
                    nextQueue,
                ),
                pausedQueueBySessionId: cleanupPausedQueueBySessionId(
                    state.pausedQueueBySessionId,
                    sessionId,
                    null,
                ),
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
        options?: {
            preserveComposerState?: boolean;
        },
    ) {
        let activeSessionId = sessionId;
        let currentItem = queuedItem;
        let session = get().sessionsById[activeSessionId];
        if (!session || session.isResumingSession) {
            return;
        }

        clearInterruptedTurnState(activeSessionId);

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
            const activatedQueuedMessage = activateQueuedMessage(
                activeSessionId,
                currentItem.id,
            );
            if (!activatedQueuedMessage) {
                return;
            }

            currentItem = activatedQueuedMessage.item;
        }

        if (!session || isSessionBusy(session)) {
            if (source === "queue") {
                restoreActiveQueuedMessage(activeSessionId, (item) => ({
                    ...item,
                    status: "queued",
                }));
            }
            return;
        }

        try {
            if (source === "immediate") {
                const replacementSessionId =
                    await replaceEmptySessionForAdditionalRoots(
                        activeSessionId,
                        currentItem,
                    );
                if (replacementSessionId !== activeSessionId) {
                    activeSessionId = replacementSessionId;
                    session = get().sessionsById[activeSessionId];
                    if (!session || isSessionBusy(session)) {
                        return;
                    }
                }
            }

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
                updateActiveQueuedMessage(
                    activeSessionId,
                    (deferredMessage) => ({
                        ...deferredMessage,
                        item: {
                            ...deferredMessage.item,
                            optimisticMessageId: userMessageId,
                        },
                    }),
                );
                currentItem = {
                    ...currentItem,
                    optimisticMessageId: userMessageId,
                };
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
                                    source === "immediate" &&
                                    !options?.preserveComposerState
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
                    ...(source === "immediate" &&
                    !options?.preserveComposerState
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
        } catch (error) {
            const message = getAiErrorMessage(
                error,
                "Failed to send the message.",
            );
            if (source === "queue") {
                restoreActiveQueuedMessage(activeSessionId, (item) => ({
                    ...item,
                    status: "failed",
                }));
            }
            get().applySessionError({
                session_id: activeSessionId,
                message,
            });
            if (isAuthenticationErrorMessage(message)) {
                await get().refreshSetupStatus(session.runtimeId);
            }
        }
    }

    async function flushPendingInterruptedSend(
        sessionId: string,
        options?: {
            waitForStop?: boolean;
        },
    ) {
        if (options?.waitForStop !== false) {
            await waitForPendingStop(sessionId);
        }
        const interruption =
            get().interruptedTurnStateBySessionId[sessionId] ?? null;
        const pending = interruption?.pendingManualSend;
        if (!pending) {
            return;
        }

        const session = get().sessionsById[sessionId];
        if (!session || session.isResumingSession || isSessionBusy(session)) {
            return;
        }

        if (get().pausedQueueBySessionId[sessionId]) {
            releasePausedQueueForManualSend(sessionId);
            const nextQueuedMessageId = (get().queuedMessagesBySessionId[
                sessionId
            ] ?? [])[0]?.id;
            if (
                nextQueuedMessageId &&
                !get().activeQueuedMessageBySessionId[sessionId]
            ) {
                activateQueuedMessage(sessionId, nextQueuedMessageId);
            }
        }

        await dispatchMessage(sessionId, pending.item, "immediate", {
            preserveComposerState: pending.preserveComposerState,
        });
    }

    return {
        runtimeConnectionByRuntimeId: {},
        setupStatusByRuntimeId: {},
        runtimes: [],
        sessionsById: {},
        sessionOrder: [],
        activeSessionId: null,
        lastFocusedSessionId: null,
        selectedRuntimeId: null,
        isInitializing: false,
        notePickerOpen: false,
        autoContextEnabled: false,
        requireCmdEnterToSend: DEFAULT_AI_PREFERENCES.requireCmdEnterToSend,
        contextUsageBarEnabled: DEFAULT_AI_PREFERENCES.contextUsageBarEnabled,
        composerFontSize: DEFAULT_AI_PREFERENCES.composerFontSize,
        chatFontSize: DEFAULT_AI_PREFERENCES.chatFontSize,
        composerFontFamily: DEFAULT_AI_PREFERENCES.composerFontFamily,
        chatFontFamily: DEFAULT_AI_PREFERENCES.chatFontFamily,
        editDiffZoom: DEFAULT_AI_PREFERENCES.editDiffZoom,
        historyRetentionDays: DEFAULT_AI_PREFERENCES.historyRetentionDays,
        screenshotRetentionSeconds:
            DEFAULT_AI_PREFERENCES.screenshotRetentionSeconds,
        composerPartsBySessionId: {},
        queuedMessagesBySessionId: {},
        queuedMessageEditBySessionId: {},
        activeQueuedMessageBySessionId: {},
        pausedQueueBySessionId: {},
        interruptedTurnStateBySessionId: {},
        tokenUsageBySessionId: {},

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

        initialize: async (options) => {
            if (get().isInitializing) {
                return { sessionInventoryLoaded: false };
            }

            const shouldCreateDefaultSession =
                options?.createDefaultSession ?? true;

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
                        setPersistedHistoryCache(vaultPath, histories);
                    } catch {
                        // Disk histories unavailable, continue without them
                        setPersistedHistoryCache(vaultPath, []);
                    }
                } else {
                    setPersistedHistoryCache(null, []);
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

                    const hydratedActiveSessionId = get().activeSessionId;
                    if (hydratedActiveSessionId) {
                        await ensureSessionAgentCatalogLoaded(
                            hydratedActiveSessionId,
                        );
                    }
                    return { sessionInventoryLoaded: true };
                }

                if (!get().activeSessionId && shouldCreateDefaultSession) {
                    const runtimeId = defaultRuntimeId;
                    const setupStatus = getSetupStatusForRuntime(
                        setupStatusByRuntimeId,
                        runtimeId,
                    );
                    if (runtimeId) {
                        if (setupStatus?.onboardingRequired) {
                            return { sessionInventoryLoaded: true };
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
                return { sessionInventoryLoaded: false };
            } finally {
                set({ isInitializing: false });
            }

            return { sessionInventoryLoaded: true };
        },

        reconcileRestoredWorkspaceTabs: async (tabs, activeTabId = null) => {
            if (tabs.length === 0) {
                return;
            }

            const sessionIdsNeedingCatalog = new Set<string>();
            const vaultPath = useVaultStore.getState().vaultPath;
            const resolvedSessionIdByTabId = new Map<string, string>();

            set((state) => {
                const nextSessionsById = { ...state.sessionsById };
                const changedSessions: AIChatSession[] = [];
                const sessionIdByHistoryId = new Map(
                    Object.values(nextSessionsById).flatMap((session) =>
                        session.historySessionId
                            ? [
                                  [
                                      session.historySessionId,
                                      session.sessionId,
                                  ] as const,
                              ]
                            : [],
                    ),
                );

                for (const tab of tabs) {
                    if (!tab.sessionId || !tab.historySessionId) {
                        continue;
                    }

                    const resolvedSessionId =
                        nextSessionsById[tab.sessionId]?.sessionId ??
                        sessionIdByHistoryId.get(tab.historySessionId) ??
                        tab.sessionId;
                    resolvedSessionIdByTabId.set(tab.id, resolvedSessionId);

                    const currentSession = nextSessionsById[resolvedSessionId];
                    if (!currentSession) {
                        continue;
                    }

                    let nextSession = currentSession;
                    if (
                        currentSession.historySessionId !==
                            tab.historySessionId ||
                        (!currentSession.runtimeId && tab.runtimeId)
                    ) {
                        nextSession = {
                            ...currentSession,
                            historySessionId: tab.historySessionId,
                            runtimeId:
                                currentSession.runtimeId ??
                                tab.runtimeId ??
                                currentSession.runtimeId,
                        };
                    }

                    const persisted = getPersistedHistoryFromCache(
                        currentSession.vaultPath ?? vaultPath,
                        tab.historySessionId,
                    );
                    if (persisted) {
                        nextSession = applyPersistedHistoryMetadata(
                            nextSession,
                            persisted,
                        );
                    }

                    if (!sessionHasAgentCatalog(nextSession)) {
                        sessionIdsNeedingCatalog.add(nextSession.sessionId);
                    }

                    if (nextSession === currentSession) {
                        continue;
                    }

                    nextSessionsById[nextSession.sessionId] = nextSession;
                    changedSessions.push(nextSession);
                }

                if (changedSessions.length === 0) {
                    return state;
                }

                return {
                    runtimes: hydrateRuntimesFromSessions(
                        state.runtimes,
                        changedSessions,
                    ),
                    sessionsById: nextSessionsById,
                };
            });

            for (const sessionId of sessionIdsNeedingCatalog) {
                await ensureSessionAgentCatalogLoaded(sessionId);
            }

            const activeSessionId = activeTabId
                ? (resolvedSessionIdByTabId.get(activeTabId) ??
                  tabs.find((tab) => tab.id === activeTabId)?.sessionId ??
                  null)
                : null;
            if (!activeSessionId) {
                return;
            }

            let activeSession: AIChatSession | null =
                get().sessionsById[activeSessionId] ?? null;
            if (!activeSession) {
                return;
            }

            if (
                activeSession.runtimeState !== "live" &&
                !activeSession.isResumingSession
            ) {
                const resumedSessionId =
                    await get().resumeSession(activeSessionId);
                activeSession =
                    (resumedSessionId
                        ? get().sessionsById[resumedSessionId]
                        : null) ?? null;
            }

            if (!activeSession) {
                return;
            }

            await ensureSessionAgentCatalogLoaded(activeSession.sessionId);
            if (activeSession.runtimeState === "live") {
                await get().ensureSessionTranscriptLoaded(
                    activeSession.sessionId,
                    "latest",
                );
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
                    secretPatchChanged(input.codexApiKey) ||
                    secretPatchChanged(input.openaiApiKey) ||
                    secretPatchChanged(input.geminiApiKey) ||
                    secretPatchChanged(input.googleApiKey) ||
                    input.googleCloudProject ||
                    input.googleCloudLocation ||
                    input.gatewayBaseUrl ||
                    secretPatchChanged(input.gatewayHeaders) ||
                    input.anthropicBaseUrl ||
                    secretPatchChanged(input.anthropicCustomHeaders) ||
                    secretPatchChanged(input.anthropicAuthToken) ||
                    secretPatchChanged(
                        input.anthropicApiKey ?? { action: "unchanged" },
                    )
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
                        anthropicApiKey: input.anthropicApiKey,
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
            let sessionToPersist: AIChatSession | null = null;
            set((state) => {
                const currentVaultPath = useVaultStore.getState().vaultPath;
                const existing = state.sessionsById[session.sessionId];
                const sessionVaultPath =
                    session.vaultPath ?? existing?.vaultPath ?? currentVaultPath;
                const workspaceTabs = selectEditorWorkspaceTabs(
                    useEditorStore.getState(),
                );
                const stampedSession = stampSessionVaultPath(
                    session,
                    sessionVaultPath,
                );
                const scopedSession = hydrateSessionCatalogFromRuntime(
                    stampedSession,
                    state.runtimes.find(
                        (runtime) =>
                            runtime.runtime.id === stampedSession.runtimeId,
                    ),
                );
                const isKnown = state.sessionOrder.includes(
                    scopedSession.sessionId,
                );
                const parentSession = findParentSessionForIncomingChild(
                    state.sessionsById,
                    scopedSession,
                );
                const isKnownChildSession =
                    parentSession != null &&
                    sessionMatchesVaultPath(parentSession, currentVaultPath);
                const isWorkspaceSession =
                    state.activeSessionId === scopedSession.sessionId ||
                    workspaceTabs.some(
                        (tab) =>
                            "sessionId" in tab &&
                            tab.kind === "ai-chat" &&
                            tab.sessionId === scopedSession.sessionId,
                    );

                if (
                    !activate &&
                    ((existing &&
                        !sessionMatchesVaultPath(existing, currentVaultPath) &&
                        !isWorkspaceSession) ||
                        !sessionMatchesVaultPath(
                            scopedSession,
                            currentVaultPath,
                        ))
                ) {
                    return state;
                }

                // Ignore unexpected sessions unless explicitly activated by
                // this vault/window lifecycle.
                if (!isKnown && !activate && !isKnownChildSession) {
                    return state;
                }

                const nextRuntimes = scopedSession.isPersistedSession
                    ? state.runtimes
                    : hydrateRuntimesFromSessions(state.runtimes, [
                          scopedSession,
                      ]);
                const nextSession = mergeSession(existing, scopedSession);
                const nextTokenUsageBySessionId =
                    existing && existing.modelId !== nextSession.modelId
                        ? removeSessionMapEntry(
                              state.tokenUsageBySessionId,
                              scopedSession.sessionId,
                          )
                        : state.tokenUsageBySessionId;
                const reconciledQueueState =
                    existing &&
                    nextSession.status === "idle" &&
                    !nextSession.isResumingSession
                        ? reconcileIdleQueuedState(
                              state,
                              scopedSession.sessionId,
                          )
                        : null;
                shouldDrainQueue =
                    nextSession.status === "idle" &&
                    (existing?.status !== "idle" ||
                        Boolean(reconciledQueueState)) &&
                    !nextSession.isResumingSession;
                sessionToPersist = nextSession;

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
                        : !isKnown && isKnownChildSession
                          ? insertSessionAfterParent(
                                state.sessionOrder,
                                scopedSession.sessionId,
                                parentSession?.sessionId ?? null,
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
                    tokenUsageBySessionId: nextTokenUsageBySessionId,
                    ...(reconciledQueueState ?? {}),
                };
            });

            if (shouldDrainQueue) {
                void get().tryDrainQueue(session.sessionId);
            }
            if (sessionToPersist) {
                void persistSession(sessionToPersist);
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
                          ...affectedSessionIds.reduce(
                              (nextState, sessionId) => {
                                  const activeQueuedMessage =
                                      state.activeQueuedMessageBySessionId[
                                          sessionId
                                      ];
                                  if (!activeQueuedMessage) {
                                      return nextState;
                                  }

                                  return {
                                      queuedMessagesBySessionId:
                                          cleanupQueuedMessagesBySessionId(
                                              nextState.queuedMessagesBySessionId,
                                              sessionId,
                                              restoreDeferredQueuedMessage(
                                                  nextState
                                                      .queuedMessagesBySessionId[
                                                      sessionId
                                                  ] ?? [],
                                                  {
                                                      ...activeQueuedMessage,
                                                      item: {
                                                          ...activeQueuedMessage.item,
                                                          status: "failed",
                                                      },
                                                  },
                                              ),
                                          ),
                                      activeQueuedMessageBySessionId:
                                          cleanupDeferredQueuedMessagesBySessionId(
                                              nextState.activeQueuedMessageBySessionId,
                                              sessionId,
                                              null,
                                          ),
                                      interruptedTurnStateBySessionId:
                                          cleanupInterruptedTurnStateBySessionId(
                                              nextState.interruptedTurnStateBySessionId,
                                              sessionId,
                                              null,
                                          ),
                                  };
                              },
                              {
                                  queuedMessagesBySessionId:
                                      state.queuedMessagesBySessionId,
                                  activeQueuedMessageBySessionId:
                                      state.activeQueuedMessageBySessionId,
                                  interruptedTurnStateBySessionId:
                                      state.interruptedTurnStateBySessionId,
                              },
                          ),
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

        applyTokenUsage: ({ session_id, used, size, cost }) => {
            set((state) => {
                if (!state.sessionsById[session_id]) {
                    return state;
                }

                return {
                    tokenUsageBySessionId: {
                        ...state.tokenUsageBySessionId,
                        [session_id]: {
                            session_id,
                            used,
                            size,
                            cost: cost ?? null,
                            updatedAt: Date.now(),
                        },
                    },
                };
            });
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
                const activeQueuedMessage =
                    state.activeQueuedMessageBySessionId[session_id] ?? null;
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
                    queuedMessagesBySessionId: activeQueuedMessage
                        ? cleanupQueuedMessagesBySessionId(
                              state.queuedMessagesBySessionId,
                              session_id,
                              restoreDeferredQueuedMessage(
                                  state.queuedMessagesBySessionId[session_id] ??
                                      [],
                                  {
                                      ...activeQueuedMessage,
                                      item: {
                                          ...activeQueuedMessage.item,
                                          status: "failed",
                                      },
                                  },
                              ),
                          )
                        : state.queuedMessagesBySessionId,
                    activeQueuedMessageBySessionId:
                        cleanupDeferredQueuedMessagesBySessionId(
                            state.activeQueuedMessageBySessionId,
                            session_id,
                            null,
                        ),
                    interruptedTurnStateBySessionId:
                        cleanupInterruptedTurnStateBySessionId(
                            state.interruptedTurnStateBySessionId,
                            session_id,
                            null,
                        ),
                };
            });

            if (session_id) {
                const updatedSession = get().sessionsById[session_id];
                if (updatedSession) persistSession(updatedSession);
            }
        },

        applyMessageStarted: ({ session_id }) => {
            if (shouldIgnoreLateActivityForSession(get(), session_id)) {
                return;
            }
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
            if (shouldIgnoreLateActivityForSession(get(), session_id)) {
                return;
            }
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
                const activeQueuedMessage =
                    state.activeQueuedMessageBySessionId[session_id] ?? null;
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
                    queuedMessagesBySessionId: activeQueuedMessage
                        ? cleanupQueuedMessagesBySessionId(
                              state.queuedMessagesBySessionId,
                              session_id,
                              (
                                  state.queuedMessagesBySessionId[session_id] ??
                                  []
                              ).filter(
                                  (item) =>
                                      item.id !== activeQueuedMessage.item.id,
                              ),
                          )
                        : state.queuedMessagesBySessionId,
                    activeQueuedMessageBySessionId:
                        cleanupDeferredQueuedMessagesBySessionId(
                            state.activeQueuedMessageBySessionId,
                            session_id,
                            null,
                        ),
                    sessionOrder: touchSessionOrder(
                        state.sessionOrder,
                        session_id,
                    ),
                };
            });

            persistCurrentSession(session_id);
            void get().tryDrainQueue(session_id);
        },

        applyThinkingStarted: ({ session_id, message_id }) => {
            if (shouldIgnoreLateActivityForSession(get(), session_id)) {
                return;
            }
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
            if (shouldIgnoreLateActivityForSession(get(), session_id)) {
                return;
            }
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
            if (shouldIgnoreLateActivityForSession(get(), session_id)) {
                return;
            }
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
            persistCurrentSession(session_id);
        },

        applyToolActivity: (payload) => {
            if (shouldIgnoreLateActivityForSession(get(), payload.session_id)) {
                return;
            }
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
                    toolAction: payload.action ?? null,
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

            const updatedSession = get().sessionsById[payload.session_id];
            if (updatedSession) {
                void persistSession(updatedSession);
            }
            if (
                payload.status === "completed" &&
                updatedSession?.actionLog &&
                (payload.diffs?.some(diffCanBeTracked) ?? false)
            ) {
                const files = getAccumulatedTrackedFiles(updatedSession);
                const vaultPath =
                    updatedSession.vaultPath ??
                    useVaultStore.getState().vaultPath;
                const scheduledIdentityKeys = new Set<string>();
                for (const diff of payload.diffs ?? []) {
                    if (!diffCanBeTracked(diff)) {
                        continue;
                    }

                    const tracked = findTrackedFileForIncomingDiff(
                        files,
                        diff,
                        vaultPath,
                    );
                    if (
                        !isTextTrackedFile(tracked) ||
                        scheduledIdentityKeys.has(tracked.identityKey)
                    ) {
                        continue;
                    }

                    scheduledIdentityKeys.add(tracked.identityKey);
                    scheduleTrackedPersistedContentReconciliation(
                        payload.session_id,
                        tracked.identityKey,
                        tracked.version,
                    );
                }
            }
        },

        applyStatusEvent: (payload) => {
            if (shouldIgnoreLateActivityForSession(get(), payload.session_id)) {
                return;
            }
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
            persistCurrentSession(payload.session_id);
        },

        applyImageGeneration: (payload) => {
            if (shouldIgnoreLateActivityForSession(get(), payload.session_id)) {
                return;
            }
            scheduleStaleStreamingCheck(payload.session_id);
            set((state) => {
                const session = state.sessionsById[payload.session_id];
                if (!session) return state;
                const baseSession = ensureSessionWorkCycle(session);
                const nextSession = imageGenerationKeepsSessionStreaming(
                    payload.status,
                )
                    ? markSessionStreamingIfLive(baseSession)
                    : baseSession;
                const nextMessage = {
                    ...createImageGenerationMessage(payload),
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
            persistCurrentSession(payload.session_id);
        },

        applyPlanUpdate: (payload) => {
            if (shouldIgnoreLateActivityForSession(get(), payload.session_id)) {
                return;
            }
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
            persistCurrentSession(payload.session_id);
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
            if (shouldIgnoreLateActivityForSession(get(), payload.session_id)) {
                return;
            }
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
            persistCurrentSession(payload.session_id);
        },

        applyUserInputRequest: (payload) => {
            if (shouldIgnoreLateActivityForSession(get(), payload.session_id)) {
                return;
            }

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
            });
            persistCurrentSession(payload.session_id);
        },

        reconcileTrackedFilesFromVaultChange: async (change) => {
            if (change.kind !== "upsert" || change.origin !== "agent") {
                return;
            }

            const pathCandidates = getVaultChangeTrackedPathCandidates(change);
            if (pathCandidates.length === 0) {
                return;
            }

            const persistedContent =
                await readVaultChangePersistedContent(change);
            if (typeof persistedContent !== "string") {
                return;
            }

            const persistedHash = hashTextContent(persistedContent);
            if (
                change.content_hash != null &&
                persistedHash !== change.content_hash
            ) {
                return;
            }

            const updatedSessions: AIChatSession[] = [];
            useChatStore.setState((state) => {
                let changed = false;
                const nextSessionsById = {
                    ...state.sessionsById,
                };

                for (const [sessionId, session] of Object.entries(
                    state.sessionsById,
                )) {
                    if (!session.actionLog) {
                        continue;
                    }

                    const vaultPath =
                        session.vaultPath ?? useVaultStore.getState().vaultPath;
                    const currentFiles = getAccumulatedTrackedFiles(session);
                    let nextFiles: Record<string, TrackedFile> | null = null;

                    for (const [identityKey, file] of Object.entries(
                        currentFiles,
                    )) {
                        if (
                            !isTextTrackedFile(file) ||
                            !pathCandidates.some((candidatePath) =>
                                trackedFileMatchesPersistedPathCandidate(
                                    file,
                                    candidatePath,
                                    vaultPath,
                                ),
                            )
                        ) {
                            continue;
                        }

                        const nextTracked = replaceTrackedFileCurrentText(
                            file,
                            persistedContent,
                            Date.now(),
                        );
                        if (
                            nextTracked === file &&
                            nextTracked.currentText === file.currentText &&
                            nextTracked.conflictHash === file.conflictHash
                        ) {
                            continue;
                        }

                        nextFiles ??= { ...currentFiles };
                        nextFiles[identityKey] = nextTracked;
                    }

                    if (!nextFiles) {
                        continue;
                    }

                    const nextSession = replaceTrackedFilesInActionLog(
                        session,
                        nextFiles,
                    );
                    nextSessionsById[sessionId] = nextSession;
                    updatedSessions.push(nextSession);
                    changed = true;
                }

                if (!changed) {
                    return state;
                }

                return {
                    sessionsById: nextSessionsById,
                };
            });

            for (const session of updatedSessions) {
                void persistSession(session);
            }
        },

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
                          lastFocusedSessionId: sessionId,
                          selectedRuntimeId:
                              state.sessionsById[sessionId]?.runtimeId ??
                              state.selectedRuntimeId,
                      }
                    : state,
            ),

        markSessionFocused: (sessionId) =>
            set((state) =>
                state.sessionsById[sessionId]
                    ? { lastFocusedSessionId: sessionId }
                    : state,
            ),

        resumeSession: async (sessionId) => {
            const state = get();
            const session = state.sessionsById[sessionId];
            if (!session) return null;
            if (session.isPendingSessionCreation) return sessionId;
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
                const latestCatalog = getRuntimeCatalogSnapshot(latestSession);

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

                if (hasRuntimeCatalog(latestCatalog)) {
                    resumedSession = hydrateSessionCatalogFromSnapshot(
                        resumedSession,
                        latestCatalog,
                    );
                    saveRuntimeCatalogCache(
                        latestSession.runtimeId,
                        getRuntimeCatalogSnapshot(resumedSession),
                    );
                }

                const migratedSession = startNewWorkCycle(
                    replaceSessionTranscript(
                        {
                            ...resumedSession,
                            historySessionId,
                            parentSessionId:
                                resumedSession.parentSessionId ??
                                latestSession.parentSessionId ??
                                null,
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
                            customTitle: latestSession.customTitle ?? null,
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

                migrateSessionLocalState(sessionId, migratedSession);

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
                if (existing.isPendingSessionCreation) {
                    return;
                }
                if (existing.runtimeState !== "live") {
                    await get().resumeSession(sessionId);
                    return;
                }

                await ensureSessionAgentCatalogLoaded(sessionId);
                await get().ensureSessionTranscriptLoaded(sessionId, "latest");
                return;
            }

            const persistedHistorySessionId =
                getPersistedHistorySessionId(sessionId);
            if (persistedHistorySessionId) {
                const vaultPath = useVaultStore.getState().vaultPath;
                const persisted = getPersistedHistoryFromCache(
                    vaultPath,
                    persistedHistorySessionId,
                );
                if (persisted) {
                    const restored = createPersistedSession(
                        { ...persisted, messages: [] },
                        get().runtimes,
                        vaultPath,
                    );
                    if (restored) {
                        get().upsertSession(restored, true);
                        await get().resumeSession(restored.sessionId);
                        return;
                    }
                }

                get().applySessionError({
                    session_id: sessionId,
                    message:
                        "Saved chat history is still loading. Try reopening the chat in a moment.",
                });
                return;
            }

            try {
                const session = await aiLoadSession(sessionId);
                get().upsertSession(session, true);
            } catch (error) {
                const fallbackHistorySessionId =
                    getWorkspaceHistorySessionIdForSession(sessionId);
                const vaultPath = useVaultStore.getState().vaultPath;
                const persisted = fallbackHistorySessionId
                    ? getPersistedHistoryFromCache(
                          vaultPath,
                          fallbackHistorySessionId,
                      )
                    : null;
                const restored = persisted
                    ? createPersistedSession(
                          { ...persisted, messages: [] },
                          get().runtimes,
                          vaultPath,
                      )
                    : null;

                if (restored) {
                    get().upsertSession(restored, true);
                    useChatTabsStore
                        .getState()
                        .replaceSessionId(
                            sessionId,
                            restored.sessionId,
                            restored.historySessionId,
                            restored.runtimeId,
                        );
                    useEditorStore
                        .getState()
                        .replaceAiSessionId(
                            sessionId,
                            restored.sessionId,
                            restored.historySessionId,
                        );
                    await get().resumeSession(restored.sessionId);
                    return;
                }

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
            await applyAgentConfigMutation({
                requestedSessionId: sessionId,
                change: { kind: "model", value: modelId },
                applyLocal: (session) =>
                    applyLocalModelSelection(session, modelId),
                applyRemote: async (session) => {
                    const modelConfig = getModelConfigOption(session);
                    return modelConfig &&
                        modelConfig.options.some(
                            (option) => option.value === modelId,
                        )
                        ? aiSetConfigOption(
                              session.sessionId,
                              modelConfig.id,
                              modelId,
                          )
                        : aiSetModel(session.sessionId, modelId);
                },
                persistPreference: () => persistModelPreference(modelId),
                errorMessage: "Failed to update the model.",
            });
        },

        setMode: async (modeId, sessionId) => {
            await applyAgentConfigMutation({
                requestedSessionId: sessionId,
                change: { kind: "mode", value: modeId },
                applyLocal: (session) =>
                    applyLocalModeSelection(session, modeId),
                applyRemote: (session) => aiSetMode(session.sessionId, modeId),
                persistPreference: () => persistModePreference(modeId),
                errorMessage: "Failed to update the mode.",
            });
        },

        setConfigOption: async (optionId, value, sessionId) => {
            await applyAgentConfigMutation({
                requestedSessionId: sessionId,
                change: { kind: "config", optionId, value },
                applyLocal: (session) =>
                    applyLocalConfigOptionSelection(session, optionId, value),
                applyRemote: (session) =>
                    aiSetConfigOption(session.sessionId, optionId, value),
                persistPreference: () =>
                    persistConfigOptionSelectionPreference(optionId, value),
                errorMessage: "Failed to update the session option.",
            });
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
                const fileMentionPaths = new Set(
                    parts
                        .filter(
                            (
                                p,
                            ): p is Extract<
                                AIComposerPart,
                                { type: "file_mention" }
                            > => p.type === "file_mention",
                        )
                        .map((p) => p.path),
                );

                const prunedAttachments = session
                    ? session.attachments.filter((a) => {
                          if (a.type === "note")
                              return mentionIds.has(a.noteId!);
                          if (a.type === "file" && a.path)
                              return fileMentionPaths.has(a.path);
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
                        ...(
                            state.queuedMessagesBySessionId[sessionId] ?? []
                        ).filter((queuedItem) => queuedItem.id !== item.id),
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
                const hasQueuedState =
                    sessionId in state.queuedMessagesBySessionId ||
                    sessionId in state.queuedMessageEditBySessionId ||
                    sessionId in state.activeQueuedMessageBySessionId ||
                    sessionId in state.pausedQueueBySessionId;
                if (!hasQueuedState) {
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
                    activeQueuedMessageBySessionId:
                        cleanupDeferredQueuedMessagesBySessionId(
                            state.activeQueuedMessageBySessionId,
                            sessionId,
                            null,
                        ),
                    pausedQueueBySessionId: cleanupPausedQueueBySessionId(
                        state.pausedQueueBySessionId,
                        sessionId,
                        null,
                    ),
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
                const finalizedEdit = finalizeQueuedMessageEditState(
                    state,
                    sessionId,
                    state.queuedMessageEditBySessionId[sessionId]?.item,
                );
                if (!finalizedEdit) {
                    return state;
                }
                shouldDrainQueue = finalizedEdit.nextSession.status === "idle";

                return {
                    sessionsById: {
                        ...state.sessionsById,
                        [sessionId]: finalizedEdit.nextSession,
                    },
                    composerPartsBySessionId:
                        finalizedEdit.nextComposerPartsBySessionId,
                    queuedMessagesBySessionId:
                        finalizedEdit.nextQueuedMessagesBySessionId,
                    queuedMessageEditBySessionId:
                        finalizedEdit.nextQueuedMessageEditBySessionId,
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
            const pendingStop = _pendingStopBySessionId.get(resolvedSessionId);

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
                const shouldDeferUntilStop = Boolean(pendingStop);
                const shouldRequeueEditedMessage =
                    !shouldDeferUntilStop && isSessionBusy(session);

                set((state) => {
                    const finalizedEdit = finalizeQueuedMessageEditState(
                        state,
                        resolvedSessionId,
                        shouldRequeueEditedMessage
                            ? updatedQueuedItem
                            : undefined,
                    );
                    if (!finalizedEdit) {
                        return state;
                    }

                    return {
                        sessionsById: {
                            ...state.sessionsById,
                            [resolvedSessionId]: finalizedEdit.nextSession,
                        },
                        composerPartsBySessionId:
                            finalizedEdit.nextComposerPartsBySessionId,
                        queuedMessagesBySessionId:
                            finalizedEdit.nextQueuedMessagesBySessionId,
                        queuedMessageEditBySessionId:
                            finalizedEdit.nextQueuedMessageEditBySessionId,
                        sessionOrder: touchSessionOrder(
                            state.sessionOrder,
                            resolvedSessionId,
                        ),
                    };
                });

                if (shouldRequeueEditedMessage) {
                    return;
                }

                if (shouldDeferUntilStop && pendingStop) {
                    const queued = queuePendingInterruptedSend(
                        resolvedSessionId,
                        {
                            item: updatedQueuedItem,
                            preserveComposerState: true,
                        },
                    );
                    if (queued) {
                        void pendingStop.finally(() => {
                            void flushPendingInterruptedSend(resolvedSessionId);
                        });
                    }
                    return;
                }

                if (get().pausedQueueBySessionId[resolvedSessionId]) {
                    releasePausedQueueForManualSend(resolvedSessionId);
                }
                await dispatchMessage(
                    resolvedSessionId,
                    updatedQueuedItem,
                    "immediate",
                    {
                        preserveComposerState: true,
                    },
                );
                return;
            }

            if (pendingStop) {
                const queued = queuePendingInterruptedSend(resolvedSessionId, {
                    item: queuedItem,
                });
                if (queued) {
                    void pendingStop.finally(() => {
                        void flushPendingInterruptedSend(resolvedSessionId);
                    });
                }
                return;
            }

            await stabilizeQueueSession(resolvedSessionId);
            const stabilizedSession = get().sessionsById[resolvedSessionId];
            if (!stabilizedSession || stabilizedSession.isResumingSession) {
                return;
            }

            if (isSessionBusy(stabilizedSession)) {
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

            if (get().pausedQueueBySessionId[resolvedSessionId]) {
                releasePausedQueueForManualSend(resolvedSessionId);
            }
            await dispatchMessage(resolvedSessionId, queuedItem, "immediate");
        },

        retryQueuedMessage: async (sessionId, messageId) => {
            await stabilizeQueueSession(sessionId);
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
            await stabilizeQueueSession(sessionId);
            if (get().queuedMessageEditBySessionId[sessionId]) {
                return;
            }

            const currentSession = get().sessionsById[sessionId];
            const queuedItem = get().queuedMessagesBySessionId[sessionId]?.find(
                (item) => item.id === messageId,
            );
            if (
                !currentSession ||
                !queuedItem ||
                queuedItem.status === "sending"
            ) {
                return;
            }

            if (_queueDrainLocks.has(sessionId)) {
                return;
            }

            _queueDrainLocks.add(sessionId);
            try {
                if (isSessionBusy(currentSession)) {
                    await get().stopStreaming(sessionId);
                    await stabilizeQueueSession(sessionId);
                }

                const nextSession = get().sessionsById[sessionId];
                if (
                    !nextSession ||
                    nextSession.isResumingSession ||
                    isSessionBusy(nextSession)
                ) {
                    return;
                }

                if (get().pausedQueueBySessionId[sessionId]) {
                    releasePausedQueueForManualSend(sessionId);
                }

                const sendNowItem = takeQueuedMessage(sessionId, messageId);
                if (!sendNowItem) {
                    return;
                }

                await dispatchMessage(sessionId, sendNowItem, "immediate");
            } finally {
                _queueDrainLocks.delete(sessionId);
            }
        },

        tryDrainQueue: async (sessionId) => {
            await stabilizeQueueSession(sessionId);
            const session = get().sessionsById[sessionId];
            if (
                !session ||
                session.status !== "idle" ||
                session.isResumingSession ||
                Boolean(get().queuedMessageEditBySessionId[sessionId]) ||
                Boolean(get().pausedQueueBySessionId[sessionId])
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
            const targetSession = get().sessionsById[resolvedSessionId];
            if (!targetSession || targetSession.runtimeState !== "live") {
                return;
            }

            const existingPendingStop =
                _pendingStopBySessionId.get(resolvedSessionId);
            if (existingPendingStop) {
                await existingPendingStop;
                return;
            }

            let stopPromise: Promise<void> | null = null;
            stopPromise = (async () => {
                clearStaleStreamingCheck(resolvedSessionId);
                clearBufferedDeltasForSession(resolvedSessionId);
                markSessionStopping(resolvedSessionId);
                const activeQueuedMessage =
                    get().activeQueuedMessageBySessionId[resolvedSessionId] ??
                    null;
                const shouldPauseQueue =
                    activeQueuedMessage != null ||
                    (get().queuedMessagesBySessionId[resolvedSessionId]
                        ?.length ?? 0) > 0;

                if (shouldPauseQueue) {
                    if (activeQueuedMessage) {
                        restoreActiveQueuedMessage(
                            resolvedSessionId,
                            (item) => ({
                                ...item,
                                status: "queued",
                            }),
                        );
                    }
                    pauseQueueForCancellation(resolvedSessionId, null);
                } else {
                    setActiveQueuedMessage(resolvedSessionId, null);
                }

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
                            [resolvedSessionId]:
                                stampElapsedOnTurnStartedSession(
                                    {
                                        ...markAllMessagesComplete(sess),
                                        status: "idle",
                                    },
                                    stoppedAt,
                                ),
                        },
                    };
                });
                finalizeSessionStopping(resolvedSessionId);
                await flushPendingInterruptedSend(resolvedSessionId, {
                    waitForStop: false,
                });
            })().finally(() => {
                if (
                    _pendingStopBySessionId.get(resolvedSessionId) ===
                    stopPromise
                ) {
                    _pendingStopBySessionId.delete(resolvedSessionId);
                }
            });

            _pendingStopBySessionId.set(resolvedSessionId, stopPromise);
            await stopPromise;
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
            const targetSession = get().sessionsById[sessionId];
            if (!targetSession || targetSession.runtimeState !== "live") {
                return;
            }

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
            try {
                const prepared = await prepareTrackedFileMutation(
                    sessionId,
                    identityKey,
                    "rejectable-text",
                );
                if (prepared.kind !== "ready") return;

                const {
                    ctx: { tracked, vaultPath },
                } = prepared;
                const restoreAction = await rejectTrackedFileAndReload(
                    vaultPath,
                    tracked,
                );

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

        rejectAllEditedFiles: async (sessionId) => {
            const { sessionsById } = get();
            const session = sessionsById[sessionId];
            if (!session) return;
            const vaultPath = getSessionVaultPath(session);
            if (!vaultPath) return;

            const trackedFiles = getAccumulatedTrackedFiles(session);

            // Track which files need undo snapshots (fresh data is read
            // inside set() to avoid stale references).
            const undoIdentityKeys = new Set<string>();
            const removedIdentityKeys = new Set<string>();
            let caughtError: unknown = null;

            for (const [identityKey, tracked] of Object.entries(trackedFiles)) {
                if (!isTextTrackedFile(tracked)) {
                    continue;
                }

                try {
                    let activeTracked = tracked;
                    let restoreCheck = await hasConflictAfterSettle(
                        vaultPath,
                        tracked,
                        {
                            sessionId,
                            identityKey,
                            source: "reject-all-edited-files",
                        },
                    );
                    if (
                        restoreCheck.conflict &&
                        restoreCheck.reason === "applied-content-mismatch"
                    ) {
                        const reconciled =
                            await reconcileTrackedFileWithPersistedContentIfSafe(
                                sessionId,
                                identityKey,
                                tracked,
                                "reject-all-edited-files",
                                {
                                    expectedHash: restoreCheck.currentHash,
                                },
                            );
                        if (isTextTrackedFile(reconciled)) {
                            activeTracked = reconciled;
                            restoreCheck = await hasConflictAfterSettle(
                                vaultPath,
                                reconciled,
                                {
                                    sessionId,
                                    identityKey,
                                    source: "reject-all-edited-files",
                                },
                            );
                        }
                    }

                    if (restoreCheck.conflict) {
                        logTrackedFileConflict(
                            sessionId,
                            identityKey,
                            tracked,
                            restoreCheck,
                            "reject-all-edited-files",
                        );
                        markTrackedFileConflict(
                            sessionId,
                            identityKey,
                            restoreCheck.currentHash,
                        );
                        continue;
                    }

                    const restoreAction = await rejectTrackedFileAndReload(
                        vaultPath,
                        activeTracked,
                    );

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
                closeReviewIfSessionHasNoPendingEdits(
                    sessionId,
                    updatedSession,
                );
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
                closeReviewIfSessionHasNoPendingEdits(
                    sessionId,
                    updatedSession,
                );
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

            let tracked = findTrackedFileInAccumulatedSession(
                session,
                identityKey,
            );
            if (!tracked) {
                return;
            }

            const reviewIndex = buildReviewProjectionIndex(tracked);
            if (reviewIndex.trackedVersion !== trackedVersion) {
                return;
            }

            const resolvedHunkIds = expandReviewHunkIdsToOverlapClosure(
                reviewIndex,
                hunkIds,
            );
            if (resolvedHunkIds.length === 0) {
                return;
            }

            const resolvedExactSpans = resolveReviewHunkIdsToExactSpans(
                reviewIndex,
                resolvedHunkIds,
            );
            if (resolvedExactSpans.length === 0) {
                return;
            }

            let updatedFile: TrackedFile;
            let hunkUndoSnapshot: {
                identityKey: string;
                snapshot: TrackedFile;
            } | null = null;

            const vaultPath = getSessionVaultPath(session);
            if (vaultPath) {
                // Run the same settle + reconcile dance for accept as for
                // reject. On accept we don't write to disk, but an external
                // edit between the agent apply and the user's accept click
                // means our in-memory currentText no longer matches disk;
                // accepting without checking would leave domain and disk
                // desynchronised on the next cycle.
                const resolution = await detectAndReconcileReviewHunkConflict(
                    sessionId,
                    identityKey,
                    tracked,
                    vaultPath,
                    "resolve-review-hunks",
                );
                if (resolution.check.conflict) {
                    logTrackedFileConflict(
                        sessionId,
                        identityKey,
                        resolution.tracked,
                        resolution.check,
                        "resolve-review-hunks",
                    );
                    markTrackedFileConflictAndPersist(
                        sessionId,
                        identityKey,
                        resolution.check.currentHash,
                    );
                    return;
                }
                if (resolution.tracked !== tracked) {
                    tracked = resolution.tracked;
                }
            }

            if (decision === "accepted") {
                updatedFile = keepExactSpans(tracked, resolvedExactSpans);
            } else {
                const preRejectTracked = tracked;
                const { file } = rejectExactSpans(tracked, resolvedExactSpans);
                updatedFile = file;
                hunkUndoSnapshot = { identityKey, snapshot: tracked };

                if (vaultPath) {
                    try {
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
                    } catch (error) {
                        // Disk write failed after the domain reject was
                        // computed. Degrade to the conflict panel — we never
                        // persisted `updatedFile` so the store still carries
                        // the pre-reject snapshot, but we surface the failure
                        // as a conflict so the UI does not silently drop the
                        // selection.
                        const preRejectHash = hashTextContent(
                            preRejectTracked.currentText,
                        );
                        logTrackedFileConflict(
                            sessionId,
                            identityKey,
                            preRejectTracked,
                            {
                                conflict: true,
                                currentHash: preRejectHash,
                                reason: "disk-write-failed",
                                conflictingPath: preRejectTracked.path,
                                appliedHash: preRejectHash ?? "",
                                pathHash: preRejectHash,
                                originHash: null,
                            },
                            "resolve-review-hunks",
                        );
                        markTrackedFileConflictAndPersist(
                            sessionId,
                            identityKey,
                            preRejectHash,
                        );
                        throw error;
                    }
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
                if (decision === "accepted") {
                    closeReviewIfSessionHasNoPendingEdits(
                        sessionId,
                        updatedSession,
                    );
                }
            }
        },

        undoLastReject: async (sessionId) => {
            const { sessionsById } = get();
            const session = sessionsById[sessionId];
            if (!session?.actionLog?.lastRejectUndo) return;
            const vaultPath = getSessionVaultPath(session);
            if (!vaultPath) return;

            const { lastRejectUndo } = session.actionLog;
            const { snapshots } = lastRejectUndo;
            const restoredSnapshots: Record<string, TrackedFile> = {};
            let caughtError: unknown = null;

            // Restore each file on disk from its pre-reject snapshot
            for (const [identityKey, snapshot] of Object.entries(snapshots)) {
                try {
                    const currentHash = await aiGetTextFileHash(
                        vaultPath,
                        snapshot.path,
                    );
                    if (!canRestoreRejectUndoSnapshot(snapshot, currentHash)) {
                        continue;
                    }

                    await restoreRejectUndoSnapshotAndReload(
                        vaultPath,
                        snapshot,
                    );
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

        newSession: async (runtimeId, provisionalSessionId) => {
            const runtimes = get().runtimes;
            const nextRuntimeId =
                runtimeId ??
                get().selectedRuntimeId ??
                getDefaultRuntimeId(runtimes);
            if (!nextRuntimeId) return null;

            const markPendingSessionError = (message: string) => {
                if (!provisionalSessionId) {
                    return;
                }

                set((state) => {
                    const provisionalSession =
                        state.sessionsById[provisionalSessionId];
                    if (!provisionalSession?.isPendingSessionCreation) {
                        return state;
                    }

                    return {
                        sessionsById: {
                            ...state.sessionsById,
                            [provisionalSessionId]: {
                                ...provisionalSession,
                                status: "error",
                                pendingSessionError: message,
                            },
                        },
                    };
                });
            };

            try {
                set({ selectedRuntimeId: nextRuntimeId });
                const setupStatus = await aiGetSetupStatus(nextRuntimeId);
                set((state) => ({
                    selectedRuntimeId: nextRuntimeId,
                    ...applyRuntimeSetupStatusPatch(state, setupStatus),
                }));
                if (setupStatus.onboardingRequired) {
                    markPendingSessionError(
                        setupStatus.message ??
                            getAuthenticationReconnectMessage(
                                nextRuntimeId,
                                runtimes,
                            ),
                    );
                    return provisionalSessionId ?? null;
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
                    markPendingSessionError(
                        getRuntimeReadyButDisabledMessage(
                            runtimes,
                            nextRuntimeId,
                        ),
                    );
                    return provisionalSessionId ?? null;
                }

                const session = await aiCreateSession(
                    nextRuntimeId,
                    useVaultStore.getState().vaultPath,
                );
                const migrated =
                    provisionalSessionId &&
                    migrateSessionLocalState(
                        provisionalSessionId,
                        {
                            ...session,
                            isPendingSessionCreation: false,
                            pendingSessionError: null,
                        },
                        (state) =>
                            Boolean(
                                state.sessionsById[provisionalSessionId]
                                    ?.isPendingSessionCreation,
                            ),
                    );
                if (!migrated) {
                    get().upsertSession(session, true);
                }
                await persistSessionNow(session);

                registerOpenEditorBaselines(session.sessionId);

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
                return session.sessionId;
            } catch (error) {
                const message = getAiErrorMessage(
                    error,
                    "Failed to create a new session.",
                );
                if (provisionalSessionId) {
                    markPendingSessionError(message);
                } else {
                    get().applySessionError({
                        message,
                    });
                }
                if (isAuthenticationErrorMessage(message)) {
                    await get().refreshSetupStatus(nextRuntimeId);
                }
                return provisionalSessionId ?? null;
            }
        },

        renameSession: (sessionId, newTitle) => {
            const session = get().sessionsById[sessionId];
            if (!session) return;
            const trimmed = newTitle?.trim() || null;
            const updated = { ...session, customTitle: trimmed };
            set({
                sessionsById: { ...get().sessionsById, [sessionId]: updated },
            });
            scheduleSessionPersistence(updated);
        },

        deleteSession: async (sessionId) => {
            const vaultPath = useVaultStore.getState().vaultPath;
            const targetSession = get().sessionsById[sessionId];
            const historySessionId =
                targetSession?.historySessionId ?? sessionId;
            clearStaleStreamingCheck(sessionId);
            _pendingStopBySessionId.delete(sessionId);
            if (
                targetSession &&
                targetSession.runtimeState === "live" &&
                (targetSession.status === "streaming" ||
                    targetSession.status === "waiting_permission" ||
                    targetSession.status === "waiting_user_input")
            ) {
                await aiCancelTurn(sessionId).catch(() => {});
            }
            if (targetSession?.runtimeState === "live") {
                await aiDeleteRuntimeSession(sessionId).catch(() => {});
            }
            if (vaultPath) {
                await aiDeleteSessionHistory(vaultPath, historySessionId).catch(
                    () => {},
                );
            }
            deletePersistedHistoryCacheEntry(vaultPath, historySessionId);
            useEditorStore.getState().closeReview(sessionId);
            useEditorStore.getState().closeChat(sessionId);
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
            const nextTokenUsageBySessionId = removeSessionMapEntry(
                state.tokenUsageBySessionId,
                sessionId,
            );
            const nextActiveQueuedMessageBySessionId =
                cleanupDeferredQueuedMessagesBySessionId(
                    state.activeQueuedMessageBySessionId,
                    sessionId,
                    null,
                );
            const nextPausedQueueBySessionId = cleanupPausedQueueBySessionId(
                state.pausedQueueBySessionId,
                sessionId,
                null,
            );
            const nextInterruptedTurnStateBySessionId =
                cleanupInterruptedTurnStateBySessionId(
                    state.interruptedTurnStateBySessionId,
                    sessionId,
                    null,
                );
            const remainingIds = sortSessionIdsByRecency(nextSessionsById);
            const nextActiveId =
                state.activeSessionId === sessionId
                    ? (remainingIds[0] ?? null)
                    : state.activeSessionId;
            const nextLastFocusedSessionId =
                state.lastFocusedSessionId === sessionId
                    ? (nextActiveId ?? remainingIds[0] ?? null)
                    : state.lastFocusedSessionId;
            const nextSelectedRuntimeId =
                (nextActiveId
                    ? nextSessionsById[nextActiveId]?.runtimeId
                    : null) ?? state.selectedRuntimeId;
            set({
                sessionsById: nextSessionsById,
                sessionOrder: remainingIds,
                activeSessionId: nextActiveId,
                lastFocusedSessionId: nextLastFocusedSessionId,
                selectedRuntimeId: nextSelectedRuntimeId,
                composerPartsBySessionId: nextComposerPartsBySessionId,
                queuedMessagesBySessionId: cleanupQueuedMessagesBySessionId(
                    state.queuedMessagesBySessionId,
                    sessionId,
                    [],
                ),
                queuedMessageEditBySessionId: nextQueuedMessageEditBySessionId,
                tokenUsageBySessionId: nextTokenUsageBySessionId,
                activeQueuedMessageBySessionId:
                    nextActiveQueuedMessageBySessionId,
                pausedQueueBySessionId: nextPausedQueueBySessionId,
                interruptedTurnStateBySessionId:
                    nextInterruptedTurnStateBySessionId,
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
            _pendingStopBySessionId.clear();
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
            clearPersistedHistoryCache(vaultPath);
            // Close all review and chat tabs before clearing sessions
            const editor = useEditorStore.getState();
            for (const sessionId of Object.keys(get().sessionsById)) {
                editor.closeReview(sessionId);
                editor.closeChat(sessionId);
            }
            useChatTabsStore.getState().reset();
            _queueDrainLocks.clear();
            resetChatRowUiStore();
            set({
                sessionsById: {},
                sessionOrder: [],
                activeSessionId: null,
                lastFocusedSessionId: null,
                selectedRuntimeId: getDefaultRuntimeId(get().runtimes),
                composerPartsBySessionId: {},
                queuedMessagesBySessionId: {},
                queuedMessageEditBySessionId: {},
                activeQueuedMessageBySessionId: {},
                pausedQueueBySessionId: {},
                interruptedTurnStateBySessionId: {},
                tokenUsageBySessionId: {},
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

        attachVaultFile: (file, sessionId) => {
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
                            type: "file",
                            noteId: null,
                            label: file.fileName,
                            path: file.path,
                            filePath: file.path,
                            mimeType: file.mimeType ?? undefined,
                            status: "ready",
                        }),
                    }),
                ),
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

            const { startLine, endLine } = currentSelection;
            const appendSelectionToSession = (sessionId: string) => {
                const state = get();
                const currentParts =
                    state.composerPartsBySessionId[sessionId] ??
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
                        [sessionId]: nextParts,
                    },
                });
            };

            const preferredWorkspaceSessionId =
                getPreferredWorkspaceChatSessionIdForSession(
                    get().lastFocusedSessionId,
                );
            if (preferredWorkspaceSessionId) {
                appendSelectionToSession(preferredWorkspaceSessionId);
                return;
            }

            const activeSessionId = get().activeSessionId;
            if (activeSessionId) {
                const activeSession = get().sessionsById[activeSessionId];
                useEditorStore.getState().openChat(activeSessionId, {
                    title: activeSession
                        ? getSessionTitle(activeSession)
                        : "Chat",
                    historySessionId: activeSession?.historySessionId ?? null,
                });
                appendSelectionToSession(activeSessionId);
                return;
            }

            void (async () => {
                const beforeSessionIds = new Set(
                    Object.keys(get().sessionsById),
                );
                await get().newSession();
                const nextState = get();
                const createdSessionId =
                    Object.keys(nextState.sessionsById).find(
                        (sessionId) => !beforeSessionIds.has(sessionId),
                    ) ?? nextState.activeSessionId;
                if (!createdSessionId) return;

                const createdSession =
                    nextState.sessionsById[createdSessionId] ?? null;
                useEditorStore.getState().openChat(createdSessionId, {
                    title: createdSession
                        ? getSessionTitle(createdSession)
                        : "Chat",
                    historySessionId:
                        createdSession?.historySessionId ?? null,
                });
                appendSelectionToSession(createdSessionId);
            })();
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

        setContextUsageBarEnabled: (enabled: boolean) => {
            set({ contextUsageBarEnabled: enabled });
            saveAiPreferences({ contextUsageBarEnabled: enabled });
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
                logWarn(
                    "chat-store",
                    "Failed to prune expired session histories",
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

        forkSession: async (sessionId) => {
            const state = get();
            const session = state.sessionsById[sessionId];
            if (!session) return;

            const vaultPath = useVaultStore.getState().vaultPath;
            if (!vaultPath) return;

            const sourceHistoryId =
                session.historySessionId ||
                getPersistedHistorySessionId(session.sessionId) ||
                session.sessionId;

            try {
                const newHistoryId = await aiForkSessionHistory(
                    vaultPath,
                    sourceHistoryId,
                );

                const forkedTitle = `${getSessionTitle(session)} (fork)`;
                const now = Date.now();
                const forkedSessionId = `persisted:${newHistoryId}`;

                const runtime =
                    state.runtimes.find(
                        (r) => r.runtime.id === session.runtimeId,
                    ) ?? state.runtimes[0];
                if (!runtime) return;

                const forkedSession: AIChatSession = {
                    ...session,
                    sessionId: forkedSessionId,
                    historySessionId: newHistoryId,
                    status: "idle",
                    isResumingSession: false,
                    isPersistedSession: true,
                    runtimeState: "persisted_only",
                    resumeContextPending:
                        (session.persistedMessageCount ?? 0) > 0,
                    messages: [],
                    attachments: [],
                    customTitle: forkedTitle,
                    persistedCreatedAt: now,
                    persistedUpdatedAt: now,
                    persistedPreview: session.persistedPreview ?? null,
                    persistedMessageCount: session.persistedMessageCount ?? 0,
                    loadedPersistedMessageStart: null,
                    isLoadingPersistedMessages: false,
                    activeWorkCycleId: null,
                    visibleWorkCycleId: null,
                };

                get().upsertSession(forkedSession, true);

                useChatTabsStore.getState().openSessionTab(forkedSessionId, {
                    activate: true,
                    historySessionId: newHistoryId,
                    runtimeId: session.runtimeId,
                });
                useEditorStore.getState().openChat(forkedSessionId, {
                    title: forkedTitle,
                    historySessionId: newHistoryId,
                });
            } catch (error) {
                logError("chat-store", "Failed to fork session", error);
            }
        },
    };
});

let chatRuntimeInitialized = false;
let stopChatStorageSync: (() => void) | null = null;
let stopChatVaultSync: (() => void) | null = null;
let aiPrefsSyncTimer: number | null = null;
let autoContextSyncTimer: number | null = null;

export function hydrateChatStorePreferences() {
    const prefs = getNormalizedAiPreferences();
    useChatStore.setState({
        autoContextEnabled: loadAutoContextPreference(
            useVaultStore.getState().vaultPath,
        ),
        requireCmdEnterToSend: prefs.requireCmdEnterToSend,
        contextUsageBarEnabled: prefs.contextUsageBarEnabled,
        composerFontSize: prefs.composerFontSize,
        chatFontSize: prefs.chatFontSize,
        composerFontFamily: prefs.composerFontFamily,
        chatFontFamily: prefs.chatFontFamily,
        editDiffZoom: prefs.editDiffZoom,
        historyRetentionDays: prefs.historyRetentionDays,
        screenshotRetentionSeconds: prefs.screenshotRetentionSeconds,
    });
}

export function initializeChatStoreRuntime() {
    if (chatRuntimeInitialized) return;
    chatRuntimeInitialized = true;

    hydrateChatStorePreferences();

    stopChatStorageSync = subscribeSafeStorage((event) => {
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
                              contextUsageBarEnabled:
                                  prefs.contextUsageBarEnabled,
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
    stopChatVaultSync = useVaultStore.subscribe((state, prev) => {
        if (state.vaultPath === prev.vaultPath) {
            return;
        }

        useChatStore.getState().syncAutoContextForVault(state.vaultPath);
    });
}

/** Flush any buffered message/thinking deltas synchronously (useful in tests). */
export { flushDeltasSync };

export function resetChatStore() {
    try {
        safeStorageRemoveItem(AI_RUNTIME_CACHE_KEY);
    } catch {
        // ignore
    }
    _persistedHistoryCacheVaultPath = null;
    _persistedHistoryCacheBySessionId.clear();
    const prefs = getNormalizedAiPreferences();
    _queueDrainLocks.clear();
    _pendingStopBySessionId.clear();
    _pendingSessionPersistence.clear();
    clearTrackedPersistedReconciliationTimers();
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
        lastFocusedSessionId: null,
        selectedRuntimeId: null,
        isInitializing: false,
        notePickerOpen: false,
        autoContextEnabled: loadAutoContextPreference(
            useVaultStore.getState().vaultPath,
        ),
        requireCmdEnterToSend: prefs.requireCmdEnterToSend,
        contextUsageBarEnabled: prefs.contextUsageBarEnabled,
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
        activeQueuedMessageBySessionId: {},
        pausedQueueBySessionId: {},
        interruptedTurnStateBySessionId: {},
        tokenUsageBySessionId: {},
    });
}

export function disposeChatStoreRuntime() {
    stopChatStorageSync?.();
    stopChatVaultSync?.();
    stopChatStorageSync = null;
    stopChatVaultSync = null;
    if (typeof window !== "undefined" && aiPrefsSyncTimer != null) {
        window.clearTimeout(aiPrefsSyncTimer);
    }
    if (typeof window !== "undefined" && autoContextSyncTimer != null) {
        window.clearTimeout(autoContextSyncTimer);
    }
    aiPrefsSyncTimer = null;
    autoContextSyncTimer = null;
    chatRuntimeInitialized = false;
    _pendingStopBySessionId.clear();
    clearTrackedPersistedReconciliationTimers();
}
