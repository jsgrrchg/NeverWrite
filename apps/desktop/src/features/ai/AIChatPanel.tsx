import { useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { openSettingsWindow } from "../../app/detachedWindows";
import {
    isChatTab,
    selectFocusedEditorTab,
    selectEditorWorkspaceTabs,
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
import { getSessionTitle } from "./sessionPresentation";
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

    const { focusedWorkspaceChatSessionId, visibleWorkspaceChatCount } =
        useEditorStore(
            useShallow((state) => {
                const focusedTab = selectFocusedEditorTab(state);
                const visibleWorkspaceChatCount = selectEditorWorkspaceTabs(
                    state,
                ).filter((tab) => isChatTab(tab)).length;
                return {
                    focusedWorkspaceChatSessionId:
                        focusedTab && isChatTab(focusedTab)
                            ? focusedTab.sessionId
                            : null,
                    visibleWorkspaceChatCount,
                };
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

    const focusedWorkspaceSession =
        (focusedWorkspaceChatSessionId
            ? (sessionsById[focusedWorkspaceChatSessionId] ?? null)
            : null) ?? null;
    const launcherSession =
        focusedWorkspaceSession ??
        (activeSessionId ? (sessionsById[activeSessionId] ?? null) : null);

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
                <div className="min-w-0">
                    <div
                        className="text-[11px] uppercase tracking-[0.16em]"
                        style={{ color: "var(--accent)" }}
                    >
                        Workspace Agents
                    </div>
                    <div
                        className="truncate text-xs font-medium"
                        style={{ color: "var(--text-primary)" }}
                    >
                        Launch and inspect chats without taking ownership away
                        from the workspace.
                    </div>
                </div>

                <div className="flex shrink-0 items-center gap-1">
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

            <div
                className="overflow-y-auto px-3 py-3"
                data-scrollbar-active="true"
            >
                <section
                    className="rounded-xl p-3"
                    style={{
                        border: "1px solid var(--border)",
                        background:
                            "color-mix(in srgb, var(--bg-primary) 72%, transparent)",
                    }}
                >
                    <div
                        className="text-[11px] uppercase tracking-[0.16em]"
                        style={{ color: "var(--text-secondary)" }}
                    >
                        {focusedWorkspaceSession
                            ? "Focused Workspace Chat"
                            : "Workspace Chat Surface"}
                    </div>
                    <div
                        className="mt-2 text-sm font-semibold"
                        style={{ color: "var(--text-primary)" }}
                    >
                        {launcherSession
                            ? getSessionTitle(launcherSession)
                            : "No chat tab open"}
                    </div>
                    <div
                        className="mt-1 text-xs"
                        style={{ color: "var(--text-secondary)" }}
                    >
                        {launcherSession
                            ? `${visibleWorkspaceChatCount} open workspace ${
                                  visibleWorkspaceChatCount === 1
                                      ? "chat"
                                      : "chats"
                              }`
                            : "Chats now live in workspace tabs. Use this sidebar to launch, inspect and revisit sessions."}
                    </div>

                    <div className="mt-3 flex flex-wrap gap-2">
                        {launcherSession ? (
                            <button
                                type="button"
                                onClick={() =>
                                    openChatSessionInWorkspace(
                                        launcherSession.sessionId,
                                    )
                                }
                                className="rounded px-2.5 py-1.5 text-xs font-medium"
                                style={{
                                    background:
                                        "color-mix(in srgb, var(--accent) 16%, transparent)",
                                    color: "var(--accent)",
                                    border: "1px solid color-mix(in srgb, var(--accent) 28%, transparent)",
                                }}
                            >
                                Open in Focused Pane
                            </button>
                        ) : null}

                        <div className="relative">
                            <button
                                type="button"
                                onClick={() => setNewMenuOpen((open) => !open)}
                                className="rounded px-2.5 py-1.5 text-xs font-medium"
                                style={{
                                    color: "var(--text-primary)",
                                    border: "1px solid var(--border)",
                                    background: "transparent",
                                }}
                            >
                                New Chat
                            </button>

                            {newMenuOpen ? (
                                <div
                                    className="absolute left-0 top-full z-20 mt-2 min-w-52 rounded-xl p-1"
                                    style={{
                                        backgroundColor: "var(--bg-secondary)",
                                        border: "1px solid var(--border)",
                                        boxShadow:
                                            "0 18px 40px rgb(0 0 0 / 0.28)",
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
                    </div>
                </section>

                <section className="mt-4">
                    <div className="mb-2 flex items-center justify-between gap-2">
                        <div>
                            <div
                                className="text-[11px] uppercase tracking-[0.16em]"
                                style={{ color: "var(--text-secondary)" }}
                            >
                                Recent Sessions
                            </div>
                            <div
                                className="text-xs"
                                style={{ color: "var(--text-secondary)" }}
                            >
                                Selecting a session opens it as a workspace tab
                                in the focused pane.
                            </div>
                        </div>
                    </div>

                    <div
                        className="overflow-hidden rounded-xl"
                        style={{
                            border: "1px solid var(--border)",
                            background:
                                "color-mix(in srgb, var(--bg-primary) 68%, transparent)",
                        }}
                    >
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
                </section>
            </div>
        </div>
    );
}
