import { confirm } from "@neverwrite/runtime";
import {
    isChatTab,
    isReviewTab,
    type Tab,
} from "../../app/store/editorStore";
import { resolveAgentSessionActivity } from "./agentSessionActivity";
import { getAiSessionLookupKeys } from "./sessionHierarchy";
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

function collectRelatedSessionRefs(
    tabs: readonly Tab[],
    sessionsById: Record<string, AIChatSession>,
) {
    const refs = new Set<string>();

    for (const tab of tabs) {
        const sessionId = getLinkedSessionId(tab);
        if (!sessionId) continue;

        refs.add(sessionId);
        const session = sessionsById[sessionId];
        if (!session) continue;

        for (const key of getAiSessionLookupKeys(session)) {
            refs.add(key);
        }
    }

    let changed = true;
    while (changed) {
        changed = false;

        for (const session of Object.values(sessionsById)) {
            const parentRef = session.parentSessionId?.trim();
            if (!parentRef || !refs.has(parentRef)) continue;

            for (const key of getAiSessionLookupKeys(session)) {
                if (refs.has(key)) continue;
                refs.add(key);
                changed = true;
            }
        }
    }

    return refs;
}

function isSessionLinkedToClosedTabs(
    session: AIChatSession,
    linkedSessionRefs: ReadonlySet<string>,
) {
    if (
        getAiSessionLookupKeys(session).some((key) =>
            linkedSessionRefs.has(key),
        )
    ) {
        return true;
    }

    const parentRef = session.parentSessionId?.trim();
    return Boolean(parentRef && linkedSessionRefs.has(parentRef));
}

export function getActiveAgentSessionsForTabs(
    tabs: readonly Tab[],
    sessionsById: Record<string, AIChatSession>,
) {
    const sessions = new Map<string, ActiveAgentSessionDescriptor>();
    const linkedSessionRefs = collectRelatedSessionRefs(tabs, sessionsById);
    if (linkedSessionRefs.size === 0) {
        return [];
    }

    for (const session of Object.values(sessionsById)) {
        if (sessions.has(session.sessionId)) continue;
        if (!isSessionActivelyWorking(session)) continue;
        if (!isSessionLinkedToClosedTabs(session, linkedSessionRefs)) {
            continue;
        }

        sessions.set(session.sessionId, {
            sessionId: session.sessionId,
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
