import { type HookCallback, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
export declare const AGENT_FILE_CHANGE_REPORT_CAPABILITY = "agentFileChangeReport";
export declare const FILE_CHANGE_AUDIT_SERVER_NAME = "claude_agent_acp";
export declare const FILE_CHANGE_AUDIT_TOOL_NAME = "report_changed_files";
export declare const FILE_CHANGE_AUDIT_WIRE_TOOL_NAME = "mcp__claude_agent_acp__report_changed_files";
export declare const AGENT_FILE_CHANGE_REPORT_MAX_BYTES: number;
export type FileChangeAuditTurnState = {
    requestId: string;
    phase: "requested" | "collecting" | "finished";
};
export type FileChangeAuditWorkspace = {
    cwd: string;
    additionalDirectories: string[];
};
export type AgentFileChangeReport = {
    paths: string[];
    complete: boolean;
    uncertainty?: string;
};
export type AgentFileChangeReportResult = {
    version: 1;
    requestId: string;
} & ({
    status: "reported";
    paths: string[];
    declaredComplete: boolean;
    truncated: boolean;
    uncertainty?: string;
} | {
    status: "unavailable";
    reason: FileChangeReportUnavailableReason;
});
export type FileChangeReportUnavailableReason = "cancelled" | "timeout" | "invalidOutput" | "notReported" | "providerError";
type FileChangeAuditSupportOptions = {
    cwd: string;
    additionalDirectories: string[];
    getActiveState: () => FileChangeAuditTurnState | undefined;
    publish: (result: AgentFileChangeReportResult) => Promise<void>;
    logError: (message: string) => void;
};
export type FileChangeAuditSupport = {
    mcpServer: McpSdkServerConfigWithInstance;
    preToolUseHook: HookCallback;
    stopHook: HookCallback;
    finishUnavailable: (state: FileChangeAuditTurnState, reason: FileChangeReportUnavailableReason) => Promise<void>;
};
export declare function agentFileChangeReportRequestId(meta: unknown): string | undefined;
export declare function supportsAgentFileChangeReport(capabilities: unknown): boolean;
export declare function agentFileChangeReportMeta(result: AgentFileChangeReportResult): Record<string, unknown>;
export declare function createFileChangeAuditTurnState(requestId: string): FileChangeAuditTurnState;
export declare function isFileChangeAuditReportPhase(state: FileChangeAuditTurnState | undefined): boolean;
export declare function isFileChangeAuditTool(toolName: string): boolean;
export declare function containsFileChangeAuditMarker(text: string): boolean;
export declare function createFileChangeAuditSupport(options: FileChangeAuditSupportOptions): FileChangeAuditSupport;
export {};
//# sourceMappingURL=file-change-audit.d.ts.map