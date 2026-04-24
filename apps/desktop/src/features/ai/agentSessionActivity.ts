import type { AIChatSession } from "./types";

export type AgentSessionActivityIndicator = {
    readonly title: string;
    readonly tone: "danger" | "working";
} | null;

const ERROR_ACTIVITY_INDICATOR: AgentSessionActivityIndicator = {
    title: "Agent error",
    tone: "danger",
};

const WORKING_ACTIVITY_INDICATOR: AgentSessionActivityIndicator = {
    title: "Agent busy",
    tone: "working",
};

export function resolveAgentSessionActivity(
    session:
        | Pick<AIChatSession, "runtimeState" | "status">
        | null
        | undefined,
): AgentSessionActivityIndicator {
    if (!session) {
        return null;
    }

    if (session.runtimeState != null && session.runtimeState !== "live") {
        return null;
    }

    switch (session.status) {
        case "error":
            return ERROR_ACTIVITY_INDICATOR;
        case "streaming":
        case "waiting_permission":
        case "waiting_user_input":
            return WORKING_ACTIVITY_INDICATOR;
        default:
            return null;
    }
}
