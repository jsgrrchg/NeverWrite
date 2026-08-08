import { RequestError } from "@agentclientprotocol/sdk";
export const GOAL_EXTENSION_VERSION = 1;
export const GOAL_CONTROL_METHOD = "_session/goal";
export const GOAL_ACTIONS = ["set", "clear"];
export function goalUpdateFromPrompt(prompt) {
    const match = /^\/goal(?:\s+([\s\S]*))?$/.exec(prompt);
    const argument = match?.[1]?.trim();
    if (!argument) {
        return undefined;
    }
    if (argument === "clear") {
        return null;
    }
    return {
        objective: argument,
        status: "active",
        controlMethod: GOAL_CONTROL_METHOD,
    };
}
export function parseGoalRequest(params) {
    if (!params || typeof params !== "object") {
        throw RequestError.invalidParams(undefined, "goal params must be an object");
    }
    const { sessionId, action, objective } = params;
    if (typeof sessionId !== "string" || sessionId.length === 0) {
        throw RequestError.invalidParams(undefined, "goal params require a non-empty sessionId");
    }
    if (!GOAL_ACTIONS.includes(action)) {
        throw RequestError.invalidParams(undefined, 'goal action must be "set" or "clear"');
    }
    if (action === "set" && (typeof objective !== "string" || objective.trim().length === 0)) {
        throw RequestError.invalidParams(undefined, 'goal action "set" requires a non-empty objective');
    }
    return action === "set"
        ? { sessionId, action, objective: objective.trim() }
        : { sessionId, action: "clear" };
}
export function toGoalSnapshot(message) {
    if (message.value === null) {
        return null;
    }
    return {
        objective: message.value.condition.trim(),
        status: "active",
        iterations: message.value.iterations,
        lastReason: message.value.last_reason ?? null,
        createdAt: message.value.set_at,
        controlMethod: GOAL_CONTROL_METHOD,
    };
}
