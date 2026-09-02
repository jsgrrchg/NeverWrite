import type { RequestPermissionResponse } from "@agentclientprotocol/sdk";
import type { PermissionMode, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { DurablePermissionChangeSet } from "./normalization.js";
export interface ClaudePermissionSelection {
    optionId: string;
    contextResetMode?: PermissionMode;
}
export interface ClaudePermissionEffectContext {
    toolName: string;
    input: Record<string, unknown>;
    toolUseID: string;
    durableChangeSet?: DurablePermissionChangeSet;
}
/** Parse the ACP envelope once before dispatching to a tool-specific effect. */
export declare function parseClaudePermissionSelection(response: RequestPermissionResponse, toolName: string): ClaudePermissionSelection;
export declare function exitPlanClearContextMode(optionId: string): PermissionMode | undefined;
/** Apply a parsed selection using the semantics of the tool that produced it. */
export declare function applyClaudePermissionSelection(selection: ClaudePermissionSelection, context: ClaudePermissionEffectContext): PermissionResult;
//# sourceMappingURL=effects.d.ts.map