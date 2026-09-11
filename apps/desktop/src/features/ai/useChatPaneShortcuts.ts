import { useEffect } from "react";
import { useLayoutStore } from "../../app/store/layoutStore";
import { matchesShortcutAction } from "../../app/shortcuts/registry";
import { getDesktopPlatform } from "../../app/utils/platform";
import { isCancellableChatTurnStatus } from "./chatTurnStatus";
import { useChatStore } from "./store/chatStore";
import { useChatTabsStore } from "./store/chatTabsStore";

export function handleChatPaneShortcut(event: KeyboardEvent) {
    const nav = useChatTabsStore.getState();
    const layout = useLayoutStore.getState();
    if (
        event.defaultPrevented ||
        !layout.chatPaneVisible ||
        nav.focusedSurface !== "chat"
    )
        return;
    if (matchesShortcutAction(event, "close_tab", getDesktopPlatform())) {
        event.preventDefault();
        event.stopPropagation();
        layout.setChatPaneVisible(false);
        nav.setFocusedSurface("editor");
        return;
    }
    if (
        !matchesShortcutAction(event, "stop_active_agent", getDesktopPlatform())
    )
        return;
    if (nav.view.mode === "history") {
        event.preventDefault();
        event.stopPropagation();
        nav.returnFromHistory(
            Object.keys(useChatStore.getState().sessionsById),
        );
        return;
    }
    if (nav.view.mode !== "conversation") return;
    const session = useChatStore.getState().sessionsById[nav.view.sessionId];
    if (!session || !isCancellableChatTurnStatus(session.status)) return;
    event.preventDefault();
    event.stopPropagation();
    void useChatStore.getState().stopStreaming(session.sessionId);
}

export function useChatPaneShortcuts() {
    useEffect(() => {
        window.addEventListener("keydown", handleChatPaneShortcut);
        return () =>
            window.removeEventListener("keydown", handleChatPaneShortcut);
    }, []);
}
