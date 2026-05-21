import { useEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import {
    isChatTab,
    selectFocusedEditorTab,
    selectEditorWorkspaceTabs,
    useEditorStore,
} from "../../app/store/editorStore";
import { useVaultStore } from "../../app/store/vaultStore";
import {
    FILE_TREE_ATTACH_TO_NEW_CHAT_EVENT,
    FILE_TREE_NOTE_DRAG_EVENT,
    emitFileTreeNoteDrag,
    type FileTreeNoteDragDetail,
} from "./dragEvents";
import type { AIChatSession } from "./types";
import {
    createNewChatInWorkspace,
    ensureWorkspaceChatSession,
    openChatSessionInWorkspace,
} from "./chatPaneMovement";
import { useChatStore } from "./store/chatStore";
import { useAiChatEventBridge } from "./useAiChatEventBridge";
import { CLAUDE_TERMINAL_RUNTIME_ID } from "./utils/runtimeMetadata";
import { openClaudeCodeTerminalWithContext } from "../terminal/claudeCodeTerminal";

function hasVisibleAiComposerDropZone(targetSessionId?: string) {
    const selector = targetSessionId
        ? `[data-ai-composer-drop-zone="true"][data-ai-composer-session-id="${CSS.escape(targetSessionId)}"]`
        : '[data-ai-composer-drop-zone="true"]';
    return document.querySelector(selector) !== null;
}

function getActiveEditorChatSessionId() {
    const activeTab = selectFocusedEditorTab(useEditorStore.getState());
    return activeTab && isChatTab(activeTab) ? activeTab.sessionId : null;
}

function needsLiveSessionResumeContextHydration(session: AIChatSession) {
    if (
        session.runtimeState !== "live" ||
        session.resumeContextPending !== true
    ) {
        return false;
    }

    const persistedCount = session.persistedMessageCount ?? 0;
    return (
        persistedCount > 0 &&
        (session.loadedPersistedMessageStart !== 0 ||
            (session.messages?.length ?? 0) < persistedCount)
    );
}

const attachReplayKeyByDetail = new WeakMap<FileTreeNoteDragDetail, string>();
let nextAttachReplayKey = 1;

function getAttachReplayKey(detail: FileTreeNoteDragDetail) {
    const existingKey = attachReplayKeyByDetail.get(detail);
    if (existingKey) return existingKey;

    const key = `attach-replay-${nextAttachReplayKey}`;
    nextAttachReplayKey += 1;
    attachReplayKeyByDetail.set(detail, key);
    return key;
}

function replayAttachAfterComposerMount(
    detail: FileTreeNoteDragDetail,
    targetSessionId: string,
) {
    const replayKey = getAttachReplayKey(detail);
    // Let the newly opened chat tab mount its composer before we replay the
    // attach event into the real in-workspace target.
    window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
            const replayDetail = { ...detail, targetSessionId };
            attachReplayKeyByDetail.set(replayDetail, replayKey);
            emitFileTreeNoteDrag(replayDetail);
        });
    });
}

function focusComposerAtEnd(sessionId: string) {
    window.requestAnimationFrame(() => {
        window.setTimeout(() => {
            const composer = document.querySelector<HTMLElement>(
                `[data-ai-composer-drop-zone="true"][data-ai-composer-session-id="${CSS.escape(sessionId)}"] [role="textbox"][contenteditable="true"]`,
            );
            if (!composer) return;

            composer.focus();
            const selection = window.getSelection();
            if (!selection) return;

            const range = document.createRange();
            range.selectNodeContents(composer);
            range.collapse(false);
            selection.removeAllRanges();
            selection.addRange(range);
        }, 0);
    });
}

interface AIChatWorkspaceHostProps {
    startupReady?: boolean;
    listenWithoutChatTabs?: boolean;
    initializeWithoutChatTabs?: boolean;
}

export function AIChatWorkspaceHost({
    startupReady = true,
    listenWithoutChatTabs = false,
    initializeWithoutChatTabs = false,
}: AIChatWorkspaceHostProps) {
    const vaultPath = useVaultStore((state) => state.vaultPath);
    const { hasChatTabs, activeChatSessionId } = useEditorStore(
        useShallow((state) => {
            const tabs = selectEditorWorkspaceTabs(state);
            const activeTab = selectFocusedEditorTab(state);
            return {
                hasChatTabs: tabs.some((tab) => isChatTab(tab)),
                activeChatSessionId:
                    activeTab && isChatTab(activeTab)
                        ? activeTab.sessionId
                        : null,
            };
        }),
    );
    const activeChatSession = useChatStore((state) =>
        activeChatSessionId
            ? (state.sessionsById[activeChatSessionId] ?? null)
            : null,
    );
    const isInitializing = useChatStore((state) => state.isInitializing);
    const chatActions = useRef(useChatStore.getState()).current;
    const initializationPromiseRef = useRef<Promise<unknown> | null>(null);
    const recoveringSessionIdRef = useRef<string | null>(null);
    const attachReplayCountsRef = useRef(new Map<string, number>());

    useAiChatEventBridge(
        Boolean(vaultPath) &&
            startupReady &&
            (hasChatTabs || listenWithoutChatTabs),
    );

    useEffect(() => {
        if (
            !startupReady ||
            !vaultPath ||
            (!hasChatTabs && !initializeWithoutChatTabs)
        ) {
            return;
        }

        const initialization = chatActions.initialize({
            createDefaultSession: false,
        });
        initializationPromiseRef.current = initialization;
        void initialization.finally(() => {
            if (initializationPromiseRef.current === initialization) {
                initializationPromiseRef.current = null;
            }
        });
    }, [
        chatActions,
        hasChatTabs,
        initializeWithoutChatTabs,
        startupReady,
        vaultPath,
    ]);

    useEffect(() => {
        if (!activeChatSessionId) {
            return;
        }

        chatActions.markSessionFocused(activeChatSessionId);
    }, [activeChatSessionId, chatActions]);

    useEffect(() => {
        if (
            recoveringSessionIdRef.current &&
            recoveringSessionIdRef.current !== activeChatSessionId
        ) {
            recoveringSessionIdRef.current = null;
        }
    }, [activeChatSessionId]);

    useEffect(() => {
        if (
            !vaultPath ||
            !hasChatTabs ||
            !startupReady ||
            !activeChatSessionId ||
            isInitializing
        ) {
            return;
        }
        if (activeChatSession?.isResumingSession) {
            return;
        }
        if (activeChatSession?.resumeReconnectFailed) {
            return;
        }
        const shouldHydrateLiveResumeContext = activeChatSession
            ? needsLiveSessionResumeContextHydration(activeChatSession)
            : false;
        if (
            activeChatSession?.runtimeState === "live" &&
            !shouldHydrateLiveResumeContext
        ) {
            return;
        }
        if (recoveringSessionIdRef.current === activeChatSessionId) {
            return;
        }

        recoveringSessionIdRef.current = activeChatSessionId;
        void (async () => {
            await initializationPromiseRef.current?.catch(() => {});
            if (
                recoveringSessionIdRef.current !== activeChatSessionId ||
                getActiveEditorChatSessionId() !== activeChatSessionId
            ) {
                return;
            }

            const latestSession =
                useChatStore.getState().sessionsById[activeChatSessionId] ??
                null;
            if (latestSession?.isResumingSession) {
                return;
            }
            if (latestSession?.resumeReconnectFailed) {
                return;
            }
            const latestNeedsLiveResumeContextHydration = latestSession
                ? needsLiveSessionResumeContextHydration(latestSession)
                : false;
            if (
                latestSession?.runtimeState === "live" &&
                !latestNeedsLiveResumeContextHydration
            ) {
                return;
            }

            if (latestNeedsLiveResumeContextHydration) {
                await chatActions.ensureSessionTranscriptLoaded(
                    activeChatSessionId,
                    "full",
                );
            } else {
                await chatActions.loadSession(activeChatSessionId);
            }
        })().finally(() => {
            if (recoveringSessionIdRef.current === activeChatSessionId) {
                recoveringSessionIdRef.current = null;
            }
        });
    }, [
        activeChatSession,
        activeChatSession?.isResumingSession,
        activeChatSession?.loadedPersistedMessageStart,
        activeChatSession?.messages?.length,
        activeChatSession?.persistedMessageCount,
        activeChatSession?.resumeReconnectFailed,
        activeChatSession?.resumeContextPending,
        activeChatSession?.runtimeState,
        activeChatSessionId,
        chatActions,
        hasChatTabs,
        isInitializing,
        startupReady,
        vaultPath,
    ]);

    useEffect(() => {
        const handleAttachWithoutVisibleComposer = (event: Event) => {
            const detail = (event as CustomEvent<FileTreeNoteDragDetail>)
                .detail;
            const replayKey = getAttachReplayKey(detail);
            if (detail.phase !== "attach") return;
            if (hasVisibleAiComposerDropZone(detail.targetSessionId)) {
                attachReplayCountsRef.current.delete(replayKey);
                return;
            }

            const replayCount =
                attachReplayCountsRef.current.get(replayKey) ?? 0;
            if (replayCount >= 3) {
                attachReplayCountsRef.current.delete(replayKey);
                return;
            }
            attachReplayCountsRef.current.set(replayKey, replayCount + 1);

            const ensureTargetSession = detail.targetSessionId
                ? Promise.resolve(
                      openChatSessionInWorkspace(detail.targetSessionId),
                  )
                : ensureWorkspaceChatSession();

            void ensureTargetSession.then((sessionId) => {
                if (!sessionId) return;
                replayAttachAfterComposerMount(detail, sessionId);
            });
        };

        const handleAttachToNewChat = (event: Event) => {
            const detail = (event as CustomEvent<FileTreeNoteDragDetail>)
                .detail;
            if (detail.phase !== "attach") return;

            if (
                useChatStore.getState().getDefaultNewChatRuntimeId() ===
                CLAUDE_TERMINAL_RUNTIME_ID
            ) {
                void openClaudeCodeTerminalWithContext(detail);
                return;
            }

            void createNewChatInWorkspace().then((sessionId) => {
                if (!sessionId) return;
                replayAttachAfterComposerMount(detail, sessionId);
                focusComposerAtEnd(sessionId);
            });
        };

        window.addEventListener(
            FILE_TREE_NOTE_DRAG_EVENT,
            handleAttachWithoutVisibleComposer,
        );
        window.addEventListener(
            FILE_TREE_ATTACH_TO_NEW_CHAT_EVENT,
            handleAttachToNewChat,
        );
        return () => {
            window.removeEventListener(
                FILE_TREE_NOTE_DRAG_EVENT,
                handleAttachWithoutVisibleComposer,
            );
            window.removeEventListener(
                FILE_TREE_ATTACH_TO_NEW_CHAT_EVENT,
                handleAttachToNewChat,
            );
        };
    }, []);

    return null;
}
