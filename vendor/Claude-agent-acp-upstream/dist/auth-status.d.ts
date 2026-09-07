/**
 * `authStatus` — interim `_meta`-based ACP extension that reports which auth
 * identity the agent process itself uses (Claude subscription, API key,
 * gateway, external cloud credentials, or nothing).
 *
 * Push only. One carrier, connection-scoped (never per session): the
 * notification `_auth/status_update` → `{authStatus}`. The client never asks;
 * there is no request method. The empty `agentCapabilities._meta.authStatus`
 * marker means "this agent pushes its identity", nothing more.
 *
 * The agent reads the identity at these moments:
 * - `initialize`, with an asynchronous CLI probe. Nothing waits for it, and its
 *   result is the first push of the connection;
 * - a completed `authenticate` or a `logout`;
 * - each `createSession`, from the session account. A refused session reports
 *   too: the client must know which account was refused;
 * - each turn the `--hide-claude-auth` guard checks. The guard reads the
 *   account anyway, so this costs nothing;
 * - the START of each user prompt, with an asynchronous CLI probe. This finds a
 *   login or a logout done in another terminal, including the sign-in a client
 *   performs after a refusal, because the retried prompt is a new prompt.
 *   Nothing waits for it and the push goes out mid-turn if that is when the
 *   read lands.
 *
 * A probe whose kind differs from a live session's account marks that session
 * for recreation under `--hide-claude-auth`. The mark is a flag, consumed at
 * the next turn boundary: a running turn is never interrupted. The probe judges
 * nothing itself — the next turn runs a new `initialize`, and the creation
 * guard decides on the account it reports.
 *
 * A read does not always cause a push. The agent sends `_auth/status_update`
 * only when the payload is different from the last one it sent.
 *
 * "Cannot determine" is expressed by silence: an agent that cannot read its own
 * identity pushes nothing, and the client shows "not reported". A known
 * logged-out state is a payload of its own (`kind: "none"`), which is what
 * distinguishes the two.
 *
 * Reporting only — there is no write path in v1. When the upstream RFD lands,
 * the same payload moves from `_meta` to first-class fields and this module
 * is retired.
 */
import type { AccountInfo } from "@anthropic-ai/claude-agent-sdk";
/** Change notification, agent → client. Fire and forget: clients that do not
 *  know the method drop it silently, so it is sent unconditionally. */
export declare const AUTH_STATUS_UPDATE_METHOD = "_auth/status_update";
/** Upper bound on one `claude auth status --json` run, so a hung CLI cannot
 *  wedge every later probe that joins it. */
export declare const AUTH_STATUS_PROBE_TIMEOUT_MS = 5000;
export type AuthStatusKind = "account" | "api_key" | "gateway" | "external" | "none";
export type AuthStatusAccount = {
    email?: string;
    organization?: string;
    /** Vendor plan/license string, not normalized. */
    plan?: string;
};
export type AuthStatus = {
    kind: AuthStatusKind;
    /** Human-readable and usable as a UI string on its own. The "type" line:
     *  "Claude Max", "Anthropic API key", "AWS Bedrock". */
    label: string;
    /** Optional second line carrying the specifics (key source, gateway host, …).
     *  Clients render it under `label`, falling back to `account.email`. */
    detail?: string;
    account?: AuthStatusAccount;
    /** Vendor-namespaced extras, e.g. `{claudeCode: {...}}`. */
    vendor?: Record<string, unknown>;
};
export type AuthStatusUpdateNotification = {
    authStatus: AuthStatus;
};
/** Advertisement carried in `agentCapabilities._meta.authStatus`, never a
 *  status payload: its mere presence means "this agent pushes its identity",
 *  and it stays empty. Informational — a client that never saw it still
 *  accepts `_auth/status_update`, because there is nothing to ask for. */
export type AuthStatusCapability = Record<string, never>;
export declare function authStatusCapability(): AuthStatusCapability;
/** Shape of `claude auth status --json`. Absent fields are omitted, not null,
 *  and the logged-out case exits 1 while still printing valid JSON. */
export type CliAuthStatus = {
    loggedIn?: boolean;
    authMethod?: string;
    apiProvider?: string;
    apiKeySource?: string;
    email?: string;
    orgId?: string;
    orgName?: string;
    subscriptionType?: string;
};
export declare function notLoggedInAuthStatus(): AuthStatus;
/** ACP-level gateway auth (`authenticate` with `gateway`/`gateway-bedrock`).
 *  The gateway owns the credentials, so it wins over anything the CLI reports. */
export declare function gatewayAuthStatus(baseUrl?: string): AuthStatus;
/**
 * Does this `AccountInfo` say anything about the identity?
 *
 * The SDK always fills `apiProvider`, but the identity fields come from the
 * claude.ai profile: with an `apiKeyHelper` and no subscription login the
 * session reports `{apiProvider: "firstParty"}` and nothing else. That is "no
 * information", not "logged out" — an empty read must never be mapped to
 * `none`, or it destroys what the CLI probe already established.
 *
 * `tokenSource` is deliberately not a signal: the CLI sets it to the OAuth
 * token's origin (`CLAUDE_CODE_OAUTH_TOKEN`,
 * `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR`, …), never to a key source, so it
 * cannot attribute a key and carries no plan of its own.
 */
export declare function accountInfoHasIdentitySignal(account: AccountInfo | undefined): boolean;
/** Session-time mapping from the SDK's `AccountInfo`, the richest source when
 *  it is populated. Returns `undefined` when the account carries no identity
 *  signal, so callers keep the status they already know. */
export declare function fromAccountInfo(account: AccountInfo | undefined): AuthStatus | undefined;
/** Pre-session mapping from `claude auth status --json` stdout. Returns
 *  `undefined` when the output is not the expected JSON object, so callers can
 *  report "not known" instead of guessing. */
export declare function fromCliStatus(stdout: string): AuthStatus | undefined;
/**
 * Do two payloads describe the same login? Compared on the field that
 * identifies each kind — the key source for `api_key`, the email for
 * `account`, the kind alone for the rest, which carry no per-identity key.
 */
export declare function sameIdentity(a: AuthStatus, b: AuthStatus): boolean;
/**
 * Folds a fresh read into what is already known. Sources differ in richness for
 * the very same login: the SDK's session `AccountInfo` can carry an
 * organization the CLI probe omits. So when the read describes the same
 * identity, its values win field by field but the fields it lacks are kept;
 * when it describes a different identity, it replaces the old one wholesale.
 */
export declare function mergeAuthStatus(previous: AuthStatus | undefined, next: AuthStatus): AuthStatus;
/**
 * Do two payloads carry the same information? Unlike {@link sameIdentity},
 * which asks "is this the same login", this compares every rendered field, so
 * a richer read of one login is NOT the same. Callers use it to suppress a
 * push that would tell the client nothing new.
 *
 * `a` undefined means "nothing reported yet", which never equals a payload.
 */
export declare function sameAuthStatus(a: AuthStatus | undefined, b: AuthStatus): boolean;
//# sourceMappingURL=auth-status.d.ts.map