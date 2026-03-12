import { useEditorStore, isReviewTab } from "../../../app/store/editorStore";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useVaultStore } from "../../../app/store/vaultStore";
import { renderComponent, setVaultEntries } from "../../../test/test-utils";
import type { AIEditedFileBufferEntry, AIChatSession } from "../types";
import { EditedFilesBufferPanel } from "./EditedFilesBufferPanel";
import { resetChatStore, useChatStore } from "../store/chatStore";

function createSession(
    sessionId: string,
    entries: AIEditedFileBufferEntry[],
): AIChatSession {
    const workCycleId = "cycle-1";

    return {
        sessionId,
        historySessionId: sessionId,
        status: "idle",
        activeWorkCycleId: workCycleId,
        visibleWorkCycleId: workCycleId,
        editedFilesBufferByWorkCycleId: {
            [workCycleId]: entries,
        },
        runtimeId: "codex-acp",
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

function createEntry(
    path: string,
    overrides: Partial<AIEditedFileBufferEntry> = {},
): AIEditedFileBufferEntry {
    return {
        identityKey: path,
        originPath: path,
        path,
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
        ...overrides,
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
                    editedFilesBufferByWorkCycleId: {},
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

    it("renders the total summary and the primary actions", () => {
        const session = createSession("session-1", [
            createEntry("/vault/src/a.ts", {
                additions: 2,
                deletions: 1,
                updatedAt: 20,
            }),
            createEntry("/vault/src/b.ts", {
                additions: 0,
                deletions: 3,
                updatedAt: 10,
            }),
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
            resolveEditedFileWithMergedText: vi.fn(async () => {}),
            rejectAllEditedFiles: vi.fn(async () => {}),
            keepAllEditedFiles: vi.fn(),
        }));

        renderComponent(<EditedFilesBufferPanel />);

        expect(screen.getByText("Edits")).toBeInTheDocument();
        expect(screen.getByText("(2)")).toBeInTheDocument();
        expect(screen.getAllByText("+2").length).toBeGreaterThan(0);
        expect(screen.getAllByText("-2").length).toBeGreaterThan(0);
        expect(
            screen.getByRole("button", { name: "Reject All" }),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "Review All" }),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "Keep All" }),
        ).toBeInTheDocument();
        expect(
            screen.getAllByRole("button", { name: "Open File" })[0],
        ).toBeEnabled();
        expect(
            screen.getAllByRole("button", { name: "Review Diff" }),
        ).toHaveLength(2);
        expect(screen.getAllByRole("button", { name: "Reject" })).toHaveLength(
            2,
        );
    });

    it("renders conflict rows with a Conflict badge and without a row-level reject action", () => {
        const session = createSession("session-conflict", [
            createEntry("/vault/src/conflict.ts", {
                status: "conflict",
                currentHash: "different-hash",
            }),
        ]);

        useChatStore.setState((state) => ({
            ...state,
            activeSessionId: session.sessionId,
            sessionsById: {
                [session.sessionId]: session,
            },
            rejectEditedFile: vi.fn(async () => {}),
            resolveEditedFileWithMergedText: vi.fn(async () => {}),
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

    it("keeps Review Diff available inline even when Open File is disabled", async () => {
        const session = createSession("session-inline", [
            createEntry("/vault/tmp/result.txt", {
                baseText: "alpha",
                appliedText: "beta",
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
            resolveEditedFileWithMergedText: vi.fn(async () => {}),
            rejectAllEditedFiles: vi.fn(async () => {}),
            keepAllEditedFiles: vi.fn(),
        }));

        renderComponent(<EditedFilesBufferPanel />);

        expect(
            screen.getByRole("button", { name: "Open File" }),
        ).toBeDisabled();

        fireEvent.click(screen.getByRole("button", { name: "Review Diff" }));

        expect(
            screen.getByTestId("edited-buffer-diff:/vault/tmp/result.txt"),
        ).toBeInTheDocument();
        expect(screen.getByText("+ beta")).toBeInTheDocument();
        expect(screen.getByText("- alpha")).toBeInTheDocument();
    });

    it("renders exact hunk line numbers in the inline review diff", () => {
        const session = createSession("session-inline-hunks", [
            createEntry("/vault/tmp/result.txt", {
                baseText: "legacy alpha",
                appliedText: "legacy beta",
                hunks: [
                    {
                        old_start: 8,
                        old_count: 2,
                        new_start: 8,
                        new_count: 2,
                        lines: [
                            { type: "context", text: "shared" },
                            { type: "remove", text: "alpha" },
                            { type: "add", text: "beta" },
                        ],
                    },
                ],
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
            resolveEditedFileWithMergedText: vi.fn(async () => {}),
            rejectAllEditedFiles: vi.fn(async () => {}),
            keepAllEditedFiles: vi.fn(),
        }));

        renderComponent(<EditedFilesBufferPanel />);

        fireEvent.click(screen.getByRole("button", { name: "Review Diff" }));

        expect(screen.getAllByText("8").length).toBeGreaterThanOrEqual(1);
        expect(screen.getAllByText("9").length).toBeGreaterThanOrEqual(1);
        expect(screen.getByText("shared")).toBeInTheDocument();
        expect(screen.getByText("alpha")).toBeInTheDocument();
        expect(screen.getByText("beta")).toBeInTheDocument();
        expect(screen.queryByText("+ beta")).not.toBeInTheDocument();
        expect(screen.queryByText("- alpha")).not.toBeInTheDocument();
    });

    it("opens the full review tab from the panel action", () => {
        const session = createSession("session-review", [
            createEntry("/vault/src/review.ts"),
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
            resolveEditedFileWithMergedText: vi.fn(async () => {}),
            rejectAllEditedFiles: vi.fn(async () => {}),
            keepAllEditedFiles: vi.fn(),
        }));

        renderComponent(<EditedFilesBufferPanel />);

        fireEvent.click(screen.getByRole("button", { name: "Review All" }));

        const { tabs, activeTabId } = useEditorStore.getState();
        const reviewTab = tabs.find(
            (tab) => isReviewTab(tab) && tab.sessionId === session.sessionId,
        );

        expect(reviewTab).toBeDefined();
        expect(activeTabId).toBe(reviewTab?.id);
        expect(reviewTab?.title).toBe("Review Codex");
    });

    it("limits the expanded compact list to four visible items and scrolls the rest", () => {
        const session = createSession("session-scroll", [
            createEntry("/vault/src/one.ts"),
            createEntry("/vault/src/two.ts"),
            createEntry("/vault/src/three.ts"),
            createEntry("/vault/src/four.ts"),
            createEntry("/vault/src/five.ts"),
        ]);

        useChatStore.setState((state) => ({
            ...state,
            activeSessionId: session.sessionId,
            sessionsById: {
                [session.sessionId]: session,
            },
            rejectEditedFile: vi.fn(async () => {}),
            resolveEditedFileWithMergedText: vi.fn(async () => {}),
            rejectAllEditedFiles: vi.fn(async () => {}),
            keepAllEditedFiles: vi.fn(),
        }));

        renderComponent(<EditedFilesBufferPanel />);

        expect(
            screen.getAllByRole("button", { name: "Review Diff" }),
        ).toHaveLength(5);
        expect(screen.getByTestId("edited-files-buffer-list")).toHaveStyle({
            maxHeight: "208px",
            overflowY: "auto",
        });
    });

    it("uses a chevron button to collapse and expand the edits list", () => {
        const session = createSession("session-toggle", [
            createEntry("/vault/src/one.ts"),
        ]);

        useChatStore.setState((state) => ({
            ...state,
            activeSessionId: session.sessionId,
            sessionsById: {
                [session.sessionId]: session,
            },
            rejectEditedFile: vi.fn(async () => {}),
            resolveEditedFileWithMergedText: vi.fn(async () => {}),
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

    it("resolves mixed per-hunk decisions into merged text", async () => {
        const resolveEditedFileWithMergedText = vi.fn(async () => {});
        const session = createSession("session-hunk-resolve", [
            createEntry("/vault/src/mixed.ts", {
                baseText: "a\nold1\nc\nd\nold2\nf",
                appliedText: "a\nnew1\nc\nd\nnew2\nf",
                hunks: [
                    {
                        old_start: 2,
                        old_count: 1,
                        new_start: 2,
                        new_count: 1,
                        lines: [
                            { type: "remove", text: "old1" },
                            { type: "add", text: "new1" },
                        ],
                    },
                    {
                        old_start: 5,
                        old_count: 1,
                        new_start: 5,
                        new_count: 1,
                        lines: [
                            { type: "remove", text: "old2" },
                            { type: "add", text: "new2" },
                        ],
                    },
                ],
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
            resolveEditedFileWithMergedText,
            rejectAllEditedFiles: vi.fn(async () => {}),
            keepAllEditedFiles: vi.fn(),
        }));

        renderComponent(<EditedFilesBufferPanel />);

        fireEvent.click(screen.getByRole("button", { name: "Review Diff" }));
        fireEvent.click(screen.getByRole("button", { name: "Accept hunk 1" }));
        fireEvent.click(screen.getByRole("button", { name: "Reject hunk 2" }));

        await waitFor(() =>
            expect(resolveEditedFileWithMergedText).toHaveBeenCalledWith(
                "session-hunk-resolve",
                "/vault/src/mixed.ts",
                "a\nnew1\nc\nd\nold2\nf",
            ),
        );
    });

    it("renders nearby changes in one visual block but resolves them independently", async () => {
        const resolveEditedFileWithMergedText = vi.fn(async () => {});
        const session = createSession("session-nearby-hunks", [
            createEntry("/vault/src/nearby.ts", {
                baseText: "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl",
                appliedText: "a\nb\nC\nd\ne\nf\ng\nH\ni\nj\nk\nl",
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
            resolveEditedFileWithMergedText,
            rejectAllEditedFiles: vi.fn(async () => {}),
            keepAllEditedFiles: vi.fn(),
        }));

        renderComponent(<EditedFilesBufferPanel />);

        fireEvent.click(screen.getByRole("button", { name: "Review Diff" }));

        expect(screen.getByText("Linked changes")).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "Accept hunk 1" }),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "Accept hunk 2" }),
        ).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "Accept hunk 1" }));
        fireEvent.click(screen.getByRole("button", { name: "Reject hunk 2" }));

        await waitFor(() =>
            expect(resolveEditedFileWithMergedText).toHaveBeenCalledWith(
                "session-nearby-hunks",
                "/vault/src/nearby.ts",
                "a\nb\nC\nd\ne\nf\ng\nh\ni\nj\nk\nl",
            ),
        );
    });

    it("treats all accepted decision hunks as Keep", async () => {
        const keepEditedFile = vi.fn();
        const session = createSession("session-hunk-keep", [
            createEntry("/vault/src/keep.ts", {
                baseText: "a\nold1\nc\nd\nold2\nf",
                appliedText: "a\nnew1\nc\nd\nnew2\nf",
                hunks: [
                    {
                        old_start: 2,
                        old_count: 1,
                        new_start: 2,
                        new_count: 1,
                        lines: [
                            { type: "remove", text: "old1" },
                            { type: "add", text: "new1" },
                        ],
                    },
                    {
                        old_start: 5,
                        old_count: 1,
                        new_start: 5,
                        new_count: 1,
                        lines: [
                            { type: "remove", text: "old2" },
                            { type: "add", text: "new2" },
                        ],
                    },
                ],
            }),
        ]);

        useChatStore.setState((state) => ({
            ...state,
            activeSessionId: session.sessionId,
            sessionsById: {
                [session.sessionId]: session,
            },
            keepEditedFile,
            rejectEditedFile: vi.fn(async () => {}),
            resolveEditedFileWithMergedText: vi.fn(async () => {}),
            rejectAllEditedFiles: vi.fn(async () => {}),
            keepAllEditedFiles: vi.fn(),
        }));

        renderComponent(<EditedFilesBufferPanel />);

        fireEvent.click(screen.getByRole("button", { name: "Review Diff" }));
        fireEvent.click(screen.getByRole("button", { name: "Accept hunk 1" }));
        fireEvent.click(screen.getByRole("button", { name: "Accept hunk 2" }));

        await waitFor(() =>
            expect(keepEditedFile).toHaveBeenCalledWith(
                "session-hunk-keep",
                "/vault/src/keep.ts",
            ),
        );
    });

    it("treats all rejected decision hunks as Reject", async () => {
        const rejectEditedFile = vi.fn(async () => {});
        const session = createSession("session-hunk-reject", [
            createEntry("/vault/src/reject.ts", {
                baseText: "a\nold1\nc\nd\nold2\nf",
                appliedText: "a\nnew1\nc\nd\nnew2\nf",
                hunks: [
                    {
                        old_start: 2,
                        old_count: 1,
                        new_start: 2,
                        new_count: 1,
                        lines: [
                            { type: "remove", text: "old1" },
                            { type: "add", text: "new1" },
                        ],
                    },
                    {
                        old_start: 5,
                        old_count: 1,
                        new_start: 5,
                        new_count: 1,
                        lines: [
                            { type: "remove", text: "old2" },
                            { type: "add", text: "new2" },
                        ],
                    },
                ],
            }),
        ]);

        useChatStore.setState((state) => ({
            ...state,
            activeSessionId: session.sessionId,
            sessionsById: {
                [session.sessionId]: session,
            },
            keepEditedFile: vi.fn(),
            rejectEditedFile,
            resolveEditedFileWithMergedText: vi.fn(async () => {}),
            rejectAllEditedFiles: vi.fn(async () => {}),
            keepAllEditedFiles: vi.fn(),
        }));

        renderComponent(<EditedFilesBufferPanel />);

        fireEvent.click(screen.getByRole("button", { name: "Review Diff" }));
        fireEvent.click(screen.getByRole("button", { name: "Reject hunk 1" }));
        fireEvent.click(screen.getByRole("button", { name: "Reject hunk 2" }));

        await waitFor(() =>
            expect(rejectEditedFile).toHaveBeenCalledWith(
                "session-hunk-reject",
                "/vault/src/reject.ts",
            ),
        );
    });

    it("keeps file-level actions for add and delete entries without per-hunk buttons", async () => {
        const session = createSession("session-file-level-only", [
            createEntry("/vault/src/added.ts", {
                identityKey: "/vault/src/added.ts",
                operation: "add",
                baseText: null,
                appliedText: "created",
                additions: 1,
                deletions: 0,
            }),
            createEntry("/vault/src/deleted.ts", {
                identityKey: "/vault/src/deleted.ts",
                operation: "delete",
                baseText: "removed",
                appliedText: null,
                additions: 0,
                deletions: 1,
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
            resolveEditedFileWithMergedText: vi.fn(async () => {}),
            rejectAllEditedFiles: vi.fn(async () => {}),
            keepAllEditedFiles: vi.fn(),
        }));

        renderComponent(<EditedFilesBufferPanel />);

        const reviewButtons = screen.getAllByRole("button", {
            name: "Review Diff",
        });
        fireEvent.click(reviewButtons[0]!);
        fireEvent.click(reviewButtons[1]!);

        expect(
            screen.queryByRole("button", { name: /Accept hunk/i }),
        ).not.toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: /Reject hunk/i }),
        ).not.toBeInTheDocument();
        expect(screen.getAllByRole("button", { name: "Keep" }).length).toBe(2);
        expect(screen.getAllByRole("button", { name: "Reject" }).length).toBe(
            2,
        );
    });
});
