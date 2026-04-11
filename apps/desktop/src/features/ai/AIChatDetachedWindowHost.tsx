import { useEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import {
    isChatTab,
    selectFocusedEditorTab,
    selectEditorWorkspaceTabs,
    useEditorStore,
} from "../../app/store/editorStore";
import { useVaultStore } from "../../app/store/vaultStore";
import { useChatStore } from "./store/chatStore";
import { useAiChatEventBridge } from "./useAiChatEventBridge";

export function AIChatDetachedWindowHost() {
    const vaultPath = useVaultStore((state) => state.vaultPath);
    const { hasChatTabs, activeChatSessionId } = useEditorStore(
        useShallow((state) => {
            const tabs = selectEditorWorkspaceTabs(state);
            const activeTab = selectFocusedEditorTab(state);
            return {
                hasChatTabs: tabs.some((tab) => isChatTab(tab)),
                activeChatSessionId:
                    activeTab && isChatTab(activeTab) ? activeTab.sessionId : null,
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
        if (!vaultPath || !hasChatTabs || !activeChatSessionId || isInitializing) {
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

    return null;
}
