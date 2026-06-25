import { AuthenticateRequest, CancelNotification, ClientCapabilities, CompleteElicitationNotification, CreateElicitationRequest, CreateElicitationResponse, ForkSessionRequest, ForkSessionResponse, InitializeRequest, InitializeResponse, ListSessionsRequest, ListSessionsResponse, LoadSessionRequest, LoadSessionResponse, NewSessionRequest, NewSessionResponse, PromptRequest, PromptResponse, ReadTextFileRequest, ReadTextFileResponse, RequestPermissionRequest, RequestPermissionResponse, ResumeSessionRequest, ResumeSessionResponse, SessionConfigOption, SessionModeState, SessionNotification, SetSessionConfigOptionRequest, SetSessionConfigOptionResponse, SetSessionModeRequest, SetSessionModeResponse, CloseSessionRequest, CloseSessionResponse, DeleteSessionRequest, DeleteSessionResponse, WriteTextFileRequest, WriteTextFileResponse } from "@agentclientprotocol/sdk";
import { AgentInfo, CanUseTool, ModelInfo, Options, PermissionMode, PermissionUpdate, Query, SDKMessageOrigin, SDKPartialAssistantMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
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
/** One in-flight `prompt()` call. A persistent per-session consumer (see
 *  `runConsumer`) drains the SDK query stream for the whole session and settles
 *  each Turn's deferred when that turn's outcome is known, so `prompt()` itself
 *  holds no loop. Turns are processed FIFO: the SDK echoes queued user messages
 *  back in submission order, so `turnQueue[0]` is the turn currently running. */
type Turn = {
    /** uuid stamped on the pushed `SDKUserMessage`; the SDK echoes it back so the
     *  consumer can match the replayed user message to this turn. */
    promptUuid: string;
    /** Local-only slash commands (e.g. `/clear`) return a result without an echo,
     *  so the consumer can't promote them via the replay; it falls back to
     *  promoting the queue head when the result arrives. */
    isLocalOnlyCommand: boolean;
    /** Set once the deferred has been resolved/rejected, so the consumer never
     *  settles a turn twice (idle + handoff + stream-end can all race). */
    settled: boolean;
    resolve: (response: PromptResponse) => void;
    reject: (error: unknown) => void;
};
type Session = {
    query: Query;
    input: Pushable<SDKUserMessage>;
    cancelled: boolean;
    /** FIFO of in-flight prompts. The head is the turn the SDK is currently
     *  processing; later entries are queued and will be echoed in order. */
    turnQueue?: Turn[];
    /** The turn whose messages the consumer is currently attributing output to
     *  (the head of `turnQueue` once its user message has been echoed). */
    activeTurn?: Turn | null;
    /** Count of result messages the consumer should treat as orphans and skip
     *  (not promote/attribute to the current head). When cancel() settles+removes
     *  a queued turn, that turn's user message was already pushed to the SDK, so
     *  the SDK still runs it and emits a result with no uuid we can match. Because
     *  the SDK processes input FIFO, those orphan results arrive (in submission
     *  order) before the next live turn's, so skipping exactly this many leaves
     *  the genuine head untouched. Reset to 0 on every activation as a backstop
     *  against an SDK that drops queued input on interrupt (no orphan emitted). */
    pendingOrphanResults?: number;
    /** The long-lived consumer task. Lazily started on the first `prompt()` and
     *  kept alive for the session so between-turn/background messages are still
     *  drained and forwarded. */
    consumer?: Promise<void>;
    /** Set once the SDK query stream has terminated (it ran to `done` or threw a
     *  non-process error). The query iterator is not reusable afterward, so a
     *  later `prompt()` rejects instead of enqueueing onto a dead stream and
     *  hanging (or silently restarting a consumer that resolves `end_turn`
     *  without ever reaching the model). */
    queryClosed?: boolean;
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
    /** Custom main-thread agent personas the user (or a plugin/project) has
     *  configured, discovered via `supportedAgents()` with Claude Code's built-in
     *  subagents filtered out. Empty when none are configured, in which case the
     *  "agent" config option is omitted entirely. */
    agents: AgentInfo[];
    /** The currently selected main-thread agent name, or "default" for the
     *  standard Claude Code agent (no `agent` flag applied). */
    currentAgent: string;
    abortController: AbortController;
    /** Signal the consumer races `query.next()` against. Aborted by cancel()
     *  (after a grace period) to force the active turn to settle "cancelled" when
     *  the SDK is wedged and `query.next()` never yields again (issue #680).
     *  Distinct from `abortController`: this only wakes the consumer; it does NOT
     *  touch the SDK query/subprocess. The consumer re-arms it after each fire.
     *  Undefined until the consumer is started by the first prompt. */
    cancelController?: AbortController;
    /** Pending grace-period timer that aborts `cancelController`. Cleared when the
     *  active turn settles normally so the backstop never fires after a clean
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
/**
 * Client-facing surface the agent calls back into. This is the subset of ACP
 * client methods the agent actually uses, expressed as a narrow interface so
 * tests can supply lightweight mocks. In production it is backed by
 * {@link ClientConnection} over the SDK's typed `AgentContext`.
 */
export interface AcpClient {
    sessionUpdate(params: SessionNotification): Promise<void>;
    /** `signal`, when aborted, sends `$/cancel_request` for the in-flight
     *  permission request so the client can dismiss its prompt (and settle our
     *  await) instead of leaving the dialog open after the turn was cancelled. */
    requestPermission(params: RequestPermissionRequest, signal?: AbortSignal): Promise<RequestPermissionResponse>;
    readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse>;
    writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse>;
    /** `signal`, when aborted, sends `$/cancel_request` for the in-flight
     *  elicitation so the client can dismiss its prompt and settle our await. */
    unstable_createElicitation(params: CreateElicitationRequest, signal?: AbortSignal): Promise<CreateElicitationResponse>;
    unstable_completeElicitation(params: CompleteElicitationNotification): Promise<void>;
    /** Send a custom (extension) notification, e.g. `_claude/sdkMessage`. */
    extNotification(method: string, params: Record<string, unknown>): Promise<void>;
}
export declare class ClaudeAcpAgent {
    sessions: {
        [key: string]: Session;
    };
    client: AcpClient;
    clientCapabilities?: ClientCapabilities;
    logger: Logger;
    gatewayAuthRequest?: GatewayAuthRequest;
    /** Grace period before a `session/cancel` forces a wedged prompt loop to
     *  return "cancelled". See {@link DEFAULT_FORCE_CANCEL_GRACE_MS}. Mutable so
     *  tests can shrink it. */
    forceCancelGraceMs: number;
    constructor(client: AcpClient, logger?: Logger);
    initialize(request: InitializeRequest): Promise<InitializeResponse>;
    newSession(params: NewSessionRequest): Promise<NewSessionResponse>;
    unstable_forkSession(params: ForkSessionRequest): Promise<ForkSessionResponse>;
    resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse>;
    loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse>;
    listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse>;
    authenticate(_params: AuthenticateRequest): Promise<void>;
    prompt(params: PromptRequest): Promise<PromptResponse>;
    /** Lazily start the per-session consumer that drains the SDK query stream for
     *  the session's whole life. Idempotent: only the first `prompt()` starts it. */
    private ensureConsumer;
    /** The single, long-lived consumer of the SDK query stream for a session. It
     *  forwards every message as ACP `sessionUpdate`s (so background/between-turn
     *  output streams live, not just while a prompt is awaiting) and settles each
     *  Turn's deferred when that turn ends. Replaces the per-prompt message loop;
     *  `params` only carries the (session-invariant) `sessionId`. */
    private runConsumer;
    cancel(params: CancelNotification): Promise<void>;
    /** Mark a session's SDK query stream as permanently ended and release the
     *  resources tied to it: drop the consumer handle, dispose the settings
     *  watchers, end the input stream, and close the query (which terminates the
     *  subprocess). The query iterator is not revivable, so `prompt()`/`cancel()`
     *  consult `queryClosed` and fail/short-circuit instead of acting on a dead
     *  stream. Idempotent (guarded by `queryClosed`), so the consumer's done/error
     *  paths and a later `teardownSession` can all call it without double-releasing.
     *
     *  Deliberately does NOT abort `session.abortController`: that controller may be
     *  CLIENT-supplied (`_meta.claudeCode.options.abortController`) and reused, so
     *  aborting it on a spontaneous stream end would cancel the client's own work
     *  or make a sibling session born aborted. `query.close()` already terminates
     *  the subprocess; aborting the signal belongs in `teardownSession` (explicit
     *  destroy), not here. Also does NOT remove the session from the map — that is
     *  `teardownSession`'s job — so prompt() can still answer with a clear "session
     *  ended" error after an unexpected stream close. The leftover session object
     *  is a lightweight husk (its heavy resources are released here) and is evicted
     *  on the next closeSession/deleteSession or when the connection's `dispose()`
     *  runs. */
    private closeQueryStream;
    /** Cleanly tear down a session: cancel in-flight work, release stream
     *  resources, and remove it from the session map. */
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
    /** Forward a permission request to the client, wiring the tool call's
     *  `signal` through as a `cancellationSignal`. When the turn is cancelled
     *  while the client's prompt is still open the signal aborts, the SDK sends
     *  `$/cancel_request`, and the client settles the request (a `cancelled`
     *  outcome or a `requestCancelled` rejection). Either way we surface the same
     *  "Tool use aborted" the callers already expect, so a cancelled dialog no
     *  longer leaves the `await` hanging. */
    private requestPermissionFromClient;
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
export declare const BUILTIN_AGENT_NAMES: Set<string>;
export declare const DEFAULT_AGENT_ID = "default";
/** Discover user/plugin/project-configured main-thread agents, excluding the
 *  built-in subagents and the reserved "default" sentinel. Returns an empty
 *  list if discovery fails so a flaky control request never blocks session
 *  creation. */
export declare function discoverCustomAgents(q: Query): Promise<AgentInfo[]>;
export declare function buildConfigOptions(modes: SessionModeState, models: SessionModelState, modelInfos: ModelInfo[], currentEffortLevel?: string, agents?: AgentInfo[], currentAgent?: string): SessionConfigOption[];
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
export declare function toAcpNotifications(content: string | ContentBlockParam[] | BetaContentBlock[] | BetaRawContentBlockDelta[], role: "assistant" | "user", sessionId: string, toolUseCache: ToolUseCache, client: AcpClient, logger: Logger, options?: {
    registerHooks?: boolean;
    clientCapabilities?: ClientCapabilities;
    parentToolUseId?: string | null;
    cwd?: string;
    taskState?: TaskState;
    messageId?: string;
}): SessionNotification[];
export declare function streamEventToAcpNotifications(message: SDKPartialAssistantMessage, sessionId: string, toolUseCache: ToolUseCache, client: AcpClient, logger: Logger, options?: {
    clientCapabilities?: ClientCapabilities;
    cwd?: string;
    taskState?: TaskState;
    messageId?: string;
}): SessionNotification[];
/** Run a `session/prompt` while honoring `$/cancel_request` for it. ACP clients
 *  normally stop a turn with the `session/cancel` notification, but `signal`
 *  (the prompt request's abort signal) also fires when the client sends the
 *  generic `$/cancel_request` for this prompt — the protocol's complementary
 *  cancellation fallback. Route that to the same `agent.cancel` path so a client
 *  using only the generic mechanism still stops the turn (and the prompt
 *  resolves "cancelled" instead of running to completion).
 *
 *  The listener is scoped to this call: once the prompt settles it is removed,
 *  so a later teardown-time abort of the (per-request) signal can't cancel a
 *  subsequent turn. `signal` also aborts on connection close, in which case
 *  cancelling the in-flight turn is the desired behavior anyway. */
export declare function runPromptWithCancellation(agent: Pick<ClaudeAcpAgent, "prompt" | "cancel" | "logger">, params: PromptRequest, signal: AbortSignal): Promise<PromptResponse>;
export declare function runAcp(): {
    connection: import("@agentclientprotocol/sdk").AgentConnection;
    agent: ClaudeAcpAgent;
};
export {};
//# sourceMappingURL=acp-agent.d.ts.map