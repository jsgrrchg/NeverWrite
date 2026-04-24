import { invoke } from "@neverwrite/runtime";
import { useEditorStore, isReviewTab } from "../../../app/store/editorStore";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useVaultStore } from "../../../app/store/vaultStore";
import { renderComponent, setVaultEntries } from "../../../test/test-utils";
import type { AIChatSession } from "../types";
import type { TrackedFile } from "../diff/actionLogTypes";
import { EditedFilesBufferPanel } from "./EditedFilesBufferPanel";
import { resetChatStore, useChatStore } from "../store/chatStore";
import { emptyPatch, syncDerivedLinePatch } from "../store/actionLogModel";

const invokeMock = vi.mocked(invoke);

function createTrackedFile(
    path: string,
    overrides: Partial<TrackedFile> = {},
): TrackedFile {
    const diffBase = overrides.diffBase ?? "old line";
    const currentText = overrides.currentText ?? "new line";
    return syncDerivedLinePatch({
        identityKey: path,
        originPath: path,
        path,
        previousPath: null,
        status: { kind: "modified" },
        diffBase,
        currentText,
        unreviewedEdits: emptyPatch(),
        version: 1,
        isText: true,
        updatedAt: 10,
        ...overrides,
    });
}

function createSession(
    sessionId: string,
    files: TrackedFile[],
    runtimeId = "codex-acp",
): AIChatSession {
    const workCycleId = "cycle-1";
    const tracked: Record<string, TrackedFile> = {};
    for (const file of files) {
        tracked[file.identityKey] = file;
    }

    return {
        sessionId,
        historySessionId: sessionId,
        status: "idle",
        activeWorkCycleId: workCycleId,
        visibleWorkCycleId: workCycleId,
        actionLog:
            files.length > 0
                ? {
                      trackedFilesByWorkCycleId: {
                          [workCycleId]: tracked,
                      },
                      lastRejectUndo: null,
                  }
                : undefined,
        runtimeId,
        modelId: "test-model",
        modeId: "default",
        models: [],
        modes: [],
        configOptions: [],
        messages: [],
        attachments: [],
        isPersistedSession: false,
        resumeContextPending: false,
    };
}

describe("EditedFilesBufferPanel", () => {
    beforeEach(() => {
        resetChatStore();
        vi.clearAllMocks();
        useVaultStore.setState({ vaultPath: "/vault", notes: [] });
    });

    it("does not render when the active session has no visible edited files buffer", () => {
        useChatStore.setState((state) => ({
            ...state,
            activeSessionId: "session-empty",
            sessionsById: {
                "session-empty": {
                    sessionId: "session-empty",
                    historySessionId: "session-empty",
                    status: "idle",
                    activeWorkCycleId: null,
                    visibleWorkCycleId: null,
                    actionLog: undefined,
                    runtimeId: "codex-acp",
                    modelId: "test-model",
                    modeId: "default",
                    models: [],
                    modes: [],
                    configOptions: [],
                    messages: [],
                    attachments: [],
                },
            },
        }));

        renderComponent(<EditedFilesBufferPanel />);

        expect(screen.queryByText("Edits")).not.toBeInTheDocument();
    });

    it("renders legacy tracked files without entering a sync loop", () => {
        const legacyFile: TrackedFile = {
            identityKey: "/vault/src/legacy.ts",
            originPath: "/vault/src/legacy.ts",
            path: "/vault/src/legacy.ts",
            previousPath: null,
            status: { kind: "modified" },
            diffBase: "alpha",
            currentText: "alpHa",
            unreviewedEdits: emptyPatch(),
            version: 1,
            isText: true,
            updatedAt: 10,
        };

        useChatStore.setState((state) => ({
            ...state,
            activeSessionId: "session-legacy",
            sessionsById: {
                "session-legacy": createSession("session-legacy", [legacyFile]),
            },
        }));

        renderComponent(<EditedFilesBufferPanel />);

        expect(screen.getByText("Edits")).toBeInTheDocument();
        expect(screen.getByText("legacy.ts")).toBeInTheDocument();
    });

    it("does not open a review tab automatically when edits appear", () => {
        const session = createSession("session-no-auto-review", [
            createTrackedFile("/vault/src/no-auto-review.ts"),
        ]);

        useChatStore.setState((state) => ({
            ...state,
            activeSessionId: session.sessionId,
            sessionsById: {
                [session.sessionId]: session,
            },
        }));

        renderComponent(<EditedFilesBufferPanel />);

        expect(screen.getByRole("button", { name: "Review" })).toBeVisible();
        expect(
            useEditorStore.getState().tabs.some((tab) => isReviewTab(tab)),
        ).toBe(false);
    });

    it("auto-hides the undo-only banner after five seconds", () => {
        vi.useFakeTimers();

        const session = {
            ...createSession("session-undo", []),
            activeWorkCycleId: "cycle-1",
            visibleWorkCycleId: "cycle-1",
            actionLog: {
                trackedFilesByWorkCycleId: {
                    "cycle-1": {},
                },
                lastRejectUndo: {
                    buffers: [],
                    snapshots: {
                        "/vault/src/a.ts": createTrackedFile("/vault/src/a.ts"),
                    },
                    timestamp: 123,
                },
            },
        } satisfies AIChatSession;

        useChatStore.setState((state) => ({
            ...state,
            activeSessionId: session.sessionId,
            sessionsById: {
                [session.sessionId]: session,
            },
            undoLastReject: vi.fn(async () => {}),
        }));

        renderComponent(<EditedFilesBufferPanel />);

        expect(screen.getByText("Undo last reject")).toBeInTheDocument();

        act(() => {
            vi.advanceTimersByTime(5000);
        });

        expect(screen.queryByText("Undo last reject")).not.toBeInTheDocument();

        vi.useRealTimers();
    });

    it("renders the total summary and the primary actions", () => {
        const session = createSession("session-1", [
            createTrackedFile("/vault/src/a.ts", { updatedAt: 20 }),
            createTrackedFile("/vault/src/b.ts", { updatedAt: 10 }),
        ]);

        useVaultStore.setState({
            vaultPath: "/vault",
            notes: [
                {
                    id: "notes/a",
                    title: "a",
                    path: "/vault/src/a.ts",
                    modified_at: 1,
                    created_at: 1,
                },
            ],
        });
        setVaultEntries([
            {
                id: "notes/a",
                path: "/vault/src/a.ts",
                relative_path: "src/a.ts",
                title: "a",
                file_name: "a.ts",
                extension: "ts",
                kind: "file",
                modified_at: 1,
                created_at: 1,
                size: 10,
                mime_type: "text/typescript",
            },
            {
                id: "notes/b",
                path: "/vault/src/b.ts",
                relative_path: "src/b.ts",
                title: "b",
                file_name: "b.ts",
                extension: "ts",
                kind: "file",
                modified_at: 1,
                created_at: 1,
                size: 10,
                mime_type: "text/typescript",
            },
        ]);
        useChatStore.setState((state) => ({
            ...state,
            activeSessionId: session.sessionId,
            sessionsById: {
                [session.sessionId]: session,
            },
            rejectEditedFile: vi.fn(async () => {}),
            rejectAllEditedFiles: vi.fn(async () => {}),
            keepAllEditedFiles: vi.fn(),
        }));

        renderComponent(<EditedFilesBufferPanel />);

        expect(screen.getByText("Edits")).toBeInTheDocument();
        expect(screen.getByText("(2)")).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "Reject All" }),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "Review" }),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "Keep All" }),
        ).toBeInTheDocument();
        expect(
            screen.getAllByRole("button", { name: "Open File" })[0],
        ).toBeEnabled();
        expect(
            screen.queryByRole("button", { name: "Review Diff" }),
        ).not.toBeInTheDocument();
        expect(screen.getAllByRole("button", { name: "Reject" })).toHaveLength(
            2,
        );
    });

    it("renders conflict rows with a Conflict badge and without a row-level reject action", () => {
        const session = createSession("session-conflict", [
            createTrackedFile("/vault/src/conflict.ts", {
                conflictHash: "different-hash",
            }),
        ]);

        useChatStore.setState((state) => ({
            ...state,
            activeSessionId: session.sessionId,
            sessionsById: {
                [session.sessionId]: session,
            },
            rejectEditedFile: vi.fn(async () => {}),
            rejectAllEditedFiles: vi.fn(async () => {}),
            keepAllEditedFiles: vi.fn(),
        }));

        renderComponent(<EditedFilesBufferPanel />);

        expect(screen.getByText("Conflict")).toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: "Reject" }),
        ).not.toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "Reject All" }),
        ).toBeDisabled();
    });

    it("opens supported text files from the buffer even before the vault index refreshes", async () => {
        const session = createSession("session-open-fallback", [
            createTrackedFile("/vault/tmp/result.txt", {
                diffBase: "alpha",
                currentText: "beta",
            }),
        ]);
        setVaultEntries([]);
        invokeMock.mockImplementation(async (command, args) => {
            if (command === "read_vault_entry") {
                expect(args).toMatchObject({
                    relativePath: "tmp/result.txt",
                });
                return {
                    id: "/vault/tmp/result.txt",
                    path: "/vault/tmp/result.txt",
                    relative_path: "tmp/result.txt",
                    title: "result",
                    file_name: "result.txt",
                    extension: "txt",
                    kind: "file",
                    modified_at: 0,
                    created_at: 0,
                    size: 4,
                    mime_type: "text/plain",
                    is_text_like: true,
                    open_in_app: true,
                    viewer_kind: "text",
                };
            }
            if (command === "read_vault_file") {
                expect(args).toMatchObject({
                    relativePath: "tmp/result.txt",
                });
                return {
                    path: "/vault/tmp/result.txt",
                    relative_path: "tmp/result.txt",
                    file_name: "result.txt",
                    mime_type: "text/plain",
                    content: "beta",
                };
            }
            throw new Error(`Unexpected invoke call: ${command}`);
        });

        useChatStore.setState((state) => ({
            ...state,
            activeSessionId: session.sessionId,
            sessionsById: {
                [session.sessionId]: session,
            },
            rejectEditedFile: vi.fn(async () => {}),
            rejectAllEditedFiles: vi.fn(async () => {}),
            keepAllEditedFiles: vi.fn(),
        }));

        renderComponent(<EditedFilesBufferPanel />);

        const openButton = screen.getByRole("button", { name: "Open File" });
        expect(openButton).toBeEnabled();

        fireEvent.click(openButton);

        await waitFor(() => {
            const activeTab = useEditorStore
                .getState()
                .tabs.find(
                    (tab) => tab.id === useEditorStore.getState().activeTabId,
                );
            expect(activeTab).toMatchObject({
                kind: "file",
                relativePath: "tmp/result.txt",
                path: "/vault/tmp/result.txt",
                title: "result.txt",
            });
        });
    });

    it("keeps Review available even when Open File is disabled", async () => {
        const session = createSession("session-inline", [
            createTrackedFile("/vault/tmp/result.bin", {
                diffBase: "alpha",
                currentText: "beta",
            }),
        ]);
        setVaultEntries([]);

        useChatStore.setState((state) => ({
            ...state,
            activeSessionId: session.sessionId,
            sessionsById: {
                [session.sessionId]: session,
            },
            rejectEditedFile: vi.fn(async () => {}),
            rejectAllEditedFiles: vi.fn(async () => {}),
            keepAllEditedFiles: vi.fn(),
        }));

        renderComponent(<EditedFilesBufferPanel />);

        expect(
            screen.getByRole("button", { name: "Open File" }),
        ).toBeDisabled();

        fireEvent.click(screen.getByRole("button", { name: "Review" }));

        expect(
            useEditorStore
                .getState()
                .tabs.find(
                    (tab) =>
                        isReviewTab(tab) && tab.sessionId === session.sessionId,
                ),
        ).toBeDefined();
    });

    it("opens the full review tab from the panel action", () => {
        const session = createSession("session-review", [
            createTrackedFile("/vault/src/review.ts"),
        ]);

        useChatStore.setState((state) => ({
            ...state,
            activeSessionId: session.sessionId,
            runtimes: [
                {
                    runtime: {
                        id: "codex-acp",
                        name: "Codex ACP",
                        description: "Codex runtime",
                        capabilities: [],
                    },
                    models: [],
                    modes: [],
                    configOptions: [],
                },
            ],
            sessionsById: {
                [session.sessionId]: session,
            },
            rejectEditedFile: vi.fn(async () => {}),
            rejectAllEditedFiles: vi.fn(async () => {}),
            keepAllEditedFiles: vi.fn(),
        }));

        renderComponent(<EditedFilesBufferPanel />);

        fireEvent.click(screen.getByRole("button", { name: "Review" }));

        const { tabs, activeTabId } = useEditorStore.getState();
        const reviewTab = tabs.find(
            (tab) => isReviewTab(tab) && tab.sessionId === session.sessionId,
        );

        expect(reviewTab).toBeDefined();
        expect(activeTabId).toBe(reviewTab?.id);
        expect(reviewTab?.title).toBe("Review Codex");
    });

    it("opens the full review tab with the Kilo runtime title", () => {
        const session = createSession(
            "session-review-kilo",
            [createTrackedFile("/vault/src/review-kilo.ts")],
            "kilo-acp",
        );

        useChatStore.setState((state) => ({
            ...state,
            activeSessionId: session.sessionId,
            runtimes: [
                {
                    runtime: {
                        id: "kilo-acp",
                        name: "Kilo ACP",
                        description: "Kilo runtime",
                        capabilities: [],
                    },
                    models: [],
                    modes: [],
                    configOptions: [],
                },
            ],
            sessionsById: {
                [session.sessionId]: session,
            },
            rejectEditedFile: vi.fn(async () => {}),
            rejectAllEditedFiles: vi.fn(async () => {}),
            keepAllEditedFiles: vi.fn(),
        }));

        renderComponent(<EditedFilesBufferPanel />);

        fireEvent.click(screen.getByRole("button", { name: "Review" }));

        const reviewTab = useEditorStore
            .getState()
            .tabs.find(
                (tab) =>
                    isReviewTab(tab) && tab.sessionId === session.sessionId,
            );

        expect(reviewTab?.title).toBe("Review Kilo");
    });

    it("limits the expanded compact list to four visible items and scrolls the rest", () => {
        const session = createSession("session-scroll", [
            createTrackedFile("/vault/src/one.ts"),
            createTrackedFile("/vault/src/two.ts"),
            createTrackedFile("/vault/src/three.ts"),
            createTrackedFile("/vault/src/four.ts"),
            createTrackedFile("/vault/src/five.ts"),
        ]);

        useChatStore.setState((state) => ({
            ...state,
            activeSessionId: session.sessionId,
            sessionsById: {
                [session.sessionId]: session,
            },
            rejectEditedFile: vi.fn(async () => {}),
            rejectAllEditedFiles: vi.fn(async () => {}),
            keepAllEditedFiles: vi.fn(),
        }));

        renderComponent(<EditedFilesBufferPanel />);

        expect(
            screen.queryByRole("button", { name: "Review Diff" }),
        ).not.toBeInTheDocument();
        expect(
            screen.getAllByRole("button", { name: "Open File" }),
        ).toHaveLength(5);
        expect(screen.getByTestId("edited-files-buffer-list")).toHaveStyle({
            maxHeight: "208px",
            overflowY: "auto",
        });
    });

    it("uses a chevron button to collapse and expand the edits list", () => {
        const session = createSession("session-toggle", [
            createTrackedFile("/vault/src/one.ts"),
        ]);

        useChatStore.setState((state) => ({
            ...state,
            activeSessionId: session.sessionId,
            sessionsById: {
                [session.sessionId]: session,
            },
            rejectEditedFile: vi.fn(async () => {}),
            rejectAllEditedFiles: vi.fn(async () => {}),
            keepAllEditedFiles: vi.fn(),
        }));

        renderComponent(<EditedFilesBufferPanel />);

        const toggle = screen.getByRole("button", {
            name: "Collapse edits",
        });
        expect(toggle).toHaveAttribute("aria-expanded", "true");
        expect(
            screen.getByTestId("edited-files-buffer-list"),
        ).toBeInTheDocument();

        fireEvent.click(toggle);

        expect(toggle).toHaveAttribute("aria-expanded", "false");
        expect(
            screen.queryByTestId("edited-files-buffer-list"),
        ).not.toBeInTheDocument();

        fireEvent.click(toggle);

        expect(toggle).toHaveAttribute("aria-expanded", "true");
        expect(
            screen.getByTestId("edited-files-buffer-list"),
        ).toBeInTheDocument();
    });

    it("keeps file-level actions for add and delete entries without per-hunk buttons", async () => {
        const session = createSession("session-file-level-only", [
            createTrackedFile("/vault/src/added.ts", {
                status: { kind: "created", existingFileContent: null },
                diffBase: "",
                currentText: "created",
            }),
            createTrackedFile("/vault/src/deleted.ts", {
                status: { kind: "deleted" },
                diffBase: "removed",
                currentText: "",
            }),
        ]);

        useChatStore.setState((state) => ({
            ...state,
            activeSessionId: session.sessionId,
            sessionsById: {
                [session.sessionId]: session,
            },
            keepEditedFile: vi.fn(),
            rejectEditedFile: vi.fn(async () => {}),
            rejectAllEditedFiles: vi.fn(async () => {}),
            keepAllEditedFiles: vi.fn(),
        }));

        renderComponent(<EditedFilesBufferPanel />);

        expect(
            screen.queryByRole("button", { name: /Accept hunk/i }),
        ).not.toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: /Reject hunk/i }),
        ).not.toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: "Review Diff" }),
        ).not.toBeInTheDocument();
        expect(screen.getAllByRole("button", { name: "Keep" }).length).toBe(2);
        expect(screen.getAllByRole("button", { name: "Reject" }).length).toBe(
            2,
        );
    });
});
