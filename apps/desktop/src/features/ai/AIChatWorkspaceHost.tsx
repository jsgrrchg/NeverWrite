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
    FILE_TREE_NOTE_DRAG_EVENT,
    emitFileTreeNoteDrag,
    type FileTreeNoteDragDetail,
} from "./dragEvents";
import { ensureWorkspaceChatSession } from "./chatPaneMovement";
import { useChatStore } from "./store/chatStore";
import { useAiChatEventBridge } from "./useAiChatEventBridge";

function hasVisibleAiComposerDropZone() {
    return (
        document.querySelector('[data-ai-composer-drop-zone="true"]') !== null
    );
}

function getActiveEditorChatSessionId() {
    const activeTab = selectFocusedEditorTab(useEditorStore.getState());
    return activeTab && isChatTab(activeTab) ? activeTab.sessionId : null;
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
    const attachReplayCountsRef = useRef(new WeakMap<object, number>());

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
        if (
            activeChatSession?.runtimeState === "live" ||
            activeChatSession?.isResumingSession
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
            if (
                latestSession?.runtimeState === "live" ||
                latestSession?.isResumingSession
            ) {
                return;
            }

            await chatActions.loadSession(activeChatSessionId);
        })().finally(() => {
            if (recoveringSessionIdRef.current === activeChatSessionId) {
                recoveringSessionIdRef.current = null;
            }
        });
    }, [
        activeChatSession?.isResumingSession,
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
            const replayKey = detail as object;
            if (detail.phase !== "attach") return;
            if (hasVisibleAiComposerDropZone()) {
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

            void ensureWorkspaceChatSession().then((sessionId) => {
                if (!sessionId) return;

                // Let the newly opened chat tab mount its composer before we
                // replay the attach event into the real in-workspace target.
                window.requestAnimationFrame(() => {
                    window.requestAnimationFrame(() => {
                        emitFileTreeNoteDrag(detail);
                    });
                });
            });
        };

        window.addEventListener(
            FILE_TREE_NOTE_DRAG_EVENT,
            handleAttachWithoutVisibleComposer,
        );
        return () =>
            window.removeEventListener(
                FILE_TREE_NOTE_DRAG_EVENT,
                handleAttachWithoutVisibleComposer,
            );
    }, []);

    return null;
}
