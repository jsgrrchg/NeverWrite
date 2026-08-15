import type { ClientCapabilities, SessionNotification } from "@agentclientprotocol/sdk";
import { getSessionMessages, type SDKAssistantMessageError } from "@anthropic-ai/claude-agent-sdk";
export declare function airSessionFailureCapabilityMeta(): {
    jetbrains: {
        air: {
            version: number;
            capabilities: string[];
        };
    };
};
export type ClaudeFailureKind = "advisory" | "auth_required" | "bad_request" | "budget_exhausted" | "context_exhausted" | "internal_error" | "overloaded" | "provider_error" | "quota_exhausted" | "rate_limited" | "transport_lost" | "worker_shutdown";
type AirSessionFailureCategory = "connection" | "access" | "limit" | "request" | "service" | "unknown";
type AirSessionFailureSeverity = "warning" | "error";
type AirSessionFailureAction = "retry" | "login" | "new_session";
type SessionFailureRecoveryPolicy = "never" | "next_attempt" | "real_model_success" | "auth_status" | "runtime_rebind";
export type PublishedSessionFailure = {
    id: string;
    revision: number;
    kind: ClaudeFailureKind;
    category: AirSessionFailureCategory;
    turnId?: string;
    severity: AirSessionFailureSeverity;
    title: string;
    details?: string;
    actions: AirSessionFailureAction[];
    recoveryPolicy: SessionFailureRecoveryPolicy;
};
type SessionFailureOptions = {
    turnId?: string;
    sessionScoped?: boolean;
    title?: string;
    details?: string;
    severity?: AirSessionFailureSeverity;
};
export type SessionFailureState = {
    epoch: string;
    revisions: Map<string, number>;
    active: Map<string, PublishedSessionFailure>;
    nextIncident?: number;
    lastNotice?: {
        title: string;
        id: string;
    };
};
type Logger = {
    error: (...args: unknown[]) => void;
};
export declare function createSessionFailureState(): SessionFailureState;
export declare function sessionFailureMeta(failure: PublishedSessionFailure): {
    jetbrains: {
        air: {
            version: number;
            sessionFailure: {
                actions: AirSessionFailureAction[];
                details?: string | undefined;
                id: string;
                revision: number;
                category: AirSessionFailureCategory;
                severity: AirSessionFailureSeverity;
                title: string;
            };
        };
    };
};
/** `getSessionMessages` deliberately exposes only the API message and strips
 *  transcript-level `error` / `isApiErrorMessage` fields. The SDK exports the
 *  exact stable prefixes used by its synthetic usage-limit errors, so replay
 *  can recover this one typed failure without matching arbitrary model prose. */
export declare function assistantMessageText(apiMessage: unknown): string | undefined;
export declare function isSyntheticUsageLimitMessage(apiMessage: unknown): boolean;
export declare function activeUsageLimitMessage(messages: Awaited<ReturnType<typeof getSessionMessages>>): {
    uuid: string;
    title: string;
} | undefined;
export declare function supportsAirSessionFailures(capabilities?: ClientCapabilities): boolean;
/** Owns the AIR failure lifecycle for both the live consumer and history replay.
 *  Published revisions become active only after delivery succeeds; recovery only
 *  removes internal active state because transcript records are historical. */
export declare class SessionFailureController {
    private readonly sessionId;
    private readonly state;
    private readonly capabilities?;
    private readonly isCurrent;
    private readonly sendUpdate;
    private readonly logger;
    constructor(options: {
        sessionId: string;
        state: SessionFailureState;
        capabilities?: ClientCapabilities;
        isCurrent: () => boolean;
        sendUpdate: (notification: SessionNotification) => Promise<void>;
        logger: Logger;
    });
    private isSupported;
    private emit;
    recordActive(failure: PublishedSessionFailure): void;
    clear(shouldClear?: (failure: PublishedSessionFailure) => boolean): Promise<boolean>;
    prepare(kind: ClaudeFailureKind, failureOptions?: SessionFailureOptions): Promise<PublishedSessionFailure | undefined>;
    publish(kind: ClaudeFailureKind, failureOptions?: SessionFailureOptions): Promise<void>;
    restore(id: string, kind: ClaudeFailureKind, title: string, active?: boolean): Promise<boolean>;
}
export declare function providerFailureCategory(errorKind?: SDKAssistantMessageError, isUsageLimit?: boolean): ClaudeFailureKind;
export {};
//# sourceMappingURL=session-failure-extension.d.ts.map