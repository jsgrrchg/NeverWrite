import { isChatTab, type Tab } from "../../app/store/editorStore";
import { isAgentSessionActive } from "../ai/agentSessionActivity";
import type { AIChatSession } from "../ai/types";

const SINGLE_TAB_CLOSE_MESSAGE =
    "The AI agent is still running. Are you sure you want to close this tab?";
const MULTI_TAB_CLOSE_MESSAGE =
    "Active AI agents are still running. Are you sure you want to close these tabs?";


export function findActiveSessionsAffectedByClose(
    tabs: readonly Tab[],
    sessionsById: Record<string, AIChatSession>,
): AIChatSession[] {
    const active: AIChatSession[] = [];
    for (const tab of tabs) {
        if (!isChatTab(tab)) continue;
        const session = sessionsById[tab.sessionId];
        if (isAgentSessionActive(session)) {
            active.push(session);
        }
    }
    return active;
}


export function getCloseTabsConfirmationMessage(
    affectedSessions: AIChatSession[],
): string | null {
    if (affectedSessions.length === 0) {
        return null;
    }

    return affectedSessions.length === 1
        ? SINGLE_TAB_CLOSE_MESSAGE
        : MULTI_TAB_CLOSE_MESSAGE;
}
