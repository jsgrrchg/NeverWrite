import type { PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
export interface DurablePermissionChangeSet {
    updates: PermissionUpdate[];
}
export declare function normalizeDurablePermissionChangeSet(suggestions: unknown, forcedAsk?: boolean): DurablePermissionChangeSet | undefined;
//# sourceMappingURL=normalization.d.ts.map