import { create } from "zustand";
import {
    safeStorageGetItem,
    safeStorageSetItem,
} from "../../../app/utils/safeStorage";
import { logWarn } from "../../../app/utils/runtimeLog";

// Folder membership is a local sidebar preference, like pinned chats. Keeping
// it separate from AIChatSession means adding folders never rewrites provider
// history or changes what existing users see.
const CHAT_FOLDERS_KEY = "neverwrite.chats.folders";

export interface ChatFolder {
    id: string;
    name: string;
    createdAt: number;
}

interface PersistedChatFolders {
    folders: Record<string, ChatFolder>;
    sessionFolderIds: Record<string, string>;
    collapsedFolderIds: string[];
}

interface ChatFoldersStore extends PersistedChatFolders {
    createFolder: (name: string) => string | null;
    renameFolder: (folderId: string, name: string) => void;
    deleteFolder: (folderId: string) => void;
    moveSession: (sessionId: string, folderId: string | null) => void;
    replaceSessionId: (fromSessionId: string, toSessionId: string) => void;
    toggleFolderCollapsed: (folderId: string) => void;
    reconcile: (existingRootSessionIds: Iterable<string>) => void;
}

const EMPTY_STATE: PersistedChatFolders = {
    folders: {},
    sessionFolderIds: {},
    collapsedFolderIds: [],
};

function normalizeFolderName(name: string) {
    return name.trim().replace(/\s+/g, " ").slice(0, 80);
}

function readHydratedState(): PersistedChatFolders {
    const raw = safeStorageGetItem(CHAT_FOLDERS_KEY);
    if (!raw) return EMPTY_STATE;
    try {
        const parsed = JSON.parse(raw) as Partial<PersistedChatFolders>;
        const folders: Record<string, ChatFolder> = {};
        for (const [id, candidate] of Object.entries(parsed.folders ?? {})) {
            const name = normalizeFolderName(candidate?.name ?? "");
            if (!id || !name) continue;
            folders[id] = {
                id,
                name,
                createdAt:
                    typeof candidate?.createdAt === "number"
                        ? candidate.createdAt
                        : 0,
            };
        }
        const sessionFolderIds: Record<string, string> = {};
        for (const [sessionId, folderId] of Object.entries(
            parsed.sessionFolderIds ?? {},
        )) {
            if (sessionId && typeof folderId === "string" && folders[folderId]) {
                sessionFolderIds[sessionId] = folderId;
            }
        }
        return {
            folders,
            sessionFolderIds,
            collapsedFolderIds: Array.isArray(parsed.collapsedFolderIds)
                ? parsed.collapsedFolderIds.filter((id): id is string =>
                      typeof id === "string" && Boolean(folders[id]),
                  )
                : [],
        };
    } catch (error) {
        logWarn("chat-folders", "Failed to hydrate chat folders", error, {
            onceKey: "hydrate-chat-folders",
        });
        return EMPTY_STATE;
    }
}

function persistState(state: PersistedChatFolders) {
    safeStorageSetItem(CHAT_FOLDERS_KEY, JSON.stringify(state));
}

function getPersistedState(state: ChatFoldersStore): PersistedChatFolders {
    return {
        folders: state.folders,
        sessionFolderIds: state.sessionFolderIds,
        collapsedFolderIds: state.collapsedFolderIds,
    };
}

export const useChatFoldersStore = create<ChatFoldersStore>((set) => ({
    ...readHydratedState(),
    createFolder: (rawName) => {
        const name = normalizeFolderName(rawName);
        if (!name) return null;
        const id = crypto.randomUUID();
        set((state) => {
            const next = {
                ...getPersistedState(state),
                folders: {
                    ...state.folders,
                    [id]: { id, name, createdAt: Date.now() },
                },
            };
            persistState(next);
            return next;
        });
        return id;
    },
    renameFolder: (folderId, rawName) => {
        const name = normalizeFolderName(rawName);
        if (!name) return;
        set((state) => {
            const folder = state.folders[folderId];
            if (!folder || folder.name === name) return state;
            const next = {
                ...getPersistedState(state),
                folders: {
                    ...state.folders,
                    [folderId]: { ...folder, name },
                },
            };
            persistState(next);
            return next;
        });
    },
    deleteFolder: (folderId) =>
        set((state) => {
            if (!state.folders[folderId]) return state;
            const folders = { ...state.folders };
            delete folders[folderId];
            const sessionFolderIds = Object.fromEntries(
                Object.entries(state.sessionFolderIds).filter(
                    ([, assignedFolderId]) => assignedFolderId !== folderId,
                ),
            );
            const next = {
                folders,
                sessionFolderIds,
                collapsedFolderIds: state.collapsedFolderIds.filter(
                    (id) => id !== folderId,
                ),
            };
            persistState(next);
            return next;
        }),
    moveSession: (sessionId, folderId) =>
        set((state) => {
            if (folderId && !state.folders[folderId]) return state;
            if (state.sessionFolderIds[sessionId] === folderId) return state;
            const sessionFolderIds = { ...state.sessionFolderIds };
            if (folderId) sessionFolderIds[sessionId] = folderId;
            else delete sessionFolderIds[sessionId];
            const next = { ...getPersistedState(state), sessionFolderIds };
            persistState(next);
            return next;
        }),
    replaceSessionId: (fromSessionId, toSessionId) =>
        set((state) => {
            if (!fromSessionId || !toSessionId || fromSessionId === toSessionId) {
                return state;
            }
            const folderId = state.sessionFolderIds[fromSessionId];
            if (!folderId || !state.folders[folderId]) return state;

            const sessionFolderIds = { ...state.sessionFolderIds };
            delete sessionFolderIds[fromSessionId];
            // The destination is the same logical chat after an ACP identity
            // transition, so the source assignment intentionally wins.
            sessionFolderIds[toSessionId] = folderId;
            const next = { ...getPersistedState(state), sessionFolderIds };
            persistState(next);
            return next;
        }),
    toggleFolderCollapsed: (folderId) =>
        set((state) => {
            if (!state.folders[folderId]) return state;
            const collapsed = new Set(state.collapsedFolderIds);
            if (collapsed.has(folderId)) collapsed.delete(folderId);
            else collapsed.add(folderId);
            const next = {
                ...getPersistedState(state),
                collapsedFolderIds: [...collapsed],
            };
            persistState(next);
            return next;
        }),
    reconcile: (existingRootSessionIds) =>
        set((state) => {
            const existing = new Set(existingRootSessionIds);
            const sessionFolderIds = Object.fromEntries(
                Object.entries(state.sessionFolderIds).filter(
                    ([sessionId, folderId]) =>
                        existing.has(sessionId) && Boolean(state.folders[folderId]),
                ),
            );
            if (
                Object.keys(sessionFolderIds).length ===
                Object.keys(state.sessionFolderIds).length
            ) {
                return state;
            }
            const next = { ...getPersistedState(state), sessionFolderIds };
            persistState(next);
            return next;
        }),
}));
