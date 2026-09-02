import type { NewSessionRequest, SessionConfigOption } from "@agentclientprotocol/sdk";
import type { PermissionMode, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
export type ClearContextReset = {
    toolUseId: string;
    plan: string;
    mode: PermissionMode;
};
type Usage = {
    inputTokens: number;
    outputTokens: number;
    cachedReadTokens: number;
    cachedWriteTokens: number;
};
export type ClearContextTurn = {
    settled: boolean;
    promptUuid: string;
    carriedUsage?: Usage;
    carriedModelUsage?: Record<string, Usage>;
};
/** The session state needed to replace Claude's private conversation without
 * replacing the public ACP turn. Keeping this projection here makes the
 * restart workflow independent from the agent's much larger Session record. */
export type ClearContextSession<Turn extends ClearContextTurn = ClearContextTurn> = {
    cwd: string;
    creationParams?: NewSessionRequest;
    accumulatedUsage: Usage;
    accumulatedModelUsage?: Record<string, Usage>;
    models: {
        currentModelId: string;
    };
    configOptions: SessionConfigOption[];
    currentAgent: string;
    fastModeEnabled: boolean;
    activeTurn?: Turn | null;
    turnQueue?: Turn[];
    pendingExitPlanContextReset?: ClearContextReset;
    contextUsedTokens?: number;
    input: {
        push(message: SDKUserMessage): unknown;
    };
};
export type ClearContextCoordinatorHost<Session extends ClearContextSession<Turn>, Turn extends ClearContextTurn> = {
    currentSession(sessionId: string): Session | undefined;
    closeQueryStream(session: Session): void;
    restartSession(params: NewSessionRequest, options: {
        publicSessionId: string;
        permissionMode: PermissionMode;
    }): Promise<Session>;
    applyFastMode(session: Session, enabled: boolean): Promise<void>;
    publishSessionState(sessionId: string, mode: PermissionMode, configOptions: SessionConfigOption[]): Promise<void>;
    continuationMessage(sessionId: string, plan: string, promptUuid: string): SDKUserMessage;
    ensureConsumer(session: Session, sessionId: string): void;
    logError(message: string, error: unknown): void;
};
/** Replace Claude's private conversation and attach the still-pending ACP turn
 * to it. The host owns provider-specific creation and stream mechanics; this
 * coordinator owns the ordering and state transfer invariants. */
export declare function continuePlanInFreshContext<Turn extends ClearContextTurn, Session extends ClearContextSession<Turn>>(sessionId: string, oldSession: Session, reset: ClearContextReset, host: ClearContextCoordinatorHost<Session, Turn>, signal?: AbortSignal): Promise<void>;
export {};
//# sourceMappingURL=clear-context-coordinator.d.ts.map