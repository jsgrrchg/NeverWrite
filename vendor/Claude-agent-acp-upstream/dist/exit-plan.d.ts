import type { SessionNotification } from "@agentclientprotocol/sdk";
import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { type ClearContextCoordinatorHost, type ClearContextReset, type ClearContextSession, type ClearContextTurn } from "./clear-context-coordinator.js";
export declare function acceptedPlanToolResult(notification: SessionNotification, toolUseId: string | undefined): SessionNotification;
type ExitPlanState = {
    toolUseCache: Record<string, {
        name: string;
    } | undefined>;
    pendingExitPlanModeInterruption?: {
        toolUseId: string;
        toolResultSeen: boolean;
    };
    pendingExitPlanContextReset?: ClearContextReset;
};
/** Reconcile an SDK user message with the two pending ExitPlanMode lanes and
 * return the accepted plan tool id whose rendered update must be completed. */
export declare function observeExitPlanToolResults(message: {
    type: string;
    tool_result_meta?: unknown;
}, content: unknown, state: ExitPlanState): string | undefined;
export declare function executionDiagnostic(message: SDKResultMessage): string | undefined;
/** Claude wraps a rejected ExitPlanMode explanation in a Markdown code fence.
 * Strip exactly one complete outer fence for that tool only. */
export declare function exitPlanModeRawOutput(toolName: string, content: unknown): unknown;
export type ExitPlanRestartHost<Session extends ClearContextSession<Turn>, Turn extends ClearContextTurn> = Omit<ClearContextCoordinatorHost<Session, Turn>, "publishSessionState" | "continuationMessage"> & {
    sessionUpdate(notification: SessionNotification): Promise<void>;
    destroyReplacement(sessionId: string, session: Session): void;
    settleCancelledTurn(oldSession: Session, turnSession: Session, turn: Turn): void;
    settleFailedTurn(turnSession: Session, turn: Turn, error: unknown): void;
};
/** Owns the lifetime of accepted-plan context replacements. In particular, a
 * session cancellation invalidates an in-progress async restart so a late
 * restartSession result cannot recreate a closed public session. */
export declare class ExitPlanCoordinator<Session extends ClearContextSession<Turn>, Turn extends ClearContextTurn> {
    private readonly host;
    private readonly restarts;
    constructor(host: ExitPlanRestartHost<Session, Turn>);
    cancel(sessionId: string): void;
    restart(sessionId: string, oldSession: Session, reset: ClearContextReset): Promise<void>;
}
export {};
//# sourceMappingURL=exit-plan.d.ts.map