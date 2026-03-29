import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { VaultNoteChange } from "../../app/store/vaultStore";
import type {
    AIAvailableCommandsPayload,
    AIAuthTerminalErrorPayload,
    AIAuthTerminalOutputPayload,
    AIAuthTerminalSessionSnapshot,
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
    AIPlanUpdatePayload,
    AIStatusEventPayload,
    AIToolActivityPayload,
    AIUserInputRequestPayload,
    AIRuntimeDescriptor,
    AIRuntimeConnectionPayload,
    AIRuntimeSetupStatus,
    AISecretPatch,
    AISessionErrorPayload,
    PersistedSessionHistory,
    PersistedSessionHistoryPage,
} from "./types";

const FALLBACK_RUNTIMES: AIRuntimeDescriptor[] = [
    {
        runtime: {
            id: "codex-acp",
            name: "Codex ACP",
            description: "Codex runtime embedded as an ACP sidecar.",
            capabilities: [
                "attachments",
                "permissions",
                "reasoning",
                "terminal_output",
                "create_session",
                "list_sessions",
                "user_input",
            ],
        },
        models: [],
        modes: [],
        configOptions: [],
    },
    {
        runtime: {
            id: "claude-acp",
            name: "Claude ACP",
            description:
                "Claude runtime exposed through the upstream ACP adapter.",
            capabilities: [
                "attachments",
                "permissions",
                "plans",
                "terminal_output",
                "create_session",
                "fork_session",
                "resume_session",
                "list_sessions",
                "prompt_queueing",
            ],
        },
        models: [],
        modes: [],
        configOptions: [],
    },
    {
        runtime: {
            id: "gemini-acp",
            name: "Gemini ACP",
            description: "Gemini CLI running as a native ACP agent.",
            capabilities: [
                "attachments",
                "permissions",
                "plans",
                "create_session",
                "resume_session",
            ],
        },
        models: [],
        modes: [],
        configOptions: [],
    },
];

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
export const AI_STATUS_EVENT = "ai://status-event";
export const AI_PERMISSION_REQUEST_EVENT = "ai://permission-request";
export const AI_USER_INPUT_REQUEST_EVENT = "ai://user-input-request";
export const AI_PLAN_UPDATED_EVENT = "ai://plan-updated";
export const AI_AVAILABLE_COMMANDS_UPDATED_EVENT =
    "ai://available-commands-updated";
export const AI_RUNTIME_CONNECTION_EVENT = "ai://runtime-connection";
export const AI_AUTH_TERMINAL_STARTED_EVENT = "ai://auth-terminal-started";
export const AI_AUTH_TERMINAL_OUTPUT_EVENT = "ai://auth-terminal-output";
export const AI_AUTH_TERMINAL_EXITED_EVENT = "ai://auth-terminal-exited";
export const AI_AUTH_TERMINAL_ERROR_EVENT = "ai://auth-terminal-error";

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
        availableCommands: undefined,
        messages: [],
        attachments: [],
        isPersistedSession: false,
        resumeContextPending: false,
        runtimeState: "live",
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
        hasCustomBinaryPath: status.has_custom_binary_path ?? false,
        authReady: status.auth_ready,
        authMethod: status.auth_method ?? undefined,
        authMethods: status.auth_methods,
        hasGatewayConfig: status.has_gateway_config ?? false,
        hasGatewayUrl: status.has_gateway_url ?? false,
        onboardingRequired: status.onboarding_required,
        message: status.message ?? undefined,
    };
}

export async function aiListRuntimes() {
    try {
        const descriptors =
            await invoke<AIBackendRuntimeDescriptorPayload[]>(
                "ai_list_runtimes",
            );
        const normalized = descriptors.map(normalizeRuntimeDescriptor);
        return normalized.length > 0 ? normalized : FALLBACK_RUNTIMES;
    } catch (error) {
        console.warn(
            "Failed to load AI runtimes from backend; using fallback descriptors.",
            error,
        );
        return FALLBACK_RUNTIMES;
    }
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

export async function aiGetSetupStatus(runtimeId: string) {
    const status = await invoke<AIBackendRuntimeSetupStatusPayload>(
        "ai_get_setup_status",
        {
            runtimeId,
        },
    );
    return normalizeRuntimeSetupStatus(status);
}

export async function aiUpdateSetup(input: {
    runtimeId: string;
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
}) {
    const status = await invoke<AIBackendRuntimeSetupStatusPayload>(
        "ai_update_setup",
        {
            input: {
                custom_binary_path: input.customBinaryPath ?? null,
                codex_api_key: input.codexApiKey,
                openai_api_key: input.openaiApiKey,
                gemini_api_key: input.geminiApiKey,
                google_api_key: input.googleApiKey,
                google_cloud_project: input.googleCloudProject ?? null,
                google_cloud_location: input.googleCloudLocation ?? null,
                gateway_base_url: input.gatewayBaseUrl ?? null,
                gateway_headers: input.gatewayHeaders,
                anthropic_base_url: input.anthropicBaseUrl ?? null,
                anthropic_custom_headers: input.anthropicCustomHeaders,
                anthropic_auth_token: input.anthropicAuthToken,
            },
            runtimeId: input.runtimeId,
        },
    );
    return normalizeRuntimeSetupStatus(status);
}

export async function aiStartAuth(
    input: {
        methodId: string;
        runtimeId: string;
    },
    vaultPath: string | null,
) {
    const status = await invoke<AIBackendRuntimeSetupStatusPayload>(
        "ai_start_auth",
        {
            input: {
                method_id: input.methodId,
                runtimeId: input.runtimeId,
            },
            vaultPath: vaultPath ?? null,
        },
    );
    return normalizeRuntimeSetupStatus(status);
}

export async function aiStartAuthTerminalSession(input: {
    runtimeId: string;
    vaultPath: string | null;
    customBinaryPath?: string;
    cols?: number;
    rows?: number;
}) {
    return invoke<AIAuthTerminalSessionSnapshot>(
        "ai_start_auth_terminal_session",
        {
            input: {
                runtimeId: input.runtimeId,
                vaultPath: input.vaultPath ?? null,
                customBinaryPath: input.customBinaryPath ?? null,
                cols: input.cols ?? null,
                rows: input.rows ?? null,
            },
        },
    );
}

export async function aiWriteAuthTerminalSession(input: {
    sessionId: string;
    data: string;
}) {
    await invoke("ai_write_auth_terminal_session", {
        input: {
            sessionId: input.sessionId,
            data: input.data,
        },
    });
}

export async function aiResizeAuthTerminalSession(input: {
    sessionId: string;
    cols: number;
    rows: number;
}) {
    return invoke<AIAuthTerminalSessionSnapshot>(
        "ai_resize_auth_terminal_session",
        {
            input: {
                sessionId: input.sessionId,
                cols: input.cols,
                rows: input.rows,
            },
        },
    );
}

export async function aiCloseAuthTerminalSession(sessionId: string) {
    await invoke("ai_close_auth_terminal_session", { sessionId });
}

export async function aiGetAuthTerminalSessionSnapshot(sessionId: string) {
    return invoke<AIAuthTerminalSessionSnapshot>(
        "ai_get_auth_terminal_session_snapshot",
        { sessionId },
    );
}

export async function aiLoadSession(sessionId: string) {
    const session = await invoke<AIBackendSessionPayload>("ai_load_session", {
        sessionId,
    });
    return normalizeBackendSession(session);
}

export async function aiLoadRuntimeSession(
    runtimeId: string,
    sessionId: string,
    vaultPath: string | null,
) {
    const session = await invoke<AIBackendSessionPayload>(
        "ai_load_runtime_session",
        {
            input: {
                runtime_id: runtimeId,
                session_id: sessionId,
            },
            vaultPath: vaultPath ?? null,
        },
    );
    return normalizeBackendSession(session);
}

export async function aiResumeRuntimeSession(
    runtimeId: string,
    sessionId: string,
    vaultPath: string | null,
) {
    const session = await invoke<AIBackendSessionPayload>(
        "ai_resume_runtime_session",
        {
            input: {
                runtime_id: runtimeId,
                session_id: sessionId,
            },
            vaultPath: vaultPath ?? null,
        },
    );
    return normalizeBackendSession(session);
}

export async function aiForkRuntimeSession(
    runtimeId: string,
    sessionId: string,
    vaultPath: string | null,
) {
    const session = await invoke<AIBackendSessionPayload>(
        "ai_fork_runtime_session",
        {
            input: {
                runtime_id: runtimeId,
                session_id: sessionId,
            },
            vaultPath: vaultPath ?? null,
        },
    );
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

export async function aiRespondUserInput(
    sessionId: string,
    requestId: string,
    answers: Record<string, string[]>,
) {
    const session = await invoke<AIBackendSessionPayload>(
        "ai_respond_user_input",
        {
            input: {
                session_id: sessionId,
                request_id: requestId,
                answers,
            },
        },
    );
    return normalizeBackendSession(session);
}

export async function aiGetTextFileHash(
    vaultPath: string,
    path: string,
): Promise<string | null> {
    return invoke<string | null>("ai_get_text_file_hash", {
        vaultPath,
        path,
    });
}

export async function aiRestoreTextFile(input: {
    vaultPath: string;
    path: string;
    previousPath?: string | null;
    content?: string | null;
}) {
    return (
        (await invoke<VaultNoteChange | null>("ai_restore_text_file", {
            vaultPath: input.vaultPath,
            path: input.path,
            previousPath: input.previousPath ?? null,
            content: input.content ?? null,
        })) ?? null
    );
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

export async function listenToAiStatusEvent(
    callback: (payload: AIStatusEventPayload) => void,
): Promise<UnlistenFn> {
    return listen<AIStatusEventPayload>(AI_STATUS_EVENT, (event) => {
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
    options?: {
        includeMessages?: boolean;
    },
): Promise<PersistedSessionHistory[]> {
    return invoke<PersistedSessionHistory[]>("ai_load_session_histories", {
        vaultPath,
        includeMessages: options?.includeMessages ?? true,
    });
}

export async function aiLoadSessionHistoryPage(
    vaultPath: string,
    sessionId: string,
    startIndex: number,
    limit: number,
): Promise<PersistedSessionHistoryPage> {
    return invoke<PersistedSessionHistoryPage>("ai_load_session_history_page", {
        vaultPath,
        sessionId,
        startIndex,
        limit,
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

export async function aiDeleteRuntimeSession(sessionId: string): Promise<void> {
    await invoke("ai_delete_runtime_session", { sessionId });
}

export async function aiDeleteRuntimeSessionsForVault(
    vaultPath: string | null,
): Promise<void> {
    await invoke("ai_delete_runtime_sessions_for_vault", {
        vaultPath: vaultPath ?? null,
    });
}

export async function aiPruneSessionHistories(
    vaultPath: string,
    maxAgeDays: number,
): Promise<number> {
    return invoke<number>("ai_prune_session_histories", {
        vaultPath,
        maxAgeDays,
    });
}

export async function aiRegisterFileBaseline(
    sessionId: string,
    displayPath: string,
    content: string,
): Promise<void> {
    await invoke("ai_register_file_baseline", {
        sessionId,
        displayPath,
        content,
    });
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

export async function listenToAiUserInputRequest(
    callback: (payload: AIUserInputRequestPayload) => void,
): Promise<UnlistenFn> {
    return listen<AIUserInputRequestPayload>(
        AI_USER_INPUT_REQUEST_EVENT,
        (event) => {
            callback(event.payload);
        },
    );
}

export async function listenToAiPlanUpdated(
    callback: (payload: AIPlanUpdatePayload) => void,
): Promise<UnlistenFn> {
    return listen<AIPlanUpdatePayload>(AI_PLAN_UPDATED_EVENT, (event) => {
        callback(event.payload);
    });
}

export async function listenToAiAvailableCommandsUpdated(
    callback: (payload: AIAvailableCommandsPayload) => void,
): Promise<UnlistenFn> {
    return listen<AIAvailableCommandsPayload>(
        AI_AVAILABLE_COMMANDS_UPDATED_EVENT,
        (event) => {
            callback(event.payload);
        },
    );
}

export async function listenToAiRuntimeConnection(
    callback: (payload: AIRuntimeConnectionPayload) => void,
): Promise<UnlistenFn> {
    return listen<AIRuntimeConnectionPayload>(
        AI_RUNTIME_CONNECTION_EVENT,
        (event) => {
            callback(event.payload);
        },
    );
}

export async function listenToAiAuthTerminalStarted(
    callback: (payload: AIAuthTerminalSessionSnapshot) => void,
): Promise<UnlistenFn> {
    return listen<AIAuthTerminalSessionSnapshot>(
        AI_AUTH_TERMINAL_STARTED_EVENT,
        (event) => {
            callback(event.payload);
        },
    );
}

export async function listenToAiAuthTerminalOutput(
    callback: (payload: AIAuthTerminalOutputPayload) => void,
): Promise<UnlistenFn> {
    return listen<AIAuthTerminalOutputPayload>(
        AI_AUTH_TERMINAL_OUTPUT_EVENT,
        (event) => {
            callback(event.payload);
        },
    );
}

export async function listenToAiAuthTerminalExited(
    callback: (payload: AIAuthTerminalSessionSnapshot) => void,
): Promise<UnlistenFn> {
    return listen<AIAuthTerminalSessionSnapshot>(
        AI_AUTH_TERMINAL_EXITED_EVENT,
        (event) => {
            callback(event.payload);
        },
    );
}

export async function listenToAiAuthTerminalError(
    callback: (payload: AIAuthTerminalErrorPayload) => void,
): Promise<UnlistenFn> {
    return listen<AIAuthTerminalErrorPayload>(
        AI_AUTH_TERMINAL_ERROR_EVENT,
        (event) => {
            callback(event.payload);
        },
    );
}
