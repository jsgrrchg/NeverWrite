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

function createSession(sessionId: string, files: TrackedFile[]): AIChatSession {
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
            resolveEditedFileWithMergedText: vi.fn(async () => {}),
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
            screen.getAllByRole("button", { name: "Review Diff" }),
        ).toHaveLength(2);
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
            createTrackedFile("/vault/tmp/result.txt", {
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
        expect(screen.getByText("beta")).toBeInTheDocument();
        expect(screen.getByText("alpha")).toBeInTheDocument();
    });

    it("renders exact hunk line numbers in the inline review diff", () => {
        // Create a file where the unreviewedEdits produce hunks at specific positions
        const lines = Array.from({ length: 12 }, (_, i) => `line-${i + 1}`);
        const newLines = [...lines];
        newLines[7] = "beta"; // change at line 8 (0-indexed: 7)
        const session = createSession("session-inline-hunks", [
            createTrackedFile("/vault/tmp/result.txt", {
                diffBase: lines.join("\n"),
                currentText: newLines.join("\n"),
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
        expect(screen.getByText("beta")).toBeInTheDocument();
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
            resolveEditedFileWithMergedText: vi.fn(async () => {}),
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
            createTrackedFile("/vault/src/one.ts"),
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

    it("resolves mixed per-hunk decisions via immediate mode", async () => {
        const resolveReviewHunks = vi.fn(async () => {});
        const session = createSession("session-hunk-resolve", [
            createTrackedFile("/vault/src/mixed.ts", {
                diffBase: "a\nold1\nc\nd\nold2\nf",
                currentText: "a\nnew1\nc\nd\nnew2\nf",
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
            resolveReviewHunks,
        }));

        renderComponent(<EditedFilesBufferPanel />);

        fireEvent.click(screen.getByRole("button", { name: "Review Diff" }));
        fireEvent.click(screen.getByRole("button", { name: "Accept hunk 1" }));

        await waitFor(() =>
            expect(resolveReviewHunks).toHaveBeenCalledWith(
                "session-hunk-resolve",
                "/vault/src/mixed.ts",
                "accepted",
                1,
                expect.arrayContaining([
                    expect.objectContaining({
                        trackedVersion: 1,
                        key: expect.any(String),
                    }),
                ]),
            ),
        );

        fireEvent.click(screen.getByRole("button", { name: "Reject hunk 2" }));

        await waitFor(() =>
            expect(resolveReviewHunks).toHaveBeenCalledWith(
                "session-hunk-resolve",
                "/vault/src/mixed.ts",
                "rejected",
                1,
                expect.arrayContaining([
                    expect.objectContaining({
                        trackedVersion: 1,
                        key: expect.any(String),
                    }),
                ]),
            ),
        );
    });

    it("renders nearby changes in one visual block but resolves them independently", async () => {
        const resolveReviewHunks = vi.fn(async () => {});
        const session = createSession("session-nearby-hunks", [
            createTrackedFile("/vault/src/nearby.ts", {
                diffBase: "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl",
                currentText: "a\nb\nC\nd\ne\nf\ng\nH\ni\nj\nk\nl",
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
            resolveReviewHunks,
        }));

        renderComponent(<EditedFilesBufferPanel />);

        fireEvent.click(screen.getByRole("button", { name: "Review Diff" }));

        expect(
            screen.getByRole("button", { name: "Accept hunk 1" }),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "Accept hunk 2" }),
        ).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "Accept hunk 1" }));

        await waitFor(() =>
            expect(resolveReviewHunks).toHaveBeenCalledWith(
                "session-nearby-hunks",
                "/vault/src/nearby.ts",
                "accepted",
                1,
                expect.arrayContaining([
                    expect.objectContaining({
                        trackedVersion: 1,
                        key: expect.any(String),
                    }),
                ]),
            ),
        );
    });

    it("treats accepted decision hunks via immediate resolve", async () => {
        const resolveReviewHunks = vi.fn(async () => {});
        const session = createSession("session-hunk-keep", [
            createTrackedFile("/vault/src/keep.ts", {
                diffBase: "a\nold1\nc\nd\nold2\nf",
                currentText: "a\nnew1\nc\nd\nnew2\nf",
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
            resolveReviewHunks,
        }));

        renderComponent(<EditedFilesBufferPanel />);

        fireEvent.click(screen.getByRole("button", { name: "Review Diff" }));
        fireEvent.click(screen.getByRole("button", { name: "Accept hunk 1" }));

        await waitFor(() =>
            expect(resolveReviewHunks).toHaveBeenCalledWith(
                "session-hunk-keep",
                "/vault/src/keep.ts",
                "accepted",
                1,
                expect.arrayContaining([
                    expect.objectContaining({
                        trackedVersion: 1,
                        key: expect.any(String),
                    }),
                ]),
            ),
        );
    });

    it("treats rejected decision hunks via immediate resolve", async () => {
        const resolveReviewHunks = vi.fn(async () => {});
        const session = createSession("session-hunk-reject", [
            createTrackedFile("/vault/src/reject.ts", {
                diffBase: "a\nold1\nc\nd\nold2\nf",
                currentText: "a\nnew1\nc\nd\nnew2\nf",
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
            resolveReviewHunks,
        }));

        renderComponent(<EditedFilesBufferPanel />);

        fireEvent.click(screen.getByRole("button", { name: "Review Diff" }));
        fireEvent.click(screen.getByRole("button", { name: "Reject hunk 1" }));

        await waitFor(() =>
            expect(resolveReviewHunks).toHaveBeenCalledWith(
                "session-hunk-reject",
                "/vault/src/reject.ts",
                "rejected",
                1,
                expect.arrayContaining([
                    expect.objectContaining({
                        trackedVersion: 1,
                        key: expect.any(String),
                    }),
                ]),
            ),
        );
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
