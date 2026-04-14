import { useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { openSettingsWindow } from "../../app/detachedWindows";
import {
    isChatTab,
    selectFocusedEditorTab,
    useEditorStore,
} from "../../app/store/editorStore";
import { useLayoutStore } from "../../app/store/layoutStore";
import { useVaultStore } from "../../app/store/vaultStore";
import {
    createNewChatInWorkspace,
    openChatSessionInWorkspace,
} from "./chatPaneMovement";
import { ChatHistoryView } from "./components/ChatHistoryView";
import { AIChatSessionList } from "./components/AIChatSessionList";
import { useChatStore } from "./store/chatStore";
import { getRuntimeDisplayName } from "./utils/runtimeMetadata";

export function AIChatPanel() {
    const [newMenuOpen, setNewMenuOpen] = useState(false);
    const vaultPath = useVaultStore((state) => state.vaultPath);
    const panelExpanded = useLayoutStore((state) => state.rightPanelExpanded);
    const toggleRightPanelExpanded = useLayoutStore(
        (state) => state.toggleRightPanelExpanded,
    );
    const historyViewOpen = useChatStore((state) => state.historyViewOpen);
    const activeSessionId = useChatStore((state) => state.activeSessionId);
    const sessionsById = useChatStore((state) => state.sessionsById);
    const sessionOrder = useChatStore((state) => state.sessionOrder);
    const runtimes = useChatStore((state) => state.runtimes);
    const selectedRuntimeId = useChatStore((state) => state.selectedRuntimeId);
    const chatActions = useRef(useChatStore.getState()).current;

    const focusedWorkspaceChatSessionId = useEditorStore(
        useShallow((state) => {
            const focusedTab = selectFocusedEditorTab(state);
            return focusedTab && isChatTab(focusedTab)
                ? focusedTab.sessionId
                : null;
        }),
    );

    const sessions = useMemo(
        () =>
            sessionOrder
                .map((sessionId) => sessionsById[sessionId])
                .filter((session): session is NonNullable<typeof session> =>
                    Boolean(session),
                ),
        [sessionOrder, sessionsById],
    );

    const orderedRuntimes = useMemo(() => {
        const nextRuntimes = [...runtimes];
        nextRuntimes.sort((left, right) => {
            if (left.runtime.id === selectedRuntimeId) return -1;
            if (right.runtime.id === selectedRuntimeId) return 1;
            return left.runtime.name.localeCompare(right.runtime.name);
        });
        return nextRuntimes;
    }, [runtimes, selectedRuntimeId]);

    if (historyViewOpen) {
        return <ChatHistoryView />;
    }

    return (
        <div
            className="flex h-full min-h-0 flex-col"
            style={{ backgroundColor: "var(--bg-secondary)" }}
        >
            <div
                className="flex items-center justify-between gap-2 px-3 py-2"
                style={{
                    borderBottom: "1px solid var(--border)",
                    minHeight: 40,
                }}
            >
                <div
                    className="text-[11px] uppercase tracking-[0.16em]"
                    style={{ color: "var(--accent)" }}
                >
                    Chats
                </div>

                <div className="flex shrink-0 items-center gap-1">
                    <div className="relative">
                        <button
                            type="button"
                            onClick={() => setNewMenuOpen((open) => !open)}
                            className="rounded px-2 py-1 text-[11px]"
                            style={{
                                color: "var(--text-secondary)",
                                border: "1px solid var(--border)",
                                background: "transparent",
                            }}
                            title="New chat"
                        >
                            New
                        </button>

                        {newMenuOpen ? (
                            <div
                                className="absolute right-0 top-full z-20 mt-2 min-w-52 rounded-xl p-1"
                                style={{
                                    backgroundColor: "var(--bg-secondary)",
                                    border: "1px solid var(--border)",
                                    boxShadow: "0 18px 40px rgb(0 0 0 / 0.28)",
                                }}
                            >
                                {orderedRuntimes.length > 0 ? (
                                    orderedRuntimes.map((runtime) => (
                                        <button
                                            key={runtime.runtime.id}
                                            type="button"
                                            onClick={() => {
                                                setNewMenuOpen(false);
                                                void createNewChatInWorkspace(
                                                    runtime.runtime.id,
                                                );
                                            }}
                                            className="flex w-full items-center rounded px-2.5 py-1.5 text-left text-xs"
                                            style={{
                                                color: "var(--text-primary)",
                                                background: "transparent",
                                            }}
                                        >
                                            {getRuntimeDisplayName(
                                                runtime.runtime.id,
                                                runtime.runtime.name,
                                            )}
                                        </button>
                                    ))
                                ) : (
                                    <div
                                        className="px-2.5 py-2 text-xs"
                                        style={{
                                            color: "var(--text-secondary)",
                                        }}
                                    >
                                        No providers available yet.
                                    </div>
                                )}
                                <div
                                    style={{
                                        height: 1,
                                        backgroundColor: "var(--border)",
                                        margin: "4px 0",
                                    }}
                                />
                                <button
                                    type="button"
                                    onClick={() => {
                                        setNewMenuOpen(false);
                                        void openSettingsWindow(vaultPath);
                                    }}
                                    className="flex w-full items-center rounded px-2.5 py-1.5 text-left text-xs"
                                    style={{
                                        color: "var(--text-secondary)",
                                        background: "transparent",
                                    }}
                                >
                                    Add providers
                                </button>
                            </div>
                        ) : null}
                    </div>
                    <button
                        type="button"
                        onClick={() => chatActions.openHistoryView()}
                        className="rounded px-2 py-1 text-[11px]"
                        style={{
                            color: "var(--text-secondary)",
                            border: "1px solid var(--border)",
                            background: "transparent",
                        }}
                        title="Open chat history"
                    >
                        History
                    </button>
                    <button
                        type="button"
                        onClick={toggleRightPanelExpanded}
                        className="inline-flex h-7 w-7 items-center justify-center rounded"
                        style={{
                            color: panelExpanded
                                ? "var(--accent)"
                                : "var(--text-secondary)",
                            backgroundColor: panelExpanded
                                ? "color-mix(in srgb, var(--accent) 12%, transparent)"
                                : "transparent",
                        }}
                        title={
                            panelExpanded
                                ? "Restore chat sidebar"
                                : "Expand chat sidebar"
                        }
                    >
                        <svg
                            width="14"
                            height="14"
                            viewBox="0 0 14 14"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        >
                            {panelExpanded ? (
                                <>
                                    <path d="M5 2.5H2.5V5" />
                                    <path d="M9 2.5h2.5V5" />
                                    <path d="M5 11.5H2.5V9" />
                                    <path d="M9 11.5h2.5V9" />
                                </>
                            ) : (
                                <>
                                    <path d="M5 5 2.5 2.5" />
                                    <path d="M9 5 11.5 2.5" />
                                    <path d="M5 9 2.5 11.5" />
                                    <path d="M9 9 11.5 11.5" />
                                </>
                            )}
                        </svg>
                    </button>
                </div>
            </div>

            <AIChatSessionList
                activeSessionId={
                    focusedWorkspaceChatSessionId ?? activeSessionId
                }
                sessions={sessions}
                runtimes={orderedRuntimes.map(
                    (descriptor) => descriptor.runtime,
                )}
                onSelectSession={(sessionId) => {
                    void openChatSessionInWorkspace(sessionId);
                }}
                onDeleteSession={(sessionId) => {
                    void chatActions.deleteSession(sessionId);
                }}
                onRenameSession={(sessionId, newTitle) => {
                    chatActions.renameSession(sessionId, newTitle);
                }}
            />
        </div>
    );
}
