import { invoke } from "@tauri-apps/api/core";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useEditorStore } from "../../app/store/editorStore";
import { useVaultStore } from "../../app/store/vaultStore";
import { renderComponent } from "../../test/test-utils";
import type {
    AIChatAttachment,
    AIChatSession,
    AIComposerPart,
    AIEditedFileBufferEntry,
    AIRuntimeDescriptor,
} from "./types";
import { AIChatPanel } from "./AIChatPanel";
import { resetChatStore, useChatStore } from "./store/chatStore";
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
        editedFilesBufferByWorkCycleId:
            overrides.editedFilesBufferByWorkCycleId ?? {},
        isPersistedSession: overrides.isPersistedSession,
        isResumingSession: overrides.isResumingSession,
        resumeContextPending: overrides.resumeContextPending,
        effortsByModel: overrides.effortsByModel,
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
            pendingReveal: null,
            pendingSelectionReveal: null,
            currentSelection: null,
        });
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
                "session-a",
                "session-b",
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
            expect(textbox.textContent).toContain("Draft B");
            expect(screen.queryByText("Doc A")).toBeNull();
            expect(screen.getByText("Doc B")).toBeTruthy();
            expect(screen.getByLabelText("Send")).not.toBeDisabled();
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

    it("prioritizes a queued item when clicking send now", async () => {
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
            expect(
                useChatStore
                    .getState()
                    .queuedMessagesBySessionId[
                        session.sessionId
                    ]?.map((item) => item.id),
            ).toEqual(["queued-2", "queued-1"]);
        });
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
            title: "Chat exportado - First conversation",
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
                "Chat exportado - First conversation",
            );
            expect(invokeMock).toHaveBeenCalledWith(
                "save_note",
                expect.objectContaining({
                    noteId: "exports/chat-export.md",
                    vaultPath: "/vault",
                    content: expect.stringContaining(
                        "# Chat exportado: First conversation",
                    ),
                }),
            );
            expect(
                useEditorStore
                    .getState()
                    .tabs.some(
                        (tab) => tab.noteId === "exports/chat-export.md",
                    ),
            ).toBe(true);
        });
    });

    it("renders the dedicated edits panel and wires its actions outside the message log", async () => {
        const rejectEditedFile = vi.fn(async () => {});
        const rejectAllEditedFiles = vi.fn(async () => {});
        const keepAllEditedFiles = vi.fn();
        const workCycleId = "cycle-1";
        const entry: AIEditedFileBufferEntry = {
            identityKey: "/vault/src/watcher.rs",
            originPath: "/vault/src/watcher.rs",
            path: "/vault/src/watcher.rs",
            previousPath: null,
            operation: "update",
            baseText: "old line",
            appliedText: "new line",
            reversible: true,
            isText: true,
            supported: true,
            status: "pending",
            appliedHash: "hash-1",
            currentHash: null,
            additions: 1,
            deletions: 1,
            updatedAt: 10,
        };
        const session = createSession("session-a", "Edit review", "idle", {
            visibleWorkCycleId: workCycleId,
            activeWorkCycleId: workCycleId,
            editedFilesBufferByWorkCycleId: {
                [workCycleId]: [entry],
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

        fireEvent.click(screen.getByRole("button", { name: "Review Diff" }));

        await waitFor(() => {
            expect(
                screen.getByTestId("edited-buffer-diff:/vault/src/watcher.rs"),
            ).toBeTruthy();
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

    it("disables Open File for unsupported entries while keeping Review Diff inline", async () => {
        const workCycleId = "cycle-unsupported";
        const entry: AIEditedFileBufferEntry = {
            identityKey: "/vault/tmp/result.txt",
            originPath: "/vault/tmp/result.txt",
            path: "/vault/tmp/result.txt",
            previousPath: null,
            operation: "update",
            baseText: "alpha",
            appliedText: "beta",
            reversible: true,
            isText: true,
            supported: true,
            status: "pending",
            appliedHash: "hash-2",
            currentHash: null,
            additions: 1,
            deletions: 1,
            updatedAt: 20,
        };
        const session = createSession("session-b", "Unsupported edit", "idle", {
            visibleWorkCycleId: workCycleId,
            activeWorkCycleId: workCycleId,
            editedFilesBufferByWorkCycleId: {
                [workCycleId]: [entry],
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
        expect(openFileButton).toBeDisabled();

        fireEvent.click(screen.getByRole("button", { name: "Review Diff" }));

        await waitFor(() => {
            expect(
                screen.getByTestId("edited-buffer-diff:/vault/tmp/result.txt"),
            ).toBeTruthy();
            expect(screen.getByText("+ beta")).toBeTruthy();
            expect(screen.getByText("- alpha")).toBeTruthy();
        });
    });
});
