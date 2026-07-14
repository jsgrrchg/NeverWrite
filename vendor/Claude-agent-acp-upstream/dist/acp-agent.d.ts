import { AuthenticateRequest, CancelNotification, ClientCapabilities, CompleteElicitationNotification, CreateElicitationRequest, CreateElicitationResponse, ForkSessionRequest, ForkSessionResponse, InitializeRequest, InitializeResponse, ListSessionsRequest, ListSessionsResponse, LoadSessionRequest, LoadSessionResponse, LogoutRequest, NewSessionRequest, NewSessionResponse, PromptRequest, PromptResponse, ReadTextFileRequest, ReadTextFileResponse, RequestPermissionRequest, RequestPermissionResponse, ResumeSessionRequest, ResumeSessionResponse, SessionConfigOption, SessionModeState, SessionNotification, SetSessionConfigOptionRequest, SetSessionConfigOptionResponse, SetSessionModeRequest, SetSessionModeResponse, CloseSessionRequest, CloseSessionResponse, DeleteSessionRequest, DeleteSessionResponse, WriteTextFileRequest, WriteTextFileResponse } from "@agentclientprotocol/sdk";
import { AgentInfo, CanUseTool, FastModeState, ModelInfo, Options, PermissionMode, PermissionUpdate, Query, SDKMessageOrigin, SDKPartialAssistantMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
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
    /** Set when a `command_lifecycle` "started" frame arrives for this turn's
     *  uuid (msg_lifecycle_v1 CLIs): the SDK dispatched the command into a turn.
     *  Read by cancel() to seed the orphan's state — a started orphan's turn may
     *  still emit a result, an undispatched one may be dropped without one. */
    commandStarted?: boolean;
    /** Set when a terminal `command_lifecycle` frame arrives for this turn's
     *  uuid while the turn is still queued (msg_lifecycle_v1 CLIs). The command
     *  is already finished SDK-side, so a later cancel() must not seed an
     *  orphan entry for it — no terminal frame will ever come to drain it.
     *  "completed"/"discarded" leave nothing outstanding; "cancelled" after a
     *  dispatch means the dead turn's result may still arrive (seeded as a
     *  zombie) unless it already passed (`commandResultSeen`), and without a
     *  dispatch means dropped (nothing coming). */
    commandFinished?: "completed" | "discarded" | "cancelled";
    /** Set when a user-turn result arrives while this command is known
     *  dispatched (`commandStarted`) with no terminal frame yet. Turns run
     *  sequentially and frames arrive in stream order, so the turn this command
     *  was dispatched into IS the turn that emitted that result — including
     *  when the command was FOLDED into another turn (their shared result).
     *  Read by cancel() and the force-cancel wedge path so neither seeds an
     *  orphan entry for a result that has already passed: such an entry could
     *  never be drained by its result and would swallow an unrelated later
     *  echo-less one instead. */
    commandResultSeen?: boolean;
    /** Task ids of the background subagents launched while this turn was the
     *  active one — including during its held-open drain window, so an agent
     *  chain (a followup that launches another subagent) extends the hold.
     *  A turn only waits on its OWN spawned subagents: a long-running agent
     *  from an earlier turn must not stall every later prompt's settlement.
     *  Known residual: task_started carries no lineage, so a spawn made by a
     *  PREVIOUS turn's followup chain while a later turn happens to be held
     *  is attributed to the holder — extending that hold behind a foreign
     *  chain. Bounded: the hold still ends at drain, hand-off, or cancel. */
    spawnedTaskIds?: Set<string>;
    /** Set instead of settling when the turn's terminal result arrives while
     *  subagents it spawned are still live (`spawnedTaskIds` ∩
     *  `session.liveBackgroundTasks`). The turn is held open — its
     *  `session/prompt` stays pending — so the subagents' streamed output,
     *  their permission requests (which would otherwise block on an RPC a
     *  client that stops consuming at the prompt response never answers —
     *  issue #866), and the model's task-notification followup summary all
     *  land inside the turn.
     *
     *  The CLI does NOT hold its trailing idle for background agents (observed
     *  on 2.1.206: `idle` follows the result immediately while the subagent
     *  still runs), so the hold spans multiple idle cycles: user result →
     *  idle → (subagent works) → task_notification → followup turn → idle.
     *  The stored outcome (the result's stop reason and usage snapshot) is
     *  what the turn settles with once its spawned subagents have settled —
     *  at the followup's terminal result (the summary has streamed by then),
     *  or at an idle with none of its subagents left (no followup came). A
     *  cancel or the next turn's echo hand-off settles it earlier, so a
     *  long-running subagent never holds the prompt hostage.
     *
     *  Accepted residuals. (1) A subagent that ends WITHOUT waking the model —
     *  its task_notification lost or skipped (only the terminal task_updated
     *  patch is guaranteed per transition) — leaves no followup result and no
     *  further idle, so the held turn parks until `session/cancel` or the next
     *  prompt (either settles it: the echo hand-off or ensureActiveTurn's
     *  held-turn hand-off). Settling at the prune sites instead would preempt
     *  the followup summary in the normal ordering (prunes precede the
     *  notification), and a grace timer was judged not worth the machinery —
     *  the same rescue contract as the adapter's other wedge classes (issue
     *  #825's out-of-scope notes). (2) Drained-ness is judged by live-task
     *  membership only: with parallel subagents, a notification that prunes
     *  the last task during an earlier task's still-streaming followup lets
     *  that followup's result settle the turn before the LAST task's summary
     *  streams — degrading to post-turn delivery for it, never worse than the
     *  pre-hold behavior (pending wakes are not countable: notifications can
     *  batch into one followup). */
    deferredSettle?: PromptResponse;
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
     *  the genuine head untouched. On CLIs with the interrupt receipt, orphans
     *  the interrupt dropped (absent from `still_queued`) are uncounted as soon
     *  as the receipt arrives (see cancel()). Reset to 0 on every activation as
     *  a backstop against a dropped queued input this can't see (older CLIs, a
     *  receipt lost to a failed control round-trip). Only used when the CLI does
     *  NOT emit lifecycle frames (see `orphanCommands` for the msg_lifecycle_v1
     *  lane); a count can't express command coalescing — N queued commands can
     *  fold into ONE turn emitting one result, leaving a stale skip of N-1. */
    pendingOrphanResults?: number;
    /** msg_lifecycle_v1 lane of the orphan accounting (see
     *  `pendingOrphanResults` for the count lane): the uuids of cancelled queued
     *  turns whose SDK-side command may still produce an unaccounted result,
     *  keyed to what we know of its fate. "pending" = not seen dispatched; if
     *  the SDK drops it (interrupt, `cancelled` before "started") no result
     *  ever comes. "started" = dispatched into a turn whose result is still
     *  coming; exactly one terminal lifecycle frame will follow. "zombie" = its
     *  turn was aborted/failed after dispatch with no result seen since
     *  (`cancelled` after "started"); no more lifecycle frames come, but the
     *  dead turn's error result may still arrive. Entries are removed the
     *  moment their result is covered: EVERY user-turn result covers ALL
     *  started and zombie entries at once (turns run sequentially and frames
     *  arrive in stream order, so at any result the started entries were
     *  dispatched into — possibly folded into — the emitting turn, and any
     *  zombie's late result has already passed or never existed), whether that
     *  result was attributed to the active turn or skipped echo-less (see
     *  recordResultForOrphanCommands / ensureActiveTurn). A command's own
     *  terminal frame also drains its entry ("completed" is emitted after any
     *  result its turn produced; a bare `cancelled` deletes a pending entry —
     *  dropped without running — and zombifies a started one). An echo-less
     *  result is an orphan's iff this map is non-empty (FIFO: orphan turns run
     *  before any live turn's). Cleared on every activation, same self-heal as
     *  the count (covers a lost frame, which can leak an entry — each state
     *  bounds the damage to one wrong skip). */
    orphanCommands?: Map<string, "pending" | "started" | "zombie">;
    /** True once a `system`/init advertised the msg_lifecycle_v1 capability, so
     *  cancel() routes orphan accounting to `orphanCommands` (exact, per-uuid)
     *  instead of `pendingOrphanResults` (count, coalescing-blind). */
    msgLifecycleV1?: boolean;
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
    /** Whether Fast mode is currently enabled for this session. Tracked as the
     *  user's intent so it persists across model switches; the Fast mode config
     *  option is only surfaced while the selected model supports it. */
    fastModeEnabled: boolean;
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
    /** Context window size of the session's current model, carried across
     *  prompts so mid-stream usage_update notifications report a correct `size`
     *  before the turn's first result message arrives. Seeded from the SDK's
     *  getContextUsage report at session creation (DEFAULT_CONTEXT_WINDOW when
     *  that and the text heuristic both fail), refreshed the same way on model
     *  switches, and confirmed by each result's modelUsage. */
    contextWindowSize: number;
    /** Accumulated task list for the session, keyed by task ID. Task IDs are
     *  per-session, so this state must not be shared across sessions. */
    taskState: TaskState;
    /** Last session title we pushed to the client via `session_info_update`.
     *  The SDK auto-generates a title in a background task and persists it to the
     *  session file; we poll it on each turn-end (`session_state_changed: idle`)
     *  and only notify the client when it actually changes. Undefined until the
     *  first title is observed. */
    lastTitle?: string;
    /** Caches `tool_use` blocks by id so the matching `tool_result` can recover
     *  the tool name/input when mapping it to a `tool_call_update`. Per-session
     *  (tool_use ids are only unique within a session) and pruned at
     *  `tool_result` time so a long-running session doesn't accumulate every
     *  tool call for its whole lifetime. */
    toolUseCache: ToolUseCache;
    /** Tracks which tool_use ids we've already emitted a `tool_call` for, so the
     *  second source to encounter a tool call sends a `tool_call_update` instead
     *  of a duplicate `tool_call`. The SDK can invoke `canUseTool` (→ a permission
     *  request, which emits the tool_call eagerly so the client has it before
     *  being asked to approve it) either before or after the assistant message's
     *  tool_use block streams; this set makes the two paths converge regardless of
     *  order. Pruned at `tool_result` time alongside `toolUseCache`. */
    emittedToolCalls: Set<string>;
    /** Registry of live background tasks, keyed by task id: populated at
     *  `task_started`, pruned when the task settles (a `task_notification` or
     *  a terminal `task_updated` patch), and reconciled against
     *  `background_tasks_changed`'s replace-semantics payload so a lost
     *  bookend can't leak an entry. One structure for both of its concerns so
     *  a future terminal path can't prune one and not the other:
     *
     *  `parentToolUseId` — the tool_use id of the Agent/Task call that spawned
     *  the task. For subagent tasks the SDK keys its registry by agent id, so
     *  `task_started.task_id` IS the `agentID` that `canUseTool` later
     *  receives. Lets the permission flow attribute a subagent's
     *  eagerly-emitted `tool_call` (and the permission request itself) to its
     *  parent tool call via `_meta.claudeCode.parentToolUseId`, matching the
     *  streamed subagent path. Best-effort: a `canUseTool` that races ahead of
     *  the consumer processing `task_started` omits the attribution from the
     *  eager tool_call, and the streamed tool_use chunk's refining
     *  `tool_call_update` — which carries the message-level
     *  `parent_tool_use_id` — restores it for merging clients; that recovery
     *  is what makes best-effort acceptable here.
     *
     *  `isSubagent` — whether the task is a Task/Agent-tool subagent
     *  (`task_started` carried a `subagent_type`). Read by
     *  `turnAwaitingSubagents` (with `spawnedTaskIds`) to decide whether a
     *  turn's settlement is deferred (see `Turn.deferredSettle`), so the
     *  subagents' post-result output and permission requests stay inside the
     *  turn (issues #864/#866). Deliberately false for non-subagent background
     *  tasks (e.g. a `run_in_background` dev server): those can outlive every
     *  turn, and the model's contract with them is a wake-on-exit
     *  notification, not a turn-scoped drain — a hold must NEVER wait on a
     *  shell.
     *
     *  `endedPerLevel` — a `background_tasks_changed` payload did not include
     *  this subagent entry. The level's universe is BACKGROUND tasks only, so
     *  a live sync (foreground) subagent is legitimately absent — its entry is
     *  kept for permission attribution — but a hold must stop waiting on the
     *  id: an absent id can equally be a leaked async entry whose settle
     *  bookends were lost, and waiting on it would park the hold forever.
     *  Non-subagent entries are simply deleted instead (shells are always in
     *  the level's universe). */
    liveBackgroundTasks: Map<string, {
        parentToolUseId?: string;
        isSubagent: boolean;
        /** Absent-from-level lifecycle, one field so the illegal
         *  armed-but-not-ended state is unrepresentable: undefined = live per
         *  the level signal; "ended" = a level omitted the task (holds stop
         *  waiting on it; attribution is kept); "sweep-armed" = a turn
         *  activation saw it ended — the NEXT activation deletes it. The
         *  one-activation grace exists for the absent-mark race (a level
         *  payload built before a live async agent's registration): a
         *  corrective inclusive level resets the field to undefined — one
         *  assignment, disarming any in-flight sweep — if it arrives within a
         *  full turn, keeping the agent's attribution; eager deletion would
         *  be irreversible, since levels never ADD entries. A re-mark
         *  preserves an in-flight arm (`??=`), keeping a continuously absent
         *  entry on its two-activation clock. */
        endedPerLevel?: "ended" | "sweep-armed";
    }>;
    /** Whether any top-level assistant text reached the client since the last
     *  stretch boundary. Set as a side effect of sending in the consumer's
     *  `sendUpdate`, never at an emission site; read at the terminal `result`
     *  to tell a turn whose answer was already delivered from one that only
     *  ever carried it on `result` (issue #453). Session-level (not
     *  consumer-scoped) so cancel()'s inline settle can clear it.
     *
     *  The CURRENT boundary set — a new clear site must be added here: the
     *  result case's `finally` (user-turn results), settleActive's wasHeld
     *  clear (every held-turn settle lane: drain settle, both hand-offs,
     *  stream-done), failActive, the force-cancel backstop, the idle
     *  cancelled-settle, the autonomous-result close (only with no turn
     *  active OR queued — see its queued-turn guard), and cancel()'s inline
     *  mirror.
     *
     *  Deliberately NOT reset on turn activation: activation can fire
     *  mid-message (see the echo hand-off), so a flag cleared there would
     *  forget text that already streamed and the result text would be emitted
     *  a second time. Neither the consolidated `assistant` message nor a
     *  `stream_event` carries `origin`, so an autonomous cycle's prose is
     *  indistinguishable from a user turn's here and sets the flag too; the
     *  autonomous-result close normally ends that stretch so a replayed
     *  prompt behind it still delivers, and only in the racing window (a
     *  turn already active or queued when the autonomous result lands) does
     *  the replayed turn stay silent rather than risk a duplicate. */
    emittedAssistantText: boolean;
    /** The most recent `session_state_changed` state the consumer processed.
     *  Read by cancel() to decide whether the interrupt will produce a
     *  trailing idle worth pre-counting: interrupting a RUNNING cycle yields
     *  one; interrupting an already-idle session (the common held-turn shape)
     *  yields none, and a pre-counted debt that never drains would mask one
     *  future issue-#825 detection. */
    lastSessionState?: "idle" | "running" | "requires_action";
    /** How many trailing `session_state_changed: idle` messages are already
     *  accounted for: every result is followed by one (user-turn results that
     *  terminate a turn — settle, reject, or orphan skip — and autonomous
     *  cycles alike), as is a cancelled turn settled by the next turn's echo
     *  hand-off or by cancel()'s inline settle of a held turn whose interrupt
     *  pre-empts a running cycle — the reason this lives on the Session:
     *  cancel() must be able to record the debt. The idle handler absorbs
     *  owed idles; an idle that arrives when NONE is owed while the active
     *  turn is still unsettled means the SDK ended the turn without ever
     *  emitting its result, so the turn will never settle on its own (issue
     *  #825). Stream-level debt, deliberately NOT reset per turn: a lagged
     *  idle can arrive after the next turn has already activated (issue
     *  #773), and the debt is what attributes it to the turn that owed it.
     *  Over-counting (an idle the SDK never emits) is benign: the counter
     *  just absorbs one future idle, and detection degrades to the status quo
     *  rather than misfiring. */
    owedTrailingIdles: number;
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
        parentToolUseId?: string;
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
type StreamedToolInput = {
    id: string;
    name: string;
    partialJson: string;
    /** Offset into `partialJson` the scanner has consumed; each delta only scans
     *  the newly appended fragment, so total scan work stays linear. */
    scannedTo: number;
    inString: boolean;
    escaped: boolean;
    objectDepth: number;
    arrayDepth: number;
    /** Offset of the most recent comma at the top level of the input object
     *  (-1 before the first). Everything before it is a complete field. */
    lastTopLevelComma: number;
    /** The comma offset the last emitted refinement was sliced at (-1 before the
     *  first), so a field boundary only triggers one recovery attempt. */
    emittedThroughComma: number;
};
export type StreamedToolInputCache = Map<string, Map<number, StreamedToolInput>>;
export declare function claudeCliPath(): Promise<string>;
/**
 * Return user-message content with local-command marker tags removed, or
 * `null` if nothing meaningful remains (caller should skip the message).
 * Preserves real prose that's mixed in alongside the markers — e.g. a
 * message like `<command-name>…</command-name>hi` becomes `hi`.
 */
export declare function stripLocalCommandMetadata(content: unknown): unknown | null;
export declare function isLocalCommandMetadata(content: unknown): boolean;
/**
 * True for the synthetic assistant message the CLI injects into the transcript
 * when a turn fails authentication (e.g. "Not logged in · Please run /login",
 * "Session expired. Please run /login to sign in again."). The `/login`
 * instruction is Claude Code TUI-specific and meaningless to ACP clients
 * (issue #863). The live prompt loop suppresses the text and fails the turn
 * with `authRequired` so the client can run its own auth flow; replay must
 * skip it too — both for parity with what the client saw live and because the
 * message stays in the transcript forever, so it would resurface on every
 * session/load even after the user has logged back in.
 *
 * Takes the API message (`message.message`), which replay only knows as
 * `unknown`. The persisted record's structured `error: "authentication_failed"`
 * marker is stripped by `getSessionMessages`, so the synthetic model + text is
 * all both paths have to match on.
 */
export declare function isSyntheticLoginMessage(apiMessage: unknown): boolean;
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
    /** Read the SDK-maintained title for a session and, if it changed since the
     *  last time we looked, notify the client with a `session_info_update`. The
     *  SDK has no push event for the title it auto-generates in the background, so
     *  we pull it at turn-end. A missing session file or read error is non-fatal:
     *  the title is best-effort and another turn will retry. */
    private maybeUpdateSessionTitle;
    authenticate(_params: AuthenticateRequest): Promise<void>;
    logout(_params: LogoutRequest): Promise<void>;
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
    /** Route one orphaned command into the session's orphan-accounting lane:
     *  the per-uuid map on msg_lifecycle_v1 CLIs (drained by the command's own
     *  terminal lifecycle frame and the echo-less-result skip), the plain count
     *  elsewhere (the count lane can't express per-command states, so `state`
     *  only matters on the map lane). Both orphan-producing paths — cancel()'s
     *  queued-turn sweep and the consumer's force-cancel wedge path — must seed
     *  through here so the lane split stays a single mechanism.
     *
     *  Known window: `msgLifecycleV1` is only learnable from the stream's first
     *  `system`/init (the control-channel initialize carries no capabilities),
     *  so a cancel that beats that drain seeds the COUNT lane on a
     *  lifecycle-capable CLI — where command coalescing can leave the count
     *  stale by N-1 (the pre-map bug, confined to this sub-second window and
     *  still healed by the next activation's reset). Structural until the SDK
     *  exposes capabilities before the stream starts. */
    private trackOrphanCommand;
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
    /** Emit the `tool_call` a permission request references if it hasn't been sent
     *  yet, so the client has the tool call before being asked to approve it. The
     *  matching streamed tool_use chunk later refines it with a `tool_call_update`
     *  instead of emitting a duplicate (see `emittedToolCalls`). Built via the same
     *  `toolCallNotification` helper as the streamed path so the two are identical.
     *  Tools the stream renders as a plan (TodoWrite) or suppresses (Task*) are
     *  emitted too: a permission request referencing a tool call the client has
     *  never seen can trip strict clients (issue #851), so the reference must
     *  always resolve. Since the streamed path never completes those calls, they
     *  are resolved at tool_result time instead (see `toAcpNotifications`).
     *  `parentToolUseId` attributes a subagent's tool call to the Agent/Task call
     *  that spawned it, matching the streamed path's `_meta`. */
    private ensureToolCallEmitted;
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
    /**
     * Handle `request_user_dialog` control requests — blocking dialogs the CLI
     * asks the host to render. Only kinds declared in `supportedDialogKinds`
     * are ever emitted; everything unexpected is answered `cancelled` (the
     * required answer for unrecognized kinds), which applies the dialog's
     * default behavior CLI-side. Today the only declared kind is the
     * refusal-fallback consent prompt, rendered as an ACP form elicitation.
     */
    private handleUserDialog;
    private sendAvailableCommandsUpdate;
    private updateConfigOption;
    private applyConfigOptionValue;
    /** Reconcile adapter model state after the SDK persistently swapped the
     *  session's model out from under us (refusal fallback). The SDK already
     *  made the switch, so this must NOT call `query.setModel` — it only
     *  updates our bookkeeping (currentModelId, context window, mode clamping,
     *  effort/Fast-mode options) via the same `applyConfigOptionValue` path a
     *  user-driven model change takes, then notifies the client. */
    private syncModelAfterRefusalFallback;
    /** Replace the Fast mode option in `session.configOptions` so it reflects
     *  `enabled` (and the client's current boolean-capability). A no-op when the
     *  option isn't present, so callers must confirm the current model surfaces
     *  it first. */
    private refreshFastModeOption;
    /** Toggle Fast mode for a session: push the SDK flag, record the user's
     *  intent, and refresh the Fast mode config option in place. Only reached
     *  once the option exists (i.e. the current model supports fast mode), so the
     *  option is guaranteed to be present in `configOptions`. */
    private applyFastMode;
    /** Reconcile the session's Fast mode toggle with an SDK-reported
     *  `fast_mode_state` (delivered on `system`/init and on user-turn `result`s).
     *  The SDK can flip fast mode independently of the user — e.g. back to `on`
     *  once a rate-limit `cooldown` clears — so we mirror definitive on/off
     *  changes into the config option and notify the client.
     *
     *  Guards, in order:
     *   - absent state: nothing to reconcile.
     *   - no Fast mode option: the current model doesn't support fast mode, so the
     *     reported state reflects capability, not the user's intent. Leave the
     *     retained setting untouched so it's correct when a supporting model is
     *     reselected (the source of the earlier intent-clobber bug was mutating it
     *     here).
     *   - `cooldown`: a transient suspension of an already-enabled fast mode.
     *     Leave the toggle as-is rather than flapping it — and never let a stray
     *     cooldown spuriously enable a toggle the user has off. */
    private syncFastModeState;
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
/** Stable ids for the session config options surfaced via `configOptions`.
 *  Centralized so the option declarations in `buildConfigOptions` and the
 *  handlers in `setSessionConfigOption`/`applyConfigOptionValue` reference the
 *  same identifiers and can't drift apart. */
export declare const MODE_CONFIG_ID = "mode";
export declare const MODEL_CONFIG_ID = "model";
export declare const EFFORT_CONFIG_ID = "effort";
export declare const AGENT_CONFIG_ID = "agent";
export declare const FAST_MODE_CONFIG_ID = "fast";
/** Select-fallback values used when the client has not opted into boolean
 *  config options (see {@link createFastModeConfigOption}). */
export declare const FAST_MODE_ON = "on";
export declare const FAST_MODE_OFF = "off";
/** Map the SDK's tri-state `fast_mode_state` onto the boolean config toggle.
 *  `cooldown` (fast mode temporarily suspended after a rate limit, per the SDK
 *  docs) keeps the toggle on so it reflects the user's intent — only an
 *  explicit `off` clears it. */
export declare function fastModeStateEnabled(state: FastModeState): boolean;
/** Whether the Client advertised support for boolean session config options
 *  (`session.configOptions.boolean`). Agents MUST only send `type: "boolean"`
 *  config options to Clients that opt in; otherwise we fall back to a `select`.
 *  See https://agentclientprotocol.com/rfds/boolean-config-option. */
export declare function clientSupportsBooleanConfigOptions(clientCapabilities?: ClientCapabilities | null): boolean;
/** Build the Fast mode config option. When the Client supports boolean config
 *  options we expose a native `type: "boolean"` toggle; otherwise we degrade to
 *  a two-value `select` ("on"/"off") so older Clients still get a usable
 *  control. */
export declare function createFastModeConfigOption(enabled: boolean, useBooleanOption: boolean): SessionConfigOption;
/** Resolve the requested Fast mode value from a `session/set_config_option`
 *  request. Accepts a native boolean (boolean-capable Clients) or the
 *  "on"/"off" select-fallback strings. */
export declare function resolveFastModeEnabled(params: SetSessionConfigOptionRequest): boolean;
/** Per-model Fast mode state threaded into {@link buildConfigOptions}. The
 *  option is only surfaced when the current model `supported`s fast mode. */
export type FastModeOptionState = {
    supported: boolean;
    enabled: boolean;
    /** Whether the Client opted into boolean config options. */
    useBooleanOption: boolean;
};
export declare function buildConfigOptions(modes: SessionModeState, models: SessionModelState, modelInfos: ModelInfo[], currentEffortLevel?: string, agents?: AgentInfo[], currentAgent?: string, fastMode?: FastModeOptionState): SessionConfigOption[];
export declare function resolveModelPreference(models: ModelInfo[], preference: string): ModelInfo | null;
/** Map the live model reported by a resumed session onto the picker's model
 *  list. The CLI restores a resumed session's model from the transcript's
 *  last assistant message, which records the concrete API id (e.g.
 *  "claude-opus-4-6") with any "[1m]" context hint dropped. Tiers, in order:
 *  1. Exact match with the Default entry's resolution — when a named alias
 *     shares Default's resolvedModel verbatim, the live id can't tell the
 *     two apart, and a never-customized session should stay on Default.
 *  2. Exact resolvedModel match on a named row. Checked before the
 *     hint-stripped Default comparison so a live "claude-sonnet-5[1m]" lands
 *     on the "sonnet[1m]" row rather than a Default that resolves to the
 *     bare "claude-sonnet-5" — the two rows differ in context window, which
 *     drives `contextWindowSize` and capability gating downstream.
 *  3. Hint-stripped match with Default's resolution — a session that never
 *     left the default resumes as the bare transcript id, and shouldn't show
 *     a concrete picker entry.
 *  4. `resolveModelPreference` over the picker entries.
 *  5. A model with no picker counterpart (e.g. excluded by an
 *     `availableModels` allowlist) is tracked verbatim, mirroring
 *     `syncModelAfterRefusalFallback`: the picker shows no selection, but the
 *     model-dependent bookkeeping stays truthful to what the SDK is running. */
export declare function matchResumedModel(models: ModelInfo[], liveModel: string): ModelInfo;
/**
 * Restrict the SDK's model list to the user's `availableModels` allowlist
 * (already merged-and-deduped across settings sources by `SettingsManager`).
 * The user's exact entries become the model IDs surfaced via configOptions
 * and passed to `setModel`, which prevents Claude Code from silently
 * substituting a date-pinned variant (e.g. `haiku` →
 * `claude-haiku-4-5-20251001`) that the user may not have access to.
 *
 * Display info and capability flags are copied from the closest SDK match so
 * the UI still renders sensible names and effort levels.
 *
 * Semantics from https://code.claude.com/docs/en/model-config#restrict-model-selection:
 * - `undefined` is handled by the caller (no allowlist applied).
 * - The Default option is unaffected by `availableModels` — it always remains
 *   available, even when the allowlist is `[]`.
 */
export declare function applyAvailableModelsAllowlist(sdkModels: ModelInfo[], allowlist: string[], settingsModelOverrides?: Record<string, string>): ModelInfo[];
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
    emittedToolCalls?: Set<string>;
    messageId?: string;
    toolUseResult?: unknown;
}): SessionNotification[];
export declare function streamEventToAcpNotifications(message: SDKPartialAssistantMessage, sessionId: string, toolUseCache: ToolUseCache, client: AcpClient, logger: Logger, options?: {
    clientCapabilities?: ClientCapabilities;
    cwd?: string;
    taskState?: TaskState;
    emittedToolCalls?: Set<string>;
    messageId?: string;
    streamedToolInputs?: StreamedToolInputCache;
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