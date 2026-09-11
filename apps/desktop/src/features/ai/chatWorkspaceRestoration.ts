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

import { useVaultStore } from "../../app/store/vaultStore";
import { isChatTab, isChatHistoryTab, type TabInput } from "../../app/store/editorTabs";
import { readPersistedChatWorkspace, persistChatNavigationNow, useChatTabsStore } from "./store/chatTabsStore";
import { readArchivedChats } from "./store/archivedChatsStore";

/** Preserve every legacy history entry before its editor projection is removed. */
export function migrateLegacyChatTabs(tabs: readonly TabInput[], focusedTabId: string | null) {
    const chats = tabs.filter(isChatTab).map(ensureChatTabHistory);
    if (!chats.length && !tabs.some(isChatHistoryTab)) return;
    const path = useVaultStore.getState().vaultPath;
    if (!path) throw new Error("Cannot migrate chat references without their vault");
    const saved = readPersistedChatWorkspace(path);
    const nav = useChatTabsStore.getState();
    // Merge persisted metadata first; this is idempotent after an interrupted write.
    for (const tab of saved?.tabs ?? []) nav.ensureSessionTab(tab.sessionId, tab.historySessionId ?? tab.conversationId, tab.runtimeId);
    const references = listChatWorkspaceHistoryReferences(chats);
    for (const entry of references) nav.ensureSessionTab(entry.sessionId, entry.historySessionId);
    const focused = tabs.find(tab => tab.id === focusedTabId);
    if (focused && isChatHistoryTab(focused)) nav.showHistory();
    else if (focused && isChatTab(focused)) nav.showConversation(focused.sessionId);
    else if (nav.view.mode === "empty") {
        if (saved?.view && saved.view.mode !== "empty") useChatTabsStore.setState({ view: saved.view });
        else {
            const archived = readArchivedChats(path);
            const selectedMetadata = saved?.tabs.find(tab => tab.id === saved.activeTabId);
            const candidates = [...(selectedMetadata ? [selectedMetadata] : []), ...references];
            const fallback = candidates.find(entry => !archived[entry.historySessionId ?? entry.sessionId.replace(/^persisted:/, "")]);
            if (fallback) nav.showConversation(fallback.sessionId);
        }
    }
    if (!persistChatNavigationNow()) throw new Error("Could not preserve legacy chat references; editor restoration postponed");
}

import { safeStorageSetItem } from "../../app/utils/safeStorage";
import { getChatTabsStorageKey, type ChatWorkspaceTab } from "./store/chatTabsStore";

/** Transfers preserve references in their source vault without importing runtime into another vault. */
export function preserveLegacyChatTabsForVault(vaultPath: string, tabs: readonly TabInput[], focusedId: string | null) {
    const saved = readPersistedChatWorkspace(vaultPath);
    const references = listChatWorkspaceHistoryReferences(tabs.filter(isChatTab).map(ensureChatTabHistory));
    const byIdentity = new Map<string, ChatWorkspaceTab>();
    for (const tab of saved?.tabs ?? []) byIdentity.set(tab.conversationId ?? tab.historySessionId ?? tab.sessionId, tab);
    for (const entry of references) {
        const identity = entry.historySessionId ?? entry.sessionId.replace(/^persisted:/, "");
        if (!byIdentity.has(identity)) byIdentity.set(identity, { id: entry.id, sessionId: entry.sessionId, conversationId: identity, historySessionId: entry.historySessionId });
    }
    const focused = tabs.find(tab => tab.id === focusedId);
    const view = focused && isChatTab(focused) ? { mode: "conversation", sessionId: focused.historySessionId ?? focused.sessionId }
        : focused && isChatHistoryTab(focused) ? { mode: "history", selectedHistorySessionId: null, returnSessionId: null }
        : saved?.view ?? { mode: "empty" };
    return safeStorageSetItem(getChatTabsStorageKey(vaultPath), JSON.stringify({ version: 2, tabs: [...byIdentity.values()], activeTabId: saved?.activeTabId ?? null, view, historyFilter: saved?.historyFilter ?? "all" }));
}
