import type { ClientCapabilities } from "@agentclientprotocol/sdk";
import type { AcpSessionNotification, AsyncTaskState } from "./acp-subagents.js";
type Publish = (notification: AcpSessionNotification) => Promise<void>;
type TaskIdentity = {
    taskId?: unknown;
    task_id?: unknown;
};
export type AsyncTaskStarted = TaskIdentity & {
    taskType?: unknown;
    task_type?: unknown;
    description?: unknown;
    subagentType?: unknown;
    subagent_type?: unknown;
    isBackgrounded?: unknown;
    is_backgrounded?: unknown;
    workflowName?: unknown;
    workflow_name?: unknown;
    skipTranscript?: unknown;
    skip_transcript?: unknown;
    outputFilePath?: unknown;
    output_file?: unknown;
    toolCallId?: unknown;
    tool_use_id?: unknown;
};
export type AsyncTaskUpdated = TaskIdentity & {
    patch?: TaskPatch;
};
type TaskPatch = {
    status?: unknown;
    description?: unknown;
    isBackgrounded?: unknown;
    is_backgrounded?: unknown;
    error?: unknown;
    outputFilePath?: unknown;
    output_file?: unknown;
};
export type AsyncTaskNotification = TaskIdentity & {
    status?: unknown;
    summary?: unknown;
    outputFilePath?: unknown;
    output_file?: unknown;
};
type TaskProgress = TaskIdentity & {
    description?: unknown;
    summary?: unknown;
    lastToolName?: unknown;
    last_tool_name?: unknown;
    usage?: unknown;
    outputFilePath?: unknown;
    output_file?: unknown;
};
type BackgroundTaskLevel = TaskIdentity & {
    taskType?: unknown;
    task_type?: unknown;
    description?: unknown;
};
export declare function clientSupportsAsyncTasks(capabilities?: ClientCapabilities | null): boolean;
/** Publishes Claude's non-agent background work as a separate AIR task lifecycle. */
export declare class AsyncTaskRuntime {
    readonly enabled: boolean;
    private readonly sessionId;
    private readonly publish;
    /**
     * One registry owns both active tasks and terminal tombstones. Keeping an
     * unannounced terminal record is intentional: the Bash result proving that
     * a command was backgrounded can arrive after its terminal SDK edge.
     */
    private readonly tasks;
    constructor(enabled: boolean, sessionId: string, publish: Publish);
    taskStarted(message: AsyncTaskStarted): Promise<void>;
    taskBackgrounded(message: AsyncTaskStarted): Promise<void>;
    taskUpdated(message: AsyncTaskUpdated): Promise<void>;
    taskUpdated(taskId: string, patch: TaskPatch): Promise<void>;
    taskProgress(message: TaskProgress): Promise<void>;
    taskNotification(message: AsyncTaskNotification): Promise<void>;
    taskNotification(taskId: string, status: unknown, summary?: unknown, outputFilePath?: unknown): Promise<void>;
    /**
     * Reconciles the SDK's replace-semantics background task level. It does not
     * create unknown tasks because this level normally precedes task_started and
     * carries no tool-call attribution. It can, however, promote a known
     * foreground task and terminate an announced task whose edge was lost.
     */
    backgroundTasksChanged(tasksOrMessage: readonly BackgroundTaskLevel[] | {
        tasks?: unknown;
    }): Promise<void>;
    finishAll(state: Extract<AsyncTaskState, "failed" | "stopped">): Promise<void>;
    canStop(taskId: string): boolean;
    claimStop(taskId: string): boolean;
    releaseStop(taskId: string): void;
    taskStopped(taskId: string): Promise<void>;
    clear(): void;
    private task;
    private mergeStarted;
    private mergePatch;
    private mergeLevel;
    private mergeOutputFilePath;
    private announce;
    private finish;
    private publishMetadata;
    private publishProgress;
    private publishState;
}
/** Recovers background Bash lifecycle data exposed only on its tool result. */
export declare function backgroundBashTaskFromToolResult(content: unknown, toolUseResult: unknown, toolUses: Record<string, {
    name: string;
    input: unknown;
}>): AsyncTaskStarted | undefined;
export {};
//# sourceMappingURL=async-tasks.d.ts.map