import { PlanEntry, ToolCallContent, ToolCallLocation, ToolKind } from "@agentclientprotocol/sdk";
import { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { TaskCreateInput, TaskCreateOutput, TaskUpdateInput } from "@anthropic-ai/claude-agent-sdk/sdk-tools.js";
import { ToolResultBlockParam, WebSearchToolResultBlockParam } from "@anthropic-ai/sdk/resources";
import { BetaBashCodeExecutionToolResultBlockParam, BetaCodeExecutionToolResultBlockParam, BetaRequestMCPToolResultBlockParam, BetaTextEditorCodeExecutionToolResultBlockParam, BetaToolResultBlockParam, BetaToolSearchToolResultBlockParam, BetaWebFetchToolResultBlockParam, BetaWebSearchToolResultBlockParam } from "@anthropic-ai/sdk/resources/beta.mjs";
import { Logger } from "./acp-agent.js";
interface ToolInfo {
    title: string;
    kind: ToolKind;
    content: ToolCallContent[];
    locations?: ToolCallLocation[];
}
interface ToolUpdate {
    title?: string;
    content?: ToolCallContent[];
    locations?: ToolCallLocation[];
    _meta?: {
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
}
/**
 * Convert an absolute file path to a project-relative path for display.
 * Returns the original path if it's outside the project directory or if no cwd is provided.
 */
export declare function toDisplayPath(filePath: string, cwd?: string): string;
export declare function toolInfoFromToolUse(toolUse: any, supportsTerminalOutput?: boolean, cwd?: string): ToolInfo;
export declare function toolUpdateFromToolResult(toolResult: ToolResultBlockParam | BetaToolResultBlockParam | BetaWebSearchToolResultBlockParam | BetaWebFetchToolResultBlockParam | WebSearchToolResultBlockParam | BetaCodeExecutionToolResultBlockParam | BetaBashCodeExecutionToolResultBlockParam | BetaTextEditorCodeExecutionToolResultBlockParam | BetaRequestMCPToolResultBlockParam | BetaToolSearchToolResultBlockParam, toolUse: any | undefined, supportsTerminalOutput?: boolean): ToolUpdate;
export type ClaudePlanEntry = {
    content: string;
    status: "pending" | "in_progress" | "completed";
    activeForm: string;
};
export declare function planEntries(input: {
    todos: ClaudePlanEntry[];
} | undefined): PlanEntry[];
/**
 * Per-session task list accumulated from Task* tool calls (TaskCreate /
 * TaskUpdate). The headless/SDK session emits these as incremental tool
 * calls keyed by task ID, replacing the snapshot-style TodoWrite tool.
 * Iteration order is insertion order (Map semantics), matching the order
 * tasks are created.
 */
export type TaskEntry = {
    subject: string;
    status: "pending" | "in_progress" | "completed";
    activeForm?: string;
    description?: string;
};
export type TaskState = Map<string, TaskEntry>;
/**
 * Best-effort parse of a TaskCreate tool_result content into the structured
 * TaskCreateOutput. The SDK delivers tool outputs either as a string or as
 * an array of TextBlockParam-like blocks containing JSON text; try both.
 */
export declare function parseTaskCreateOutput(content: unknown): TaskCreateOutput | undefined;
export declare function applyTaskCreate(state: TaskState, input: TaskCreateInput | undefined, output: TaskCreateOutput | undefined): void;
export declare function applyTaskUpdate(state: TaskState, input: TaskUpdateInput | undefined): void;
export declare function taskStateToPlanEntries(state: TaskState): PlanEntry[];
export declare function markdownEscape(text: string): string;
/**
 * Builds diff ToolUpdate content from the structured toolResponse provided by
 * the PostToolUse hook for diff-producing tools (Edit, Write). Unlike parsing
 * the plain unified diff string, this uses the pre-parsed structuredPatch
 * which supports multiple replacement sites (replaceAll) and always includes
 * context lines for better readability.
 */
export declare function toolUpdateFromDiffToolResponse(toolResponse: unknown): {
    content?: ToolCallContent[];
    locations?: ToolCallLocation[];
};
export declare const registerHookCallback: (toolUseID: string, { onPostToolUseHook, }: {
    onPostToolUseHook?: (toolUseID: string, toolInput: unknown, toolResponse: unknown) => Promise<void>;
}) => void;
export declare const createPostToolUseHook: (logger?: Logger, options?: {
    onEnterPlanMode?: () => Promise<void>;
}) => HookCallback;
/**
 * Hook callback for `TaskCreated` / `TaskCompleted` events. The SDK fires
 * these for both user-facing TaskCreate tool calls and subagent task
 * creation, giving us `task_id` + `task_subject` without having to parse
 * tool_result payloads.
 *
 * Populating `taskState` from the hook means a later `TaskUpdate` (which
 * typically only carries `taskId` + `status`) finds an existing entry with
 * a real subject, instead of synthesizing a placeholder with empty content.
 */
export declare const createTaskHook: (options: {
    taskState: TaskState;
    onChange?: () => Promise<void>;
}) => HookCallback;
export {};
//# sourceMappingURL=tools.d.ts.map