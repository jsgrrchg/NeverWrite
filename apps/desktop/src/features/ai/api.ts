import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
    AIBackendRuntimeDescriptorPayload,
    AIBackendRuntimeSetupStatusPayload,
    AIBackendSessionPayload,
    AIChatAttachment,
    AIChatSession,
    AIConfigOption,
    AIMessageCompletedPayload,
    AIMessageDeltaPayload,
    AIMessageStartedPayload,
    AIPermissionRequestPayload,
    AIToolActivityPayload,
    AIRuntimeDescriptor,
    AIRuntimeSetupStatus,
    AISessionErrorPayload,
    PersistedSessionHistory,
} from "./types";

export const AI_SESSION_CREATED_EVENT = "ai://session-created";
export const AI_SESSION_UPDATED_EVENT = "ai://session-updated";
export const AI_SESSION_ERROR_EVENT = "ai://session-error";
export const AI_MESSAGE_STARTED_EVENT = "ai://message-started";
export const AI_MESSAGE_DELTA_EVENT = "ai://message-delta";
export const AI_MESSAGE_COMPLETED_EVENT = "ai://message-completed";
export const AI_THINKING_STARTED_EVENT = "ai://thinking-started";
export const AI_THINKING_DELTA_EVENT = "ai://thinking-delta";
export const AI_THINKING_COMPLETED_EVENT = "ai://thinking-completed";
export const AI_TOOL_ACTIVITY_EVENT = "ai://tool-activity";
export const AI_PERMISSION_REQUEST_EVENT = "ai://permission-request";

function normalizeConfigOption(
    option: AIBackendSessionPayload["config_options"][number],
): AIConfigOption {
    return {
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
    };
}

export function normalizeBackendSession(
    session: AIBackendSessionPayload,
): AIChatSession {
    return {
        sessionId: session.session_id,
        historySessionId: session.session_id,
        runtimeId: session.runtime_id,
        modelId: session.model_id,
        modeId: session.mode_id,
        status: session.status,
        isResumingSession: false,
        effortsByModel: session.efforts_by_model ?? {},
        models: session.models.map((model) => ({
            id: model.id,
            runtimeId: model.runtime_id,
            name: model.name,
            description: model.description,
        })),
        modes: session.modes.map((mode) => ({
            id: mode.id,
            runtimeId: mode.runtime_id,
            name: mode.name,
            description: mode.description,
            disabled: mode.disabled,
        })),
        configOptions: session.config_options.map(normalizeConfigOption),
        messages: [],
        attachments: [],
        isPersistedSession: false,
        resumeContextPending: false,
    };
}

function normalizeRuntimeDescriptor(
    descriptor: AIBackendRuntimeDescriptorPayload,
): AIRuntimeDescriptor {
    return {
        runtime: {
            id: descriptor.runtime.id,
            name: descriptor.runtime.name,
            description: descriptor.runtime.description,
            capabilities: descriptor.runtime.capabilities,
        },
        models: descriptor.models.map((model) => ({
            id: model.id,
            runtimeId: model.runtime_id,
            name: model.name,
            description: model.description,
        })),
        modes: descriptor.modes.map((mode) => ({
            id: mode.id,
            runtimeId: mode.runtime_id,
            name: mode.name,
            description: mode.description,
            disabled: mode.disabled,
        })),
        configOptions: descriptor.config_options.map(normalizeConfigOption),
    };
}

function normalizeRuntimeSetupStatus(
    status: AIBackendRuntimeSetupStatusPayload,
): AIRuntimeSetupStatus {
    return {
        runtimeId: status.runtime_id,
        binaryReady: status.binary_ready,
        binaryPath: status.binary_path ?? undefined,
        binarySource: status.binary_source,
        authReady: status.auth_ready,
        authMethod: status.auth_method ?? undefined,
        authMethods: status.auth_methods,
        onboardingRequired: status.onboarding_required,
        message: status.message ?? undefined,
    };
}

export async function aiListRuntimes() {
    const descriptors =
        await invoke<AIBackendRuntimeDescriptorPayload[]>("ai_list_runtimes");
    return descriptors.map(normalizeRuntimeDescriptor);
}

export async function aiListSessions(vaultPath: string | null) {
    const sessions = await invoke<AIBackendSessionPayload[]>(
        "ai_list_sessions",
        {
            vaultPath: vaultPath ?? null,
        },
    );
    return sessions.map(normalizeBackendSession);
}

export async function aiGetSetupStatus() {
    const status = await invoke<AIBackendRuntimeSetupStatusPayload>(
        "ai_get_setup_status",
    );
    return normalizeRuntimeSetupStatus(status);
}

export async function aiUpdateSetup(input: {
    customBinaryPath?: string;
    codexApiKey?: string;
    openaiApiKey?: string;
}) {
    const status = await invoke<AIBackendRuntimeSetupStatusPayload>(
        "ai_update_setup",
        {
            input: {
                custom_binary_path: input.customBinaryPath ?? null,
                codex_api_key: input.codexApiKey ?? null,
                openai_api_key: input.openaiApiKey ?? null,
            },
        },
    );
    return normalizeRuntimeSetupStatus(status);
}

export async function aiStartAuth(methodId: string, vaultPath: string | null) {
    const status = await invoke<AIBackendRuntimeSetupStatusPayload>(
        "ai_start_auth",
        {
            input: {
                method_id: methodId,
            },
            vaultPath: vaultPath ?? null,
        },
    );
    return normalizeRuntimeSetupStatus(status);
}

export async function aiLoadSession(sessionId: string) {
    const session = await invoke<AIBackendSessionPayload>("ai_load_session", {
        sessionId,
    });
    return normalizeBackendSession(session);
}

export async function aiCreateSession(
    runtimeId: string,
    vaultPath: string | null,
) {
    const session = await invoke<AIBackendSessionPayload>("ai_create_session", {
        runtimeId,
        vaultPath: vaultPath ?? null,
    });
    return normalizeBackendSession(session);
}

export async function aiSetModel(sessionId: string, modelId: string) {
    const session = await invoke<AIBackendSessionPayload>("ai_set_model", {
        sessionId,
        modelId,
    });
    return normalizeBackendSession(session);
}

export async function aiSetMode(sessionId: string, modeId: string) {
    const session = await invoke<AIBackendSessionPayload>("ai_set_mode", {
        sessionId,
        modeId,
    });
    return normalizeBackendSession(session);
}

export async function aiSetConfigOption(
    sessionId: string,
    optionId: string,
    value: string,
) {
    const session = await invoke<AIBackendSessionPayload>(
        "ai_set_config_option",
        {
            input: {
                session_id: sessionId,
                option_id: optionId,
                value,
            },
        },
    );
    return normalizeBackendSession(session);
}

export async function aiSendMessage(
    sessionId: string,
    content: string,
    attachments: AIChatAttachment[],
) {
    const session = await invoke<AIBackendSessionPayload>("ai_send_message", {
        sessionId,
        content,
        attachments,
    });
    return normalizeBackendSession(session);
}

export async function aiCancelTurn(sessionId: string) {
    const session = await invoke<AIBackendSessionPayload>("ai_cancel_turn", {
        sessionId,
    });
    return normalizeBackendSession(session);
}

export async function aiRespondPermission(
    sessionId: string,
    requestId: string,
    optionId?: string,
) {
    const session = await invoke<AIBackendSessionPayload>(
        "ai_respond_permission",
        {
            input: {
                session_id: sessionId,
                request_id: requestId,
                option_id: optionId ?? null,
            },
        },
    );
    return normalizeBackendSession(session);
}

export async function listenToAiSessionCreated(
    callback: (session: AIChatSession) => void,
): Promise<UnlistenFn> {
    return listen<AIBackendSessionPayload>(
        AI_SESSION_CREATED_EVENT,
        (event) => {
            callback(normalizeBackendSession(event.payload));
        },
    );
}

export async function listenToAiSessionUpdated(
    callback: (session: AIChatSession) => void,
): Promise<UnlistenFn> {
    return listen<AIBackendSessionPayload>(
        AI_SESSION_UPDATED_EVENT,
        (event) => {
            callback(normalizeBackendSession(event.payload));
        },
    );
}

export async function listenToAiSessionError(
    callback: (payload: AISessionErrorPayload) => void,
): Promise<UnlistenFn> {
    return listen<AISessionErrorPayload>(AI_SESSION_ERROR_EVENT, (event) => {
        callback(event.payload);
    });
}

export async function listenToAiMessageStarted(
    callback: (payload: AIMessageStartedPayload) => void,
): Promise<UnlistenFn> {
    return listen<AIMessageStartedPayload>(
        AI_MESSAGE_STARTED_EVENT,
        (event) => {
            callback(event.payload);
        },
    );
}

export async function listenToAiMessageDelta(
    callback: (payload: AIMessageDeltaPayload) => void,
): Promise<UnlistenFn> {
    return listen<AIMessageDeltaPayload>(AI_MESSAGE_DELTA_EVENT, (event) => {
        callback(event.payload);
    });
}

export async function listenToAiMessageCompleted(
    callback: (payload: AIMessageCompletedPayload) => void,
): Promise<UnlistenFn> {
    return listen<AIMessageCompletedPayload>(
        AI_MESSAGE_COMPLETED_EVENT,
        (event) => {
            callback(event.payload);
        },
    );
}

export async function listenToAiThinkingStarted(
    callback: (payload: AIMessageStartedPayload) => void,
): Promise<UnlistenFn> {
    return listen<AIMessageStartedPayload>(
        AI_THINKING_STARTED_EVENT,
        (event) => {
            callback(event.payload);
        },
    );
}

export async function listenToAiThinkingDelta(
    callback: (payload: AIMessageDeltaPayload) => void,
): Promise<UnlistenFn> {
    return listen<AIMessageDeltaPayload>(AI_THINKING_DELTA_EVENT, (event) => {
        callback(event.payload);
    });
}

export async function listenToAiThinkingCompleted(
    callback: (payload: AIMessageCompletedPayload) => void,
): Promise<UnlistenFn> {
    return listen<AIMessageCompletedPayload>(
        AI_THINKING_COMPLETED_EVENT,
        (event) => {
            callback(event.payload);
        },
    );
}

export async function listenToAiToolActivity(
    callback: (payload: AIToolActivityPayload) => void,
): Promise<UnlistenFn> {
    return listen<AIToolActivityPayload>(AI_TOOL_ACTIVITY_EVENT, (event) => {
        callback(event.payload);
    });
}

export async function aiSaveSessionHistory(
    vaultPath: string,
    history: PersistedSessionHistory,
): Promise<void> {
    await invoke("ai_save_session_history", { vaultPath, history });
}

export async function aiLoadSessionHistories(
    vaultPath: string,
): Promise<PersistedSessionHistory[]> {
    return invoke<PersistedSessionHistory[]>("ai_load_session_histories", {
        vaultPath,
    });
}

export async function aiDeleteSessionHistory(
    vaultPath: string,
    sessionId: string,
): Promise<void> {
    await invoke("ai_delete_session_history", { vaultPath, sessionId });
}

export async function aiDeleteAllSessionHistories(
    vaultPath: string,
): Promise<void> {
    await invoke("ai_delete_all_session_histories", { vaultPath });
}

export async function listenToAiPermissionRequest(
    callback: (payload: AIPermissionRequestPayload) => void,
): Promise<UnlistenFn> {
    return listen<AIPermissionRequestPayload>(
        AI_PERMISSION_REQUEST_EVENT,
        (event) => {
            callback(event.payload);
        },
    );
}
