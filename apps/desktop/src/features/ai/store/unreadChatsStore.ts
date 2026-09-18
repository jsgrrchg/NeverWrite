import { create } from "zustand";
import { useVaultStore } from "../../../app/store/vaultStore";
import { safeStorageGetItem, safeStorageSetItem } from "../../../app/utils/safeStorage";
import { useChatTabsStore } from "./chatTabsStore";

const storageKey = () => `neverwrite.chats.unread:${useVaultStore.getState().vaultPath ?? ""}`;

function readEntries(): Record<string, true> {
    if (!useVaultStore.getState().vaultPath) return {};
    try {
        const parsed: unknown = JSON.parse(safeStorageGetItem(storageKey()) ?? "{}");
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
        return Object.fromEntries(Object.entries(parsed).filter(([, value]) => value === true)) as Record<string, true>;
    } catch {
        return {};
    }
}

function isViewingSession(sessionId: string): boolean {
    const { view, focusedSurface } = useChatTabsStore.getState();
    return view.mode === "conversation" && view.sessionId === sessionId &&
        focusedSurface === "chat" && typeof document !== "undefined" &&
        document.visibilityState === "visible" && document.hasFocus();
}

interface UnreadChatsStore {
    entries: Record<string, true>;
    markCompleted: (sessionId: string) => void;
    markRead: (sessionId: string) => void;
    replaceSessionId: (from: string, to: string) => void;
    clear: () => void;
}

export const useUnreadChatsStore = create<UnreadChatsStore>((set) => {
    const update = (transform: (entries: Record<string, true>) => Record<string, true>) =>
        set((state) => {
            const entries = transform(state.entries);
            if (entries === state.entries) return state;
            if (useVaultStore.getState().vaultPath) {
                safeStorageSetItem(storageKey(), JSON.stringify(entries));
            }
            return { entries };
        });
    return {
        entries: readEntries(),
        markCompleted: (sessionId) => {
            if (isViewingSession(sessionId)) return;
            update((entries) => entries[sessionId] ? entries : { ...entries, [sessionId]: true });
        },
        markRead: (sessionId) => update((entries) => {
            if (!entries[sessionId]) return entries;
            const next = { ...entries };
            delete next[sessionId];
            return next;
        }),
        replaceSessionId: (from, to) => update((entries) => {
            if (from === to || !entries[from]) return entries;
            const next = { ...entries, [to]: true as const };
            delete next[from];
            return next;
        }),
        clear: () => update(() => ({})),
    };
});

function markVisibleConversationRead() {
    const { view } = useChatTabsStore.getState();
    if (view.mode === "conversation" && isViewingSession(view.sessionId)) {
        useUnreadChatsStore.getState().markRead(view.sessionId);
    }
}

useVaultStore.subscribe((state, previous) => {
    if (state.vaultPath !== previous.vaultPath) {
        useUnreadChatsStore.setState({ entries: readEntries() });
    }
});
useChatTabsStore.subscribe(markVisibleConversationRead);
if (typeof window !== "undefined") {
    window.addEventListener("focus", markVisibleConversationRead);
    document.addEventListener("visibilitychange", markVisibleConversationRead);
}
