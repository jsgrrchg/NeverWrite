import { createRoot } from "react-dom/client";
import "./chat.css";
import { AppLayout } from "../../src/components/layout/AppLayout";
import { ChatEditorWorkspace } from "../../src/components/layout/ChatEditorWorkspace";
import { AgentsSidebarPanel } from "../../src/features/ai/AgentsSidebarPanel";
import { ChatArchiveNotice } from "../../src/features/ai/components/ChatArchiveNotice";
import { useChatStore } from "../../src/features/ai/store/chatStore";
import { useChatTabsStore } from "../../src/features/ai/store/chatTabsStore";
import { useVaultStore } from "../../src/app/store/vaultStore";
import { useLayoutStore } from "../../src/app/store/layoutStore";
import type { AIChatSession } from "../../src/features/ai/types";

useVaultStore.setState({ vaultPath: "/fixture", notes: [], entries: [] });
const session: AIChatSession = {
    sessionId: "fixture-chat",
    historySessionId: "fixture-chat",
    customTitle: "Plan the next chapter with a long conversation title",
    runtimeId: "codex-acp",
    status: "idle",
    runtimeState: "live",
    modelId: "fixture-model",
    modeId: "default",
    models: [
        {
            id: "fixture-model",
            runtimeId: "codex-acp",
            name: "Model",
            description: "",
        },
    ],
    modes: [],
    configOptions: [],
    attachments: [],
    activeWorkCycleId: null,
    visibleWorkCycleId: null,
    messages: [
        {
            id: "hello",
            role: "user",
            kind: "text",
            content: "Help me organize my notes.",
            timestamp: Date.now(),
        },
        {
            id: "reply",
            role: "assistant",
            kind: "text",
            content:
                "Start with the outline, then collect the references for each section.",
            timestamp: Date.now(),
        },
    ],
};
useChatStore.setState({
    sessionsById: { [session.sessionId]: session },
    sessionOrder: [session.sessionId],
    sessionInventoryLoaded: true,
    selectedRuntimeId: "codex-acp",
    activeSessionId: session.sessionId,
    runtimes: [
        {
            runtime: {
                id: "codex-acp",
                name: "Codex",
                description: "",
                capabilities: [],
            },
            models: session.models,
            modes: [],
            configOptions: [],
        },
    ],
    loadSession: async () => {},
    ensureSessionTranscriptLoaded: async () => true,
});
useChatTabsStore.getState().showConversation(session.sessionId);
useLayoutStore.setState({
    sidebarCollapsed: false,
    rightPanelCollapsed: true,
    sidebarWidth: 280,
    chatPaneWidth: 480,
    chatPaneVisible: true,
});

export function Fixture() {
    return (
        <div style={{ height: "100vh", color: "var(--text-primary)" }}>
            <AppLayout
                preferredCenterMinimumWidth={646}
                left={<AgentsSidebarPanel />}
                center={
                    <ChatEditorWorkspace>
                        <div
                            className="flex h-full flex-col p-4"
                            style={{ background: "var(--bg-primary)" }}
                        >
                            <h1>Chapter outline</h1>
                            <textarea
                                aria-label="Document draft"
                                className="mt-4 flex-1 resize-none"
                                defaultValue="Keep this document open while chatting."
                            />
                        </div>
                    </ChatEditorWorkspace>
                }
            />
            <ChatArchiveNotice />
        </div>
    );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
