import { create } from "zustand";
import { useLayoutStore } from "../../app/store/layoutStore";
import { useChatTabsStore } from "./store/chatTabsStore";
import { useVaultStore } from "../../app/store/vaultStore";
import { useChatStore } from "./store/chatStore";
import { usePinnedChatsStore } from "./store/pinnedChatsStore";
import {
    getArchiveIdentity,
    getArchiveRoot,
    isSessionArchived,
    useArchivedChatsStore,
} from "./store/archivedChatsStore";
import { openChatSessionInWorkspace } from "./chatPaneMovement";

export const useArchiveNoticeStore = create<{
    notice: { id: string; undo: () => void; open: () => void } | null;
}>(() => ({ notice: null }));

export function unarchiveChat(sessionId: string) {
    const sessions = useChatStore.getState().sessionsById;
    const session = sessions[sessionId];
    if (!session) return false;
    const root = getArchiveRoot(session, sessions);
    const archive = useArchivedChatsStore.getState();
    archive.unarchive(getArchiveIdentity(root));
    if (root.sessionId !== getArchiveIdentity(root))
        archive.unarchive(root.sessionId);
    return !isSessionArchived(root, sessions, useArchivedChatsStore.getState().entries);
}

export function archiveChat(sessionId: string) {
    const sessions = useChatStore.getState().sessionsById;
    const session = sessions[sessionId];
    if (!session) return;
    const root = getArchiveRoot(session, sessions);
    const vaultPath = useVaultStore.getState().vaultPath;
    const archive = useArchivedChatsStore.getState();
    archive.archive(getArchiveIdentity(root));
    if (
        !isSessionArchived(
            root,
            sessions,
            useArchivedChatsStore.getState().entries,
        )
    )
        return;
    usePinnedChatsStore.getState().unpin(root.sessionId);
    const nav = useChatTabsStore.getState();
    const selected =
        nav.view.mode === "conversation" ? sessions[nav.view.sessionId] : null;
    const wasSelected =
        selected &&
        getArchiveRoot(selected, sessions).sessionId === root.sessionId;
    if (wasSelected) {
        nav.showEmpty();
        nav.setFocusedSurface("editor");
        useLayoutStore.getState().setChatPaneVisible(false);
    }
    const archivedEntry =
        useArchivedChatsStore.getState().entries[getArchiveIdentity(root)];
    // Rebinding pending IDs preserves the entry object, so Undo follows the
    // conversation even if the runtime assigns its durable ID after archiving.
    const resolveCurrentRoot = () => {
        const current = useChatStore.getState().sessionsById;
        if (current[root.sessionId]) return root.sessionId;
        const identity = Object.entries(
            useArchivedChatsStore.getState().entries,
        ).find(([, entry]) => entry === archivedEntry)?.[0];
        return Object.values(current).find(
            (candidate) =>
                getArchiveIdentity(candidate) ===
                (identity ?? getArchiveIdentity(root)),
        )?.sessionId;
    };
    const selectionAfterArchive =
        useChatTabsStore.getState().navigationRevision;
    const id = crypto.randomUUID();
    const inVault = () => useVaultStore.getState().vaultPath === vaultPath;
    useArchiveNoticeStore.setState({
        notice: {
            id,
            open: () => {
                const currentId = inVault() ? resolveCurrentRoot() : null;
                if (currentId) openChatSessionInWorkspace(currentId);
            },
            undo: () => {
                if (!inVault()) return;
                const currentId = resolveCurrentRoot();
                if (!currentId) return;
                unarchiveChat(currentId);
                if (
                    wasSelected &&
                    useChatTabsStore.getState().navigationRevision ===
                        selectionAfterArchive
                )
                    openChatSessionInWorkspace(currentId);
                useArchiveNoticeStore.setState({ notice: null });
            },
        },
    });
    setTimeout(() => {
        if (useArchiveNoticeStore.getState().notice?.id === id)
            useArchiveNoticeStore.setState({ notice: null });
    }, 8000);
}
