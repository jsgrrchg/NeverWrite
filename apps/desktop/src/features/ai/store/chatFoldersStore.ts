import { create } from "zustand";
import {
    safeStorageGetItem,
    safeStorageSetItem,
} from "../../../app/utils/safeStorage";
import { logWarn } from "../../../app/utils/runtimeLog";

// Folder membership is a local sidebar preference, like pinned chats. Keeping
// it separate from AIChatSession means adding folders never rewrites provider
// history or changes what existing users see.
const LEGACY_CHAT_FOLDERS_KEY = "neverwrite.chats.folders";
const CHAT_FOLDERS_MIGRATION_KEY = "neverwrite.chats.folders.vault-migrated";

function getChatFoldersKey(vaultPath: string) {
    return `${LEGACY_CHAT_FOLDERS_KEY}:${encodeURIComponent(vaultPath)}`;
}

export interface ChatFolder {
    id: string;
    name: string;
    createdAt: number;
}

interface PersistedChatFolders {
    folders: Record<string, ChatFolder>;
    folderOrder: string[];
    sessionFolderIds: Record<string, string>;
    collapsedFolderIds: string[];
}

interface ChatFoldersStore extends PersistedChatFolders {
    vaultPath: string | null;
    setVaultPath: (vaultPath: string | null) => void;
    createFolder: (name: string) => string | null;
    renameFolder: (folderId: string, name: string) => void;
    deleteFolder: (folderId: string) => void;
    reorderFolder: (folderId: string, destinationIndex: number) => void;
    moveSession: (sessionId: string, folderId: string | null) => void;
    replaceSessionId: (fromSessionId: string, toSessionId: string) => void;
    toggleFolderCollapsed: (folderId: string) => void;
    reconcile: (existingRootSessionIds: Iterable<string>) => void;
}

const EMPTY_STATE: PersistedChatFolders = {
    folders: {},
    folderOrder: [],
    sessionFolderIds: {},
    collapsedFolderIds: [],
};

function normalizeFolderName(name: string) {
    return name.trim().replace(/\s+/g, " ").slice(0, 80);
}

function getOrderedFolderIds(
    folders: Record<string, ChatFolder>,
    requestedOrder: readonly string[],
) {
    const legacyOrder = Object.values(folders)
        .sort((left, right) => left.createdAt - right.createdAt)
        .map((folder) => folder.id);
    const knownRequestedIds = requestedOrder.filter((id) => Boolean(folders[id]));
    return [
        ...new Set(knownRequestedIds),
        ...legacyOrder.filter((id) => !knownRequestedIds.includes(id)),
    ];
}

function parsePersistedState(raw: string | null): PersistedChatFolders {
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
        // Older persisted state did not have an explicit order. Preserve the
        // historical created-at ordering when it is first read.
        const requestedOrder = Array.isArray(parsed.folderOrder)
            ? parsed.folderOrder.filter(
                  (id): id is string => typeof id === "string" && Boolean(folders[id]),
              )
            : [];
        const folderOrder = getOrderedFolderIds(folders, requestedOrder);
        return {
            folders,
            folderOrder,
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

function readHydratedState(vaultPath: string | null): PersistedChatFolders {
    if (!vaultPath) return EMPTY_STATE;
    const key = getChatFoldersKey(vaultPath);
    let raw = safeStorageGetItem(key);

    // Existing installations had one global folder catalog. Let the first
    // opened vault claim it once, then keep all subsequent state vault-scoped.
    if (!raw && !safeStorageGetItem(CHAT_FOLDERS_MIGRATION_KEY)) {
        raw = safeStorageGetItem(LEGACY_CHAT_FOLDERS_KEY);
        if (raw) safeStorageSetItem(key, raw);
        safeStorageSetItem(CHAT_FOLDERS_MIGRATION_KEY, "1");
    }
    return parsePersistedState(raw);
}

function persistState(vaultPath: string | null, state: PersistedChatFolders) {
    if (!vaultPath) return;
    safeStorageSetItem(getChatFoldersKey(vaultPath), JSON.stringify(state));
}

function getPersistedState(state: ChatFoldersStore): PersistedChatFolders {
    return {
        folders: state.folders,
        folderOrder: state.folderOrder,
        sessionFolderIds: state.sessionFolderIds,
        collapsedFolderIds: state.collapsedFolderIds,
    };
}

export const useChatFoldersStore = create<ChatFoldersStore>((set) => ({
    ...EMPTY_STATE,
    vaultPath: null,
    setVaultPath: (vaultPath) =>
        set((state) => {
            if (state.vaultPath === vaultPath) return state;
            return { vaultPath, ...readHydratedState(vaultPath) };
        }),
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
                folderOrder: [
                    ...getOrderedFolderIds(state.folders, state.folderOrder),
                    id,
                ],
            };
            persistState(state.vaultPath, next);
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
            persistState(state.vaultPath, next);
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
                folderOrder: getOrderedFolderIds(
                    folders,
                    state.folderOrder.filter((id) => id !== folderId),
                ),
                sessionFolderIds,
                collapsedFolderIds: state.collapsedFolderIds.filter(
                    (id) => id !== folderId,
                ),
            };
            persistState(state.vaultPath, next);
            return next;
        }),
    reorderFolder: (folderId, destinationIndex) =>
        set((state) => {
            if (!state.folders[folderId]) return state;
            const currentOrder = getOrderedFolderIds(
                state.folders,
                state.folderOrder,
            ).filter((id) => id !== folderId);
            const nextIndex = Math.max(
                0,
                Math.min(destinationIndex, currentOrder.length),
            );
            const folderOrder = [...currentOrder];
            folderOrder.splice(nextIndex, 0, folderId);
            if (
                folderOrder.length === state.folderOrder.length &&
                folderOrder.every((id, index) => id === state.folderOrder[index])
            ) {
                return state;
            }
            const next = { ...getPersistedState(state), folderOrder };
            persistState(state.vaultPath, next);
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
            persistState(state.vaultPath, next);
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
            persistState(state.vaultPath, next);
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
            persistState(state.vaultPath, next);
            return next;
        }),
    reconcile: (existingRootSessionIds) =>
        set((state) => {
            const existing = new Set(existingRootSessionIds);
            const sessionFolderIds: Record<string, string> = {};
            for (const [sessionId, folderId] of Object.entries(
                state.sessionFolderIds,
            )) {
                if (!state.folders[folderId]) continue;
                if (existing.has(sessionId)) {
                    sessionFolderIds[sessionId] = folderId;
                    continue;
                }

                // A history-only chat is represented as `persisted:<history id>`
                // after a cold start. Preserve its folder while the runtime id
                // is absent; replaceSessionId will migrate it again on resume.
                const persistedSessionId = `persisted:${sessionId}`;
                if (existing.has(persistedSessionId)) {
                    sessionFolderIds[persistedSessionId] = folderId;
                }
            }
            if (
                Object.keys(sessionFolderIds).length ===
                    Object.keys(state.sessionFolderIds).length &&
                Object.entries(sessionFolderIds).every(
                    ([sessionId, folderId]) =>
                        state.sessionFolderIds[sessionId] === folderId,
                )
            ) {
                return state;
            }
            const next = { ...getPersistedState(state), sessionFolderIds };
            persistState(state.vaultPath, next);
            return next;
        }),
}));
