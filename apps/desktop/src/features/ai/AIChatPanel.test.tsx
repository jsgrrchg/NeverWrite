import { invoke } from "@tauri-apps/api/core";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    isNoteTab,
    isReviewTab,
    useEditorStore,
} from "../../app/store/editorStore";
import { useVaultStore } from "../../app/store/vaultStore";
import { renderComponent } from "../../test/test-utils";
import type {
    AIChatAttachment,
    AIChatSession,
    AIComposerPart,
    AIRuntimeDescriptor,
} from "./types";
import { AIChatPanel } from "./AIChatPanel";
import { resetChatStore, useChatStore } from "./store/chatStore";
import { syncDerivedLinePatch } from "./store/actionLogModel";
import {
    markChatTabsReady,
    resetChatTabsStore,
    useChatTabsStore,
} from "./store/chatTabsStore";

const invokeMock = vi.mocked(invoke);

function createSession(
    sessionId: string,
    title: string,
    status: AIChatSession["status"] = "idle",
    overrides: Partial<AIChatSession> = {},
): AIChatSession {
    const defaultMessages = overrides.messages ?? [
        {
            id: `${sessionId}-user`,
            role: "user" as const,
            kind: "text" as const,
            content: title,
            timestamp: 10,
        },
    ];

    return {
        sessionId,
        historySessionId: overrides.historySessionId ?? sessionId,
        status: overrides.status ?? status,
        runtimeId: overrides.runtimeId ?? "codex-acp",
        modelId: overrides.modelId ?? "test-model",
        modeId: overrides.modeId ?? "default",
        models: overrides.models ?? [],
        modes: overrides.modes ?? [],
        configOptions: overrides.configOptions ?? [],
        messages: defaultMessages,
        attachments: overrides.attachments ?? [],
        activeWorkCycleId: overrides.activeWorkCycleId ?? null,
        visibleWorkCycleId: overrides.visibleWorkCycleId ?? null,
        actionLog: overrides.actionLog,
        isPersistedSession: overrides.isPersistedSession,
        isResumingSession: overrides.isResumingSession,
        resumeContextPending: overrides.resumeContextPending,
        effortsByModel: overrides.effortsByModel,
        runtimeState:
            overrides.runtimeState ??
            (overrides.isPersistedSession ? "persisted_only" : "live"),
    };
}

function createAttachment(
    id: string,
    label: string,
    noteId: string,
): AIChatAttachment {
    return {
        id,
        type: "note",
        noteId,
        label,
        path: `/vault/${label}.md`,
    };
}

function createDraft(text: string): AIComposerPart[] {
    return [
        {
            id: `draft:${text}`,
            type: "text",
            text,
        },
    ];
}

const runtimeDescriptor: AIRuntimeDescriptor = {
    runtime: {
        id: "codex-acp",
        name: "Codex ACP",
        description: "Codex runtime embedded as an ACP sidecar.",
        capabilities: ["attachments", "permissions", "reasoning"],
    },
    models: [],
    modes: [],
    configOptions: [],
};

const claudeRuntimeDescriptor: AIRuntimeDescriptor = {
    runtime: {
        id: "claude-acp",
        name: "Claude ACP",
        description: "Claude runtime embedded as an ACP sidecar.",
        capabilities: ["attachments", "permissions", "reasoning"],
    },
    models: [],
    modes: [],
    configOptions: [],
};

const restoredSessionModels: AIChatSession["models"] = [
    {
        id: "test-model",
        runtimeId: "codex-acp",
        name: "Test Model",
        description: "Default test model.",
    },
    {
        id: "wide-model",
        runtimeId: "codex-acp",
        name: "Wide Model",
        description: "Alternative test model.",
    },
];

const restoredSessionModes: AIChatSession["modes"] = [
    {
        id: "default",
        runtimeId: "codex-acp",
        name: "Default",
        description: "Default approval preset.",
    },
    {
        id: "review-mode",
        runtimeId: "codex-acp",
        name: "Review Mode",
        description: "Review-focused preset.",
    },
];

const restoredSessionConfigOptions: AIChatSession["configOptions"] = [
    {
        id: "model",
        runtimeId: "codex-acp",
        category: "model",
        label: "Model",
        type: "select",
        value: "test-model",
        options: [
            { value: "test-model", label: "Test Model" },
            { value: "wide-model", label: "Wide Model" },
        ],
    },
    {
        id: "reasoning_effort",
        runtimeId: "codex-acp",
        category: "reasoning",
        label: "Reasoning Effort",
        type: "select",
        value: "medium",
        options: [
            { value: "medium", label: "Medium" },
            { value: "high", label: "High" },
        ],
    },
];

describe("AIChatPanel tabs lifecycle", () => {
    beforeEach(() => {
        resetChatStore();
        resetChatTabsStore();
        markChatTabsReady();
        invokeMock.mockReset();
        useVaultStore.setState({ vaultPath: "/vault", notes: [], entries: [] });
        useEditorStore.setState({
            tabs: [],
            activeTabId: null,
            activationHistory: [],
            tabNavigationHistory: [],
            tabNavigationIndex: -1,
            pendingReveal: null,
            pendingSelectionReveal: null,
            currentSelection: null,
        });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("opens and activates a chat tab when selecting an existing session", async () => {
        const sessionA = createSession("session-a", "First conversation");
        const sessionB = createSession("session-b", "Second conversation");
        const loadSession = vi.fn(async (sessionId: string) => {
            useChatStore.setState((state) => ({
                activeSessionId: sessionId,
                sessionOrder: [
                    sessionId,
                    ...state.sessionOrder.filter((id) => id !== sessionId),
                ],
            }));
        });

        useChatStore.setState((state) => ({
            ...state,
            runtimeConnection: { status: "ready", message: null },
            setupStatus: {
                runtimeId: "codex-acp",
                binaryReady: true,
                binarySource: "bundled",
                authReady: true,
                authMethods: [],
                onboardingRequired: false,
            },
            runtimes: [runtimeDescriptor],
            sessionsById: {
                [sessionA.sessionId]: sessionA,
                [sessionB.sessionId]: sessionB,
            },
            sessionOrder: [sessionA.sessionId, sessionB.sessionId],
            activeSessionId: sessionA.sessionId,
            composerPartsBySessionId: {
                [sessionA.sessionId]: [],
                [sessionB.sessionId]: [],
            },
            loadSession,
        }));
        useChatTabsStore.setState({
            tabs: [{ id: "tab-a", sessionId: sessionA.sessionId }],
            activeTabId: "tab-a",
        });

        renderComponent(<AIChatPanel />);

        fireEvent.click(screen.getByTitle("Recent chats"));
        fireEvent.click(screen.getByText("Second conversation"));

        await waitFor(() => {
            expect(loadSession).toHaveBeenCalledWith("session-b");
            expect(useChatTabsStore.getState().activeTabId).not.toBeNull();
            expect(
                useChatTabsStore
                    .getState()
                    .tabs.find(
                        (tab) =>
                            tab.id === useChatTabsStore.getState().activeTabId,
                    )?.sessionId,
            ).toBe("session-b");
            expect(useChatStore.getState().activeSessionId).toBe("session-b");
        });
    });

    it("recovers an active restored tab when its session has not been hydrated yet", async () => {
        const sessionA = createSession("session-a", "First conversation");
        const restoredSession = createSession(
            "session-restored",
            "Recovered conversation",
        );
        const originalLoadSession = useChatStore.getState().loadSession;
        const loadSession = vi.fn(async (sessionId: string) => {
            expect(sessionId).toBe(restoredSession.sessionId);
            useChatStore.setState((state) => ({
                ...state,
                sessionsById: {
                    ...state.sessionsById,
                    [restoredSession.sessionId]: restoredSession,
                },
                sessionOrder: [
                    restoredSession.sessionId,
                    ...state.sessionOrder.filter(
                        (candidate) => candidate !== restoredSession.sessionId,
                    ),
                ],
                activeSessionId: restoredSession.sessionId,
                composerPartsBySessionId: {
                    ...state.composerPartsBySessionId,
                    [restoredSession.sessionId]: [],
                },
            }));
        });
        useChatStore.setState({ loadSession });

        try {
            useChatStore.setState((state) => ({
                ...state,
                runtimeConnection: { status: "ready", message: null },
                setupStatus: {
                    runtimeId: "codex-acp",
                    binaryReady: true,
                    binarySource: "bundled",
                    authReady: true,
                    authMethods: [],
                    onboardingRequired: false,
                },
                runtimes: [runtimeDescriptor],
                sessionsById: {
                    [sessionA.sessionId]: sessionA,
                },
                sessionOrder: [sessionA.sessionId],
                activeSessionId: sessionA.sessionId,
                composerPartsBySessionId: {
                    [sessionA.sessionId]: [],
                },
            }));
            useChatTabsStore.setState({
                tabs: [
                    {
                        id: "tab-restored",
                        sessionId: restoredSession.sessionId,
                    },
                ],
                activeTabId: "tab-restored",
            });

            renderComponent(<AIChatPanel />);

            await waitFor(() => {
                expect(loadSession).toHaveBeenCalledWith(
                    restoredSession.sessionId,
                );
                expect(useChatStore.getState().activeSessionId).toBe(
                    "session-restored",
                );
                expect(
                    useChatStore.getState().sessionsById[
                        restoredSession.sessionId
                    ],
                ).toMatchObject({
                    sessionId: restoredSession.sessionId,
                });
            });
        } finally {
            useChatStore.setState({ loadSession: originalLoadSession });
        }
    });

    it("opens a new active tab after creating a chat", async () => {
        const sessionA = createSession("session-a", "First conversation");
        const sessionC = createSession("session-c", "Fresh session");
        const newSession = vi.fn(async () => {
            useChatStore.setState((state) => ({
                ...state,
                sessionsById: {
                    ...state.sessionsById,
                    [sessionC.sessionId]: sessionC,
                },
                sessionOrder: [sessionC.sessionId, ...state.sessionOrder],
                activeSessionId: sessionC.sessionId,
                composerPartsBySessionId: {
                    ...state.composerPartsBySessionId,
                    [sessionC.sessionId]: [],
                },
            }));
        });

        useChatStore.setState((state) => ({
            ...state,
            runtimeConnection: { status: "ready", message: null },
            setupStatus: {
                runtimeId: "codex-acp",
                binaryReady: true,
                binarySource: "bundled",
                authReady: true,
                authMethods: [],
                onboardingRequired: false,
            },
            runtimes: [runtimeDescriptor],
            sessionsById: {
                [sessionA.sessionId]: sessionA,
            },
            sessionOrder: [sessionA.sessionId],
            activeSessionId: sessionA.sessionId,
            composerPartsBySessionId: {
                [sessionA.sessionId]: [],
            },
            newSession,
        }));
        useChatTabsStore.setState({
            tabs: [{ id: "tab-a", sessionId: sessionA.sessionId }],
            activeTabId: "tab-a",
        });

        renderComponent(<AIChatPanel />);

        fireEvent.click(screen.getByTitle("New chat"));
        fireEvent.click(screen.getByRole("button", { name: "Codex ACP" }));

        await waitFor(() => {
            expect(newSession).toHaveBeenCalledWith("codex-acp");
            expect(
                useChatTabsStore
                    .getState()
                    .tabs.some((tab) => tab.sessionId === "session-c"),
            ).toBe(true);
            expect(
                useChatTabsStore
                    .getState()
                    .tabs.find(
                        (tab) =>
                            tab.id === useChatTabsStore.getState().activeTabId,
                    )?.sessionId,
            ).toBe("session-c");
            expect(useChatStore.getState().activeSessionId).toBe("session-c");
        });
    });

    it("shows the selected runtime onboarding when it differs from the active session", async () => {
        const sessionA = createSession("session-a", "First conversation");

        useChatStore.setState((state) => ({
            ...state,
            runtimes: [runtimeDescriptor, claudeRuntimeDescriptor],
            sessionsById: {
                [sessionA.sessionId]: sessionA,
            },
            sessionOrder: [sessionA.sessionId],
            activeSessionId: sessionA.sessionId,
            selectedRuntimeId: "claude-acp",
            composerPartsBySessionId: {
                [sessionA.sessionId]: [],
            },
            setupStatusByRuntimeId: {
                "codex-acp": {
                    runtimeId: "codex-acp",
                    binaryReady: true,
                    binarySource: "bundled",
                    authReady: true,
                    authMethods: [],
                    onboardingRequired: false,
                },
                "claude-acp": {
                    runtimeId: "claude-acp",
                    binaryReady: true,
                    binarySource: "bundled",
                    authReady: false,
                    authMethods: [
                        {
                            id: "claude-login",
                            name: "Claude login",
                            description:
                                "Open a terminal-based Claude login flow.",
                        },
                    ],
                    onboardingRequired: true,
                },
            },
            runtimeConnectionByRuntimeId: {
                "codex-acp": { status: "ready", message: null },
                "claude-acp": { status: "ready", message: null },
            },
        }));
        useChatTabsStore.setState({
            tabs: [{ id: "tab-a", sessionId: sessionA.sessionId }],
            activeTabId: "tab-a",
        });

        renderComponent(<AIChatPanel />);

        expect(
            await screen.findByText("Connect Claude ACP to start chatting"),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "Open sign-in terminal" }),
        ).toBeInTheDocument();
    });

    it("keeps the selected runtime onboarding focused when a stale tab exists without an active session", async () => {
        const sessionA = createSession("session-a", "First conversation");

        useChatStore.setState((state) => ({
            ...state,
            runtimes: [runtimeDescriptor, claudeRuntimeDescriptor],
            sessionsById: {
                [sessionA.sessionId]: sessionA,
            },
            sessionOrder: [sessionA.sessionId],
            activeSessionId: null,
            selectedRuntimeId: "claude-acp",
            composerPartsBySessionId: {
                [sessionA.sessionId]: [],
            },
            setupStatusByRuntimeId: {
                "codex-acp": {
                    runtimeId: "codex-acp",
                    binaryReady: true,
                    binarySource: "bundled",
                    authReady: false,
                    authMethods: [],
                    onboardingRequired: true,
                },
                "claude-acp": {
                    runtimeId: "claude-acp",
                    binaryReady: true,
                    binarySource: "bundled",
                    authReady: false,
                    authMethods: [
                        {
                            id: "claude-login",
                            name: "Claude login",
                            description:
                                "Open a terminal-based Claude login flow.",
                        },
                    ],
                    onboardingRequired: true,
                },
            },
            runtimeConnectionByRuntimeId: {
                "codex-acp": { status: "idle", message: null },
                "claude-acp": { status: "idle", message: null },
            },
        }));
        useChatTabsStore.setState({
            tabs: [{ id: "tab-a", sessionId: sessionA.sessionId }],
            activeTabId: "tab-a",
        });

        renderComponent(<AIChatPanel />);

        expect(
            await screen.findByText("Connect Claude ACP to start chatting"),
        ).toBeInTheDocument();
        expect(
            screen.queryByText("Connect Codex ACP to start chatting"),
        ).not.toBeInTheDocument();
    });

    it("switches to the nearest remaining session when closing the active tab", async () => {
        const sessionA = createSession("session-a", "First conversation");
        const sessionB = createSession("session-b", "Second conversation");

        useChatStore.setState((state) => ({
            ...state,
            runtimeConnection: { status: "ready", message: null },
            setupStatus: {
                runtimeId: "codex-acp",
                binaryReady: true,
                binarySource: "bundled",
                authReady: true,
                authMethods: [],
                onboardingRequired: false,
            },
            runtimes: [runtimeDescriptor],
            sessionsById: {
                [sessionA.sessionId]: sessionA,
                [sessionB.sessionId]: sessionB,
            },
            sessionOrder: [sessionA.sessionId, sessionB.sessionId],
            activeSessionId: sessionA.sessionId,
            composerPartsBySessionId: {
                [sessionA.sessionId]: [],
                [sessionB.sessionId]: [],
            },
        }));
        useChatTabsStore.setState({
            tabs: [
                { id: "tab-a", sessionId: sessionA.sessionId },
                { id: "tab-b", sessionId: sessionB.sessionId },
            ],
            activeTabId: "tab-a",
        });

        renderComponent(<AIChatPanel />);

        fireEvent.click(screen.getByLabelText("Close First conversation"));

        await waitFor(() => {
            expect(useChatTabsStore.getState().tabs).toHaveLength(1);
            expect(useChatTabsStore.getState().tabs[0]?.sessionId).toBe(
                "session-b",
            );
            expect(useChatStore.getState().activeSessionId).toBe("session-b");
            expect(useChatStore.getState().sessionOrder).toEqual([
                "session-b",
                "session-a",
            ]);
            expect(
                useChatStore.getState().sessionsById["session-a"]?.messages[0]
                    ?.content,
            ).toBe("First conversation");
        });
    });

    it("resumes a persisted session when its tab becomes active", async () => {
        const sessionA = createSession("session-a", "First conversation");
        const persistedSession = createSession(
            "persisted:history-1",
            "Recovered from disk",
            "idle",
            {
                historySessionId: "history-1",
                isPersistedSession: true,
            },
        );
        const resumedSession = createSession(
            "session-live",
            "Recovered from disk",
            "idle",
            {
                historySessionId: "history-1",
            },
        );
        const resumeSession = vi.fn(async (sessionId: string) => {
            useChatStore.setState((state) => {
                const nextSessionsById = { ...state.sessionsById };
                delete nextSessionsById[sessionId];
                nextSessionsById[resumedSession.sessionId] = resumedSession;

                const nextComposerParts = {
                    ...state.composerPartsBySessionId,
                    [resumedSession.sessionId]:
                        state.composerPartsBySessionId[sessionId] ?? [],
                };
                delete nextComposerParts[sessionId];

                return {
                    sessionsById: nextSessionsById,
                    sessionOrder: state.sessionOrder.map((id) =>
                        id === sessionId ? resumedSession.sessionId : id,
                    ),
                    activeSessionId: resumedSession.sessionId,
                    composerPartsBySessionId: nextComposerParts,
                };
            });
            useChatTabsStore
                .getState()
                .replaceSessionId(sessionId, resumedSession.sessionId);
            return resumedSession.sessionId;
        });

        useChatStore.setState((state) => ({
            ...state,
            runtimeConnection: { status: "ready", message: null },
            setupStatus: {
                runtimeId: "codex-acp",
                binaryReady: true,
                binarySource: "bundled",
                authReady: true,
                authMethods: [],
                onboardingRequired: false,
            },
            runtimes: [runtimeDescriptor],
            sessionsById: {
                [sessionA.sessionId]: sessionA,
                [persistedSession.sessionId]: persistedSession,
            },
            sessionOrder: [sessionA.sessionId, persistedSession.sessionId],
            activeSessionId: sessionA.sessionId,
            composerPartsBySessionId: {
                [sessionA.sessionId]: [],
                [persistedSession.sessionId]: createDraft("Recovered draft"),
            },
            resumeSession,
        }));
        useChatTabsStore.setState({
            tabs: [
                { id: "tab-a", sessionId: sessionA.sessionId },
                { id: "tab-persisted", sessionId: persistedSession.sessionId },
            ],
            activeTabId: "tab-a",
        });

        renderComponent(<AIChatPanel />);

        fireEvent.click(
            screen.getByRole("tab", { name: /Recovered from disk/i }),
        );

        await waitFor(() => {
            expect(resumeSession).toHaveBeenCalledWith("persisted:history-1");
            expect(useChatStore.getState().activeSessionId).toBe(
                "session-live",
            );
            expect(
                useChatTabsStore
                    .getState()
                    .tabs.find((tab) => tab.id === "tab-persisted")?.sessionId,
            ).toBe("session-live");
        });
    });

    it("preserves drafts, attachments and permission state when switching tabs", async () => {
        const sessionA = createSession(
            "session-a",
            "First conversation",
            "idle",
            {
                attachments: [createAttachment("att-a", "Doc A", "doc-a")],
            },
        );
        const sessionB = createSession(
            "session-b",
            "Second conversation",
            "waiting_permission",
            {
                attachments: [createAttachment("att-b", "Doc B", "doc-b")],
            },
        );

        useChatStore.setState((state) => ({
            ...state,
            runtimeConnection: { status: "ready", message: null },
            setupStatus: {
                runtimeId: "codex-acp",
                binaryReady: true,
                binarySource: "bundled",
                authReady: true,
                authMethods: [],
                onboardingRequired: false,
            },
            runtimes: [runtimeDescriptor],
            sessionsById: {
                [sessionA.sessionId]: sessionA,
                [sessionB.sessionId]: sessionB,
            },
            sessionOrder: [sessionA.sessionId, sessionB.sessionId],
            activeSessionId: sessionA.sessionId,
            composerPartsBySessionId: {
                [sessionA.sessionId]: createDraft("Draft A"),
                [sessionB.sessionId]: createDraft("Draft B"),
            },
        }));
        useChatTabsStore.setState({
            tabs: [
                { id: "tab-a", sessionId: sessionA.sessionId },
                { id: "tab-b", sessionId: sessionB.sessionId },
            ],
            activeTabId: "tab-a",
        });

        renderComponent(<AIChatPanel />);

        const textbox = screen.getByRole("textbox", {
            name: "Message VaultAI",
        });
        expect(textbox.textContent).toContain("Draft A");
        expect(screen.getByText("Doc A")).toBeTruthy();
        expect(screen.queryByText("Doc B")).toBeNull();
        expect(screen.getByLabelText("Send")).not.toBeDisabled();

        fireEvent.click(
            screen.getByRole("tab", { name: /Second conversation/i }),
        );

        await waitFor(() => {
            expect(useChatTabsStore.getState().activeTabId).toBe("tab-b");
            expect(useChatStore.getState().activeSessionId).toBe("session-b");
            expect(
                screen.getByRole("textbox", {
                    name: "Message VaultAI",
                }).textContent,
            ).toContain("Draft B");
            expect(screen.queryByText("Doc A")).toBeNull();
            expect(screen.getByText("Doc B")).toBeTruthy();
            expect(screen.getByLabelText("Send")).not.toBeDisabled();
        });
    });

    it("shows the active note auto-context without rendering a selection pill", () => {
        const session = createSession("session-a", "First conversation");

        useVaultStore.setState({
            notes: [
                {
                    id: "notes/tasks",
                    title: "TAREAS",
                    path: "/vault/TAREAS.md",
                    modified_at: 0,
                    created_at: 0,
                },
            ],
        });
        useEditorStore.setState({
            tabs: [
                {
                    id: "note-tab",
                    kind: "note",
                    noteId: "notes/tasks",
                    title: "TAREAS",
                    content: "- [ ] Win bug",
                    history: [],
                    historyIndex: 0,
                },
            ],
            activeTabId: "note-tab",
            activationHistory: ["note-tab"],
            tabNavigationHistory: ["note-tab"],
            tabNavigationIndex: 0,
            currentSelection: {
                noteId: "notes/tasks",
                path: "/vault/TAREAS.md",
                text: "- [ ] Win bug",
                from: 0,
                to: 13,
                startLine: 11,
                endLine: 19,
            },
        });
        useChatStore.setState((state) => ({
            ...state,
            autoContextEnabled: true,
            runtimeConnection: { status: "ready", message: null },
            setupStatus: {
                runtimeId: "codex-acp",
                binaryReady: true,
                binarySource: "bundled",
                authReady: true,
                authMethods: [],
                onboardingRequired: false,
            },
            runtimes: [runtimeDescriptor],
            sessionsById: {
                [session.sessionId]: session,
            },
            sessionOrder: [session.sessionId],
            activeSessionId: session.sessionId,
            composerPartsBySessionId: {
                [session.sessionId]: [],
            },
        }));
        useChatTabsStore.setState({
            tabs: [{ id: "tab-a", sessionId: session.sessionId }],
            activeTabId: "tab-a",
        });

        renderComponent(<AIChatPanel />);

        expect(screen.getByText("TAREAS")).toBeTruthy();
        expect(screen.queryByText(/\(11:19\)/)).toBeNull();
    });

    it("routes composer edits to the visible tab session when tab and active session diverge", async () => {
        const sessionA = createSession("session-a", "First conversation");
        const sessionB = createSession("session-b", "Second conversation");

        useChatStore.setState((state) => ({
            ...state,
            runtimeConnection: { status: "ready", message: null },
            setupStatus: {
                runtimeId: "codex-acp",
                binaryReady: true,
                binarySource: "bundled",
                authReady: true,
                authMethods: [],
                onboardingRequired: false,
            },
            runtimes: [runtimeDescriptor],
            sessionsById: {
                [sessionA.sessionId]: sessionA,
                [sessionB.sessionId]: sessionB,
            },
            sessionOrder: [sessionA.sessionId, sessionB.sessionId],
            activeSessionId: sessionA.sessionId,
            composerPartsBySessionId: {
                [sessionA.sessionId]: createDraft("Draft A"),
                [sessionB.sessionId]: createDraft("Draft B"),
            },
            setActiveSession: vi.fn(),
        }));
        useChatTabsStore.setState({
            tabs: [
                { id: "tab-a", sessionId: sessionA.sessionId },
                { id: "tab-b", sessionId: sessionB.sessionId },
            ],
            activeTabId: "tab-b",
        });

        renderComponent(<AIChatPanel />);

        const textbox = screen.getByRole("textbox", {
            name: "Message VaultAI",
        });
        expect(textbox.textContent).toContain("Draft B");
        await waitFor(() => {
            expect(useChatStore.getState().activeSessionId).toBe("session-b");
        });

        textbox.textContent = "Visible draft";
        fireEvent.input(textbox);

        expect(
            useChatStore.getState().composerPartsBySessionId["session-b"],
        ).toMatchObject([{ type: "text", text: "Visible draft" }]);
        expect(
            useChatStore.getState().composerPartsBySessionId["session-a"],
        ).toMatchObject([{ type: "text", text: "Draft A" }]);
    });

    it("updates the composer banner to the visible session provider when switching tabs", async () => {
        const sessionA = createSession(
            "session-a",
            "First conversation",
            "idle",
            {
                runtimeId: "codex-acp",
            },
        );
        const sessionB = createSession(
            "session-b",
            "Second conversation",
            "idle",
            {
                runtimeId: "claude-acp",
            },
        );

        useChatStore.setState((state) => ({
            ...state,
            runtimeConnection: { status: "ready", message: null },
            setupStatus: {
                runtimeId: "codex-acp",
                binaryReady: true,
                binarySource: "bundled",
                authReady: true,
                authMethods: [],
                onboardingRequired: false,
            },
            runtimes: [runtimeDescriptor, claudeRuntimeDescriptor],
            sessionsById: {
                [sessionA.sessionId]: sessionA,
                [sessionB.sessionId]: sessionB,
            },
            sessionOrder: [sessionA.sessionId, sessionB.sessionId],
            activeSessionId: sessionA.sessionId,
            composerPartsBySessionId: {
                [sessionA.sessionId]: [],
                [sessionB.sessionId]: [],
            },
        }));
        useChatTabsStore.setState({
            tabs: [
                { id: "tab-a", sessionId: sessionA.sessionId },
                { id: "tab-b", sessionId: sessionB.sessionId },
            ],
            activeTabId: "tab-a",
        });

        renderComponent(<AIChatPanel />);

        expect(
            screen.getByText(/Message Codex — @ to include context/i),
        ).toBeTruthy();

        fireEvent.click(
            screen.getByRole("tab", { name: /Second conversation/i }),
        );

        await waitFor(() => {
            expect(
                screen.getByText(/Message Claude — @ to include context/i),
            ).toBeTruthy();
        });
    });

    it("renders the session queue and lets the user edit, clear or send queued items now", async () => {
        const session = createSession(
            "session-a",
            "Queued conversation",
            "streaming",
        );

        useChatStore.setState((state) => ({
            ...state,
            runtimeConnection: { status: "ready", message: null },
            setupStatus: {
                runtimeId: "codex-acp",
                binaryReady: true,
                binarySource: "bundled",
                authReady: true,
                authMethods: [],
                onboardingRequired: false,
            },
            runtimes: [runtimeDescriptor],
            sessionsById: {
                [session.sessionId]: session,
            },
            sessionOrder: [session.sessionId],
            activeSessionId: session.sessionId,
            composerPartsBySessionId: {
                [session.sessionId]: [],
            },
            queuedMessagesBySessionId: {
                [session.sessionId]: [
                    {
                        id: "queued-1",
                        content: "First queued item",
                        prompt: "First queued item",
                        composerParts: createDraft("First queued item"),
                        attachments: [],
                        createdAt: 1,
                        status: "queued",
                        modelId: "test-model",
                        modeId: "default",
                        optionsSnapshot: {},
                    },
                    {
                        id: "queued-2",
                        content: "Failed queued item",
                        prompt: "Failed queued item",
                        composerParts: createDraft("Failed queued item"),
                        attachments: [],
                        createdAt: 2,
                        status: "failed",
                        modelId: "test-model",
                        modeId: "default",
                        optionsSnapshot: {},
                    },
                ],
            },
        }));
        useChatTabsStore.setState({
            tabs: [{ id: "tab-a", sessionId: session.sessionId }],
            activeTabId: "tab-a",
        });

        renderComponent(<AIChatPanel />);

        expect(screen.getByText("2 Queued Messages")).toBeTruthy();
        expect(screen.getAllByText("First queued item").length).toBeGreaterThan(
            0,
        );
        expect(
            screen.getAllByRole("button", { name: /Edit / }).length,
        ).toBeGreaterThan(0);
        expect(
            screen.getAllByRole("button", { name: "Send Now" }).length,
        ).toBeGreaterThan(0);

        fireEvent.click(
            screen.getByRole("button", { name: "Edit First queued item" }),
        );

        await waitFor(() => {
            expect(screen.getByText("Editing queued message")).toBeTruthy();
            expect(
                screen.getByRole("textbox", { name: "Message VaultAI" })
                    .textContent,
            ).toContain("First queued item");
            expect(
                useChatStore.getState().queuedMessagesBySessionId[
                    session.sessionId
                ],
            ).toHaveLength(1);
        });

        fireEvent.click(screen.getByRole("button", { name: "Cancel Edit" }));

        await waitFor(() => {
            expect(
                useChatStore.getState().queuedMessagesBySessionId[
                    session.sessionId
                ],
            ).toHaveLength(2);
        });

        fireEvent.click(screen.getByRole("button", { name: "Clear All" }));

        await waitFor(() => {
            expect(
                useChatStore.getState().queuedMessagesBySessionId[
                    session.sessionId
                ],
            ).toBeUndefined();
        });
    });

    it("dispatches the send now action for the selected queued item", async () => {
        const session = createSession(
            "session-a",
            "Queued conversation",
            "streaming",
        );
        const sendQueuedMessageNow = vi.fn().mockResolvedValue(undefined);

        useChatStore.setState((state) => ({
            ...state,
            runtimeConnection: { status: "ready", message: null },
            setupStatus: {
                runtimeId: "codex-acp",
                binaryReady: true,
                binarySource: "bundled",
                authReady: true,
                authMethods: [],
                onboardingRequired: false,
            },
            runtimes: [runtimeDescriptor],
            sessionsById: {
                [session.sessionId]: session,
            },
            sessionOrder: [session.sessionId],
            activeSessionId: session.sessionId,
            composerPartsBySessionId: {
                [session.sessionId]: [],
            },
            sendQueuedMessageNow,
            queuedMessagesBySessionId: {
                [session.sessionId]: [
                    {
                        id: "queued-1",
                        content: "First queued item",
                        prompt: "First queued item",
                        composerParts: createDraft("First queued item"),
                        attachments: [],
                        createdAt: 1,
                        status: "queued",
                        modelId: "test-model",
                        modeId: "default",
                        optionsSnapshot: {},
                    },
                    {
                        id: "queued-2",
                        content: "Second queued item",
                        prompt: "Second queued item",
                        composerParts: createDraft("Second queued item"),
                        attachments: [],
                        createdAt: 2,
                        status: "queued",
                        modelId: "test-model",
                        modeId: "default",
                        optionsSnapshot: {},
                    },
                ],
            },
        }));
        useChatTabsStore.setState({
            tabs: [{ id: "tab-a", sessionId: session.sessionId }],
            activeTabId: "tab-a",
        });

        renderComponent(<AIChatPanel />);

        fireEvent.click(screen.getAllByRole("button", { name: "Send Now" })[1]);

        await waitFor(() => {
            expect(sendQueuedMessageNow).toHaveBeenCalledWith(
                session.sessionId,
                "queued-2",
            );
        });
    });

    it("hides the active queued turn from the queue panel", async () => {
        const session = createSession(
            "session-a",
            "Queued conversation",
            "streaming",
        );

        useChatStore.setState((state) => ({
            ...state,
            runtimeConnection: { status: "ready", message: null },
            setupStatus: {
                runtimeId: "codex-acp",
                binaryReady: true,
                binarySource: "bundled",
                authReady: true,
                authMethods: [],
                onboardingRequired: false,
            },
            runtimes: [runtimeDescriptor],
            sessionsById: {
                [session.sessionId]: session,
            },
            sessionOrder: [session.sessionId],
            activeSessionId: session.sessionId,
            composerPartsBySessionId: {
                [session.sessionId]: [],
            },
            activeQueuedMessageBySessionId: {
                [session.sessionId]: {
                    item: {
                        id: "queued-1",
                        content: "First queued item",
                        prompt: "First queued item",
                        composerParts: createDraft("First queued item"),
                        attachments: [],
                        createdAt: 1,
                        status: "sending",
                        modelId: "test-model",
                        modeId: "default",
                        optionsSnapshot: {},
                    },
                    originalIndex: 0,
                    previousItemId: null,
                    nextItemId: "queued-2",
                },
            },
            queuedMessagesBySessionId: {
                [session.sessionId]: [
                    {
                        id: "queued-2",
                        content: "Second queued item",
                        prompt: "Second queued item",
                        composerParts: createDraft("Second queued item"),
                        attachments: [],
                        createdAt: 2,
                        status: "queued",
                        modelId: "test-model",
                        modeId: "default",
                        optionsSnapshot: {},
                    },
                ],
            },
        }));
        useChatTabsStore.setState({
            tabs: [{ id: "tab-a", sessionId: session.sessionId }],
            activeTabId: "tab-a",
        });

        renderComponent(<AIChatPanel />);

        expect(screen.getByText("1 Queued Message")).toBeTruthy();
        expect(screen.queryByText("First queued item")).toBeNull();
        expect(
            screen.getAllByText("Second queued item").length,
        ).toBeGreaterThan(0);
        expect(
            screen.getAllByRole("button", { name: "Send Now" }),
        ).toHaveLength(1);
        expect(
            screen.getByRole("button", { name: "Delete Second queued item" }),
        ).not.toBeDisabled();
    });

    it("queues a new message from the composer while the agent is streaming", async () => {
        const session = createSession(
            "session-a",
            "Queued conversation",
            "streaming",
        );

        useChatStore.setState((state) => ({
            ...state,
            runtimeConnection: { status: "ready", message: null },
            setupStatus: {
                runtimeId: "codex-acp",
                binaryReady: true,
                binarySource: "bundled",
                authReady: true,
                authMethods: [],
                onboardingRequired: false,
            },
            runtimes: [runtimeDescriptor],
            sessionsById: {
                [session.sessionId]: session,
            },
            sessionOrder: [session.sessionId],
            activeSessionId: session.sessionId,
            composerPartsBySessionId: {
                [session.sessionId]: [],
            },
        }));
        useChatTabsStore.setState({
            tabs: [{ id: "tab-a", sessionId: session.sessionId }],
            activeTabId: "tab-a",
        });

        renderComponent(<AIChatPanel />);

        const textbox = screen.getByRole("textbox", {
            name: "Message VaultAI",
        });
        textbox.textContent = "Queued while streaming";
        fireEvent.input(textbox);

        fireEvent.click(screen.getByRole("button", { name: "Queue" }));

        await waitFor(() => {
            expect(
                useChatStore.getState().queuedMessagesBySessionId[
                    session.sessionId
                ],
            ).toHaveLength(1);
            expect(
                useChatStore.getState().queuedMessagesBySessionId[
                    session.sessionId
                ]?.[0]?.content,
            ).toBe("Queued while streaming");
        });
    });

    it("removes composer screenshots after the configured retention timeout", async () => {
        vi.useFakeTimers();

        const session = createSession("session-a", "Screenshot timeout");
        const screenshotPart: AIComposerPart = {
            id: "shot-1",
            type: "screenshot",
            filePath: "/vault/assets/chat/pasted-image.png",
            mimeType: "image/png",
            label: "Screenshot 10:30 hrs",
        };

        useChatStore.setState((state) => ({
            ...state,
            runtimeConnection: { status: "ready", message: null },
            setupStatus: {
                runtimeId: "codex-acp",
                binaryReady: true,
                binarySource: "bundled",
                authReady: true,
                authMethods: [],
                onboardingRequired: false,
            },
            runtimes: [runtimeDescriptor],
            screenshotRetentionSeconds: 1,
            sessionsById: {
                [session.sessionId]: session,
            },
            sessionOrder: [session.sessionId],
            activeSessionId: session.sessionId,
            composerPartsBySessionId: {
                [session.sessionId]: [
                    { id: "text-before", type: "text", text: "" },
                    screenshotPart,
                    { id: "text-after", type: "text", text: " trailing" },
                ],
            },
        }));
        useChatTabsStore.setState({
            tabs: [{ id: "tab-a", sessionId: session.sessionId }],
            activeTabId: "tab-a",
        });

        renderComponent(<AIChatPanel />);

        expect(
            useChatStore.getState().composerPartsBySessionId[session.sessionId],
        ).toEqual([
            { id: "text-before", type: "text", text: "" },
            screenshotPart,
            { id: "text-after", type: "text", text: " trailing" },
        ]);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(1000);
        });

        expect(
            useChatStore.getState().composerPartsBySessionId[session.sessionId],
        ).toEqual([{ id: "text-before", type: "text", text: " trailing" }]);
    });

    it("exports a chat tab to markdown and opens the created note", async () => {
        const sessionA = createSession("session-a", "First conversation");
        const sessionB = createSession("session-b", "Second conversation");
        const createNote = vi.fn(async (name: string) => ({
            id: "exports/chat-export.md",
            path: "exports/chat-export.md",
            title: name,
            modified_at: 1,
            created_at: 1,
        }));

        invokeMock.mockResolvedValue({
            title: "Exported chat - First conversation",
            path: "exports/chat-export.md",
        });

        useVaultStore.setState({
            vaultPath: "/vault",
            notes: [],
            createNote,
        });
        useChatStore.setState((state) => ({
            ...state,
            runtimeConnection: { status: "ready", message: null },
            setupStatus: {
                runtimeId: "codex-acp",
                binaryReady: true,
                binarySource: "bundled",
                authReady: true,
                authMethods: [],
                onboardingRequired: false,
            },
            runtimes: [runtimeDescriptor],
            sessionsById: {
                [sessionA.sessionId]: sessionA,
                [sessionB.sessionId]: sessionB,
            },
            sessionOrder: [sessionA.sessionId, sessionB.sessionId],
            activeSessionId: sessionA.sessionId,
            composerPartsBySessionId: {
                [sessionA.sessionId]: [],
                [sessionB.sessionId]: [],
            },
        }));
        useChatTabsStore.setState({
            tabs: [
                { id: "tab-a", sessionId: sessionA.sessionId },
                { id: "tab-b", sessionId: sessionB.sessionId },
            ],
            activeTabId: "tab-a",
        });

        renderComponent(<AIChatPanel />);

        fireEvent.contextMenu(
            screen.getByRole("tab", { name: /First conversation/i }),
            {
                clientX: 24,
                clientY: 18,
            },
        );
        fireEvent.click(screen.getByText("Export chat to Markdown"));

        await waitFor(() => {
            expect(createNote).toHaveBeenCalledWith(
                "Exported chat - First conversation",
            );
            expect(invokeMock).toHaveBeenCalledWith(
                "save_note",
                expect.objectContaining({
                    noteId: "exports/chat-export.md",
                    vaultPath: "/vault",
                    content: expect.stringContaining(
                        "# Exported chat: First conversation",
                    ),
                }),
            );
            expect(
                useEditorStore
                    .getState()
                    .tabs.some(
                        (tab) =>
                            isNoteTab(tab) &&
                            tab.noteId === "exports/chat-export.md",
                    ),
            ).toBe(true);
        });
    });

    it("renders the dedicated edits panel and wires its actions outside the message log", async () => {
        const rejectEditedFile = vi.fn(async () => {});
        const rejectAllEditedFiles = vi.fn(async () => {});
        const keepAllEditedFiles = vi.fn();
        const workCycleId = "cycle-1";
        const session = createSession("session-a", "Edit review", "idle", {
            visibleWorkCycleId: workCycleId,
            activeWorkCycleId: workCycleId,
            actionLog: {
                trackedFilesByWorkCycleId: {
                    [workCycleId]: {
                        "/vault/src/watcher.rs": syncDerivedLinePatch({
                            identityKey: "/vault/src/watcher.rs",
                            originPath: "/vault/src/watcher.rs",
                            path: "/vault/src/watcher.rs",
                            previousPath: null,
                            status: { kind: "modified" },
                            diffBase: "old line",
                            currentText: "new line",
                            unreviewedEdits: { edits: [] },
                            version: 1,
                            isText: true,
                            updatedAt: 10,
                        }),
                    },
                },
                lastRejectUndo: null,
            },
        });

        useVaultStore.setState({
            vaultPath: "/vault",
            notes: [
                {
                    id: "notes/watcher",
                    title: "watcher",
                    path: "/vault/src/watcher.rs",
                    modified_at: 1,
                    created_at: 1,
                },
            ],
            entries: [
                {
                    id: "entry/watcher",
                    path: "/vault/src/watcher.rs",
                    relative_path: "src/watcher.rs",
                    title: "watcher.rs",
                    file_name: "watcher.rs",
                    extension: "rs",
                    kind: "file",
                    modified_at: 1,
                    created_at: 1,
                    size: 20,
                    mime_type: "text/rust",
                },
            ],
        });
        useChatStore.setState((state) => ({
            ...state,
            runtimeConnection: { status: "ready", message: null },
            setupStatus: {
                runtimeId: "codex-acp",
                binaryReady: true,
                binarySource: "bundled",
                authReady: true,
                authMethods: [],
                onboardingRequired: false,
            },
            runtimes: [runtimeDescriptor],
            sessionsById: {
                [session.sessionId]: session,
            },
            sessionOrder: [session.sessionId],
            activeSessionId: session.sessionId,
            composerPartsBySessionId: {
                [session.sessionId]: [],
            },
            rejectEditedFile,
            rejectAllEditedFiles,
            keepAllEditedFiles,
        }));
        useChatTabsStore.setState({
            tabs: [{ id: "tab-a", sessionId: session.sessionId }],
            activeTabId: "tab-a",
        });

        renderComponent(<AIChatPanel />);

        expect(screen.getByText("Edits")).toBeTruthy();
        expect(screen.getByText("watcher.rs")).toBeTruthy();
        expect(screen.getByRole("button", { name: "Reject All" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "Keep All" })).toBeTruthy();

        fireEvent.click(screen.getByRole("button", { name: "Review" }));

        await waitFor(() => {
            const reviewTab = useEditorStore
                .getState()
                .tabs.find(
                    (tab) =>
                        isReviewTab(tab) && tab.sessionId === session.sessionId,
                );
            expect(reviewTab).toBeTruthy();
            expect(useEditorStore.getState().activeTabId).toBe(reviewTab?.id);
        });

        fireEvent.click(screen.getByRole("button", { name: "Reject" }));
        expect(rejectEditedFile).toHaveBeenCalledWith(
            session.sessionId,
            "/vault/src/watcher.rs",
        );

        fireEvent.click(screen.getByRole("button", { name: "Reject All" }));
        expect(rejectAllEditedFiles).toHaveBeenCalledWith(session.sessionId);

        fireEvent.click(screen.getByRole("button", { name: "Keep All" }));
        expect(keepAllEditedFiles).toHaveBeenCalledWith(session.sessionId);
    });

    it("opens the dedicated review tab from Edits even for external files", async () => {
        const workCycleId = "cycle-unsupported";
        const session = createSession("session-b", "Unsupported edit", "idle", {
            visibleWorkCycleId: workCycleId,
            activeWorkCycleId: workCycleId,
            actionLog: {
                trackedFilesByWorkCycleId: {
                    [workCycleId]: {
                        "/vault/tmp/result.txt": syncDerivedLinePatch({
                            identityKey: "/vault/tmp/result.txt",
                            originPath: "/vault/tmp/result.txt",
                            path: "/vault/tmp/result.txt",
                            previousPath: null,
                            status: { kind: "modified" },
                            diffBase: "alpha",
                            currentText: "beta",
                            unreviewedEdits: { edits: [] },
                            version: 1,
                            isText: true,
                            updatedAt: 20,
                        }),
                    },
                },
                lastRejectUndo: null,
            },
        });

        useVaultStore.setState({
            vaultPath: "/vault",
            notes: [],
        });
        useChatStore.setState((state) => ({
            ...state,
            runtimeConnection: { status: "ready", message: null },
            setupStatus: {
                runtimeId: "codex-acp",
                binaryReady: true,
                binarySource: "bundled",
                authReady: true,
                authMethods: [],
                onboardingRequired: false,
            },
            runtimes: [runtimeDescriptor],
            sessionsById: {
                [session.sessionId]: session,
            },
            sessionOrder: [session.sessionId],
            activeSessionId: session.sessionId,
            composerPartsBySessionId: {
                [session.sessionId]: [],
            },
        }));
        useChatTabsStore.setState({
            tabs: [{ id: "tab-b", sessionId: session.sessionId }],
            activeTabId: "tab-b",
        });

        renderComponent(<AIChatPanel />);

        const openFileButton = screen.getByRole("button", {
            name: "Open File",
        });
        expect(openFileButton).toBeEnabled();

        fireEvent.click(screen.getByRole("button", { name: "Review" }));

        await waitFor(() => {
            const reviewTab = useEditorStore
                .getState()
                .tabs.find(
                    (tab) =>
                        isReviewTab(tab) && tab.sessionId === session.sessionId,
                );
            expect(reviewTab).toBeTruthy();
            expect(useEditorStore.getState().activeTabId).toBe(reviewTab?.id);
        });
    });

    it("uses the restored session catalog when ACP descriptors are empty", async () => {
        const session = createSession(
            "session-restored",
            "Restored chat",
            "idle",
            {
                isPersistedSession: true,
                runtimeState: "persisted_only",
                models: restoredSessionModels,
                modes: restoredSessionModes,
                configOptions: restoredSessionConfigOptions,
                modelId: "test-model",
                modeId: "default",
            },
        );
        const setMode = vi.fn();
        const setConfigOption = vi.fn();
        const resumeSession = vi.fn(async () => session.sessionId);

        useChatStore.setState((state) => ({
            ...state,
            runtimeConnection: { status: "ready", message: null },
            runtimes: [runtimeDescriptor],
            sessionsById: {
                [session.sessionId]: session,
            },
            sessionOrder: [session.sessionId],
            activeSessionId: session.sessionId,
            selectedRuntimeId: "codex-acp",
            composerPartsBySessionId: {
                [session.sessionId]: [],
            },
            setupStatusByRuntimeId: {
                "codex-acp": {
                    runtimeId: "codex-acp",
                    binaryReady: true,
                    binarySource: "bundled",
                    authReady: true,
                    authMethods: [],
                    onboardingRequired: false,
                },
            },
            runtimeConnectionByRuntimeId: {
                "codex-acp": { status: "ready", message: null },
            },
            resumeSession,
            setMode,
            setConfigOption,
        }));
        useChatTabsStore.setState({
            tabs: [{ id: "tab-restored", sessionId: session.sessionId }],
            activeTabId: "tab-restored",
        });

        renderComponent(<AIChatPanel />);

        const approvalButton = screen.getByTitle("Approval Preset");
        const modelButton = screen.getByTitle("Model");
        const reasoningButton = screen.getByTitle("Reasoning Effort");

        expect(approvalButton).toBeEnabled();
        expect(modelButton).toBeEnabled();
        expect(reasoningButton).toBeEnabled();

        fireEvent.click(approvalButton);
        fireEvent.click(screen.getByRole("button", { name: "Review Mode" }));

        fireEvent.click(modelButton);
        fireEvent.click(screen.getByRole("button", { name: "Wide Model" }));

        fireEvent.click(reasoningButton);
        fireEvent.click(screen.getByRole("button", { name: "High" }));

        expect(setMode).toHaveBeenCalledWith("review-mode", session.sessionId);
        expect(setConfigOption).toHaveBeenNthCalledWith(
            1,
            "model",
            "wide-model",
            session.sessionId,
        );
        expect(setConfigOption).toHaveBeenNthCalledWith(
            2,
            "reasoning_effort",
            "high",
            session.sessionId,
        );
    });

    it("keeps agent controls enabled while the session is streaming", () => {
        const session = createSession(
            "streaming-session",
            "Streaming session",
            "streaming",
            {
                models: restoredSessionModels,
                modes: restoredSessionModes,
                configOptions: restoredSessionConfigOptions,
                effortsByModel: {
                    "test-model": ["medium", "high"],
                    "wide-model": ["medium", "high"],
                },
            },
        );
        const setMode = vi.fn();
        const setConfigOption = vi.fn();

        useChatStore.setState((state) => ({
            ...state,
            runtimeConnection: { status: "ready", message: null },
            runtimes: [runtimeDescriptor],
            sessionsById: {
                [session.sessionId]: session,
            },
            sessionOrder: [session.sessionId],
            activeSessionId: session.sessionId,
            selectedRuntimeId: "codex-acp",
            composerPartsBySessionId: {
                [session.sessionId]: [],
            },
            setupStatusByRuntimeId: {
                "codex-acp": {
                    runtimeId: "codex-acp",
                    binaryReady: true,
                    binarySource: "bundled",
                    authReady: true,
                    authMethods: [],
                    onboardingRequired: false,
                },
            },
            runtimeConnectionByRuntimeId: {
                "codex-acp": { status: "ready", message: null },
            },
            setMode,
            setConfigOption,
        }));
        useChatTabsStore.setState({
            tabs: [{ id: "tab-streaming", sessionId: session.sessionId }],
            activeTabId: "tab-streaming",
        });

        renderComponent(<AIChatPanel />);

        const approvalButton = screen.getByTitle("Approval Preset");
        const reasoningButton = screen.getByTitle("Reasoning Effort");

        expect(approvalButton).toBeEnabled();
        expect(reasoningButton).toBeEnabled();

        fireEvent.click(approvalButton);
        fireEvent.click(screen.getByRole("button", { name: "Review Mode" }));

        fireEvent.click(reasoningButton);
        fireEvent.click(screen.getByRole("button", { name: "High" }));

        expect(setMode).toHaveBeenCalledWith("review-mode", session.sessionId);
        expect(setConfigOption).toHaveBeenCalledWith(
            "reasoning_effort",
            "high",
            session.sessionId,
        );
    });
});
