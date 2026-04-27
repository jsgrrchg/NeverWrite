import { create } from "zustand";
import {
    safeStorageGetItem,
    safeStorageSetItem,
} from "../../../app/utils/safeStorage";
import { logWarn } from "../../../app/utils/runtimeLog";

// Client-side persisted set of chat session IDs the user has pinned to the
// top of the sidebar. Kept out of the Rust backend for now; if we ever want
// pins to be per-vault or shared across devices the data can migrate.

const PINNED_CHATS_KEY = "neverwrite.chats.pinnedIds";

interface PinnedChatEntry {
    pinnedAt: number;
}

interface PinnedChatsStore {
    entries: Record<string, PinnedChatEntry>;
    togglePin: (sessionId: string) => void;
    pin: (sessionId: string) => void;
    unpin: (sessionId: string) => void;
    reconcile: (existingSessionIds: Iterable<string>) => void;
}

function readHydratedEntries(): Record<string, PinnedChatEntry> {
    const raw = safeStorageGetItem(PINNED_CHATS_KEY);
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object") return {};
        const result: Record<string, PinnedChatEntry> = {};
        for (const [id, value] of Object.entries(parsed)) {
            if (typeof id !== "string" || !id) continue;
            if (value && typeof value === "object") {
                const pinnedAt = (value as { pinnedAt?: unknown }).pinnedAt;
                if (typeof pinnedAt === "number" && Number.isFinite(pinnedAt)) {
                    result[id] = { pinnedAt };
                    continue;
                }
            }
            // Legacy shape: plain array of ids → assign current time so sort
            // order is deterministic on first migration.
            if (typeof value === "number") {
                result[id] = { pinnedAt: value };
            }
        }
        return result;
    } catch (error) {
        logWarn("pinned-chats", "Failed to hydrate pinned chats", error, {
            onceKey: "hydrate-pinned-chats",
        });
        return {};
    }
}

function persistEntries(entries: Record<string, PinnedChatEntry>) {
    safeStorageSetItem(PINNED_CHATS_KEY, JSON.stringify(entries));
}

export const usePinnedChatsStore = create<PinnedChatsStore>((set) => ({
    entries: readHydratedEntries(),
    togglePin: (sessionId) =>
        set((state) => {
            const next = { ...state.entries };
            if (next[sessionId]) {
                delete next[sessionId];
            } else {
                next[sessionId] = { pinnedAt: Date.now() };
            }
            persistEntries(next);
            return { entries: next };
        }),
    pin: (sessionId) =>
        set((state) => {
            if (state.entries[sessionId]) return state;
            const next = {
                ...state.entries,
                [sessionId]: { pinnedAt: Date.now() },
            };
            persistEntries(next);
            return { entries: next };
        }),
    unpin: (sessionId) =>
        set((state) => {
            if (!state.entries[sessionId]) return state;
            const next = { ...state.entries };
            delete next[sessionId];
            persistEntries(next);
            return { entries: next };
        }),
    reconcile: (existingSessionIds) =>
        set((state) => {
            const keep = new Set<string>();
            for (const id of existingSessionIds) keep.add(id);
            const next: Record<string, PinnedChatEntry> = {};
            let changed = false;
            for (const [id, entry] of Object.entries(state.entries)) {
                if (keep.has(id)) {
                    next[id] = entry;
                } else {
                    changed = true;
                }
            }
            if (!changed) return state;
            persistEntries(next);
            return { entries: next };
        }),
}));
