/**
 * `--hide-claude-auth`: this integration must never bill a claude.ai
 * subscription. The flag hides the claude.ai login method from `initialize`
 * and makes the agent behave like a logged-out CLI whenever a subscription
 * would pay for a turn. `acp-agent.ts` decides *when* the guard applies (flag
 * on, no provider override) and calls in here for the *what*.
 *
 * The account the CLI reports at `initialize` is the source of truth. The SDK
 * memoizes it, so it is a constant for the life of a query, and two layers
 * keep it honest:
 *
 * 1. Session creation refuses an account that holds no credential this
 *    integration accepts. A logged-out session never exists, so the client's
 *    sign-in always leads to a new session with a fresh `initialize`. The
 *    per-turn guard repeats the check on the same cached account, which costs
 *    microseconds and covers a session created under a provider override that
 *    `providers/disable` later removed.
 * 2. A sign-out during the session ends the query. The next turn recreates it,
 *    so the next `initialize` reports the real account and layer 1 judges it.
 *    The recreation resumes the stored conversation. When the CLI never wrote
 *    one, because the first turn was the one that signed out, the recreation
 *    starts a fresh query under the same session id instead.
 *
 * A file-based credential replaced by a subscription between two turns is seen
 * by the CLI probe the agent fires at the START of every user prompt. That read
 * is never awaited, so it usually lands mid-turn; all it does there is mark the
 * session. The guard consumes the mark at the turn boundary — the next prompt
 * recreates the query and layer 1 judges the account the new `initialize`
 * reports — so a probe never interrupts a running turn. A swap that happens
 * after the last probe stays unseen until the next prompt reads the store
 * again. Closing that window would cost a blocking read per turn.
 */
import { RequestError } from "@agentclientprotocol/sdk";
import type { AccountInfo, Query } from "@anthropic-ai/claude-agent-sdk";
import type { SessionFailureController } from "./session-failure-extension.js";
export declare function shouldHideClaudeAuth(): boolean;
/**
 * `data.reason` carried by the `authRequired` JSON-RPC error when the flag
 * blocks a turn. From the client's point of view the agent is logged out (same
 * error code and flow as a signed-out CLI); the reason lets it render a
 * different hint. A string enum so further reasons can be added without a
 * shape change.
 */
export declare const CLAUDE_SUBSCRIPTION_NOT_SUPPORTED_REASON = "claude_subscription_not_supported";
export type AuthRequiredReason = typeof CLAUDE_SUBSCRIPTION_NOT_SUPPORTED_REASON;
export declare const CLAUDE_SUBSCRIPTION_NOT_SUPPORTED_MESSAGE = "This integration does not support using claude.ai subscriptions.";
/** The message of the plain sign-out refusal. It carries no `reason`: the
 *  account holds nothing this integration can bill, which is the ordinary
 *  signed-out state every ACP client already knows how to answer. */
export declare const CLAUDE_LOGIN_REQUIRED_MESSAGE = "Sign in with an API key or a Console account to use this integration.";
/**
 * True when a turn on this account is paid by a claude.ai subscription.
 *
 * The SDK types `apiKeySource` and `tokenSource` as an open `string`, so this
 * is an allowlist. An account bills the subscription only when every field
 * proves it, and an unknown value keeps the guard on.
 *
 * - `subscriptionType` must be set. Without it the CLI reports no subscription.
 * - `tokenSource` must be absent. The CLI sets it in place of the subscription
 *   when a bearer or OAuth environment token pays for the turn.
 * - `apiProvider` must be absent or `firstParty`. The SDK documents that the
 *   Anthropic OAuth login applies only to `firstParty`; for a third-party
 *   backend such as `bedrock`, `vertex`, `foundry` or `gateway` the other
 *   fields are absent and the authentication is external.
 * - `apiKeySource` must not be one of {@link API_KEY_SOURCES_ABOVE_SUBSCRIPTION}.
 *   Claude Code's credential precedence puts those keys above the `/login`
 *   subscription, so the key pays and the stored subscription is inert.
 */
export declare function billsClaudeSubscription(account: AccountInfo | undefined): boolean;
/**
 * True when the account already holds a credential this integration accepts:
 * a third-party backend, a bearer or OAuth environment token, or one of the
 * API key sources in {@link API_KEY_SOURCES_ABOVE_SUBSCRIPTION}.
 *
 * False therefore covers both the signed-out CLI and the account whose only
 * credential is a claude.ai subscription. {@link billsClaudeSubscription} runs
 * first and separates the two, so a caller that reaches a `false` here is
 * looking at a session with no way to pay.
 */
export declare function holdsNonSubscriptionCredential(account: AccountInfo | undefined): boolean;
export declare function claudeSubscriptionNotSupportedError(): RequestError;
/** The signed-out refusal. Deliberately without `data`, so a client that reads
 *  `data.reason` sees the plain ACP sign-out it already handles. */
export declare function claudeLoginRequiredError(): RequestError;
/**
 * The state the guard keeps for one session. It lives on the session so that a
 * concurrent pair of turns shares one account read and one failure row, and so
 * that each degraded-guard warning is logged once.
 */
export type ClaudeSubscriptionGuardState = {
    /** The in-flight guard run. Set before the first `await`. */
    pendingRun?: Promise<RequestError | undefined>;
    /** True after the "no account source" warning was logged for this session. */
    degradedWarningLogged?: boolean;
};
export type GuardLogger = {
    error: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
};
/**
 * Report once per session that the guard cannot read the account at all. The
 * guard is then absent, not passing. The CLI build decides this, not the user,
 * so a message on every turn would only add noise.
 */
export declare function warnClaudeSubscriptionGuardDegraded(options: {
    sessionId: string;
    guardState: ClaudeSubscriptionGuardState;
    logger: GuardLogger;
    cause: string;
}): void;
type GuardOptions = {
    sessionId: string;
    query: Pick<Query, "accountInfo">;
    guardState: ClaudeSubscriptionGuardState;
    /** Built lazily: most turns pass and never need a controller. */
    sessionFailures: () => SessionFailureController;
    logger: GuardLogger;
    /** Display hook: called with the account the guard just read, before the
     *  guard decides on it. It exists so a refused turn still reports which
     *  account it was refused for. Purely observational — this module knows
     *  nothing about what the caller does with it, and a throw from here never
     *  changes the verdict. */
    onAccount?: (account: AccountInfo) => void;
};
/**
 * The per-turn guard for a live session.
 *
 * It decides on the account the SDK cached at `initialize`, which is this
 * integration's source of truth. That account is a constant for the life of
 * the query, so the check costs microseconds. It still earns its place: it
 * covers a session created under a provider override that `providers/disable`
 * later removed, so the create-time check never ran for the routing in force
 * now. A sign-out ends the query (see `markSessionForSignOutRespawn` in
 * `acp-agent.ts`), so the next turn recreates it and `initialize` reports the
 * real account. This guard does not see the residual case the module header
 * names either.
 *
 * A turn is refused when the account bills a subscription, and also when it
 * holds nothing this integration accepts, which is the user signing out in
 * mid-session. The refusal mirrors the signed-out path exactly (see
 * `failActiveWithSessionFailure` for `auth_required` in `acp-agent.ts`): every
 * client gets the `authRequired` JSON-RPC rejection that starts its own auth
 * flow, and a capable client additionally gets one session-scoped access
 * failure whose `login` action stays the way back in.
 *
 * Fails open when no account can be read at all: session creation already
 * refused every account without a usable credential, and an unavailable probe
 * must not block a session that passed that check.
 */
export declare function refuseClaudeSubscriptionTurn(options: GuardOptions): Promise<void>;
export {};
//# sourceMappingURL=hide-claude-auth.d.ts.map