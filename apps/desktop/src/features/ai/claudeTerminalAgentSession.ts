import { invoke } from "@neverwrite/runtime";
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
// `terminalId`, with title/preview sourced from Claude Code's transcript.
//
// chatStore is the source of truth for the sidebar, but it is rebuilt from the
// backend on several events (vault init, runtime reconnect, …) which would drop
// a client-only session. So we keep our own registry of live terminal agents
// and re-assert any entry that goes missing while its terminal is still alive —
// and remove entries whose terminal has closed.

const SESSION_ID_PREFIX = "claude-terminal:";
const TRANSCRIPT_POLL_INTERVAL_MS = 4_000;

interface TerminalAgentEntry {
    terminalId: string;
    defaultTitle: string;
    transcriptSessionId: string | null;
    cwd: string | null;
    createdAt: number;
    // Latest transcript-derived values, re-applied if the session is rebuilt.
    title: string | null;
    preview: string | null;
    customTitle: string | null;
    updatedAt: number;
    lastMtimeMs: number | null;
}

const agentsByTerminalId = new Map<string, TerminalAgentEntry>();
let pollTimer: ReturnType<typeof setInterval> | null = null;
let terminalUnsubscribe: (() => void) | null = null;
let chatUnsubscribe: (() => void) | null = null;

export function claudeTerminalAgentSessionId(terminalId: string) {
    return `${SESSION_ID_PREFIX}${terminalId}`;
}

export function isClaudeTerminalAgentSession(
    session: Pick<AIChatSession, "runtimeId">,
) {
    return session.runtimeId === CLAUDE_TERMINAL_RUNTIME_ID;
}

function buildSession(entry: TerminalAgentEntry): AIChatSession {
    return {
        sessionId: claudeTerminalAgentSessionId(entry.terminalId),
        historySessionId: claudeTerminalAgentSessionId(entry.terminalId),
        runtimeId: CLAUDE_TERMINAL_RUNTIME_ID,
        terminalId: entry.terminalId,
        vaultPath: useVaultStore.getState().vaultPath ?? null,
        status: "idle",
        modelId: "",
        modeId: "",
        models: [],
        modes: [],
        configOptions: [],
        messages: [],
        attachments: [],
        // persistedTitle carries the transcript/default title; customTitle
        // mirrors sidebar renames so re-asserted entries keep the user's label.
        persistedTitle: entry.title ?? entry.defaultTitle,
        customTitle: entry.customTitle,
        persistedPreview: entry.preview,
        persistedCreatedAt: entry.createdAt,
        persistedUpdatedAt: entry.updatedAt,
    };
}

function upsertAgentSession(entry: TerminalAgentEntry) {
    const sessionId = claudeTerminalAgentSessionId(entry.terminalId);
    const previousActiveSessionId = useChatStore.getState().activeSessionId;
    // activate:false so it doesn't hijack the active chat; allowUnknownSession
    // so this client-only entry is admitted to the list.
    useChatStore
        .getState()
        .upsertSession(buildSession(entry), false, { allowUnknownSession: true });
    // upsertSession makes a session active when none was — a terminal agent is
    // never a real chat target, so keep the prior active session.
    if (
        previousActiveSessionId !== sessionId &&
        useChatStore.getState().activeSessionId === sessionId
    ) {
        useChatStore.setState({ activeSessionId: previousActiveSessionId });
    }
}

// Keep chatStore in sync with live terminal agents: re-add any that a store
// rebuild dropped, and remove any whose terminal has closed.
function reconcileAgentSessions() {
    const liveTerminalIds = new Set(
        Object.keys(useTerminalRuntimeStore.getState().runtimesById),
    );
    const chat = useChatStore.getState();

    for (const entry of [...agentsByTerminalId.values()]) {
        const sessionId = claudeTerminalAgentSessionId(entry.terminalId);
        if (!liveTerminalIds.has(entry.terminalId)) {
            agentsByTerminalId.delete(entry.terminalId);
            if (chat.sessionsById[sessionId]) {
                void chat.deleteSession(sessionId);
            }
            continue;
        }
        if (!chat.sessionsById[sessionId]) {
            upsertAgentSession(entry);
            continue;
        }
        syncTerminalAgentCustomTitle(entry, chat.sessionsById[sessionId]);
    }
    stopTranscriptPollingIfIdle();
}

// Back-compat name used elsewhere (and tests): prune == reconcile.
export function pruneClaudeTerminalAgentSessions() {
    reconcileAgentSessions();
}

function installSubscriptions() {
    if (!terminalUnsubscribe) {
        terminalUnsubscribe = useTerminalRuntimeStore.subscribe(() => {
            reconcileAgentSessions();
        });
    }
    if (!chatUnsubscribe) {
        // A store rebuild can drop our client-only entries; re-assert them.
        chatUnsubscribe = useChatStore.subscribe(() => {
            reconcileAgentSessions();
        });
    }
}

function ensureTranscriptPolling() {
    if (pollTimer || agentsByTerminalId.size === 0) return;
    pollTimer = setInterval(() => {
        void refreshClaudeTerminalAgentTranscripts();
    }, TRANSCRIPT_POLL_INTERVAL_MS);
}

function stopTranscriptPollingIfIdle() {
    if (pollTimer && agentsByTerminalId.size === 0) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
}

function updateTerminalTabTitle(terminalId: string, nextTitle: string) {
    const tab = selectEditorWorkspaceTabs(useEditorStore.getState()).find(
        (candidate) =>
            isTerminalTab(candidate) && candidate.terminalId === terminalId,
    );
    if (!tab || tab.title === nextTitle) return;

    useEditorStore.getState().updateTabTitle(tab.id, nextTitle);
}

function syncTerminalTabTitleFromTranscript(
    entry: TerminalAgentEntry,
    nextTitle: string,
    previousTitle: string | null,
) {
    const tab = selectEditorWorkspaceTabs(useEditorStore.getState()).find(
        (candidate) =>
            isTerminalTab(candidate) && candidate.terminalId === entry.terminalId,
    );
    if (!tab || tab.title === nextTitle) return;

    const titleIsStillAutomatic =
        tab.title === entry.defaultTitle ||
        (previousTitle != null && tab.title === previousTitle);
    if (!titleIsStillAutomatic) return;

    useEditorStore.getState().updateTabTitle(tab.id, nextTitle);
}

function syncTerminalAgentCustomTitle(
    entry: TerminalAgentEntry,
    session: AIChatSession | undefined,
) {
    const nextCustomTitle = session?.customTitle?.trim() || null;
    if (entry.customTitle === nextCustomTitle) return;

    const previousCustomTitle = entry.customTitle;
    entry.customTitle = nextCustomTitle;

    const nextTabTitle = nextCustomTitle ?? entry.title ?? entry.defaultTitle;
    if (nextCustomTitle) {
        updateTerminalTabTitle(entry.terminalId, nextTabTitle);
        return;
    }

    const tab = selectEditorWorkspaceTabs(useEditorStore.getState()).find(
        (candidate) =>
            isTerminalTab(candidate) && candidate.terminalId === entry.terminalId,
    );
    if (previousCustomTitle && tab?.title === previousCustomTitle) {
        useEditorStore.getState().updateTabTitle(tab.id, nextTabTitle);
    }
}

// Poll Claude Code's transcript for each tracked terminal and refresh the agent
// entry's title (first prompt), preview (latest answer), and terminal tab title.
export async function refreshClaudeTerminalAgentTranscripts() {
    for (const entry of [...agentsByTerminalId.values()]) {
        if (!entry.cwd || !entry.transcriptSessionId) continue;

        let result:
            | {
                  found: boolean;
                  changed: boolean;
                  mtimeMs: number | null;
                  title: string | null;
                  preview: string | null;
              }
            | undefined;
        try {
            result = await invoke("devtools_read_claude_transcript", {
                input: {
                    sessionId: entry.transcriptSessionId,
                    cwd: entry.cwd,
                    sinceMtimeMs: entry.lastMtimeMs,
                },
            });
        } catch {
            continue;
        }

        if (!result?.changed) continue;
        if (result.mtimeMs != null) entry.lastMtimeMs = result.mtimeMs;
        if (!result.title && !result.preview) continue;

        if (result.title) {
            const previousTitle = entry.title;
            entry.title = result.title;
            syncTerminalTabTitleFromTranscript(entry, result.title, previousTitle);
        }
        if (result.preview) entry.preview = result.preview;
        entry.updatedAt = Date.now();

        const sessionId = claudeTerminalAgentSessionId(entry.terminalId);
        const session = useChatStore.getState().sessionsById[sessionId];
        if (!session) continue;
        useChatStore.setState((state) => {
            const current = state.sessionsById[sessionId];
            if (!current) return state;
            return {
                sessionsById: {
                    ...state.sessionsById,
                    [sessionId]: {
                        ...current,
                        persistedTitle: entry.title ?? current.persistedTitle,
                        persistedPreview:
                            entry.preview ?? current.persistedPreview,
                        persistedUpdatedAt: entry.updatedAt,
                    },
                },
            };
        });
    }
    stopTranscriptPollingIfIdle();
}

// Register (or update) the Agents-sidebar entry for a Claude Code terminal.
export function registerClaudeTerminalAgentSession(args: {
    terminalId: string;
    title: string;
    transcriptSessionId?: string | null;
    cwd?: string | null;
}) {
    installSubscriptions();

    const now = Date.now();
    const existing = agentsByTerminalId.get(args.terminalId);
    const entry: TerminalAgentEntry = {
        terminalId: args.terminalId,
        defaultTitle: args.title,
        transcriptSessionId: args.transcriptSessionId ?? null,
        cwd: args.cwd ?? null,
        createdAt: existing?.createdAt ?? now,
        title: existing?.title ?? null,
        preview: existing?.preview ?? null,
        customTitle: existing?.customTitle ?? null,
        updatedAt: existing?.updatedAt ?? now,
        lastMtimeMs: existing?.lastMtimeMs ?? null,
    };
    agentsByTerminalId.set(args.terminalId, entry);

    upsertAgentSession(entry);

    if (entry.cwd && entry.transcriptSessionId) {
        ensureTranscriptPolling();
        void refreshClaudeTerminalAgentTranscripts();
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

// Close the workspace terminal backing this lightweight Agents entry. The
// terminal runtime store tears down the PTY; the regular reconciliation path
// then removes the pseudo-session from the sidebar.
export async function closeClaudeTerminalAgentSession(
    session: Pick<AIChatSession, "terminalId">,
): Promise<boolean> {
    const terminalId = session.terminalId;
    if (!terminalId) return false;

    const tab = selectEditorWorkspaceTabs(useEditorStore.getState()).find(
        (candidate) =>
            isTerminalTab(candidate) && candidate.terminalId === terminalId,
    );
    const hadRuntime = Boolean(
        useTerminalRuntimeStore.getState().runtimesById[terminalId],
    );

    if (tab) {
        useEditorStore.getState().closeTab(tab.id);
    }
    await useTerminalRuntimeStore.getState().closeTerminal(terminalId);
    return Boolean(tab || hadRuntime);
}

export function resetClaudeTerminalAgentSessionsForTests() {
    agentsByTerminalId.clear();
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
    terminalUnsubscribe?.();
    terminalUnsubscribe = null;
    chatUnsubscribe?.();
    chatUnsubscribe = null;
}
