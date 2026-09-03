import { AuthenticateRequest, CancelNotification, ClientCapabilities, CompleteElicitationNotification, CreateElicitationRequest, CreateElicitationResponse, DisableProviderRequest, DisableProviderResponse, ForkSessionRequest, ForkSessionResponse, InitializeRequest, InitializeResponse, ListProvidersRequest, ListProvidersResponse, LlmProtocol, ListSessionsRequest, ListSessionsResponse, LoadSessionRequest, LoadSessionResponse, LogoutRequest, NewSessionRequest, NewSessionResponse, PromptRequest, PromptResponse, ReadTextFileRequest, ReadTextFileResponse, SetProviderRequest, SetProviderResponse, RequestPermissionRequest, RequestPermissionResponse, ResumeSessionRequest, ResumeSessionResponse, SessionConfigOption, SessionModeState, SessionNotification, SetSessionConfigOptionRequest, SetSessionConfigOptionResponse, SetSessionModeRequest, SetSessionModeResponse, CloseSessionRequest, CloseSessionResponse, DeleteSessionRequest, DeleteSessionResponse, WriteTextFileRequest, WriteTextFileResponse } from "@agentclientprotocol/sdk";
import { AgentInfo, CanUseTool, FastModeDisabledReason, FastModeState, ModelInfo, Options, PermissionMode, Query, SDKMessageOrigin, SDKPartialAssistantMessage, SDKUserMessage, Settings } from "@anthropic-ai/claude-agent-sdk";
import { GoalRequest, GoalControlResponse, GoalSnapshot } from "./goal-extension.js";
import { SessionTitles } from "./session-titles.js";
import { AcpSessionNotification } from "./acp-subagents.js";
import { NativeSubagent, NativeSubagentRuntime } from "./native-subagents.js";
import { AsyncTaskRuntime } from "./async-tasks.js";
import { ContentBlockParam } from "@anthropic-ai/sdk/resources";
import { BetaContentBlock, BetaRawContentBlockDelta } from "@anthropic-ai/sdk/resources/beta.mjs";
import { SettingsManager } from "./settings.js";
import { type SessionFailureState } from "./session-failure-extension.js";
import { type FileChangeAuditSupport, type FileChangeAuditTurnState } from "./file-change-audit.js";
import { TaskState } from "./tools.js";
import { Pushable } from "./utils.js";
export { DEFAULT_AGENT_ID, EFFORT_CONFIG_ID } from "./session-config-ids.js";
import { MODE_CONFIG_ID } from "./session-mode.js";
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
/** Per-model token tallies keyed by the model id the SDK reported them under
 *  (its resolved spelling, e.g. "claude-opus-5[1m]"). */
type ModelTokenTally = Record<string, AccumulatedUsage>;
type AsyncTaskStopRequest = {
    sessionId: string;
    asyncTaskId: string;
};
type AsyncTaskStopResponse = {
    stopped: boolean;
};
/** Request-level steering options. `promptRequired` is opt-in so existing Hosts
 *  keep the established idle fallback behavior. */
type SteerMeta = {
    [key: string]: unknown;
    steering?: {
        idleBehavior?: "promptRequired";
    };
};
/** Params of a {@link STEER_METHOD} request. Shaped like the relevant subset of
 *  a `PromptRequest` so the same `promptToClaude` conversion applies. Delivery
 *  priority is deliberately NOT exposed here — it's an internal detail the agent
 *  chooses (see {@link STEER_PRIORITY}). */
export type SteerRequest = {
    sessionId: string;
    prompt: PromptRequest["prompt"];
    _meta?: SteerMeta | null;
};
/** Result of a {@link STEER_METHOD} request. The legacy `startedNewTurn` result
 *  remains the default idle behavior; `promptRequired` is returned only when the
 *  Host explicitly opts into the host-owned fallback in request `_meta`. */
export type SteerResponse = {
    outcome: "injected";
} | {
    outcome: "startedNewTurn";
} | {
    outcome: "promptRequired";
    reason: "noRunningTurn";
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
    /** Optional hidden, model-authored file-change audit requested by the ACP
     *  client for this turn. The state is turn-owned so a late tool call can
     *  never be rebound to a newer prompt. */
    fileChangeAudit?: FileChangeAuditTurnState;
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
     *  "completed"/"discarded"/"refused" leave nothing outstanding; "cancelled"
     *  after a dispatch means the dead turn's result may still arrive (seeded
     *  as a zombie) unless it already passed (`commandResultSeen`), and without
     *  a dispatch means dropped (nothing coming). */
    commandFinished?: "completed" | "discarded" | "cancelled" | "refused";
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
    /** Uuids of `steer()`-injected messages the SDK has not replayed back yet.
     *
     *  A steer is normally delivered at priority `now`, so the CLI ABORTS
     *  the running cycle: it emits its own human-origin `result` —
     *  indistinguishable from a turn's terminal one — and the steered message runs
     *  as a SECOND cycle. Settling at that result would answer `session/prompt`
     *  mid-work, so a steered turn's results only RECORD their outcome
     *  (`steeredSettle`) and it settles at the SDK's `idle`, the only signal
     *  spanning both cycles (CLI 2.1.220).
     *
     *  A non-empty set at an idle means the steered cycle hasn't started — the CLI
     *  replays a message only when it picks it up, always after the interrupted
     *  cycle's result — so that idle is swallowed. Drained by the replay handler.
     *
     *  Residual: a message the CLI drops unreplayed parks the turn until
     *  `session/cancel` or the next prompt (both settle it). */
    steeredEchoes?: Set<string>;
    /** What a steered turn settles with once its steered work has run: the outcome
     *  of its latest result, so its usage covers every cycle the turn ran. */
    steeredSettle?: PromptResponse;
    carriedUsage?: AccumulatedUsage;
    /** `carriedUsage`'s per-model counterpart, so a turn that survives a
     *  clear-context restart keeps the `_meta.quota` rows it earned pre-restart. */
    carriedModelUsage?: ModelTokenTally;
    resolve: (response: PromptResponse) => void;
    reject: (error: unknown) => void;
    /** Settles after the ACP prompt request completes, regardless of outcome. */
    completion?: Promise<void>;
};
export type Session = {
    query: Query;
    input: Pushable<SDKUserMessage>;
    cancelled: boolean;
    /** FIFO of in-flight prompts. The head is the turn the SDK is currently
     *  processing; later entries are queued and will be echoed in order. */
    turnQueue?: Turn[];
    /** The turn whose messages the consumer is currently attributing output to
     *  (the head of `turnQueue` once its user message has been echoed). */
    activeTurn?: Turn | null;
    /** Request ids already accepted for hidden agent file-change reports. Kept
     *  for the session lifetime so a redelivered prompt cannot publish the same
     *  audit twice or bind a late report to another turn. */
    fileChangeReportRequestIds: Set<string>;
    /** Session-owned publisher for negotiated file-change audits. Turn state
     *  stays on each Turn; this controller supplies the single idempotent
     *  unavailable terminal used by every non-report settlement path. */
    fileChangeAuditSupport?: FileChangeAuditSupport;
    /** Optimistic goal state published for a submitted `/goal` command whose
     *  matching runtime update has not arrived yet. Runtime updates for the old
     *  goal are suppressed until this command is echoed or completes, otherwise
     *  a late old-goal update can overwrite a replacement that the runtime never
     *  announces (the compatibility case the optimistic update exists for). */
    pendingGoalUpdate?: {
        commandUuid: string;
        expected: GoalSnapshot | null;
        previous: GoalSnapshot | null | undefined;
        started: boolean;
    };
    /** Last goal snapshot sent to the ACP client, used to roll back an
     *  optimistic `/goal` update when the command itself fails. */
    lastPublishedGoal?: GoalSnapshot | null;
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
    /** UUIDs of cancelled-before-echo commands that can still emit Claude's
     * empty user-interruption diagnostic. Interrupt receipts and command
     * lifecycle frames remove commands that were dropped before dispatch; the
     * next ordinary result clears any stale survivors. */
    pendingEmptyInterruptionDiagnosticCommands?: Set<string>;
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
    /** Latched from `system`/init `terminal_slash_commands` (CLI 2.1.232+):
     *  names of advertised slash commands whose UX is bound to the CLI's own
     *  terminal (e.g. /doctor, /color). ACP clients aren't that terminal, so
     *  these are filtered out of `available_commands_update` payloads. */
    terminalSlashCommands?: string[];
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
    /** Original ACP parameters used to recreate this query with a new provider. */
    creationParams?: NewSessionRequest;
    settingsManager: SettingsManager;
    /** This session's title state and the turn-end logic that maintains it. */
    titles: SessionTitles;
    accumulatedUsage: AccumulatedUsage;
    /** The active turn's spend broken out per model — the breakdown behind
     *  `accumulatedUsage`, reported as `_meta.quota.model_usage` on the prompt
     *  response. Accumulated and reset in lockstep with it. */
    accumulatedModelUsage?: ModelTokenTally;
    /** The last per-model reading seen on this query, autonomous cycles included.
     *  `result.modelUsage` is a running total for the whole query() call rather
     *  than a per-result figure, so consecutive readings are what a result's own
     *  spend is derived from — this is not itself a turn tally. */
    lastModelUsageReading?: ModelTokenTally;
    modes: SessionModeState;
    models: SessionModelState;
    modelInfos: ModelInfo[];
    /** Prevents the model-specific Auto fallback from spamming the transcript. */
    autoModeFallbackWarningShown?: boolean;
    /** Initial mode fallback is reported after session/new, on the first prompt. */
    autoModeFallbackWarningPending?: boolean;
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
    /** Whether the user picked a non-default effort through the ACP picker this
     *  session. A pin lives at the SDK's flag layer, which overrides the CLI's
     *  persisted effort (including the per-model `modelSettings` entries), so it
     *  follows the session across model switches; without one, the CLI resolves
     *  effort itself and the Effort option is display-only. Cleared when the
     *  user picks "Default" (the flag layer is cleared with it) or when a model
     *  switch clamps the pin away. */
    effortPinnedByUser?: boolean;
    /** Why the SDK currently can't serve Fast mode, when the reason is one worth
     *  telling the user about (see {@link FAST_MODE_UNAVAILABLE_EXPLANATIONS} —
     *  routine states like the SDK's own opt-in requirement normalize to
     *  `undefined`). Refreshed from every `fast_mode_disabled_reason` the SDK
     *  reports on `system`/init and user-turn `result`s; surfaced in the Fast mode
     *  option's description so a toggle that snaps back off explains itself. */
    fastModeDisabledReason?: FastModeDisabledReason;
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
    /** Whether nested subagent text/thinking is forwarded to the ACP client.
     *  Enabled by either the ACP capability or the pre-existing SDK option. */
    forwardSubagentText: boolean;
    /** Number of ACP permission/elicitation requests currently awaiting user
     *  input. This is a counter rather than a boolean because parallel subagents
     *  can ask concurrently; steering must remain non-interrupting until the last
     *  request settles. */
    pendingUserInputCount?: number;
    /** Context window size of the session's current model, carried across
     *  prompts so mid-stream usage_update notifications report a correct `size`
     *  before the turn's first result message arrives. Seeded synchronously at
     *  session creation and on model switches from the per-model cache or the
     *  text heuristic (DEFAULT_CONTEXT_WINDOW when both miss; on session/load the
     *  resumed session's own `getContextUsage` report wins, see
     *  `readResumedLiveModel`), then confirmed — and the cache populated — by each
     *  result's modelUsage. No extra `getContextUsage` IPC is on these paths: on a
     *  fresh session it stalls until the first turn runs (see the seeding call
     *  sites and `contextWindowCache`). */
    contextWindowSize: number;
    contextUsedTokens?: number;
    /** Whether `contextWindowSize` came from an authoritative source (the
     *  cross-session cache, a resumed session's `getContextUsage` report, or a
     *  `result.modelUsage`) rather than the text heuristic / default. Guards the
     *  mid-stream `message_start` heuristic upgrade: an authoritative window that
     *  happens to equal DEFAULT_CONTEXT_WINDOW must not be mistaken for "unseeded"
     *  and clobbered by a "1m" text match. */
    contextWindowAuthoritative: boolean;
    /** Stable identifier of the LLM backend this session's query was created
     *  against, derived from the routing-relevant vars of the exact `env` handed
     *  to the SDK at query creation (see {@link providerCacheKeyFor}). The context
     *  window is a property of (model id, backend) — the same resolved model id
     *  can name different windows behind different base URLs, routing headers, or
     *  credentials — so this scopes the module-global `contextWindowCache` per
     *  backend. Captured from the query's own env (not re-resolved later) because
     *  the process-wide provider config can change while a session is being
     *  created, while the query stays baked to the env it was created with. */
    providerCacheKey: string;
    /** Accumulated task list for the session, keyed by task ID. Task IDs are
     *  per-session, so this state must not be shared across sessions. */
    taskState: TaskState;
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
    /** ACP session affinity for calls emitted eagerly by permission handling. */
    eagerToolCallSessions?: Map<string, string>;
    /** ExitPlanMode denial that intentionally interrupts the current Claude
     *  cycle. Correlated by tool-use id until the terminal result arrives. */
    pendingExitPlanModeInterruption?: {
        toolUseId: string;
        toolResultSeen: boolean;
    };
    pendingExitPlanContextReset?: {
        toolUseId: string;
        plan: string;
        mode: PermissionMode;
    };
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
    /** Native ACP subagent sessions negotiated through PR #1992. Records are
     *  retained for the parent session lifetime so late child output cannot be
     *  rebound to another task after the SDK prunes its live-task registry. */
    nativeSubagentsByTaskId?: Map<string, NativeSubagent>;
    /** Resolves the spawning Agent/Task tool use carried by child messages to
     *  the corresponding native ACP child session. */
    nativeSubagentTaskIdByToolUseId?: Map<string, string>;
    /** Captures the ACP session in which an Agent/Task tool call was made. This
     *  supplies the immediate parent for nested `task_started` notifications,
     *  whose SDK payload has no lineage field of its own. */
    nativeSubagentParentByToolUseId?: Map<string, string>;
    /** Session-owned lifecycle controller shared by the consumer, cancel, reset,
     *  and teardown paths. */
    nativeSubagentRuntime?: NativeSubagentRuntime;
    /** Child-aware delivery closure paired with {@link nativeSubagentRuntime}. */
    nativeSubagentDeliver?: (notification: AcpSessionNotification) => Promise<void>;
    /** Session-owned async task controller. Prompt cancellation intentionally
     *  does not finish it because background work may outlive a prompt. */
    asyncTaskRuntime?: AsyncTaskRuntime;
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
    /** Durable-for-this-consumer failure state shared with session/load replay.
     *  Keeping it on the Session lets replay seed a failure that the persistent
     *  consumer can later clear with the same id and a higher revision. */
    sessionFailureState: SessionFailureState;
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
 * Resolved, non-secret + secret routing config for the `main` provider. This is
 * the shared shape produced by both `providers/set` and the legacy gateway auth
 * path, and consumed by {@link createEnvForProvider}. `null` means the provider
 * is unconfigured (no client-managed routing in effect).
 */
type ProviderConfig = {
    apiType: LlmProtocol;
    baseUrl: string;
    headers: Record<string, string>;
    /** Present only for `apiType === "vertex"`. */
    vertex?: {
        projectId: string;
        region: string;
    };
};
export type ToolUpdateMeta = {
    claudeCode?: {
        toolName: string;
        title?: string;
        toolResponse?: unknown;
        parentToolUseId?: string;
        nonExecutionKind?: string;
        userFeedback?: string;
        subagent?: true;
        skill?: string;
        skillPath?: string;
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
/**
 * Client-facing surface the agent calls back into. This is the subset of ACP
 * client methods the agent actually uses, expressed as a narrow interface so
 * tests can supply lightweight mocks. In production it is backed by
 * {@link ClientConnection} over the SDK's typed `AgentContext`.
 */
export interface AcpClient {
    sessionUpdate(params: AcpSessionNotification): Promise<void>;
    /** `signal`, when aborted, sends `$/cancel_request` for the in-flight
     *  permission request so the client can dismiss its prompt (and settle our
     *  await) instead of leaving the dialog open after the turn was cancelled. */
    requestPermission(params: RequestPermissionRequest, signal?: AbortSignal): Promise<RequestPermissionResponse>;
    readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse>;
    writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse>;
    /** `signal`, when aborted, sends `$/cancel_request` for the in-flight
     *  elicitation so the client can dismiss its prompt and settle our await. */
    createElicitation(params: CreateElicitationRequest, signal?: AbortSignal): Promise<CreateElicitationResponse>;
    completeElicitation(params: CompleteElicitationNotification): Promise<void>;
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
    private readonly sessionModes;
    gatewayAuthRequest?: GatewayAuthRequest;
    /** Set while ACP overrides the agent's native provider configuration. */
    providerConfig?: ProviderConfig;
    /** Serializes provider changes while every open query is recreated between turns. */
    private providerUpdate;
    private readonly exitPlan;
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
    unstable_listProviders(_params: ListProvidersRequest): Promise<ListProvidersResponse>;
    /**
     * `providers/set` — replace the full configuration for the `main` provider.
     * Rejects unknown IDs, unsupported protocols, and empty/invalid base URLs with
     * `invalid_params`. Config is process-scoped and applies to sessions created or
     * loaded after this call.
     */
    unstable_setProvider(params: SetProviderRequest): Promise<SetProviderResponse>;
    /**
     * `providers/disable` ends ACP ownership of the single mutually exclusive
     * backend slot and restores the agent's native routing state.
     */
    unstable_disableProvider(params: DisableProviderRequest): Promise<DisableProviderResponse>;
    resolveProviderConfig(): ProviderConfig | null;
    private defaultProviderConfig;
    logout(_params: LogoutRequest): Promise<void>;
    prompt(params: PromptRequest): Promise<PromptResponse>;
    goal(params: GoalRequest): Promise<GoalControlResponse>;
    private publishGoal;
    private publishTaskPlan;
    private publishGoalFromPrompt;
    private publishRuntimeGoal;
    /** Steer the session per the ACP steering wire protocol: inject a follow-up
     *  message into the turn that is currently running. If that turn already
     *  settled, the established default starts a new detached turn; Hosts may opt
     *  into the host-owned `promptRequired` fallback through request `_meta`.
     *
     *  When a turn is in flight this injects (returns `injected`): unlike
     *  `prompt()`, it does NOT create a Turn or enqueue on `turnQueue`; it pushes
     *  an `SDKUserMessage` onto the same streaming input, which the SDK routes
     *  into the in-flight turn. The injected message's echo carries a uuid that
     *  matches no queued turn, so the consumer drops it as an unrelated replay
     *  without promoting/settling anything. It is normally delivered at priority
     *  `now` so it pre-empts the current generation (interrupting a single-shot
     *  response, or slotting in between a multi-step turn's tool calls). While a
     *  permission or elicitation is awaiting user input it uses `later`, because
     *  interrupting that SDK callback cancels the ACP request and can strand the
     *  prompt (IJAI-1191). The steered message's own output streams via
     *  `session/update`, not this response.
     *
     *  Pre-empting means ABORTING: the interrupted cycle emits a `result` of its
     *  own and the steered message runs as a second one, so the turn is marked
     *  (`Turn.steeredEchoes`) to settle at the SDK's `idle` instead of that result.
     *
     *  When the session is idle, the opt-in path returns `promptRequired` WITHOUT
     *  calling `prompt()`, pushing SDK input, or mutating `turnQueue`: the content
     *  stays Host-owned so the Host can submit it through a standard
     *  `session/prompt`. Without the opt-in, the existing detached `prompt()` and
     *  `startedNewTurn` result are preserved for compatibility. */
    steer(params: SteerRequest): Promise<SteerResponse>;
    stopAsyncTask(params: AsyncTaskStopRequest): Promise<AsyncTaskStopResponse>;
    /** Publish the audit terminal for every turn path that did not reach the
     *  report tool. The support flips the turn state synchronously before its
     *  transport await, so callers can stay fail-open and settle the ACP prompt
     *  immediately without allowing a racing lifecycle path to publish twice. */
    private finishFileChangeAudit;
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
    private replaySessionHistory;
    readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse>;
    writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse>;
    /** Mark a client request as blocking on user input for exactly the lifetime
     *  of its promise. Steering consults this session-local count synchronously,
     *  so a message arriving while any permission/elicitation card is open uses
     *  non-interrupting SDK delivery. */
    private withPendingUserInput;
    /** Forward a permission request to the client, wiring the tool call's
     *  `signal` through as a `cancellationSignal`. When the turn is cancelled
     *  while the client's prompt is still open the signal aborts, the SDK sends
     *  `$/cancel_request`, and our local abort race settles even if the client
     *  ignores it. A `cancelled` outcome, request rejection, and local abort all
     *  surface the same "Tool use aborted" the callers already expect. */
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
    /** Reconcile adapter model state after the SDK switched the session's
     *  model out from under us — a refusal fallback, or any switch reported by
     *  the PostModelSwitch hook that the adapter didn't drive (e.g. a `/model`
     *  command typed as a prompt). The SDK already made the switch, so this
     *  must NOT call `query.setModel` — it only updates our bookkeeping
     *  (currentModelId, context window, mode clamping, effort/Fast-mode
     *  options) via the same `applyConfigOptionValue` path a user-driven model
     *  change takes, then notifies the client. */
    private syncModelAfterExternalSwitch;
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
     *     cooldown spuriously enable a toggle the user has off.
     *
     *  `reason` is the SDK's `fast_mode_disabled_reason`, reported alongside the
     *  state. Only explainable reasons are retained (see
     *  {@link normalizeFastModeDisabledReason}), so the comparison below tracks
     *  exactly what the user can see: a routine `sdk_opt_in_required` report on
     *  every turn's result can't churn the option, while a real blocker updates
     *  the description even when the toggle's own value is unchanged. */
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
    /**
     * Provider routing is baked into the environment of each SDK Query. Wait for
     * all submitted turns to settle, close every query, then resume each Claude
     * session with the same ID so subsequent turns inherit the new environment.
     */
    private enqueueProviderUpdate;
}
/** The effort level the CLI itself resolves for a model from the persisted
 *  settings: the per-model entry (`modelSettings`, keyed by canonical model
 *  name — the CLI persists /effort per model since 2.1.243) wins over the
 *  legacy top-level `effortLevel`. Alias picker rows are looked up by their
 *  resolved model id first, then the row value, then the raw config value
 *  for models not in the picker. Exact keys only — the CLI's canonical-form
 *  fallback matching isn't replicated, so a miss simply falls back to the
 *  top-level value (best-effort display; `buildConfigOptions` still
 *  validates the result against the model's supported levels). */
export declare function settingsEffortForModel(settings: Settings, modelInfo: ModelInfo | undefined, modelId?: string): string | undefined;
export declare const BUILTIN_AGENT_NAMES: Set<string>;
/** Discover user/plugin/project-configured main-thread agents, excluding the
 *  built-in subagents and the reserved "default" sentinel. Returns an empty
 *  list if discovery fails so a flaky control request never blocks session
 *  creation. */
export declare function discoverCustomAgents(q: Query): Promise<AgentInfo[]>;
/** Stable ids for the session config options surfaced via `configOptions`.
 *  Centralized so the option declarations in `buildConfigOptions` and the
 *  handlers in `setSessionConfigOption`/`applyConfigOptionValue` reference the
 *  same identifiers and can't drift apart. */
export { MODE_CONFIG_ID };
export declare const MODEL_CONFIG_ID = "model";
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
/** Normalize an SDK-reported `fast_mode_disabled_reason` to the one we retain:
 *  a reason we have an explanation for, else `undefined`. Keeping only
 *  explainable reasons means state comparisons (see `syncFastModeState`) track
 *  exactly what the user can see, so routine reports like
 *  `sdk_opt_in_required` never churn the config option. */
export declare function normalizeFastModeDisabledReason(reason: FastModeDisabledReason | undefined): FastModeDisabledReason | undefined;
/** Whether the Client advertised support for boolean session config options
 *  (`session.configOptions.boolean`). Agents MUST only send `type: "boolean"`
 *  config options to Clients that opt in; otherwise we fall back to a `select`.
 *  See https://agentclientprotocol.com/rfds/boolean-config-option. */
export declare function clientSupportsBooleanConfigOptions(clientCapabilities?: ClientCapabilities | null): boolean;
/** Build the Fast mode config option. When the Client supports boolean config
 *  options we expose a native `type: "boolean"` toggle; otherwise we degrade to
 *  a two-value `select` ("on"/"off") so older Clients still get a usable
 *  control.
 *
 *  `disabledReason` (the SDK's `fast_mode_disabled_reason`) is folded into the
 *  description while the toggle reads off, so a user whose account or provider
 *  can't serve Fast mode sees why instead of a switch that silently refuses to
 *  stay on. Ignored while enabled: a reason reported alongside an `on`/`cooldown`
 *  state isn't blocking anything right now. */
export declare function createFastModeConfigOption(enabled: boolean, useBooleanOption: boolean, disabledReason?: FastModeDisabledReason): SessionConfigOption;
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
    /** Latest explainable `fast_mode_disabled_reason`, folded into the option's
     *  description while the toggle reads off. */
    disabledReason?: FastModeDisabledReason;
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
 *     `syncModelAfterExternalSwitch`: the picker shows no selection, but the
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
    toolResultMeta?: unknown;
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
export declare function runAcp(logger?: Logger): {
    connection: import("@agentclientprotocol/sdk").AgentConnection;
    agent: ClaudeAcpAgent;
};
//# sourceMappingURL=acp-agent.d.ts.map