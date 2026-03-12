export type AIChatSessionStatus =
    | "idle"
    | "streaming"
    | "waiting_permission"
    | "waiting_user_input"
    | "review_required"
    | "error";

export type AIRuntimeConnectionStatus = "idle" | "loading" | "ready" | "error";

export type AIRuntimeBinarySource =
    | "bundled"
    | "custom"
    | "env"
    | "vendor"
    | "missing";

export interface AIRuntimeConnectionState {
    status: AIRuntimeConnectionStatus;
    message: string | null;
}

export interface AIRuntimeSetupStatus {
    runtimeId: string;
    binaryReady: boolean;
    binaryPath?: string;
    binarySource: AIRuntimeBinarySource;
    authReady: boolean;
    authMethod?: string;
    authMethods: AIAuthMethod[];
    onboardingRequired: boolean;
    message?: string;
}

export interface AIAuthMethod {
    id: string;
    name: string;
    description: string;
}

export interface AIRuntimeOption {
    id: string;
    name: string;
    description: string;
    capabilities: string[];
}

export interface AIModelOption {
    id: string;
    runtimeId: string;
    name: string;
    description: string;
}

export interface AIModeOption {
    id: string;
    runtimeId: string;
    name: string;
    description: string;
    disabled?: boolean;
}

export interface AIConfigSelectOption {
    value: string;
    label: string;
    description?: string;
}

export interface AIConfigOption {
    id: string;
    runtimeId: string;
    category: "mode" | "model" | "reasoning" | "other";
    label: string;
    description?: string;
    type: "select";
    value: string;
    options: AIConfigSelectOption[];
}

export type AIAttachmentType =
    | "note"
    | "current_note"
    | "selection"
    | "folder"
    | "audio"
    | "file";

export type AIAttachmentStatus = "pending" | "processing" | "ready" | "error";

export interface AIChatAttachment {
    id: string;
    type: AIAttachmentType;
    noteId: string | null;
    label: string;
    path: string | null;
    content?: string;
    filePath?: string;
    mimeType?: string;
    transcription?: string;
    status?: AIAttachmentStatus;
    errorMessage?: string;
}

export type AIChatRole = "user" | "assistant" | "system";

export type AIChatMessageKind =
    | "text"
    | "thinking"
    | "tool"
    | "plan"
    | "status"
    | "permission"
    | "user_input_request"
    | "error";

export interface AIUserInputQuestionOption {
    label: string;
    description: string;
}

export interface AIUserInputQuestion {
    id: string;
    header: string;
    question: string;
    is_other: boolean;
    is_secret: boolean;
    options?: AIUserInputQuestionOption[];
}

export interface AIUserInputRequestPayload {
    session_id: string;
    request_id: string;
    title: string;
    questions: AIUserInputQuestion[];
}

export interface AIPlanEntry {
    content: string;
    priority: "high" | "medium" | "low" | string;
    status: "pending" | "in_progress" | "completed" | string;
}

export interface AIPlanUpdatePayload {
    session_id: string;
    plan_id: string;
    title?: string;
    detail?: string;
    entries: AIPlanEntry[];
}

export interface AIChatMessage {
    id: string;
    role: AIChatRole;
    kind: AIChatMessageKind;
    content: string;
    timestamp: number;
    title?: string;
    inProgress?: boolean;
    meta?: Record<string, string | number | boolean | null>;
    permissionRequestId?: string;
    permissionOptions?: AIPermissionOption[];
    diffs?: AIFileDiff[];
    userInputRequestId?: string;
    userInputQuestions?: AIUserInputQuestion[];
    planEntries?: AIPlanEntry[];
    planDetail?: string;
}

export interface AIChatSession {
    sessionId: string;
    historySessionId: string;
    status: AIChatSessionStatus;
    isResumingSession?: boolean;
    effortsByModel?: Record<string, string[]>;
    runtimeId: string;
    modelId: string;
    modeId: string;
    models: AIModelOption[];
    modes: AIModeOption[];
    configOptions: AIConfigOption[];
    messages: AIChatMessage[];
    attachments: AIChatAttachment[];
    isPersistedSession?: boolean;
    resumeContextPending?: boolean;
}

export interface AIRuntimeDescriptor {
    runtime: AIRuntimeOption;
    models: AIModelOption[];
    modes: AIModeOption[];
    configOptions: AIConfigOption[];
}

export interface AIBackendSessionPayload {
    session_id: string;
    runtime_id: string;
    model_id: string;
    mode_id: string;
    status: AIChatSessionStatus;
    efforts_by_model?: Record<string, string[]>;
    models: AIBackendRuntimeDescriptorPayload["models"];
    modes: AIBackendRuntimeDescriptorPayload["modes"];
    config_options: Array<{
        id: string;
        runtime_id: string;
        category: "mode" | "model" | "reasoning" | "other";
        label: string;
        description?: string | null;
        type: "select";
        value: string;
        options: Array<{
            value: string;
            label: string;
            description?: string | null;
        }>;
    }>;
}

export interface AIBackendRuntimeDescriptorPayload {
    runtime: {
        id: string;
        name: string;
        description: string;
        capabilities: string[];
    };
    models: Array<{
        id: string;
        runtime_id: string;
        name: string;
        description: string;
    }>;
    modes: Array<{
        id: string;
        runtime_id: string;
        name: string;
        description: string;
        disabled: boolean;
    }>;
    config_options: AIBackendSessionPayload["config_options"];
}

export interface AIBackendRuntimeSetupStatusPayload {
    runtime_id: string;
    binary_ready: boolean;
    binary_path?: string | null;
    binary_source: AIRuntimeBinarySource;
    auth_ready: boolean;
    auth_method?: string | null;
    auth_methods: AIAuthMethod[];
    onboarding_required: boolean;
    message?: string | null;
}

export interface AISessionErrorPayload {
    session_id?: string | null;
    message: string;
}

export interface AIMessageStartedPayload {
    session_id: string;
    message_id: string;
}

export interface AIMessageDeltaPayload {
    session_id: string;
    message_id: string;
    delta: string;
}

export interface AIMessageCompletedPayload {
    session_id: string;
    message_id: string;
}

export interface AIToolActivityPayload {
    session_id: string;
    tool_call_id: string;
    title: string;
    kind: string;
    status: string;
    target?: string | null;
    summary?: string | null;
}

export interface AIStatusEventPayload {
    session_id: string;
    event_id: string;
    kind: string;
    status: string;
    title: string;
    detail?: string | null;
    emphasis: string;
}

export interface AIPermissionOption {
    option_id: string;
    name: string;
    kind: string;
}

export interface AIFileDiff {
    path: string;
    kind: "add" | "delete" | "update";
    old_text?: string | null;
    new_text?: string | null;
}

export interface AIPermissionRequestPayload {
    session_id: string;
    request_id: string;
    tool_call_id: string;
    title: string;
    target?: string | null;
    options: AIPermissionOption[];
    diffs: AIFileDiff[];
}

export interface AIChatNoteSummary {
    id: string;
    title: string;
    path: string;
}

export type AIComposerPart =
    | {
          id: string;
          type: "text";
          text: string;
      }
    | {
          id: string;
          type: "mention";
          noteId: string;
          label: string;
          path: string;
      }
    | {
          id: string;
          type: "folder_mention";
          folderPath: string;
          label: string;
      }
    | {
          id: string;
          type: "fetch_mention";
      }
    | {
          id: string;
          type: "plan_mention";
      };

export type AIMentionSuggestion =
    | { kind: "note"; note: AIChatNoteSummary }
    | { kind: "folder"; folderPath: string; name: string }
    | { kind: "fetch" }
    | { kind: "plan" };

export interface PersistedMessage {
    id: string;
    role: string;
    kind: string;
    content: string;
    timestamp: number;
    title?: string;
    meta?: Record<string, string | number | boolean | null>;
    permission_request_id?: string;
    permission_options?: AIPermissionOption[];
    user_input_request_id?: string;
    user_input_questions?: AIUserInputQuestion[];
    plan_entries?: AIPlanEntry[];
    plan_detail?: string;
}

export interface PersistedSessionHistory {
    version: number;
    session_id: string;
    model_id: string;
    mode_id: string;
    created_at: number;
    updated_at: number;
    messages: PersistedMessage[];
}
