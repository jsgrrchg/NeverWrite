import type { RequestPermissionResponse } from "@agentclientprotocol/sdk";
import type { PermissionOption } from "@agentclientprotocol/sdk";
import type { PermissionMode, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { DurablePermissionChangeSet } from "./normalization.js";
export interface ClaudePermissionDecision {
    permissionResult: PermissionResult;
    contextResetMode?: PermissionMode;
}
/** Decode, validate, and interpret an ACP response exactly once. */
export declare function decodeClaudePermissionResponse(response: RequestPermissionResponse, toolName: string, input: Record<string, unknown>, toolUseID: string, offeredOptions: readonly PermissionOption[], durableChangeSet?: DurablePermissionChangeSet): ClaudePermissionDecision;
//# sourceMappingURL=response.d.ts.map