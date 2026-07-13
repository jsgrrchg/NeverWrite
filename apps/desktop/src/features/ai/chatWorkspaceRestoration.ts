import {
    ensureChatTabHistory,
    type ChatHistoryEntry,
    type ChatTab,
} from "../../app/store/editorStore";

export interface ChatWorkspaceHistoryReference extends ChatHistoryEntry {
    id: string;
    tabId: string;
    historyIndex: number;
    isCurrent: boolean;
}

// A physical chat tab can project several durable sessions. Give every entry
// an opaque reconciliation ID while preserving the tab ID for the visible one,
// since startup uses that ID to decide which session should be resumed.
export function listChatWorkspaceHistoryReferences(
    tabs: readonly ChatTab[],
): ChatWorkspaceHistoryReference[] {
    return tabs.flatMap((tab) => {
        const normalized = ensureChatTabHistory(tab);
        return normalized.history.map((entry, historyIndex) => {
            const isCurrent = historyIndex === normalized.historyIndex;
            return {
                ...entry,
                id: isCurrent
                    ? normalized.id
                    : `${normalized.id}:history:${historyIndex}`,
                tabId: normalized.id,
                historyIndex,
                isCurrent,
            };
        });
    });
}
