import { create } from "zustand";
import {
    aiCancelTurn,
    aiCreateSession,
    aiGetSetupStatus,
    aiListSessions,
    aiListRuntimes,
    aiLoadSession,
    aiLoadSessionHistories,
    aiRespondPermission,
    aiSaveSessionHistory,
    aiSendMessage,
    aiStartAuth,
    aiSetConfigOption,
    aiSetMode,
    aiSetModel,
    aiUpdateSetup,
} from "../api";
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

interface AiPreferences {
    modelId?: string;
    modeId?: string;
    configOptions?: Record<string, string>;
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

interface ChatStore {
    runtimeConnection: AIRuntimeConnectionState;
    setupStatus: AIRuntimeSetupStatus | null;
    runtimes: AIRuntimeDescriptor[];
    sessionsById: Record<string, AIChatSession>;
    sessionOrder: string[];
    activeSessionId: string | null;
    notePickerOpen: boolean;
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
    applyMessageStarted: (payload: { session_id: string; message_id: string }) => void;
    applyMessageDelta: (payload: {
        session_id: string;
        message_id: string;
        delta: string;
    }) => void;
    applyMessageCompleted: (payload: {
        session_id: string;
        message_id: string;
    }) => void;
    applyThinkingStarted: (payload: { session_id: string; message_id: string }) => void;
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
    loadSession: (sessionId: string) => Promise<void>;
    setModel: (modelId: string) => Promise<void>;
    setMode: (modeId: string) => Promise<void>;
    setConfigOption: (optionId: string, value: string) => Promise<void>;
    setComposerParts: (parts: AIComposerPart[]) => void;
    sendMessage: () => Promise<void>;
    stopStreaming: () => Promise<void>;
    respondPermission: (requestId: string, optionId?: string) => Promise<void>;
    newSession: (runtimeId?: string) => Promise<void>;
    attachNote: (note: AIChatNoteSummary) => void;
    attachFolder: (folderPath: string, name: string) => void;
    attachCurrentNote: (note: AIChatNoteSummary | null) => void;
    attachSelection: (note: AIChatNoteSummary | null) => void;
    removeAttachment: (attachmentId: string) => void;
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
        return {
            ...incoming,
            // The backend never resets session status to "idle" after streaming,
            // so cap stale "streaming" for freshly loaded sessions.
            status: incoming.status === "streaming" ? "idle" : incoming.status,
            messages: incoming.messages ?? [],
            attachments: incoming.attachments ?? [],
        };
    }

    // Never let upsertSession set status to "streaming".
    // The backend session status stays "streaming" forever after a prompt starts
    // (it's never reset to "idle"). So "streaming" from the backend is always stale.
    // All legitimate "streaming" transitions happen through direct event handlers:
    // sendMessage (optimistic), respondPermission (optimistic),
    // applyMessageStarted, applyThinkingStarted.
    const status =
        incoming.status === "streaming" ? existing.status : incoming.status;

    return {
        ...existing,
        ...incoming,
        status,
        messages: existing.messages,
        attachments: existing.attachments,
    };
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
        session_id: session.sessionId,
        model_id: session.modelId,
        mode_id: session.modeId,
        created_at: timestamps.length ? Math.min(...timestamps) : Date.now(),
        updated_at: timestamps.length ? Math.max(...timestamps) : Date.now(),
        messages,
    };
}

function persistSession(session: AIChatSession) {
    const vaultPath = useVaultStore.getState().vaultPath;
    if (!vaultPath || session.messages.length === 0) return;

    aiSaveSessionHistory(vaultPath, toPersistedHistory(session)).catch(
        (error) => console.warn("Failed to persist session history:", error),
    );
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
            const runtimes = await aiListRuntimes();

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

            let persistedBySessionId = new Map<string, PersistedSessionHistory>();
            if (vaultPath) {
                try {
                    const histories = await aiLoadSessionHistories(vaultPath);
                    persistedBySessionId = new Map(
                        histories.map((h) => [h.session_id, h]),
                    );
                } catch {
                    // Disk histories unavailable, continue without them
                }
            }

            if (sessions.length) {
                set((state) => ({
                    sessionsById: sessions.reduce<Record<string, AIChatSession>>(
                        (accumulator, session) => {
                            const existing = state.sessionsById[session.sessionId];
                            const merged = mergeSession(existing, session);

                            // Restore messages from disk if none in memory
                            if (merged.messages.length === 0) {
                                const persisted = persistedBySessionId.get(
                                    session.sessionId,
                                );
                                if (persisted) {
                                    merged.messages =
                                        restoreMessagesFromHistory(persisted);
                                }
                            }

                            accumulator[session.sessionId] = merged;
                            return accumulator;
                        },
                        {},
                    ),
                    sessionOrder: sessions.map((session) => session.sessionId),
                    activeSessionId:
                        state.activeSessionId && state.sessionsById[state.activeSessionId]
                            ? state.activeSessionId
                            : sessions[0]?.sessionId ?? null,
                    composerPartsBySessionId: sessions.reduce<
                        Record<string, AIComposerPart[]>
                    >((accumulator, session) => {
                        accumulator[session.sessionId] =
                            state.composerPartsBySessionId[session.sessionId] ??
                            createEmptyComposerParts();
                        return accumulator;
                    }, { ...state.composerPartsBySessionId }),
                }));
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
                    message: getAiErrorMessage(error, "Failed to load AI runtimes."),
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
                    message: getAiErrorMessage(error, "Failed to check the AI setup."),
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
                    await state.newSession(getDefaultRuntimeId(state.runtimes) ?? undefined);
                }
            }
        } catch (error) {
            set({
                runtimeConnection: {
                    status: "error",
                    message: getAiErrorMessage(error, "Failed to save the AI setup."),
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

            const setupStatus = await aiStartAuth(input.methodId, useVaultStore.getState().vaultPath);
            set({ setupStatus });

            if (!setupStatus.onboardingRequired) {
                const state = get();
                if (!state.activeSessionId && state.runtimes.length) {
                    await state.newSession(getDefaultRuntimeId(state.runtimes) ?? undefined);
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

            const nextSession = mergeSession(existing, session);

            return {
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
            return {
                setupStatus: nextSetupStatus,
                sessionsById: {
                    ...state.sessionsById,
                    [session_id]: {
                        ...session,
                        status: "error",
                        messages: [...session.messages, createErrorMessage(message)],
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

    applyMessageStarted: ({ session_id }) =>
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
        }),

    applyMessageDelta: ({ session_id, message_id, delta }) =>
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
                    sessionOrder: touchSessionOrder(state.sessionOrder, session_id),
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
        }),

    applyMessageCompleted: ({ session_id }) => {
        set((state) => {
            const session = state.sessionsById[session_id];
            if (!session) return state;

            return {
                sessionsById: {
                    ...state.sessionsById,
                    [session_id]: {
                        ...session,
                        status: "idle",
                        // Mark all in-progress assistant text segments as done
                        messages: session.messages.map((message) =>
                            message.role === "assistant" &&
                            message.kind === "text" &&
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

    applyThinkingStarted: ({ session_id, message_id }) =>
        set((state) => {
            const session = state.sessionsById[session_id];
            if (!session) return state;

            const exists = session.messages.some((message) => message.id === message_id);
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
        }),

    applyThinkingDelta: ({ session_id, message_id, delta }) =>
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
        }),

    applyThinkingCompleted: ({ session_id, message_id }) =>
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
        }),

    applyToolActivity: (payload) =>
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

            const exists = session.messages.some((message) => message.id === messageId);

            return {
                sessionsById: {
                    ...state.sessionsById,
                    [payload.session_id]: {
                        ...session,
                        messages: exists
                            ? session.messages.map((message) =>
                                  message.id === messageId ? nextMessage : message,
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
                    target: payload.target ?? null,
                },
            };

            const exists = session.messages.some((message) => message.id === messageId);

            return {
                sessionsById: {
                    ...state.sessionsById,
                    [payload.session_id]: {
                        ...session,
                        status: "waiting_permission",
                        messages: exists
                            ? session.messages.map((message) =>
                                  message.id === messageId ? nextMessage : message,
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

    loadSession: async (sessionId) => {
        const existing = get().sessionsById[sessionId];
        if (existing) {
            set((state) => ({
                activeSessionId: sessionId,
                sessionOrder: touchSessionOrder(state.sessionOrder, sessionId),
            }));
        }

        try {
            const session = await aiLoadSession(sessionId);
            get().upsertSession(session, true);
        } catch (error) {
            get().applySessionError({
                session_id: sessionId,
                message:
                    getAiErrorMessage(error, "Failed to load the session."),
            });
        }
    },

    setModel: async (modelId) => {
        const { activeSessionId } = get();
        if (!activeSessionId) return;

        try {
            const session = await aiSetModel(activeSessionId, modelId);
            get().upsertSession(session);
            saveAiPreferences({ modelId });
        } catch (error) {
            get().applySessionError({
                session_id: activeSessionId,
                message:
                    getAiErrorMessage(error, "Failed to update the model."),
            });
        }
    },

    setMode: async (modeId) => {
        const { activeSessionId } = get();
        if (!activeSessionId) return;

        try {
            const session = await aiSetMode(activeSessionId, modeId);
            get().upsertSession(session);
            saveAiPreferences({ modeId });
        } catch (error) {
            get().applySessionError({
                session_id: activeSessionId,
                message:
                    getAiErrorMessage(error, "Failed to update the mode."),
            });
        }
    },

    setConfigOption: async (optionId, value) => {
        const { activeSessionId } = get();
        if (!activeSessionId) return;

        try {
            const session = await aiSetConfigOption(activeSessionId, optionId, value);
            get().upsertSession(session);
            saveConfigOptionPreference(optionId, value);
        } catch (error) {
            get().applySessionError({
                session_id: activeSessionId,
                message:
                    getAiErrorMessage(error, "Failed to update the session option."),
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
        const { activeSessionId, sessionsById, composerPartsBySessionId } = get();
        if (!activeSessionId) return;

        const session = sessionsById[activeSessionId];
        if (!session || session.status === "streaming") return;

        const composerParts =
            composerPartsBySessionId[activeSessionId] ?? createEmptyComposerParts();
        const prompt = serializeComposerParts(composerParts);
        const trimmed = prompt.trim();
        if (!trimmed) return;

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
            sessionOrder: touchSessionOrder(state.sessionOrder, activeSessionId),
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
                trimmed,
                session.attachments,
            );
            get().upsertSession(nextSession);
        } catch (error) {
            const message = getAiErrorMessage(error, "Failed to send the message.");
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

        try {
            const session = await aiCancelTurn(activeSessionId);
            get().upsertSession(session);
        } catch (error) {
            get().applySessionError({
                session_id: activeSessionId,
                message:
                    getAiErrorMessage(error, "Failed to stop the current turn."),
            });
        }
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
                    [activeSessionId]: { ...session, status: "streaming" },
                },
            };
        });

        try {
            const session = await aiRespondPermission(activeSessionId, requestId, optionId);
            get().upsertSession(session);
        } catch (error) {
            get().applySessionError({
                session_id: activeSessionId,
                message:
                    getAiErrorMessage(
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
            const session = await aiCreateSession(nextRuntimeId, useVaultStore.getState().vaultPath);
            get().upsertSession(session, true);

            // Restore saved preferences
            const prefs = loadAiPreferences();
            const sid = session.sessionId;
            const availableModels = session.models.map((m) => m.id);
            const availableModes = session.modes
                .filter((m) => !m.disabled)
                .map((m) => m.id);

            if (prefs.modelId && prefs.modelId !== session.modelId && availableModels.includes(prefs.modelId)) {
                aiSetModel(sid, prefs.modelId)
                    .then((s) => get().upsertSession(s))
                    .catch(() => {});
            }
            if (prefs.modeId && prefs.modeId !== session.modeId && availableModes.includes(prefs.modeId)) {
                aiSetMode(sid, prefs.modeId)
                    .then((s) => get().upsertSession(s))
                    .catch(() => {});
            }
            if (prefs.configOptions) {
                for (const [optionId, value] of Object.entries(prefs.configOptions)) {
                    const option = session.configOptions.find((o) => o.id === optionId);
                    if (option && option.value !== value && option.options.some((o) => o.value === value)) {
                        aiSetConfigOption(sid, optionId, value)
                            .then((s) => get().upsertSession(s))
                            .catch(() => {});
                    }
                }
            }
        } catch (error) {
            const message = getAiErrorMessage(error, "Failed to create a new session.");
            get().applySessionError({
                message,
            });
            if (isAuthenticationErrorMessage(message)) {
                await get().refreshSetupStatus();
            }
        }
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
                    label: `📁 ${name}`,
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

    openNotePicker: () => set({ notePickerOpen: true }),

    closeNotePicker: () => set({ notePickerOpen: false }),
}));

export function resetChatStore() {
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
