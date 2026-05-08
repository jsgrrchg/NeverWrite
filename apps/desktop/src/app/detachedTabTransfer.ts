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

function addNonEmptySessionRef(refs: Set<string>, ref: string | null | undefined) {
    const normalizedRef = ref?.trim();
    if (normalizedRef) {
        refs.add(normalizedRef);
    }
}

function addSessionRefs(refs: Set<string>, session: AIChatSession) {
    addNonEmptySessionRef(refs, session.sessionId);
    addNonEmptySessionRef(refs, session.historySessionId);
    addNonEmptySessionRef(refs, session.runtimeSessionId);
}

function sessionMatchesAnyRef(session: AIChatSession, refs: Set<string>) {
    return (
        refs.has(session.sessionId) ||
        refs.has(session.historySessionId) ||
        (session.runtimeSessionId ? refs.has(session.runtimeSessionId) : false)
    );
}

function isSessionConnectedToRefs(session: AIChatSession, refs: Set<string>) {
    const parentSessionId = session.parentSessionId?.trim();
    return (
        sessionMatchesAnyRef(session, refs) ||
        (parentSessionId ? refs.has(parentSessionId) : false)
    );
}

export function collectAiSessionsForDetachedTransfer(
    tabs: readonly TabInput[],
): AIChatSession[] {
    const sessionsById = useChatStore.getState().sessionsById;
    const collected = new Map<string, AIChatSession>();
    const refs = new Set<string>();

    for (const tab of tabs) {
        if (!isChatTab(tab)) continue;

        const session = sessionsById[tab.sessionId];
        if (!session) continue;

        collected.set(session.sessionId, session);
        addSessionRefs(refs, session);
        addNonEmptySessionRef(refs, session.parentSessionId);
    }

    let changed = true;
    while (changed) {
        changed = false;
        for (const session of Object.values(sessionsById)) {
            if (
                collected.has(session.sessionId) ||
                !isSessionConnectedToRefs(session, refs)
            ) {
                continue;
            }

            collected.set(session.sessionId, session);
            addSessionRefs(refs, session);
            addNonEmptySessionRef(refs, session.parentSessionId);
            changed = true;
        }
    }

    return [...collected.values()];
}
