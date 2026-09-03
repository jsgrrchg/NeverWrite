import type { PermissionOption } from "@agentclientprotocol/sdk";
import { type PermissionOptionContext } from "./shared.js";
export declare function buildWebFetchPermissionOptions(context: PermissionOptionContext): PermissionOption[];
export declare function buildSkillPermissionOptions(context: PermissionOptionContext): PermissionOption[];
export declare function buildEnterPlanModePermissionOptions(): PermissionOption[];
export declare function buildExitPlanModePermissionOptions(context: PermissionOptionContext): PermissionOption[];
export declare function buildSandboxNetworkPermissionOptions(context: PermissionOptionContext): PermissionOption[];
export declare function buildFallbackPermissionOptions(context: PermissionOptionContext): PermissionOption[];
export declare function isComputerUseMcpTool(toolName: string): boolean;
export declare function buildComputerUseMcpPermissionOptions(context: PermissionOptionContext): PermissionOption[];
//# sourceMappingURL=tools.d.ts.map