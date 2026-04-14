import { PlanEntry, ToolCallContent, ToolCallLocation, ToolKind } from "@agentclientprotocol/sdk";
import { HookCallback } from "@anthropic-ai/claude-agent-sdk";
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
export declare function markdownEscape(text: string): string;
/**
 * Builds diff ToolUpdate content from the structured Edit toolResponse provided
 * by the PostToolUse hook. Unlike parsing the plain unified diff string, this uses
 * the pre-parsed structuredPatch which supports multiple replacement sites (replaceAll)
 * and always includes context lines for better readability.
 */
export declare function toolUpdateFromEditToolResponse(toolResponse: unknown): {
    content?: ToolCallContent[];
    locations?: ToolCallLocation[];
};
export declare const registerHookCallback: (toolUseID: string, { onPostToolUseHook, }: {
    onPostToolUseHook?: (toolUseID: string, toolInput: unknown, toolResponse: unknown) => Promise<void>;
}) => void;
export declare const createPostToolUseHook: (logger?: Logger, options?: {
    onEnterPlanMode?: () => Promise<void>;
}) => HookCallback;
export {};
//# sourceMappingURL=tools.d.ts.map