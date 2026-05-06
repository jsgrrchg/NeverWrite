import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    findActiveSessionsAffectedByClose,
    getCloseTabsConfirmationMessage,
} from "./tabClosePolicy";
import type { Tab } from "../../app/store/editorStore";
import type { AIChatSession } from "../ai/types";

function makeChatTab(sessionId: string): Tab {
    return {
        id: `tab-${sessionId}`,
        kind: "ai-chat",
        sessionId,
        title: "Chat",
    } satisfies Tab;
}

function makeNoteTab(id = "note-1"): Tab {
    return {
        id,
        kind: "note",
        noteId: id,
        title: "Note",
        content: "",
        history: [],
        historyIndex: 0,
    } satisfies Tab;
}

function makeSession(
    sessionId: string,
    overrides: Partial<AIChatSession> = {},
): AIChatSession {
    return {
        sessionId,
        title: null,
        runtimeState: "live",
        status: "idle",
        messages: [],
        attachments: [],
        actionLog: [],
        historySessionId: undefined,
        activeWorkCycleId: null,
        visibleWorkCycleId: null,
        ...overrides,
    } as AIChatSession;
}

describe("findActiveSessionsAffectedByClose", () => {
    it("returns empty array when no chat tabs are in the list", () => {
        const sessions: Record<string, AIChatSession> = {
            s1: makeSession("s1", { status: "streaming" }),
        };
        expect(
            findActiveSessionsAffectedByClose([makeNoteTab()], sessions),
        ).toEqual([]);
    });

    it("returns empty array when chat tab session is idle", () => {
        const tab = makeChatTab("s1");
        const sessions = { s1: makeSession("s1", { status: "idle" }) };
        expect(findActiveSessionsAffectedByClose([tab], sessions)).toEqual([]);
    });

    it("returns empty array when session has no entry in sessionsById", () => {
        const tab = makeChatTab("missing");
        expect(findActiveSessionsAffectedByClose([tab], {})).toEqual([]);
    });

    it("returns the active session for a streaming chat tab", () => {
        const tab = makeChatTab("s1");
        const session = makeSession("s1", { status: "streaming" });
        const result = findActiveSessionsAffectedByClose([tab], { s1: session });
        expect(result).toHaveLength(1);
        expect(result[0]).toBe(session);
    });

    it("returns active sessions for waiting_permission and waiting_user_input", () => {
        const tab1 = makeChatTab("s1");
        const tab2 = makeChatTab("s2");
        const s1 = makeSession("s1", { status: "waiting_permission" });
        const s2 = makeSession("s2", { status: "waiting_user_input" });
        const result = findActiveSessionsAffectedByClose([tab1, tab2], {
            s1,
            s2,
        });
        expect(result).toHaveLength(2);
    });

    it("excludes sessions whose runtime is not live", () => {
        const tab = makeChatTab("s1");
        const session = makeSession("s1", {
            status: "streaming",
            runtimeState: "persisted_only",
        });
        expect(
            findActiveSessionsAffectedByClose([tab], { s1: session }),
        ).toEqual([]);
    });

    it("returns only active sessions when list contains mixed tabs", () => {
        const chatTab = makeChatTab("s1");
        const noteTab = makeNoteTab();
        const idleChat = makeChatTab("s2");
        const activeSession = makeSession("s1", { status: "streaming" });
        const idleSession = makeSession("s2", { status: "idle" });
        const result = findActiveSessionsAffectedByClose(
            [chatTab, noteTab, idleChat],
            { s1: activeSession, s2: idleSession },
        );
        expect(result).toHaveLength(1);
        expect(result[0]).toBe(activeSession);
    });
});

describe("getCloseTabsConfirmationMessage", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it("returns null when there are no affected sessions", () => {
        expect(getCloseTabsConfirmationMessage([])).toBeNull();
    });

    it("returns a singular message for a single affected session", () => {
        const session = makeSession("s1", { status: "streaming" });
        expect(getCloseTabsConfirmationMessage([session])).toBe(
            "The AI agent is still running. Are you sure you want to close this tab?",
        );
    });

    it("returns a plural message for multiple affected sessions", () => {
        const sessions = [
            makeSession("s1", { status: "streaming" }),
            makeSession("s2", { status: "waiting_permission" }),
        ];
        expect(getCloseTabsConfirmationMessage(sessions)).toBe(
            "Active AI agents are still running. Are you sure you want to close these tabs?",
        );
    });
});
