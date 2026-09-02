import type { PermissionOption } from "@agentclientprotocol/sdk";
import type { DurablePermissionChangeSet } from "../normalization.js";
export declare const PERMISSION_OPTION_ID: {
    readonly allowOnce: "allow-once";
    readonly allowWithUpdates: "allow-with-updates";
    readonly allowSkillExact: "allow-skill-exact";
    readonly allowSkillPrefix: "allow-skill-prefix";
    readonly exitPlanBypass: "exit-plan-bypass";
    readonly exitPlanAuto: "exit-plan-auto";
    readonly exitPlanAcceptEdits: "exit-plan-accept-edits";
    readonly exitPlanDefault: "exit-plan-default";
    readonly exitPlanClearAuto: "exit-plan-clear-auto";
    readonly exitPlanClearBypass: "exit-plan-clear-bypass";
    readonly exitPlanClearAcceptEdits: "exit-plan-clear-accept-edits";
    readonly reject: "reject";
};
export interface PermissionOptionContext {
    toolName: string;
    displayName?: string;
    input: Record<string, unknown>;
    cwd: string;
    durableChangeSet?: DurablePermissionChangeSet;
    allowPersistentOptions?: boolean;
    availableModes?: readonly string[];
    contextUsedPercent?: number;
}
export declare function allowOnce(name?: string): PermissionOption;
export declare function allowWithUpdates(name: string): PermissionOption;
export declare function reject(name?: string): PermissionOption;
export declare function withOptionalUpdate(changeSet: DurablePermissionChangeSet | undefined, updateName: string | undefined, allowName?: string, rejectName?: string): PermissionOption[];
export declare function plainString(value: unknown): string | undefined;
export declare function exactLocalAllowRule(changeSet: DurablePermissionChangeSet | undefined, toolName: string, ruleContent?: string): boolean;
/**
 * An MCP "don't ask again" option is only truthful when every provider update
 * adds an unrestricted allow rule for the tool currently being prompted.
 */
export declare function isMcpAllowChangeSet(changeSet: DurablePermissionChangeSet | undefined, toolName: string): boolean;
export declare function withGeneratedUpdate(name: string, rejectName?: string): PermissionOption[];
//# sourceMappingURL=shared.d.ts.map