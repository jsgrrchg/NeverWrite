import {
    selectEditorWorkspaceTabs,
    useEditorStore,
} from "../../app/store/editorStore";
import { isTerminalTab } from "../../app/store/editorTabs";
import { useVaultStore } from "../../app/store/vaultStore";
import { useTerminalRuntimeStore } from "../terminal/terminalRuntimeStore";
import { useChatStore } from "./store/chatStore";
import type { AIChatSession } from "./types";
import { CLAUDE_TERMINAL_RUNTIME_ID } from "./utils/runtimeMetadata";

// Claude Code launched in a terminal has no ACP backend session, so it never
// appears in the Agents sidebar on its own. We register a lightweight,
// non-persisted chat session entry for it, linked to the terminal via
// `terminalId`. The entry is removed when its terminal goes away.

const SESSION_ID_PREFIX = "claude-terminal:";

function sessionIdForTerminal(terminalId: string) {
    return `${SESSION_ID_PREFIX}${terminalId}`;
}

export function isClaudeTerminalAgentSession(
    session: Pick<AIChatSession, "runtimeId">,
) {
    return session.runtimeId === CLAUDE_TERMINAL_RUNTIME_ID;
}

let pruneSubscriptionInstalled = false;

function installPruneSubscription() {
    if (pruneSubscriptionInstalled) return;
    pruneSubscriptionInstalled = true;
    // Terminal lifecycle drives the agent entry: when a terminal runtime is
    // gone (tab closed), drop its agent session. Firing on every terminal
    // store change is cheap — prune only touches the handful of claude-terminal
    // sessions.
    useTerminalRuntimeStore.subscribe(() => {
        pruneClaudeTerminalAgentSessions();
    });
}

// Remove agent entries whose backing terminal runtime no longer exists.
export function pruneClaudeTerminalAgentSessions() {
    const liveTerminalIds = new Set(
        Object.keys(useTerminalRuntimeStore.getState().runtimesById),
    );
    const chat = useChatStore.getState();
    for (const session of Object.values(chat.sessionsById)) {
        if (
            isClaudeTerminalAgentSession(session) &&
            session.terminalId &&
            !liveTerminalIds.has(session.terminalId)
        ) {
            void chat.deleteSession(session.sessionId);
        }
    }
}

// Register (or update) the Agents-sidebar entry for a Claude Code terminal.
// Idempotent: the session id is derived from the terminal id.
export function registerClaudeTerminalAgentSession(args: {
    terminalId: string;
    title: string;
}) {
    installPruneSubscription();

    const sessionId = sessionIdForTerminal(args.terminalId);
    const session: AIChatSession = {
        sessionId,
        historySessionId: sessionId,
        runtimeId: CLAUDE_TERMINAL_RUNTIME_ID,
        terminalId: args.terminalId,
        vaultPath: useVaultStore.getState().vaultPath ?? null,
        status: "idle",
        modelId: "",
        modeId: "",
        models: [],
        modes: [],
        configOptions: [],
        messages: [],
        attachments: [],
        customTitle: args.title,
    };

    // activate:false so launching a terminal doesn't hijack the active chat;
    // allowUnknownSession so this brand-new entry is admitted to the list.
    const previousActiveSessionId = useChatStore.getState().activeSessionId;
    useChatStore.getState().upsertSession(session, false, {
        allowUnknownSession: true,
    });
    // upsertSession makes a session active when none was — but a terminal agent
    // is never a real chat target, so keep the prior active session.
    if (
        previousActiveSessionId !== sessionId &&
        useChatStore.getState().activeSessionId === sessionId
    ) {
        useChatStore.setState({ activeSessionId: previousActiveSessionId });
    }
}

// Focus the terminal tab backing a Claude Code agent entry. Returns false if no
// matching terminal tab exists (e.g. it was closed between render and click).
export function focusClaudeTerminalAgentSession(
    session: Pick<AIChatSession, "terminalId">,
): boolean {
    if (!session.terminalId) return false;
    const tab = selectEditorWorkspaceTabs(useEditorStore.getState()).find(
        (candidate) =>
            isTerminalTab(candidate) &&
            candidate.terminalId === session.terminalId,
    );
    if (!tab) return false;
    useEditorStore.getState().switchTab(tab.id);
    return true;
}
