import { confirm } from "@neverwrite/runtime";
import {
    isChatTab,
    isReviewTab,
    type Tab,
} from "../../app/store/editorStore";
import { resolveAgentSessionActivity } from "./agentSessionActivity";
import { getSessionTitle } from "./sessionPresentation";
import type { AIChatSession, AIChatSessionStatus } from "./types";

const ACTIVE_AGENT_STATUS_LABELS: Record<AIChatSessionStatus, string> = {
    idle: "Idle",
    streaming: "Streaming response",
    waiting_permission: "Waiting for permission",
    waiting_user_input: "Waiting for input",
    review_required: "Review required",
    error: "Error",
};

interface ActiveAgentSessionDescriptor {
    sessionId: string;
    title: string;
    statusLabel: string;
}

function isSessionActivelyWorking(session: AIChatSession) {
    return resolveAgentSessionActivity(session)?.tone === "working";
}

function getLinkedSessionId(tab: Tab) {
    if (isChatTab(tab) || isReviewTab(tab)) {
        return tab.sessionId;
    }

    return null;
}

export function getActiveAgentSessionsForTabs(
    tabs: readonly Tab[],
    sessionsById: Record<string, AIChatSession>,
) {
    const sessions = new Map<string, ActiveAgentSessionDescriptor>();

    for (const tab of tabs) {
        const sessionId = getLinkedSessionId(tab);
        if (!sessionId || sessions.has(sessionId)) {
            continue;
        }

        const session = sessionsById[sessionId];
        if (!session || !isSessionActivelyWorking(session)) {
            continue;
        }

        sessions.set(sessionId, {
            sessionId,
            title: getSessionTitle(session),
            statusLabel: ACTIVE_AGENT_STATUS_LABELS[session.status],
        });
    }

    return [...sessions.values()];
}

export async function confirmActiveAgentTabClose(args: {
    actionLabel: string;
    tabs: readonly Tab[];
    sessionsById: Record<string, AIChatSession>;
}) {
    const activeSessions = getActiveAgentSessionsForTabs(
        args.tabs,
        args.sessionsById,
    );
    if (activeSessions.length === 0) {
        return true;
    }

    const title =
        activeSessions.length === 1
            ? "Close active agent tab?"
            : "Close tabs with active agents?";
    const summary =
        activeSessions.length === 1
            ? "An agent is still working in this tab."
            : `${activeSessions.length} agents are still working in the tabs you are closing.`;
    const detailLines = activeSessions
        .slice(0, 5)
        .map((session) => `• ${session.title} (${session.statusLabel})`)
        .join("\n");
    const overflowLine =
        activeSessions.length > 5
            ? `\n• ${activeSessions.length - 5} more active sessions`
            : "";

    return confirm(
        `${summary}\n\n${detailLines}${overflowLine}\n\nClosing the tab will not stop the agent automatically.\n\nAre you sure you want to ${args.actionLabel}?`,
        {
            title,
            kind: "warning",
        },
    );
}
