import { create } from "zustand";
import { useEditorStore, selectFocusedEditorTab, isChatTab } from "../../app/store/editorStore";
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
    const focused = selectFocusedEditorTab(useEditorStore.getState());
    const wasSelected = focused && isChatTab(focused) && sessions[focused.sessionId] && getArchiveRoot(sessions[focused.sessionId], sessions).sessionId === root.sessionId;
    for (const candidate of Object.values(sessions)) {
        if (getArchiveRoot(candidate, sessions).sessionId === root.sessionId) useEditorStore.getState().closeChat(candidate.sessionId);
    }
    const selectionAfterArchive = selectFocusedEditorTab(useEditorStore.getState());
    const id = crypto.randomUUID();
    const inVault = () => useVaultStore.getState().vaultPath === vaultPath;
    useArchiveNoticeStore.setState({ notice: {
        id,
        open: () => { if (inVault()) openChatSessionInWorkspace(root.sessionId); },
        undo: () => {
            if (!inVault()) return;
            unarchiveChat(root.sessionId);
            if (wasSelected && selectFocusedEditorTab(useEditorStore.getState()) === selectionAfterArchive) openChatSessionInWorkspace(root.sessionId);
            useArchiveNoticeStore.setState({ notice: null });
        },
    } });
    setTimeout(() => { if (useArchiveNoticeStore.getState().notice?.id === id) useArchiveNoticeStore.setState({ notice: null }); }, 8000);
}
