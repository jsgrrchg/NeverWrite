import { useSettingsStore } from "../../app/store/settingsStore";
import { openClaudeCodeTerminalWithContext } from "../terminal/claudeCodeTerminal";
import { createNewChatInWorkspace } from "./chatPaneMovement";
import { useChatStore } from "./store/chatStore";
import { CLAUDE_TERMINAL_RUNTIME_ID } from "./utils/runtimeMetadata";

export function canCreateClaudeCodeAgent() {
    if (!useSettingsStore.getState().claudeCodeEnabled) return false;

    const setupStatus =
        useChatStore.getState().setupStatusByRuntimeId[
            CLAUDE_TERMINAL_RUNTIME_ID
        ];
    return setupStatus?.authReady === true && !setupStatus.onboardingRequired;
}

export function createCanonicalAgent(paneId?: string) {
    return paneId
        ? createNewChatInWorkspace(undefined, { paneId })
        : createNewChatInWorkspace();
}

export function createClaudeCodeAgent(paneId?: string) {
    return openClaudeCodeTerminalWithContext(undefined, paneId);
}
