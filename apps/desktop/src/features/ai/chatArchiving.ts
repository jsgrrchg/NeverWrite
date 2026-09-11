import { create } from "zustand";
import { useLayoutStore } from "../../app/store/layoutStore";
import { useChatTabsStore } from "./store/chatTabsStore";
import { useVaultStore } from "../../app/store/vaultStore";
import { useChatStore } from "./store/chatStore";
import { usePinnedChatsStore } from "./store/pinnedChatsStore";
import { getArchiveIdentity, getArchiveRoot, isSessionArchived, useArchivedChatsStore } from "./store/archivedChatsStore";
import { openChatSessionInWorkspace } from "./chatPaneMovement";

export const useArchiveNoticeStore = create<{ notice: { id: string; undo: () => void; open: () => void } | null }>(() => ({ notice: null }));

export function unarchiveChat(sessionId: string) {
    const sessions = useChatStore.getState().sessionsById;
    const session = sessions[sessionId];
    if (!session) return;
    const root = getArchiveRoot(session, sessions);
    const archive = useArchivedChatsStore.getState();
    archive.unarchive(getArchiveIdentity(root));
    if (root.sessionId !== getArchiveIdentity(root)) archive.unarchive(root.sessionId);
}

export function archiveChat(sessionId: string) {
    const sessions = useChatStore.getState().sessionsById;
    const session = sessions[sessionId];
    if (!session) return;
    const root = getArchiveRoot(session, sessions);
    const vaultPath = useVaultStore.getState().vaultPath;
    const archive = useArchivedChatsStore.getState();
    archive.archive(getArchiveIdentity(root));
    if (!isSessionArchived(root, sessions, useArchivedChatsStore.getState().entries)) return;
    usePinnedChatsStore.getState().unpin(root.sessionId);
    const nav = useChatTabsStore.getState();
    const selected = nav.view.mode === "conversation" ? sessions[nav.view.sessionId] : null;
    const wasSelected = selected && getArchiveRoot(selected, sessions).sessionId === root.sessionId;
    if (wasSelected) {
        nav.showEmpty();
        useLayoutStore.getState().setChatPaneVisible(false);
    }
    const selectionAfterArchive = useChatTabsStore.getState().navigationRevision;
    const id = crypto.randomUUID();
    const inVault = () => useVaultStore.getState().vaultPath === vaultPath;
    useArchiveNoticeStore.setState({ notice: {
        id,
        open: () => { if (inVault()) openChatSessionInWorkspace(root.sessionId); },
        undo: () => {
            if (!inVault()) return;
            unarchiveChat(root.sessionId);
            if (wasSelected && useChatTabsStore.getState().navigationRevision === selectionAfterArchive) openChatSessionInWorkspace(root.sessionId);
            useArchiveNoticeStore.setState({ notice: null });
        },
    } });
    setTimeout(() => { if (useArchiveNoticeStore.getState().notice?.id === id) useArchiveNoticeStore.setState({ notice: null }); }, 8000);
}
