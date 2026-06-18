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

/** Reason an approved additional root could not be re-resolved on disk. */
export type DiscardedAdditionalRootReason =
    | { kind: "not_found" }
    | { kind: "not_a_directory" }
    | { kind: "permission_denied" }
    | { kind: "other"; message: string };

export interface DiscardedAdditionalRoot {
    raw: string;
    reason: DiscardedAdditionalRootReason;
}

/** Wire shape (snake_case) as serialized by the Rust backend. */
export interface DiscardedAdditionalRootPayload {
    raw: string;
    reason: DiscardedAdditionalRootReason;
}

export interface AIRuntimeConnectionState {
    status: AIRuntimeConnectionStatus;
    message: string | null;
}

export interface AIRuntimeConnectionPayload extends AIRuntimeConnectionState {
    runtime_id: string;
}

export interface AITokenUsageCost {
    amount: number;
    currency: string;
}

export interface AITokenUsagePayload {
    session_id: string;
    used: number;
    size: number;
    cost?: AITokenUsageCost | null;
}

export interface AITokenUsage extends AITokenUsagePayload {
    updatedAt: number;
}

export type AISecretPatch =
    | { action: "unchanged" }
    | { action: "clear" }
    | { action: "set"; value: string };

export type AIAuthTerminalStatus = "starting" | "running" | "exited" | "error";

export interface AIAuthTerminalSessionSnapshot {
    sessionId: string;
    runtimeId: string;
    program: string;
    displayName: string;
    cwd: string;
    cols: number;
    rows: number;
    buffer: string;
    status: AIAuthTerminalStatus;
    exitCode: number | null;
    errorMessage: string | null;
}

export interface AIAuthTerminalOutputPayload {
    sessionId: string;
    chunk: string;
}

export interface AIAuthTerminalErrorPayload {
    sessionId: string;
    message: string;
}

export interface AIRuntimeSetupStatus {
    runtimeId: string;
    binaryReady: boolean;
    binaryPath?: string;
    binarySource: AIRuntimeBinarySource;
    hasCustomBinaryPath?: boolean;
    authReady: boolean;
    authMethod?: string;
    authMethods: AIAuthMethod[];
    hasGatewayConfig?: boolean;
    hasGatewayUrl?: boolean;
    onboardingRequired: boolean;
    message?: string;
}

export interface AIResolvedExecutable {
    name: string;
    path?: string;
}

export interface AIRuntimeDiagnostic {
    runtimeId: string;
    runtimeName: string;
    setupStatus?: AIRuntimeSetupStatus;
    setupError?: string;
    launchProgram?: string;
    launchArgs: string[];
    resolutionDisplay?: string;
}

export interface AIEnvironmentDiagnostics {
    inheritedPath?: string;
    inheritedEntries: string[];
    preferredPath?: string;
    preferredEntries: string[];
    executables: AIResolvedExecutable[];
    runtimes: AIRuntimeDiagnostic[];
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
    agentType?: string;
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
    agentType?: string;
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
    startLine?: number;
    endLine?: number;
}

export function buildSelectionLabel(
    selectedText: string,
    startLine: number,
    endLine: number,
): string {
    const preview = selectedText.replace(/\s+/g, " ").trim();
    const truncated =
        preview.length > 20 ? `${preview.slice(0, 20).trimEnd()}...` : preview;
    const range =
        startLine === endLine ? `(${startLine})` : `(${startLine}:${endLine})`;
    return `${range}  ${truncated}`;
}

export type QueuedChatMessageStatus = "queued" | "sending" | "failed";

export interface QueuedChatMessage {
    id: string;
    content: string;
    prompt: string;
    composerParts: AIComposerPart[];
    attachments: AIChatAttachment[];
    createdAt: number;
    status: QueuedChatMessageStatus;
    modelId: string | null;
    modeId: string | null;
    optionsSnapshot: Record<string, string>;
    optimisticMessageId?: string;
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
    | "url_elicitation_request"
    | "image"
    | "error";

export interface AIUserInputQuestionOption {
    label: string;
    value: string;
    description?: string;
    preview?: string;
}

export interface AIUserInputQuestion {
    id: string;
    custom_answer_id?: string;
    header: string;
    question: string;
    is_other: boolean;
    is_secret: boolean;
    allows_multiple?: boolean;
    options?: AIUserInputQuestionOption[];
}

export interface AIUserInputRequestPayload {
    session_id: string;
    request_id: string;
    title: string;
    questions: AIUserInputQuestion[];
}

export type AIUserInputAction = "accept" | "decline" | "skip" | "cancel";
export type AIUrlElicitationAction = "complete" | "cancel";
export type AIUrlElicitationStatus =
    | "pending"
    | "opening"
    | "completed"
    | "cancelled"
    | "error";

export interface AIUrlElicitationRequestPayload {
    session_id: string;
    request_id: string;
    elicitation_id: string;
    title: string;
    url: string;
    status?: AIUrlElicitationStatus;
    scope?: string;
    runtime_session_id?: string | null;
    tool_call_id?: string | null;
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

export interface AIAvailableCommand {
    id: string;
    label: string;
    description: string;
    insert_text: string;
}

export interface AIAvailableCommandsPayload {
    session_id: string;
    commands: AIAvailableCommand[];
}

export type AIBufferedSessionTimelineEvent =
    | {
          type: "tool_activity";
          payload: AIToolActivityPayload;
          timestamp: number;
      }
    | {
          type: "status_event";
          payload: AIStatusEventPayload;
          timestamp: number;
      }
    | {
          type: "plan_update";
          payload: AIPlanUpdatePayload;
          timestamp: number;
      }
    | {
          type: "permission_request";
          payload: AIPermissionRequestPayload;
          timestamp: number;
      }
    | {
          type: "user_input_request";
          payload: AIUserInputRequestPayload;
          timestamp: number;
      }
    | {
          type: "url_elicitation_request";
          payload: AIUrlElicitationRequestPayload;
          timestamp: number;
      };

export interface AIChatMessage {
    id: string;
    role: AIChatRole;
    kind: AIChatMessageKind;
    content: string;
    timestamp: number;
    workCycleId?: string | null;
    attachments?: AIChatAttachment[];
    title?: string;
    inProgress?: boolean;
    meta?: Record<string, string | number | boolean | null>;
    permissionRequestId?: string;
    permissionOptions?: AIPermissionOption[];
    diffs?: AIFileDiff[];
    reviewDiffs?: AIFileDiff[];
    userInputRequestId?: string;
    userInputQuestions?: AIUserInputQuestion[];
    urlElicitationRequestId?: string;
    urlElicitationId?: string;
    urlElicitationUrl?: string;
    planEntries?: AIPlanEntry[];
    planDetail?: string;
    toolAction?: AIToolActivityAction | null;
}

export interface AIChatSession {
    sessionId: string;
    historySessionId: string;
    parentSessionId?: string | null;
    runtimeSessionId?: string | null;
    closedAt?: string | null;
    /**
     * For the "claude-code-terminal" pseudo-runtime: the terminal runtime this
     * agent entry stands in for. Clicking the entry focuses that terminal tab
     * instead of opening an ACP chat pane. Unset for real ACP sessions.
     */
    terminalId?: string | null;
    vaultPath?: string | null;
    status: AIChatSessionStatus;
    activeWorkCycleId?: string | null;
    visibleWorkCycleId?: string | null;
    /** ActionLog state — source of truth for tracked files. */
    actionLog?: import("./diff/actionLogTypes").ActionLogState;
    isResumingSession?: boolean;
    effortsByModel?: Record<string, string[]>;
    runtimeId: string;
    additionalRoots?: string[];
    /**
     * Roots the user previously approved that could not be re-resolved on
     * disk when the session was (re)opened. Surfaced as an inline banner so
     * powerusers see why an approved directory is no longer accessible.
     */
    discardedAdditionalRoots?: DiscardedAdditionalRoot[];
    /** Session ids for which the discarded-roots banner has been dismissed. */
    discardedRootsBannerDismissed?: boolean;
    modelId: string;
    modeId: string;
    models: AIModelOption[];
    modes: AIModeOption[];
    configOptions: AIConfigOption[];
    availableCommands?: AIAvailableCommand[];
    messages: AIChatMessage[];
    persistedCreatedAt?: number | null;
    persistedUpdatedAt?: number | null;
    persistedTitle?: string | null;
    customTitle?: string | null;
    persistedPreview?: string | null;
    persistedMessageCount?: number;
    loadedPersistedMessageStart?: number | null;
    isLoadingPersistedMessages?: boolean;
    /**
     * Internal transcript normalization layer.
     * `messages` remains the public shape for current consumers.
     */
    messageOrder?: string[];
    messagesById?: Record<string, AIChatMessage>;
    /** Internal O(1) lookup for in-place row replacement. */
    messageIndexById?: Record<string, number>;
    lastAssistantMessageId?: string | null;
    lastTurnStartedMessageId?: string | null;
    activePlanMessageId?: string | null;
    attachments: AIChatAttachment[];
    isPersistedSession?: boolean;
    isPendingSessionCreation?: boolean;
    pendingSessionError?: string | null;
    resumeContextPending?: boolean;
    resumeReconnectFailed?: boolean;
    runtimeState?: "live" | "persisted_only" | "detached";
}

export interface AIRuntimeDescriptor {
    runtime: AIRuntimeOption;
    models: AIModelOption[];
    modes: AIModeOption[];
    configOptions: AIConfigOption[];
}

export interface AIBackendSessionPayload {
    session_id: string;
    parent_session_id?: string | null;
    runtime_session_id?: string | null;
    closed_at?: string | null;
    title?: string | null;
    runtime_id: string;
    model_id: string;
    mode_id: string;
    status: AIChatSessionStatus;
    additional_roots?: string[];
    discarded_additional_roots?: DiscardedAdditionalRootPayload[];
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
            agent_type?: string | null;
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
        agent_type?: string | null;
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
    has_custom_binary_path?: boolean;
    auth_ready: boolean;
    auth_method?: string | null;
    auth_methods: AIAuthMethod[];
    has_gateway_config?: boolean;
    has_gateway_url?: boolean;
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
    role?: AIChatRole;
}

export interface AIMessageDeltaPayload {
    session_id: string;
    message_id: string;
    delta: string;
    role?: AIChatRole;
}

export interface AIMessageCompletedPayload {
    session_id: string;
    message_id: string;
    role?: AIChatRole;
    turn_complete?: boolean;
}

export interface AIToolActivityPayload {
    session_id: string;
    tool_call_id: string;
    title: string;
    kind: string;
    status: string;
    action?: AIToolActivityAction | null;
    target?: string | null;
    summary?: string | null;
    diffs?: AIFileDiff[];
}

export type AIToolActivityAction = {
    kind: "open_session";
    session_id: string;
    label?: string | null;
};

export interface AIStatusEventPayload {
    session_id: string;
    event_id: string;
    kind: string;
    status: string;
    title: string;
    detail?: string | null;
    emphasis: string;
    tool_action?: AIToolActivityAction | null;
}

export interface AIImageGenerationPayload {
    session_id: string;
    image_id: string;
    status: "in_progress" | "completed" | "failed" | string;
    title: string;
    path?: string | null;
    mime_type?: string | null;
    revised_prompt?: string | null;
    result?: string | null;
    error?: string | null;
}

export interface AIPermissionOption {
    option_id: string;
    name: string;
    kind: string;
}

export interface AIFileDiffHunkLine {
    type: "context" | "add" | "remove";
    text: string;
}

export interface AIFileDiffHunk {
    old_start: number;
    old_count: number;
    new_start: number;
    new_count: number;
    lines: AIFileDiffHunkLine[];
}

export interface AIFileDiff {
    path: string;
    kind: "add" | "delete" | "move" | "update";
    previous_path?: string | null;
    reversible?: boolean;
    is_text?: boolean;
    old_text?: string | null;
    new_text?: string | null;
    hunks?: AIFileDiffHunk[];
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

export interface AIChatFileSummary {
    id: string;
    title: string;
    path: string;
    relativePath: string;
    fileName: string;
    mimeType: string | null;
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
          type: "file_mention";
          label: string;
          path: string;
          relativePath: string;
          mimeType: string | null;
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
      }
    | {
          id: string;
          type: "selection_mention";
          noteId: string | null;
          label: string;
          path: string;
          selectedText: string;
          startLine: number;
          endLine: number;
      }
    | {
          id: string;
          type: "screenshot";
          filePath: string;
          mimeType: string;
          label: string;
          createdAt?: number;
      }
    | {
          id: string;
          type: "file_attachment";
          filePath: string;
          mimeType: string;
          label: string;
      };

export type AIMentionSuggestion =
    | { kind: "note"; note: AIChatNoteSummary; label: string }
    | { kind: "file"; file: AIChatFileSummary; label: string }
    | { kind: "folder"; folderPath: string; name: string }
    | { kind: "fetch" }
    | { kind: "plan" };

export interface PersistedMessage {
    id: string;
    role: string;
    kind: string;
    content: string;
    timestamp: number;
    attachments?: AIChatAttachment[];
    title?: string;
    meta?: Record<string, string | number | boolean | null>;
    permission_request_id?: string;
    permission_options?: AIPermissionOption[];
    diffs?: AIFileDiff[];
    review_diffs?: AIFileDiff[];
    user_input_request_id?: string;
    user_input_questions?: AIUserInputQuestion[];
    url_elicitation_request_id?: string;
    url_elicitation_id?: string;
    url_elicitation_url?: string;
    plan_entries?: AIPlanEntry[];
    plan_detail?: string;
    tool_action?: AIToolActivityAction | null;
}

export interface PersistedSessionHistory {
    version: number;
    session_id: string;
    parent_session_id?: string | null;
    closed_at?: string | null;
    runtime_id?: string;
    model_id: string;
    mode_id: string;
    models?: AIBackendRuntimeDescriptorPayload["models"];
    modes?: AIBackendRuntimeDescriptorPayload["modes"];
    config_options?: AIBackendSessionPayload["config_options"];
    additional_roots?: string[];
    created_at: number;
    updated_at: number;
    start_index?: number;
    message_count?: number;
    title?: string;
    custom_title?: string | null;
    preview?: string;
    messages: PersistedMessage[];
}

export interface PersistedSessionHistoryPage {
    session_id: string;
    total_messages: number;
    start_index: number;
    end_index: number;
    messages: PersistedMessage[];
}
