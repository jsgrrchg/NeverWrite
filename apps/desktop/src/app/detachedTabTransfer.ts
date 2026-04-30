import {
    isChatTab,
    isTerminalTab,
    type TabInput,
} from "./store/editorStore";
import { ensureTerminalTabDefaults } from "./store/editorTabs";
import { useChatStore } from "../features/ai/store/chatStore";
import type { AIChatSession } from "../features/ai/types";

function resolveChatHistorySessionId(
    tab: Extract<TabInput, { kind: "ai-chat" }>,
) {
    if (tab.historySessionId) {
        return tab.historySessionId;
    }

    if (tab.sessionId.startsWith("persisted:")) {
        return tab.sessionId.slice("persisted:".length) || undefined;
    }

    if (tab.sessionId.startsWith("pending:")) {
        return undefined;
    }

    return tab.sessionId;
}

/**
 * Detached windows hydrate in a separate renderer process, so every transferred
 * tab must carry enough durable identity to rebuild its view/runtime there.
 */
export function prepareTabForDetachedTransfer(tab: TabInput): TabInput {
    if (isChatTab(tab)) {
        const historySessionId = resolveChatHistorySessionId(tab);
        return {
            ...tab,
            ...(historySessionId ? { historySessionId } : {}),
        };
    }

    if (isTerminalTab(tab)) {
        return ensureTerminalTabDefaults(tab);
    }

    return tab;
}

export function prepareTabsForDetachedTransfer(tabs: readonly TabInput[]) {
    return tabs.map((tab) => prepareTabForDetachedTransfer(tab));
}

export function collectAiSessionsForDetachedTransfer(
    tabs: readonly TabInput[],
): AIChatSession[] {
    const sessionsById = useChatStore.getState().sessionsById;
    const collected = new Map<string, AIChatSession>();

    for (const tab of tabs) {
        if (!isChatTab(tab)) continue;

        const session = sessionsById[tab.sessionId];
        if (!session) continue;

        collected.set(session.sessionId, session);
    }

    return [...collected.values()];
}
