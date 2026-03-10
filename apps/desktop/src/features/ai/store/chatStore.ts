import { create } from "zustand";
import {
    aiCancelTurn,
    aiCreateSession,
    aiDeleteSessionHistory,
    aiDeleteAllSessionHistories,
    aiGetSetupStatus,
    aiListSessions,
    aiListRuntimes,
    aiLoadSession,
    aiLoadSessionHistories,
    aiPruneSessionHistories,
    aiRespondPermission,
    aiSaveSessionHistory,
    aiSendMessage,
    aiStartAuth,
    aiSetConfigOption,
    aiSetMode,
    aiSetModel,
    aiUpdateSetup,
} from "../api";
import { useEditorStore } from "../../../app/store/editorStore";
import { useVaultStore } from "../../../app/store/vaultStore";
import {
    createEmptyComposerParts,
    serializeComposerParts,
} from "../composerParts";
import type {
    AIChatAttachment,
    AIChatMessage,
    AIChatMessageKind,
    AIChatNoteSummary,
    AIChatRole,
    AIChatSession,
    AIComposerPart,
    AIPermissionRequestPayload,
    AIToolActivityPayload,
    AIRuntimeConnectionState,
    AIRuntimeDescriptor,
    AIRuntimeSetupStatus,
    AISessionErrorPayload,
    PersistedSessionHistory,
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
    historyRetentionDays?: number;
}

interface AIRuntimeCatalogSnapshot {
    models: AIRuntimeDescriptor["models"];
    modes: AIRuntimeDescriptor["modes"];
    configOptions: AIRuntimeDescriptor["configOptions"];
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
    historyRetentionDays: number;
    composerPartsBySessionId: Record<string, AIComposerPart[]>;
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
    applyPermissionRequest: (payload: AIPermissionRequestPayload) => void;
    setActiveSession: (sessionId: string) => void;
    resumeSession: (sessionId: string) => Promise<string | null>;
    loadSession: (sessionId: string) => Promise<void>;
    setModel: (modelId: string) => Promise<void>;
    setMode: (modeId: string) => Promise<void>;
    setConfigOption: (optionId: string, value: string) => Promise<void>;
    setComposerParts: (parts: AIComposerPart[]) => void;
    sendMessage: () => Promise<void>;
    stopStreaming: () => Promise<void>;
    respondPermission: (requestId: string, optionId?: string) => Promise<void>;
    newSession: (runtimeId?: string) => Promise<void>;
    deleteSession: (sessionId: string) => Promise<void>;
    deleteAllSessions: () => Promise<void>;
    attachNote: (note: AIChatNoteSummary) => void;
    attachFolder: (folderPath: string, name: string) => void;
    attachCurrentNote: (note: AIChatNoteSummary | null) => void;
    attachSelection: (note: AIChatNoteSummary | null) => void;
    removeAttachment: (attachmentId: string) => void;
    clearAttachments: () => void;
    toggleAutoContext: () => void;
    toggleRequireCmdEnterToSend: () => void;
    setComposerFontSize: (size: number) => void;
    setChatFontSize: (size: number) => void;
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

function normalizeAiErrorMessage(message: string) {
    if (message.includes("No hay vault abierto")) {
        return "Open a vault before starting a chat.";
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
    const activeNoteId = activeTab?.noteId ?? null;
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
            id: `auto:selection:${currentSelection.noteId}:${currentSelection.from}:${currentSelection.to}`,
            type: "selection",
            noteId: currentSelection.noteId,
            label: `${activeNote.title} selection`,
            path: activeNote.path,
            content: currentSelection.text,
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
        .filter((message) => message.kind !== "permission")
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
    return session;
}

function getDefaultRuntimeId(runtimes: AIRuntimeDescriptor[]) {
    return runtimes[0]?.runtime.id ?? null;
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

function scheduleStaleStreamingCheck(sessionId: string) {
    clearStaleStreamingCheck(sessionId);
    _staleTimers.set(
        sessionId,
        setTimeout(() => {
            _staleTimers.delete(sessionId);
            useChatStore.setState((s) => {
                const sess = s.sessionsById[sessionId];
                if (!sess || sess.status !== "streaming") return s;
                return {
                    sessionsById: {
                        ...s.sessionsById,
                        [sessionId]: {
                            ...sess,
                            status: "idle",
                            messages: sess.messages.map((m) =>
                                m.inProgress ? { ...m, inProgress: false } : m,
                            ),
                        },
                    },
                };
            });

            const updated = useChatStore.getState().sessionsById[sessionId];
            if (updated) persistSession(updated);
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

function persistSession(session: AIChatSession) {
    const vaultPath = useVaultStore.getState().vaultPath;
    if (!vaultPath || session.messages.length === 0) return;

    const historyRetentionDays = useChatStore.getState().historyRetentionDays;
    aiSaveSessionHistory(vaultPath, toPersistedHistory(session))
        .then(() =>
            historyRetentionDays > 0
                ? aiPruneSessionHistories(vaultPath, historyRetentionDays)
                : undefined,
        )
        .catch((error) =>
            console.warn("Failed to persist session history:", error),
        );
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
    }));
}

export const useChatStore = create<ChatStore>((set, get) => ({
    runtimeConnection: INITIAL_RUNTIME_CONNECTION,
    setupStatus: null,
    runtimes: [],
    sessionsById: {},
    sessionOrder: [],
    activeSessionId: null,
    notePickerOpen: false,
    autoContextEnabled: loadAiPreferences().autoContextEnabled !== false,
    requireCmdEnterToSend: loadAiPreferences().requireCmdEnterToSend === true,
    composerFontSize: loadAiPreferences().composerFontSize ?? 14,
    chatFontSize: loadAiPreferences().chatFontSize ?? 20,
    historyRetentionDays: loadAiPreferences().historyRetentionDays ?? 0,
    composerPartsBySessionId: {},

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
            const runtimes = hydrateRuntimesFromCache(await aiListRuntimes());

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
            let hydratedRuntimes = hydrateRuntimesFromSessions(
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
                        await aiPruneSessionHistories(vaultPath, retentionDays);
                    }
                    histories = await aiLoadSessionHistories(vaultPath);
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
                        const existing = state.sessionsById[session.sessionId];
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
                        if (liveHistoryIds.has(history.session_id)) continue;
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
                                    state.composerPartsBySessionId[sessionId] ??
                                    createEmptyComposerParts();
                                return accumulator;
                            },
                            { ...state.composerPartsBySessionId },
                        ),
                    };
                });

                const nextActiveSessionId = get().activeSessionId;
                if (
                    nextActiveSessionId &&
                    get().sessionsById[nextActiveSessionId]?.isPersistedSession
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
            set({ setupStatus });
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
            set({ setupStatus });

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
                set({ setupStatus });
            }

            const setupStatus = await aiStartAuth(
                input.methodId,
                useVaultStore.getState().vaultPath,
            );
            set({ setupStatus });

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

    upsertSession: (session, activate = false) =>
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

            return {
                runtimes: nextRuntimes,
                sessionsById: {
                    ...state.sessionsById,
                    [session.sessionId]: nextSession,
                },
                sessionOrder: activate
                    ? touchSessionOrder(state.sessionOrder, session.sessionId)
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
        }),

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
                sessionOrder: touchSessionOrder(state.sessionOrder, session_id),
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

            // Don't create the message yet — it will be created lazily
            // on the first delta so it appears in chronological order
            // (after thinking and tool messages).
            return {
                sessionsById: {
                    ...state.sessionsById,
                    [session_id]: {
                        ...session,
                        status: "streaming",
                    },
                },
                sessionOrder: touchSessionOrder(state.sessionOrder, session_id),
            };
        });
    },

    applyMessageDelta: ({ session_id, message_id, delta }) => {
        scheduleStaleStreamingCheck(session_id);
        set((state) => {
            const session = state.sessionsById[session_id];
            if (!session) return state;

            const messages = session.messages;
            const lastMsg = messages[messages.length - 1];

            // If the last message is an in-progress assistant text, append to it
            if (
                lastMsg &&
                lastMsg.role === "assistant" &&
                lastMsg.kind === "text" &&
                lastMsg.inProgress
            ) {
                return {
                    sessionsById: {
                        ...state.sessionsById,
                        [session_id]: {
                            ...session,
                            messages: messages.map((m, i) =>
                                i === messages.length - 1
                                    ? { ...m, content: `${m.content}${delta}` }
                                    : m,
                            ),
                        },
                    },
                    sessionOrder: touchSessionOrder(
                        state.sessionOrder,
                        session_id,
                    ),
                };
            }

            // Otherwise create a new text segment at the end
            // (tools/thinking appeared since last text, so we split)
            const idTaken = messages.some((m) => m.id === message_id);
            return {
                sessionsById: {
                    ...state.sessionsById,
                    [session_id]: {
                        ...session,
                        messages: [
                            ...messages,
                            {
                                id: idTaken
                                    ? `${message_id}:${Date.now()}`
                                    : message_id,
                                role: "assistant" as const,
                                kind: "text" as const,
                                content: delta,
                                title: "Assistant",
                                timestamp: Date.now(),
                                inProgress: true,
                            },
                        ],
                    },
                },
                sessionOrder: touchSessionOrder(state.sessionOrder, session_id),
            };
        });
    },

    applyMessageCompleted: ({ session_id }) => {
        clearStaleStreamingCheck(session_id);
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
                        messages: session.messages.map((message) =>
                            message.inProgress
                                ? { ...message, inProgress: false }
                                : message,
                        ),
                    },
                },
                sessionOrder: touchSessionOrder(state.sessionOrder, session_id),
            };
        });

        const updatedSession = get().sessionsById[session_id];
        if (updatedSession) persistSession(updatedSession);
    },

    applyThinkingStarted: ({ session_id, message_id }) => {
        scheduleStaleStreamingCheck(session_id);
        set((state) => {
            const session = state.sessionsById[session_id];
            if (!session) return state;

            const exists = session.messages.some(
                (message) => message.id === message_id,
            );
            if (exists) return state;

            return {
                sessionsById: {
                    ...state.sessionsById,
                    [session_id]: {
                        ...session,
                        status: "streaming",
                        messages: [
                            ...session.messages,
                            {
                                id: message_id,
                                role: "assistant",
                                kind: "thinking",
                                content: "",
                                title: "Thinking",
                                timestamp: Date.now(),
                                inProgress: true,
                            },
                        ],
                    },
                },
                sessionOrder: touchSessionOrder(state.sessionOrder, session_id),
            };
        });
    },

    applyThinkingDelta: ({ session_id, message_id, delta }) => {
        scheduleStaleStreamingCheck(session_id);
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
                                      content: `${message.content}${delta}`,
                                      inProgress: true,
                                  }
                                : message,
                        ),
                    },
                },
                sessionOrder: touchSessionOrder(state.sessionOrder, session_id),
            };
        });
    },

    applyThinkingCompleted: ({ session_id, message_id }) => {
        scheduleStaleStreamingCheck(session_id);
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
                sessionOrder: touchSessionOrder(state.sessionOrder, session_id),
            };
        });
    },

    applyToolActivity: (payload) => {
        scheduleStaleStreamingCheck(payload.session_id);
        set((state) => {
            const session = state.sessionsById[payload.session_id];
            if (!session) return state;

            const messageId = `tool:${payload.tool_call_id}`;
            const nextMessage: AIChatMessage = {
                id: messageId,
                role: "assistant",
                kind: "tool",
                title: payload.title,
                content: payload.summary ?? payload.title,
                timestamp: Date.now(),
                meta: {
                    tool: payload.kind,
                    status: payload.status,
                    target: payload.target ?? null,
                },
            };

            const exists = session.messages.some(
                (message) => message.id === messageId,
            );

            return {
                sessionsById: {
                    ...state.sessionsById,
                    [payload.session_id]: {
                        ...session,
                        messages: exists
                            ? session.messages.map((message) =>
                                  message.id === messageId
                                      ? nextMessage
                                      : message,
                              )
                            : [...session.messages, nextMessage],
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

            const messageId = `permission:${payload.request_id}`;
            const nextMessage: AIChatMessage = {
                id: messageId,
                role: "assistant",
                kind: "permission",
                title: "Permission request",
                content: payload.title,
                timestamp: Date.now(),
                permissionRequestId: payload.request_id,
                permissionOptions: payload.options,
                meta: {
                    status: "pending",
                    target: payload.target ?? null,
                },
            };

            const exists = session.messages.some(
                (message) => message.id === messageId,
            );

            return {
                sessionsById: {
                    ...state.sessionsById,
                    [payload.session_id]: {
                        ...session,
                        status: "waiting_permission",
                        messages: exists
                            ? session.messages.map((message) =>
                                  message.id === messageId
                                      ? nextMessage
                                      : message,
                              )
                            : [...session.messages, nextMessage],
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
                supportsModelSelection(resumedSession, latestSession.modelId)
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

            const migratedSession: AIChatSession = {
                ...resumedSession,
                historySessionId: latestSession.historySessionId,
                messages: latestSession.messages,
                attachments: latestSession.attachments,
                effortsByModel:
                    resumedSession.effortsByModel ??
                    latestSession.effortsByModel ??
                    {},
                isPersistedSession: false,
                isResumingSession: false,
                resumeContextPending: latestSession.messages.length > 0,
            };

            set((currentState) => {
                const previousParts =
                    currentState.composerPartsBySessionId[sessionId] ??
                    createEmptyComposerParts();
                const nextSessionsById = { ...currentState.sessionsById };
                delete nextSessionsById[sessionId];

                const nextComposerParts = {
                    ...currentState.composerPartsBySessionId,
                };
                delete nextComposerParts[sessionId];
                nextComposerParts[migratedSession.sessionId] = previousParts;

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
                };
            });

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
                sessionOrder: touchSessionOrder(state.sessionOrder, sessionId),
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
                modelConfig.options.some((option) => option.value === modelId)
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
                message: getAiErrorMessage(error, "Failed to update the mode."),
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
                              configOptions: currentSession.configOptions.map(
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

            return {
                composerPartsBySessionId: {
                    ...state.composerPartsBySessionId,
                    [activeSessionId]: parts,
                },
            };
        }),

    sendMessage: async () => {
        let { activeSessionId, sessionsById, composerPartsBySessionId } = get();
        if (!activeSessionId) return;

        let session = sessionsById[activeSessionId];
        if (
            !session ||
            session.status === "streaming" ||
            session.status === "waiting_permission"
        ) {
            return;
        }

        if (session.isPersistedSession) {
            const resumedSessionId = await get().resumeSession(activeSessionId);
            if (!resumedSessionId) return;

            const resumedState = get();
            activeSessionId = resumedSessionId;
            sessionsById = resumedState.sessionsById;
            composerPartsBySessionId = resumedState.composerPartsBySessionId;
            session = sessionsById[activeSessionId];
            if (!session) return;
        }

        const composerParts =
            composerPartsBySessionId[activeSessionId] ??
            createEmptyComposerParts();
        const prompt = serializeComposerParts(composerParts);
        const trimmed = prompt.trim();
        if (!trimmed) return;
        const promptToSend = buildPromptWithResumeContext(session, trimmed);
        const turnAttachments = [
            ...session.attachments,
            ...getAutoContextAttachments(session.attachments),
        ];

        const userMessage = createTextMessage("user", trimmed);

        set((state) => ({
            sessionsById: {
                ...state.sessionsById,
                [activeSessionId]: {
                    ...state.sessionsById[activeSessionId]!,
                    status: "streaming",
                    messages: [
                        ...state.sessionsById[activeSessionId]!.messages,
                        userMessage,
                    ],
                },
            },
            sessionOrder: touchSessionOrder(
                state.sessionOrder,
                activeSessionId,
            ),
            composerPartsBySessionId: {
                ...state.composerPartsBySessionId,
                [activeSessionId]: createEmptyComposerParts(),
            },
        }));

        // Persist user message immediately
        const afterSend = get().sessionsById[activeSessionId];
        if (afterSend) persistSession(afterSend);

        try {
            const nextSession = await aiSendMessage(
                activeSessionId,
                promptToSend,
                turnAttachments,
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
            get().applySessionError({
                session_id: activeSessionId,
                message,
            });
            if (isAuthenticationErrorMessage(message)) {
                await get().refreshSetupStatus();
            }
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
        set((state) => {
            const sess = state.sessionsById[activeSessionId];
            if (!sess || sess.status === "idle") return state;
            return {
                sessionsById: {
                    ...state.sessionsById,
                    [activeSessionId]: {
                        ...sess,
                        status: "idle",
                        messages: sess.messages.map((m) =>
                            m.inProgress ? { ...m, inProgress: false } : m,
                        ),
                    },
                },
            };
        });
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

                updateModel.then((s) => get().upsertSession(s)).catch(() => {});
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
        if (vaultPath) {
            await aiDeleteSessionHistory(vaultPath, sessionId).catch(() => {});
        }
        const state = get();
        const nextSessionsById = { ...state.sessionsById };
        delete nextSessionsById[sessionId];
        const remainingIds = sortSessionIdsByRecency(nextSessionsById);
        const nextActiveId =
            state.activeSessionId === sessionId
                ? (remainingIds[0] ?? null)
                : state.activeSessionId;
        set({ sessionsById: nextSessionsById, activeSessionId: nextActiveId });
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
        set({ sessionsById: {}, activeSessionId: null });
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

    attachSelection: (note) => {
        if (!note) return;

        set((state) => ({
            sessionsById: updateActiveSession(state, (session) => ({
                ...session,
                attachments: withUniqueAttachment(session.attachments, {
                    ...createAttachment("selection", note),
                    label: `${note.title} selection`,
                }),
            })),
        }));
    },

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

    setHistoryRetentionDays: async (days) => {
        const next = Math.max(0, Math.round(days));
        set({ historyRetentionDays: next });
        saveAiPreferences({ historyRetentionDays: next });

        if (next <= 0) return;
        try {
            await pruneSessionHistoriesForCurrentVault(next);
            await get().initialize();
        } catch (error) {
            console.warn("Failed to prune expired session histories:", error);
        }
    },

    openNotePicker: () => set({ notePickerOpen: true }),

    closeNotePicker: () => set({ notePickerOpen: false }),
}));

// Sync AI preferences when another window (e.g. standalone Settings) updates localStorage
if (typeof window !== "undefined") {
    window.addEventListener("storage", (event) => {
        if (event.key === AI_PREFS_KEY) {
            const prefs = loadAiPreferences();
            useChatStore.setState({
                autoContextEnabled: prefs.autoContextEnabled !== false,
                requireCmdEnterToSend: prefs.requireCmdEnterToSend === true,
                composerFontSize: prefs.composerFontSize ?? 14,
                chatFontSize: prefs.chatFontSize ?? 20,
                historyRetentionDays: prefs.historyRetentionDays ?? 0,
            });
        }
    });
}

export function resetChatStore() {
    try {
        localStorage.removeItem(AI_RUNTIME_CACHE_KEY);
    } catch {
        // ignore
    }
    useChatStore.setState({
        runtimeConnection: INITIAL_RUNTIME_CONNECTION,
        setupStatus: null,
        runtimes: [],
        sessionsById: {},
        sessionOrder: [],
        activeSessionId: null,
        notePickerOpen: false,
        composerPartsBySessionId: {},
    });
}
