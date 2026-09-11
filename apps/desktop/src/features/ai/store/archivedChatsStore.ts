import { create } from "zustand";
import { useVaultStore } from "../../../app/store/vaultStore";
import { safeStorageGetItem, safeStorageSetItem } from "../../../app/utils/safeStorage";
import { getAiSessionLookupKeys } from "../sessionHierarchy";
import type { AIChatSession } from "../types";

export type ArchivedChatEntries = Record<string, { archivedAt: number }>;
export const getArchivedChatsStorageKey = (vaultPath: string) => `neverwrite.chats.archived:${vaultPath}`;

export function readArchivedChats(vaultPath: string | null): ArchivedChatEntries {
    if (!vaultPath) return {};
    try {
        const value = JSON.parse(safeStorageGetItem(getArchivedChatsStorageKey(vaultPath)) ?? "null");
        if (value?.version !== 1 || !value.entries || typeof value.entries !== "object") return {};
        return Object.fromEntries(Object.entries(value.entries).filter(([id, entry]) =>
            id && entry && typeof entry === "object" && "archivedAt" in entry &&
            typeof entry.archivedAt === "number" && Number.isFinite(entry.archivedAt),
        )) as ArchivedChatEntries;
    } catch { return {}; }
}

export function getArchiveRoot(session: AIChatSession, sessions: Record<string, AIChatSession>): AIChatSession {
    const seen = new Set<string>();
    let root = session;
    while (root.parentSessionId && !seen.has(root.sessionId)) {
        seen.add(root.sessionId);
        const parent = Object.values(sessions).find(candidate => getAiSessionLookupKeys(candidate).includes(root.parentSessionId!));
        if (!parent || seen.has(parent.sessionId)) break;
        root = parent;
    }
    return root;
}

export function getArchiveIdentity(session: AIChatSession) {
    return session.historySessionId || session.sessionId.replace(/^persisted:/, "");
}

export function isSessionArchived(session: AIChatSession, sessions: Record<string, AIChatSession>, entries: ArchivedChatEntries) {
    const root = getArchiveRoot(session, sessions);
    return Boolean(entries[getArchiveIdentity(root)] || entries[root.sessionId]);
}

interface ArchivedChatsStore {
    vaultPath: string | null;
    entries: ArchivedChatEntries;
    setVaultPath: (path: string | null) => void;
    archive: (identity: string) => void;
    unarchive: (identity: string) => void;
    isArchived: (identity: string) => boolean;
    replaceSessionId: (from: string, to: string) => void;
    reconcile: (identities: Iterable<string>, inventoryComplete: boolean) => void;
}

export const useArchivedChatsStore = create<ArchivedChatsStore>((set, get) => {
    const update = (entries: ArchivedChatEntries) => {
        const path = get().vaultPath;
        if (!path) return;
        // A failed write must leave the recoverable snapshot and UI intact.
        if (!safeStorageSetItem(getArchivedChatsStorageKey(path), JSON.stringify({ version: 1, entries }))) return;
        set({ entries });
    };
    return {
        vaultPath: useVaultStore.getState().vaultPath,
        entries: readArchivedChats(useVaultStore.getState().vaultPath),
        setVaultPath: (vaultPath) => {
            if (get().vaultPath !== vaultPath) set({ vaultPath, entries: readArchivedChats(vaultPath) });
        },
        archive: (id) => { if (id && !get().entries[id]) update({ ...get().entries, [id]: { archivedAt: Date.now() } }); },
        unarchive: (id) => { const entries = { ...get().entries }; delete entries[id]; update(entries); },
        isArchived: (id) => Boolean(get().entries[id]),
        replaceSessionId: (from, to) => {
            if (!from || !to || from === to || !get().entries[from]) return;
            const entries = { ...get().entries, [to]: get().entries[from] };
            delete entries[from];
            update(entries);
        },
        reconcile: (ids, complete) => {
            if (!complete) return;
            const keep = new Set(ids);
            update(Object.fromEntries(Object.entries(get().entries).filter(([id]) => keep.has(id))));
        },
    };
});
useVaultStore.subscribe((state) => useArchivedChatsStore.getState().setVaultPath(state.vaultPath));
