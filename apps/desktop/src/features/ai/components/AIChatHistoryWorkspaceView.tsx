import { useChatTabsStore } from "../store/chatTabsStore";
import { ChatHistoryView } from "./ChatHistoryView";

export function AIChatHistoryWorkspaceView() {
    const view = useChatTabsStore((state) => state.view);
    const selected =
        view.mode === "history" ? view.selectedHistorySessionId : null;
    return (
        <div data-testid="ai-chat-history-workspace-view" className="h-full">
            <ChatHistoryView
                selectedHistorySessionId={selected}
                onSelectHistorySessionId={
                    useChatTabsStore.getState().selectHistoryEntry
                }
                showBackButton={false}
            />
        </div>
    );
}
