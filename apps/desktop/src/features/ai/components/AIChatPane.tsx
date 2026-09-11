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
import { getSessionTitle } from "../sessionPresentation";

export function AIChatPane() {
    useChatPaneShortcuts();
    const view = useChatTabsStore((state) => state.view);
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
    const showStandaloneHeader = view.mode !== "conversation";
    const paneActions = (
        <>
            <button
                type="button"
                className="shrink-0 whitespace-nowrap"
                aria-label="Chat pane position"
                onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
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
                className="inline-flex shrink-0 items-center justify-center rounded-md opacity-70 transition-[background-color,opacity,transform] duration-150 ease-out hover:bg-gray-500/30 hover:opacity-100 active:bg-gray-500/55 active:scale-90"
                style={{ width: 20, height: 20, color: "var(--text-secondary)" }}
                aria-label="Hide chat pane"
                onClick={() => {
                    layout.setChatPaneVisible(false);
                    nav.setFocusedSurface("editor");
                }}
            >
                <svg
                    width={13}
                    height={13}
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.1"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                >
                    <path d="M4 4l8 8M4 12l8-8" />
                </svg>
            </button>
        </>
    );
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
            {showStandaloneHeader && (
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
                        {view.mode === "history"
                            ? "Chat history"
                            : session
                              ? getSessionTitle(session)
                              : "Chat"}
                    </span>
                    {paneActions}
                </header>
            )}
            <div
                className="min-h-0 flex-1"
                style={{
                    display: view.mode === "history" ? "none" : undefined,
                }}
            >
                {sessionId ? (
                    <AIChatSessionView
                        sessionId={sessionId}
                        focused={focused && view.mode === "conversation"}
                        headerActions={paneActions}
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
