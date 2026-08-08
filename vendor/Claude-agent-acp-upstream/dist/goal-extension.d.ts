import type { SDKActiveGoalMessage } from "@anthropic-ai/claude-agent-sdk";
export declare const GOAL_EXTENSION_VERSION: 1;
export declare const GOAL_CONTROL_METHOD = "_session/goal";
export declare const GOAL_ACTIONS: readonly ["set", "clear"];
export type GoalAction = (typeof GOAL_ACTIONS)[number];
export type GoalCapability = {
    version: typeof GOAL_EXTENSION_VERSION;
    controlMethod: typeof GOAL_CONTROL_METHOD;
    actions: GoalAction[];
};
export type GoalStatus = "active" | "paused" | "blocked" | "limited" | "complete";
export type GoalSnapshot = {
    objective: string;
    status: GoalStatus;
    iterations?: number;
    lastReason?: string | null;
    createdAt?: number;
    updatedAt?: number;
    tokenBudget?: number | null;
    tokensUsed?: number;
    timeUsedSeconds?: number;
    controlMethod: typeof GOAL_CONTROL_METHOD;
};
export type GoalRequest = {
    sessionId: string;
    action: "clear";
} | {
    sessionId: string;
    action: "set";
    objective: string;
};
export type GoalControlResponse = Record<string, never>;
export declare function goalUpdateFromPrompt(prompt: string): GoalSnapshot | null | undefined;
export declare function parseGoalRequest(params: unknown): GoalRequest;
export declare function toGoalSnapshot(message: SDKActiveGoalMessage): GoalSnapshot | null;
//# sourceMappingURL=goal-extension.d.ts.map