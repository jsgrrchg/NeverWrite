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

export function AIChatWorkspaceHost() {
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
    const recoveringSessionIdRef = useRef<string | null>(null);
    const attachReplayCountsRef = useRef(new WeakMap<object, number>());

    useAiChatEventBridge(Boolean(vaultPath) && hasChatTabs);

    useEffect(() => {
        if (!vaultPath || !hasChatTabs) return;

        void chatActions.initialize({ createDefaultSession: false });
    }, [chatActions, hasChatTabs, vaultPath]);

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
        void chatActions.loadSession(activeChatSessionId).finally(() => {
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
