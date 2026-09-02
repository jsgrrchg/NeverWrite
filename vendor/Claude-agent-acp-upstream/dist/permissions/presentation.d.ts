import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
export interface ClaudePermissionPresentationInput {
    toolName: string;
    input: Record<string, unknown>;
    toolUseID: string;
    cwd?: string;
    supportsTerminalOutput?: boolean;
    blockedPath?: string;
    title?: string;
    displayName?: string;
    description?: string;
    decisionReason?: string;
}
export declare function buildClaudePermissionPresentation(value: ClaudePermissionPresentationInput): Pick<RequestPermissionRequest, "toolCall" | "_meta">;
//# sourceMappingURL=presentation.d.ts.map