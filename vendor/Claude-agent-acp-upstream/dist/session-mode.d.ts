import { type SessionConfigOption, type SessionModeState, type SessionNotification, type SetSessionModeRequest, type SetSessionModeResponse } from "@agentclientprotocol/sdk";
import type { ModelInfo, PermissionMode, PermissionResult, Query } from "@anthropic-ai/claude-agent-sdk";
export declare const MODE_CONFIG_ID = "mode";
export declare const AUTO_MODE_FALLBACK: PermissionMode;
export type SessionMode = {
    query: Pick<Query, "setPermissionMode">;
    queryClosed?: boolean;
    modes: SessionModeState;
    models: {
        currentModelId: string;
    };
    modelInfos: ModelInfo[];
    /** Prevents the model-specific Auto fallback from spamming the transcript. */
    autoModeFallbackWarningShown?: boolean;
    /** Initial mode fallback is reported after session/new, on the first prompt. */
    autoModeFallbackWarningPending?: boolean;
};
export type SessionModeManagerOptions<S extends SessionMode> = {
    getSession(sessionId: string): S | undefined;
    sessionEndedMessage: string;
    updateConfigOption(sessionId: string, configId: string, value: string): Promise<void>;
    sessionUpdate(params: SessionNotification): Promise<void>;
    logError(...args: unknown[]): void;
};
type ModeConfigSession = SessionMode & {
    configOptions: SessionConfigOption[];
};
type InitializeSessionModeParams = {
    query: Pick<Query, "setPermissionMode">;
    requestedMode: PermissionMode;
    currentModelInfo?: ModelInfo;
    currentModelId: string;
};
/** Owns session-mode policy and the ACP/SDK synchronization it requires. */
export declare class SessionModeManager<S extends SessionMode> {
    private readonly options;
    constructor(options: SessionModeManagerOptions<S>);
    initialize({ query, requestedMode, currentModelInfo, currentModelId, }: InitializeSessionModeParams): Promise<{
        modes: SessionModeState;
        autoModeFallbackWarningPending: boolean;
    }>;
    static configOption(modes: SessionModeState): SessionConfigOption;
    syncConfig(session: ModeConfigSession, mode: string): void;
    availableModeIds(modes: SessionModeState): string[];
    effectiveMode(session: SessionMode, requestedMode: PermissionMode): PermissionMode;
    applyPermissionFallback(session: SessionMode, permissionResult: PermissionResult): {
        permissionResult: PermissionResult;
        fallbackApplied: boolean;
    };
    /** Reconcile mode after a model switch. The caller rebuilds config options
     * before publishing the returned state change. */
    reconcileForModel(session: SessionMode, model: ModelInfo | undefined): Promise<boolean>;
    selectMode(sessionId: string, modeId: string): Promise<PermissionMode>;
    setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse>;
    publishCurrent(sessionId: string, mode: string): Promise<void>;
    publishFallbackWarning(sessionId: string, session: SessionMode): Promise<void>;
    publishFallbackState(sessionId: string, session: SessionMode): Promise<void>;
    private requireOpenSession;
    private isAutoUnavailable;
    private isAvailable;
    private parseMode;
    private buildAvailableModes;
    private trySyncMode;
}
export {};
//# sourceMappingURL=session-mode.d.ts.map