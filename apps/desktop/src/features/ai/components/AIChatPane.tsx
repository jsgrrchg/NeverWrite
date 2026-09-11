import {
    isSessionArchived,
    useArchivedChatsStore,
} from "../store/archivedChatsStore";
import { unarchiveChat } from "../chatArchiving";
import { HistoryTranscriptViewer } from "./HistoryTranscriptViewer";
import { useChatPaneShortcuts } from "../useChatPaneShortcuts";
import { useState } from "react";
import { useLayoutStore } from "../../../app/store/layoutStore";
import {
    ContextMenu,
    type ContextMenuState,
} from "../../../components/context-menu/ContextMenu";
import { createNewChatInWorkspace } from "../chatPaneMovement";
import { useChatTabsStore } from "../store/chatTabsStore";
import { useChatStore } from "../store/chatStore";
import { AIChatSessionView } from "./AIChatSessionView";
import { AIChatHistoryWorkspaceView } from "./AIChatHistoryWorkspaceView";

export function AIChatPane() {
    useChatPaneShortcuts();
    const view = useChatTabsStore((state) => state.view);
    const archiveEntries = useArchivedChatsStore((state) => state.entries);
    const sessions = useChatStore((state) => state.sessionsById);
    const focused = useChatTabsStore(
        (state) => state.focusedSurface === "chat",
    );
    const [menu, setMenu] = useState<ContextMenuState<undefined> | null>(null);
    const nav = useChatTabsStore.getState();
    const layout = useLayoutStore.getState();
    const sessionId =
        view.mode === "conversation"
            ? view.sessionId
            : view.mode === "history"
              ? view.returnSessionId
              : null;
    const session = sessionId ? sessions[sessionId] : null;
    const archived =
        session && isSessionArchived(session, sessions, archiveEntries);
    return (
        <section
            aria-label="Chat pane"
            className="flex h-full min-h-0 flex-col"
            style={{
                background: "var(--bg-secondary)",
                color: "var(--text-primary)",
            }}
            onFocusCapture={() => nav.setFocusedSurface("chat")}
            onPointerDownCapture={() => nav.setFocusedSurface("chat")}
        >
            <header
                className="flex shrink-0 items-center gap-2 border-b px-3 py-2 text-xs"
                style={{ borderColor: "var(--border)" }}
            >
                {view.mode === "history" && (
                    <button
                        type="button"
                        onClick={() =>
                            nav.returnFromHistory(
                                Object.keys(
                                    useChatStore.getState().sessionsById,
                                ),
                            )
                        }
                    >
                        Back
                    </button>
                )}
                <span className="min-w-0 flex-1 truncate">
                    {view.mode === "history" ? "Chat history" : "Chat"}
                </span>
                <button
                    type="button"
                    onClick={() => void createNewChatInWorkspace()}
                >
                    New chat
                </button>
                <button type="button" onClick={() => nav.showHistory()}>
                    History
                </button>
                <button
                    type="button"
                    aria-label="Chat pane position"
                    onClick={(event) => {
                        const rect =
                            event.currentTarget.getBoundingClientRect();
                        setMenu({
                            x: rect.left,
                            y: rect.bottom,
                            payload: undefined,
                        });
                    }}
                >
                    ⋯
                </button>
                <button
                    type="button"
                    aria-label="Hide chat pane"
                    onClick={() => {
                        layout.setChatPaneVisible(false);
                        nav.setFocusedSurface("editor");
                    }}
                >
                    ×
                </button>
            </header>
            <div
                className="min-h-0 flex-1"
                style={{
                    display: view.mode === "history" ? "none" : undefined,
                }}
            >
                {archived ? (
                    <div className="flex h-full min-h-0 flex-col">
                        <div className="flex shrink-0 items-center justify-between p-2 text-xs">
                            <span>Archived</span>
                            <button
                                type="button"
                                onClick={() => {
                                    if (!unarchiveChat(session.sessionId)) return;
                                    void useChatStore
                                        .getState()
                                        .loadSession(session.sessionId);
                                }}
                            >
                                Unarchive and continue
                            </button>
                        </div>
                        <div className="min-h-0 flex-1">
                            <HistoryTranscriptViewer
                                historySessionId={
                                    session.historySessionId ??
                                    session.sessionId
                                }
                            />
                        </div>
                    </div>
                ) : sessionId ? (
                    <AIChatSessionView
                        sessionId={sessionId}
                        focused={focused && view.mode === "conversation"}
                    />
                ) : (
                    <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-sm">
                        <p>Select a conversation or start a new chat.</p>
                        <button
                            type="button"
                            onClick={() => void createNewChatInWorkspace()}
                        >
                            New chat
                        </button>
                    </div>
                )}
            </div>
            {view.mode === "history" && (
                <div className="min-h-0 flex-1">
                    <AIChatHistoryWorkspaceView />
                </div>
            )}
            {menu && (
                <ContextMenu
                    menu={menu}
                    onClose={() => setMenu(null)}
                    entries={[
                        {
                            label: "Move to the left",
                            action: () => layout.setChatPanePlacement("left"),
                        },
                        {
                            label: "Move to the right",
                            action: () => layout.setChatPanePlacement("right"),
                        },
                        {
                            label: "Follow Agents sidebar",
                            action: () =>
                                layout.setChatPanePlacement("follow-agents"),
                        },
                    ]}
                />
            )}
        </section>
    );
}
