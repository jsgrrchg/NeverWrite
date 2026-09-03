import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
interface PermissionModeLogger {
    error: (...args: unknown[]) => void;
}
export declare const ALLOW_BYPASS: boolean;
export declare function resolvePermissionMode(defaultMode?: unknown, logger?: PermissionModeLogger): PermissionMode;
export {};
//# sourceMappingURL=modes.d.ts.map