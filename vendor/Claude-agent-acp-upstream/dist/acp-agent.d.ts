import { Agent, AgentSideConnection, AuthenticateRequest, CancelNotification, ClientCapabilities, ForkSessionRequest, ForkSessionResponse, InitializeRequest, InitializeResponse, ListSessionsRequest, ListSessionsResponse, LoadSessionRequest, LoadSessionResponse, NewSessionRequest, NewSessionResponse, PromptRequest, PromptResponse, ReadTextFileRequest, ReadTextFileResponse, ResumeSessionRequest, ResumeSessionResponse, SessionConfigOption, SessionModelState, SessionModeState, SessionNotification, SetSessionConfigOptionRequest, SetSessionConfigOptionResponse, SetSessionModelRequest, SetSessionModelResponse, SetSessionModeRequest, SetSessionModeResponse, CloseSessionRequest, CloseSessionResponse, TerminalHandle, TerminalOutputResponse, WriteTextFileRequest, WriteTextFileResponse } from "@agentclientprotocol/sdk";
import { CanUseTool, Options, PermissionMode, Query, SDKPartialAssistantMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { ContentBlockParam } from "@anthropic-ai/sdk/resources";
import { BetaContentBlock, BetaRawContentBlockDelta } from "@anthropic-ai/sdk/resources/beta.mjs";
import { SettingsManager } from "./settings.js";
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
    configOptions: SessionConfigOption[];
    promptRunning: boolean;
    pendingMessages: Map<string, {
        resolve: (cancelled: boolean) => void;
        order: number;
    }>;
    nextPendingOrder: number;
    abortController: AbortController;
    emitRawSDKMessages: boolean | SDKMessageFilter[];
    /** Context window size of the last top-level assistant model, carried across
     *  prompts so mid-stream usage_update notifications report a correct `size`
     *  before the turn's first result message arrives. Defaults to
     *  DEFAULT_CONTEXT_WINDOW, refreshed from each result's modelUsage, and
     *  invalidated when the user switches the session's model. */
    contextWindowSize: number;
};
type BackgroundTerminal = {
    handle: TerminalHandle;
    status: "started";
    lastOutput: TerminalOutputResponse | null;
} | {
    status: "aborted" | "exited" | "killed" | "timedOut";
    pendingOutput: TerminalOutputResponse;
};
export type SDKMessageFilter = {
    type: string;
    subtype?: string;
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
export declare function resolvePermissionMode(defaultMode?: unknown): PermissionMode;
export declare class ClaudeAcpAgent implements Agent {
    sessions: {
        [key: string]: Session;
    };
    client: AgentSideConnection;
    toolUseCache: ToolUseCache;
    backgroundTerminals: {
        [key: string]: BackgroundTerminal;
    };
    clientCapabilities?: ClientCapabilities;
    logger: Logger;
    gatewayAuthMeta?: GatewayAuthMeta;
    constructor(client: AgentSideConnection, logger?: Logger);
    initialize(request: InitializeRequest): Promise<InitializeResponse>;
    newSession(params: NewSessionRequest): Promise<NewSessionResponse>;
    unstable_forkSession(params: ForkSessionRequest): Promise<ForkSessionResponse>;
    unstable_resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse>;
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
    unstable_closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse>;
    unstable_setSessionModel(params: SetSessionModelRequest): Promise<SetSessionModelResponse | void>;
    setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse>;
    setSessionConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse>;
    private applySessionMode;
    private replaySessionHistory;
    readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse>;
    writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse>;
    canUseTool(sessionId: string): CanUseTool;
    private sendAvailableCommandsUpdate;
    private updateConfigOption;
    private syncSessionConfigState;
    private getOrCreateSession;
    private createSession;
}
export declare function promptToClaude(prompt: PromptRequest): SDKUserMessage;
/**
 * Convert an SDKAssistantMessage (Claude) to a SessionNotification (ACP).
 * Only handles text, image, and thinking chunks for now.
 */
export declare function toAcpNotifications(content: string | ContentBlockParam[] | BetaContentBlock[] | BetaRawContentBlockDelta[], role: "assistant" | "user", sessionId: string, toolUseCache: ToolUseCache, client: AgentSideConnection, logger: Logger, options?: {
    registerHooks?: boolean;
    clientCapabilities?: ClientCapabilities;
    parentToolUseId?: string | null;
    cwd?: string;
}): SessionNotification[];
export declare function streamEventToAcpNotifications(message: SDKPartialAssistantMessage, sessionId: string, toolUseCache: ToolUseCache, client: AgentSideConnection, logger: Logger, options?: {
    clientCapabilities?: ClientCapabilities;
    cwd?: string;
}): SessionNotification[];
export declare function runAcp(): {
    connection: AgentSideConnection;
    agent: ClaudeAcpAgent;
};
export {};
//# sourceMappingURL=acp-agent.d.ts.map