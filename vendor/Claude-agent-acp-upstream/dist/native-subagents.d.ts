import type { AcpSessionNotification, SubagentState } from "./acp-subagents.js";
export type NativeSubagent = {
    sessionId: string;
    parentSessionId: string;
    parentToolUseId?: string;
    name: string;
    task: string;
    announced?: boolean;
    terminalState?: SubagentState;
    /** Connection-local single-flight state; never serialized on the wire. */
    announcePromise?: Promise<void>;
    /** Connection-local single-flight state; never serialized on the wire. */
    terminalPromise?: Promise<void>;
};
export type NativeSubagentSession = {
    nativeSubagentsByTaskId?: Map<string, NativeSubagent>;
    nativeSubagentTaskIdByToolUseId?: Map<string, string>;
    nativeSubagentParentByToolUseId?: Map<string, string>;
};
type Publish = (notification: AcpSessionNotification) => Promise<void>;
type Logger = {
    log(message: string): void;
};
type TaskStarted = {
    taskId: string;
    toolUseId?: string | null;
    subagentType?: unknown;
    description?: unknown;
    prompt?: unknown;
};
/**
 * Owns the connection-local native subagent registry and all ACP lifecycle
 * ordering. The main agent only supplies SDK facts and delivers routed output.
 */
export declare class NativeSubagentRuntime {
    private readonly rootSessionId;
    private readonly session;
    private readonly publish;
    private readonly logger;
    readonly enabled: boolean;
    private readonly children;
    private readonly taskByToolUse;
    private readonly parentByToolUse;
    private readonly identityByToolUse;
    private readonly controlByToolUse;
    private readonly childByParentToolUse;
    private readonly taskFinishPromises;
    private readonly generationByTaskId;
    private readonly pending;
    private pendingCount;
    constructor(enabled: boolean, rootSessionId: string, session: NativeSubagentSession, publish: Publish, logger: Logger);
    route(notification: AcpSessionNotification, deliver: Publish, forcedSessionId?: string): Promise<AcpSessionNotification | null>;
    taskStarted(task: TaskStarted, deliver: Publish): Promise<void>;
    finishTask(taskId: string, status: unknown, deliver: Publish, toolUseId?: string | null): Promise<void>;
    finishAll(state: SubagentState, deliver: Publish): Promise<void>;
    discardPending(parentToolUseId: string): void;
    clear(): void;
    private takePending;
    private buffer;
    private cleanupControl;
    private nextChildSessionId;
}
export declare function announceNativeSubagent(child: NativeSubagent, publish: Publish): Promise<void>;
export declare function finishNativeSubagent(session: NativeSubagentSession, taskId: string, state: SubagentState, publish: Publish): Promise<void>;
export declare function nativeSubagentState(status: unknown): SubagentState | undefined;
export declare function isNativeSubagentControlUpdate(update: AcpSessionNotification["update"]): update is Extract<AcpSessionNotification["update"], {
    sessionUpdate: "tool_call" | "tool_call_update";
}>;
export declare function isNativeSubagentControlTool(toolName: unknown): boolean;
export {};
//# sourceMappingURL=native-subagents.d.ts.map