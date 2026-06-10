import { Agent, AgentSideConnection, AuthenticateRequest, CancelNotification, ClientCapabilities, ForkSessionRequest, ForkSessionResponse, InitializeRequest, InitializeResponse, ListSessionsRequest, ListSessionsResponse, LoadSessionRequest, LoadSessionResponse, NewSessionRequest, NewSessionResponse, PromptRequest, PromptResponse, ReadTextFileRequest, ReadTextFileResponse, ResumeSessionRequest, ResumeSessionResponse, SessionConfigOption, SessionModeState, SessionNotification, SetSessionConfigOptionRequest, SetSessionConfigOptionResponse, SetSessionModeRequest, SetSessionModeResponse, CloseSessionRequest, CloseSessionResponse, DeleteSessionRequest, DeleteSessionResponse, WriteTextFileRequest, WriteTextFileResponse } from "@agentclientprotocol/sdk";
import { CanUseTool, ModelInfo, Options, PermissionMode, PermissionUpdate, Query, SDKMessageOrigin, SDKPartialAssistantMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { ContentBlockParam } from "@anthropic-ai/sdk/resources";
import { BetaContentBlock, BetaRawContentBlockDelta } from "@anthropic-ai/sdk/resources/beta.mjs";
import { SettingsManager } from "./settings.js";
import { TaskState } from "./tools.js";
import { Pushable } from "./utils.js";
export declare const CLAUDE_CONFIG_DIR: string;
/**
 * Logger interface for customizing logging output
 */
export interface Logger {
    log: (...args: any[]) => void;
    error: (...args: any[]) => void;
}
type AccumulatedUsage = {
    inputTokens: number;
    outputTokens: number;
    cachedReadTokens: number;
    cachedWriteTokens: number;
};
/** Internal model-selection state. Mirrors the shape the ACP SDK exposed as
 *  `SessionModelState` before model selection moved entirely into
 *  `SessionConfigOption` (category "model"). Retained internally to track the
 *  current model and build the "model" config option. */
type SessionModelState = {
    availableModels: Array<{
        modelId: string;
        name: string;
        description?: string;
    }>;
    currentModelId: string;
};
type Session = {
    query: Query;
    input: Pushable<SDKUserMessage>;
    cancelled: boolean;
    cwd: string;
    /** Serialized snapshot of session-defining params (cwd, mcpServers) used to
     *  detect when loadSession/resumeSession is called with changed values. */
    sessionFingerprint: string;
    settingsManager: SettingsManager;
    accumulatedUsage: AccumulatedUsage;
    modes: SessionModeState;
    models: SessionModelState;
    modelInfos: ModelInfo[];
    configOptions: SessionConfigOption[];
    promptRunning: boolean;
    pendingMessages: Map<string, {
        resolve: (cancelled: boolean) => void;
        order: number;
    }>;
    nextPendingOrder: number;
    abortController: AbortController;
    /** Per-turn signal the active prompt loop races `query.next()` against.
     *  Aborted by cancel() (after a grace period) to force the loop to return
     *  "cancelled" when the SDK is wedged and `query.next()` never yields again
     *  (issue #680). Distinct from `abortController`: this only wakes the loop;
     *  it does NOT touch the SDK query/subprocess. Undefined when no prompt is
     *  actively consuming the query. */
    cancelController?: AbortController;
    /** Pending grace-period timer that aborts `cancelController`. Cleared when
     *  the loop returns normally so the backstop never fires after a clean
     *  cancel. */
    forceCancelTimer?: ReturnType<typeof setTimeout>;
    emitRawSDKMessages: boolean | SDKMessageFilter[];
    /** Context window size of the last top-level assistant model, carried across
     *  prompts so mid-stream usage_update notifications report a correct `size`
     *  before the turn's first result message arrives. Defaults to
     *  DEFAULT_CONTEXT_WINDOW, refreshed from each result's modelUsage, and
     *  invalidated when the user switches the session's model. */
    contextWindowSize: number;
    /** Accumulated task list for the session, keyed by task ID. Task IDs are
     *  per-session, so this state must not be shared across sessions. */
    taskState: TaskState;
    /** Caches `tool_use` blocks by id so the matching `tool_result` can recover
     *  the tool name/input when mapping it to a `tool_call_update`. Per-session
     *  (tool_use ids are only unique within a session) and pruned at
     *  `tool_result` time so a long-running session doesn't accumulate every
     *  tool call for its whole lifetime. */
    toolUseCache: ToolUseCache;
    /** Maps the ACP `messageId` we expose to clients (see `messageIdForGrouping`)
     *  to the SDK message uuid that the Agent SDK's rewind/resume APIs key on
     *  (`Query.rewindFiles` takes a user-message uuid; `resumeSessionAt` takes an
     *  `SDKAssistantMessage.uuid`). For assistant turns the two differ — the ACP
     *  id is the Anthropic API message id (`msg_…`), available at `message_start`
     *  so streamed chunks can carry it, while the uuid only arrives on the
     *  consolidated message — so a client can only ask to rewind/fork by the id it
     *  was given, and we need this table to translate it back.
     *
     *  Populated as a byproduct of the message loop (the consolidated message
     *  carries both ids) and of `replaySessionHistory` on load, so no extra
     *  `getSessionMessages` read is needed at rewind time. Last-write-wins
     *  naturally yields the turn-boundary uuid when one `msg_…` spans several
     *  content-block messages.
     *
     *  NOT READ YET — recorded now so the mapping exists if/when we wire up
     *  fork/rewind. */
    messageIdToUuid: Map<string, string>;
};
export type SDKMessageFilter = {
    type: string;
    subtype?: string;
    origin?: SDKMessageOrigin["kind"];
};
/**
 * Extra metadata that can be given when creating a new session.
 */
export type NewSessionMeta = {
    claudeCode?: {
        /**
         * Options forwarded to Claude Code when starting a new session.
         * Those parameters will be ignored and managed by ACP:
         *   - cwd
         *   - includePartialMessages
         *   - allowDangerouslySkipPermissions
         *   - permissionMode
         *   - canUseTool
         *   - executable
         * Those parameters will be used and updated to work with ACP:
         *   - hooks (merged with ACP's hooks)
         *   - mcpServers (merged with ACP's mcpServers)
         *   - disallowedTools (merged with ACP's disallowedTools)
         *   - tools (passed through; defaults to claude_code preset if not provided)
         */
        options?: Options;
        /**
         * When set, raw SDK messages are emitted as extNotification("_claude/sdkMessage", message)
         * in addition to normal processing.
         * - true: emit all messages
         * - false/undefined: emit nothing (default)
         * - SDKMessageFilter[]: emit only messages matching at least one filter
         */
        emitRawSDKMessages?: boolean | SDKMessageFilter[];
    };
    additionalRoots?: string[];
};
/**
 * Extra metadata for 'gateway' authentication requests.
 */
type GatewayAuthMeta = {
    /**
     * These parameters are mapped to environment variables to:
     * - Redirect API calls via baseUrl
     * - Inject custom headers
     * - Bypass the default Claude login requirement
     */
    gateway: {
        baseUrl: string;
        headers: Record<string, string>;
    };
};
type GatewayAuthRequest = AuthenticateRequest & {
    _meta?: GatewayAuthMeta;
};
/**
 * Extra metadata that the agent provides for each tool_call / tool_update update.
 */
export type ToolUpdateMeta = {
    claudeCode?: {
        toolName: string;
        toolResponse?: unknown;
    };
    terminal_info?: {
        terminal_id: string;
    };
    terminal_output?: {
        terminal_id: string;
        data: string;
    };
    terminal_exit?: {
        terminal_id: string;
        exit_code: number;
        signal: string | null;
    };
};
export type ToolUseCache = {
    [key: string]: {
        type: "tool_use" | "server_tool_use" | "mcp_tool_use";
        id: string;
        name: string;
        input: unknown;
    };
};
export declare function claudeCliPath(): Promise<string>;
/**
 * Return user-message content with local-command marker tags removed, or
 * `null` if nothing meaningful remains (caller should skip the message).
 * Preserves real prose that's mixed in alongside the markers — e.g. a
 * message like `<command-name>…</command-name>hi` becomes `hi`.
 */
export declare function stripLocalCommandMetadata(content: unknown): unknown | null;
export declare function isLocalCommandMetadata(content: unknown): boolean;
export declare function resolvePermissionMode(defaultMode?: unknown, logger?: Logger): PermissionMode;
/**
 * Builds the label for the "Always Allow" permission option so the user can see
 * the exact scope they are committing to. Uses the SDK-provided suggestions
 * when available (e.g. `Bash(npm test:*)`) and falls back to naming the whole
 * tool so "Always Allow" is never a blank check without disclosure.
 */
export declare function describeAlwaysAllow(suggestions: PermissionUpdate[] | undefined, toolName: string): string;
export declare class ClaudeAcpAgent implements Agent {
    sessions: {
        [key: string]: Session;
    };
    client: AgentSideConnection;
    clientCapabilities?: ClientCapabilities;
    logger: Logger;
    gatewayAuthRequest?: GatewayAuthRequest;
    /** Grace period before a `session/cancel` forces a wedged prompt loop to
     *  return "cancelled". See {@link DEFAULT_FORCE_CANCEL_GRACE_MS}. Mutable so
     *  tests can shrink it. */
    forceCancelGraceMs: number;
    constructor(client: AgentSideConnection, logger?: Logger);
    initialize(request: InitializeRequest): Promise<InitializeResponse>;
    newSession(params: NewSessionRequest): Promise<NewSessionResponse>;
    unstable_forkSession(params: ForkSessionRequest): Promise<ForkSessionResponse>;
    resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse>;
    loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse>;
    listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse>;
    authenticate(_params: AuthenticateRequest): Promise<void>;
    prompt(params: PromptRequest): Promise<PromptResponse>;
    cancel(params: CancelNotification): Promise<void>;
    /** Cleanly tear down a session: cancel in-flight work, dispose resources,
     *  and remove it from the session map. */
    private teardownSession;
    /** Tear down all active sessions. Called when the ACP connection closes. */
    dispose(): Promise<void>;
    closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse>;
    deleteSession(params: DeleteSessionRequest): Promise<DeleteSessionResponse>;
    setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse>;
    setSessionConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse>;
    private applySessionMode;
    private replaySessionHistory;
    readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse>;
    writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse>;
    canUseTool(sessionId: string): CanUseTool;
    /**
     * Handle elicitation requests that originate from MCP servers by forwarding
     * them to the client over ACP. Modes the client did not advertise (or
     * requests we can't represent) are declined.
     */
    private handleMcpElicitation;
    /**
     * Present the built-in AskUserQuestion tool's questions as an ACP form
     * elicitation and return the answers as the tool's `updatedInput`. Called from
     * `canUseTool` since that is where the SDK routes the tool's permission check.
     */
    private handleAskUserQuestion;
    private sendAvailableCommandsUpdate;
    private updateConfigOption;
    private applyConfigOptionValue;
    private getOrCreateSession;
    /**
     * Ensures the requested `cwd` is an absolute path that points at an existing
     * directory before we create a session. Throws an `invalidParams` error with
     * an actionable message so clients (e.g. Zed) can surface it to the user
     * instead of failing later with an opaque SDK error.
     */
    private validateCwd;
    private createSession;
}
export declare function promptToClaude(prompt: PromptRequest): SDKUserMessage;
/**
 * Resolves the ACP `messageId` for a Claude SDK message (live) or a persisted
 * transcript message (replay) so chunk grouping is identical in both views.
 *
 * Assistant turns are keyed by the Anthropic API message id (`message.id`),
 * which is identical at `message_start`, on the consolidated assistant message,
 * and in the persisted transcript — unlike the per-`stream_event` uuid, which is
 * unique per event and never persisted. User messages have no API id, but they
 * are never streamed, so their (stable) SDK uuid is used instead. ACP message
 * ids are opaque strings, so no particular format is required.
 */
export declare function messageIdForGrouping(message: {
    type?: string;
    uuid?: string | null;
    message?: unknown;
}): string | undefined;
/**
 * Convert an SDKAssistantMessage (Claude) to a SessionNotification (ACP).
 * Only handles text, image, and thinking chunks for now.
 */
export declare function toAcpNotifications(content: string | ContentBlockParam[] | BetaContentBlock[] | BetaRawContentBlockDelta[], role: "assistant" | "user", sessionId: string, toolUseCache: ToolUseCache, client: AgentSideConnection, logger: Logger, options?: {
    registerHooks?: boolean;
    clientCapabilities?: ClientCapabilities;
    parentToolUseId?: string | null;
    cwd?: string;
    taskState?: TaskState;
    messageId?: string;
}): SessionNotification[];
export declare function streamEventToAcpNotifications(message: SDKPartialAssistantMessage, sessionId: string, toolUseCache: ToolUseCache, client: AgentSideConnection, logger: Logger, options?: {
    clientCapabilities?: ClientCapabilities;
    cwd?: string;
    taskState?: TaskState;
    messageId?: string;
}): SessionNotification[];
export declare function runAcp(): {
    connection: AgentSideConnection;
    agent: ClaudeAcpAgent;
};
export {};
//# sourceMappingURL=acp-agent.d.ts.map