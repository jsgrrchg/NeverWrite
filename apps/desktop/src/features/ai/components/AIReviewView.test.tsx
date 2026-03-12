import { fireEvent, screen } from "@testing-library/react";
import { waitFor } from "@testing-library/react";
import { describe, expect, it, beforeEach, vi } from "vitest";
import { useEditorStore } from "../../../app/store/editorStore";
import {
    renderComponent,
    setVaultEntries,
    setVaultNotes,
} from "../../../test/test-utils";
import { resetChatStore, useChatStore } from "../store/chatStore";
import type { AIEditedFileBufferEntry, AIChatSession } from "../types";
import { AIReviewView } from "./AIReviewView";

function makeSession(
    sessionId: string,
    buffer: AIEditedFileBufferEntry[] = [],
): AIChatSession {
    return {
        sessionId,
        historySessionId: sessionId,
        status: "idle",
        runtimeId: "codex-acp",
        modelId: "test-model",
        modeId: "default",
        models: [],
        modes: [],
        configOptions: [],
        messages: [],
        attachments: [],
        editedFilesBuffer: buffer,
    };
}

function makeEntry(
    overrides: Partial<AIEditedFileBufferEntry> = {},
): AIEditedFileBufferEntry {
    return {
        identityKey: overrides.identityKey ?? "key-1",
        originPath: overrides.originPath ?? "/vault/test.md",
        path: overrides.path ?? "/vault/test.md",
        operation: overrides.operation ?? "update",
        baseText: overrides.baseText ?? "old line",
        appliedText: overrides.appliedText ?? "new line",
        reversible: overrides.reversible ?? true,
        isText: overrides.isText ?? true,
        hunks: overrides.hunks,
        supported: overrides.supported ?? true,
        status: overrides.status ?? "pending",
        appliedHash: overrides.appliedHash ?? "abc123",
        additions: overrides.additions ?? 1,
        deletions: overrides.deletions ?? 1,
        updatedAt: overrides.updatedAt ?? Date.now(),
    };
}

function setupReviewTab(sessionId: string) {
    useEditorStore.setState({
        tabs: [
            {
                id: `review-${sessionId}`,
                kind: "ai-review" as const,
                sessionId,
                title: "Review",
            },
        ],
        activeTabId: `review-${sessionId}`,
    });
}

function setOpenableNoteEntry(path: string, title = "Alpha") {
    setVaultNotes([
        {
            id: path,
            title,
            path,
            modified_at: 0,
            created_at: 0,
        },
    ]);
    setVaultEntries([
        {
            id: path,
            path,
            relative_path: path.replace("/vault/", ""),
            title,
            file_name: path.split("/").pop() ?? title,
            extension: "md",
            kind: "note",
            modified_at: 0,
            created_at: 0,
            size: 10,
            mime_type: "text/markdown",
        },
    ]);
}

describe("AIReviewView", () => {
    beforeEach(() => {
        resetChatStore();
        vi.clearAllMocks();
    });

    it("shows fallback when no review tab is active", () => {
        renderComponent(<AIReviewView />);
        expect(screen.getByText("No review tab active")).toBeInTheDocument();
    });

    it("shows empty state when session has no buffer entries", () => {
        const sessionId = "sess-1";
        setupReviewTab(sessionId);
        useChatStore.setState({
            sessionsById: { [sessionId]: makeSession(sessionId) },
            activeSessionId: sessionId,
        });

        renderComponent(<AIReviewView />);
        expect(screen.getByText("No pending AI edits")).toBeInTheDocument();
    });

    it("renders file entries with diff stats", () => {
        const sessionId = "sess-2";
        const entry = makeEntry({
            identityKey: "e1",
            path: "/vault/notes/hello.md",
            originPath: "/vault/notes/hello.md",
            additions: 3,
            deletions: 1,
        });

        setupReviewTab(sessionId);
        useChatStore.setState({
            sessionsById: {
                [sessionId]: makeSession(sessionId, [entry]),
            },
            activeSessionId: sessionId,
        });

        renderComponent(<AIReviewView />);
        expect(screen.getByText("hello.md")).toBeInTheDocument();
        expect(screen.getAllByText("+3").length).toBeGreaterThanOrEqual(1);
        expect(screen.getAllByText("-1").length).toBeGreaterThanOrEqual(1);
    });

    it("shows Reject All and Keep All buttons", () => {
        const sessionId = "sess-3";
        setupReviewTab(sessionId);
        useChatStore.setState({
            sessionsById: {
                [sessionId]: makeSession(sessionId, [makeEntry()]),
            },
            activeSessionId: sessionId,
        });

        renderComponent(<AIReviewView />);
        expect(screen.getByText("Reject All")).toBeInTheDocument();
        expect(screen.getByText("Keep All")).toBeInTheDocument();
    });

    it("shows Conflict badge for conflict entries", () => {
        const sessionId = "sess-4";
        const entry = makeEntry({
            identityKey: "conflict-1",
            status: "conflict",
        });

        setupReviewTab(sessionId);
        useChatStore.setState({
            sessionsById: {
                [sessionId]: makeSession(sessionId, [entry]),
            },
            activeSessionId: sessionId,
        });

        renderComponent(<AIReviewView />);
        expect(screen.getByText("Conflict")).toBeInTheDocument();
    });

    it("shows Open File button when note exists in vault", () => {
        const sessionId = "sess-5";
        const entry = makeEntry({
            identityKey: "open-1",
            path: "/vault/notes/alpha.md",
            originPath: "/vault/notes/alpha.md",
        });

        setOpenableNoteEntry("/vault/notes/alpha.md");
        setupReviewTab(sessionId);
        useChatStore.setState({
            sessionsById: {
                [sessionId]: makeSession(sessionId, [entry]),
            },
            activeSessionId: sessionId,
        });

        renderComponent(<AIReviewView />);
        expect(
            screen.getByRole("button", { name: "Open File" }),
        ).toBeInTheDocument();
    });

    it("enables Open File for supported non-note vault files", () => {
        const sessionId = "sess-file";
        const entry = makeEntry({
            identityKey: "open-file-1",
            path: "/vault/src/mod.rs",
            originPath: "/vault/src/mod.rs",
        });

        setVaultEntries([
            {
                id: "src/mod.rs",
                path: "/vault/src/mod.rs",
                relative_path: "src/mod.rs",
                title: "mod.rs",
                file_name: "mod.rs",
                extension: "rs",
                kind: "file",
                modified_at: 0,
                created_at: 0,
                size: 20,
                mime_type: "text/rust",
            },
        ]);

        setupReviewTab(sessionId);
        useChatStore.setState({
            sessionsById: {
                [sessionId]: makeSession(sessionId, [entry]),
            },
            activeSessionId: sessionId,
        });

        renderComponent(<AIReviewView />);
        expect(screen.getByRole("button", { name: "Open File" })).toBeEnabled();
    });

    it("scopes review actions to the review tab session instead of the active chat session", () => {
        const reviewSessionId = "sess-review";
        const activeSessionId = "sess-active";
        const rejectEditedFile = vi.fn(async () => {});
        const rejectAllEditedFiles = vi.fn(async () => {});
        const keepAllEditedFiles = vi.fn();
        const entry = makeEntry({
            identityKey: "scoped-entry",
            path: "/vault/scoped.md",
            originPath: "/vault/scoped.md",
        });

        setOpenableNoteEntry("/vault/scoped.md", "Scoped");
        setupReviewTab(reviewSessionId);
        useChatStore.setState((state) => ({
            ...state,
            sessionsById: {
                [reviewSessionId]: makeSession(reviewSessionId, [entry]),
                [activeSessionId]: makeSession(activeSessionId, [
                    makeEntry({
                        identityKey: "other-entry",
                        path: "/vault/other.md",
                        originPath: "/vault/other.md",
                    }),
                ]),
            },
            activeSessionId,
            rejectEditedFile,
            rejectAllEditedFiles,
            keepAllEditedFiles,
        }));

        renderComponent(<AIReviewView />);

        fireEvent.click(screen.getByRole("button", { name: "Reject" }));
        fireEvent.click(screen.getByRole("button", { name: "Reject All" }));
        fireEvent.click(screen.getByRole("button", { name: "Keep All" }));

        expect(rejectEditedFile).toHaveBeenCalledWith(
            reviewSessionId,
            "scoped-entry",
        );
        expect(rejectAllEditedFiles).toHaveBeenCalledWith(reviewSessionId);
        expect(keepAllEditedFiles).toHaveBeenCalledWith(reviewSessionId);
    });

    it("toggles file expansion on click", () => {
        const sessionId = "sess-6";
        const entry = makeEntry({
            identityKey: "toggle-1",
            baseText: "old content",
            appliedText: "new content",
        });

        setupReviewTab(sessionId);
        useChatStore.setState({
            sessionsById: {
                [sessionId]: makeSession(sessionId, [entry]),
            },
            activeSessionId: sessionId,
        });

        renderComponent(<AIReviewView />);

        // With a single entry, it starts expanded (<=5 entries rule).
        // The Reject button is visible when expanded.
        expect(screen.getByText("Reject")).toBeInTheDocument();

        // Click the header to collapse
        fireEvent.click(screen.getByText("test.md"));
        expect(screen.queryByText("Reject")).not.toBeInTheDocument();

        // Click again to expand
        fireEvent.click(screen.getByText("test.md"));
        expect(screen.getByText("Reject")).toBeInTheDocument();
    });

    it("renders exact hunk gutters in the full review view", () => {
        const sessionId = "sess-hunks";
        const entry = makeEntry({
            identityKey: "exact-hunk-entry",
            baseText: "legacy old",
            appliedText: "legacy new",
            hunks: [
                {
                    old_start: 15,
                    old_count: 2,
                    new_start: 15,
                    new_count: 2,
                    lines: [
                        { type: "context", text: "shared" },
                        { type: "remove", text: "old content" },
                        { type: "add", text: "new content" },
                    ],
                },
            ],
        });

        setupReviewTab(sessionId);
        useChatStore.setState({
            sessionsById: {
                [sessionId]: makeSession(sessionId, [entry]),
            },
            activeSessionId: sessionId,
        });

        renderComponent(<AIReviewView />);

        expect(screen.getAllByText("15").length).toBeGreaterThanOrEqual(1);
        expect(screen.getAllByText("16").length).toBeGreaterThanOrEqual(1);
        expect(screen.getByText("shared")).toBeInTheDocument();
        expect(screen.getByText("old content")).toBeInTheDocument();
        expect(screen.getByText("new content")).toBeInTheDocument();
    });

    it("resolves nearby changes independently inside one visual block", async () => {
        const sessionId = "sess-nearby";
        const resolveEditedFileWithMergedText = vi.fn(async () => {});
        const entry = makeEntry({
            identityKey: "nearby-entry",
            path: "/vault/nearby.md",
            originPath: "/vault/nearby.md",
            baseText: "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl",
            appliedText: "a\nb\nC\nd\ne\nf\ng\nH\ni\nj\nk\nl",
        });

        setupReviewTab(sessionId);
        useChatStore.setState({
            sessionsById: {
                [sessionId]: makeSession(sessionId, [entry]),
            },
            activeSessionId: sessionId,
            rejectEditedFile: vi.fn(async () => {}),
            keepEditedFile: vi.fn(),
            keepAllEditedFiles: vi.fn(),
            rejectAllEditedFiles: vi.fn(async () => {}),
            resolveEditedFileWithMergedText,
        });

        renderComponent(<AIReviewView />);

        expect(screen.getByText("Linked changes")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Accept hunk 1" }));
        fireEvent.click(screen.getByRole("button", { name: "Reject hunk 2" }));

        await waitFor(() =>
            expect(resolveEditedFileWithMergedText).toHaveBeenCalledWith(
                sessionId,
                "nearby-entry",
                "a\nb\nC\nd\ne\nf\ng\nh\ni\nj\nk\nl",
            ),
        );
    });

    it("shows summary with file count", () => {
        const sessionId = "sess-7";
        const entries = [
            makeEntry({
                identityKey: "f1",
                path: "/vault/a.md",
                originPath: "/vault/a.md",
            }),
            makeEntry({
                identityKey: "f2",
                path: "/vault/b.md",
                originPath: "/vault/b.md",
            }),
        ];

        setupReviewTab(sessionId);
        useChatStore.setState({
            sessionsById: {
                [sessionId]: makeSession(sessionId, entries),
            },
            activeSessionId: sessionId,
        });

        renderComponent(<AIReviewView />);
        expect(screen.getByText("Pending Changes")).toBeInTheDocument();
        expect(screen.getByText(/2 files/)).toBeInTheDocument();
    });

    it("reads from work-cycle buffer when visibleWorkCycleId is set", () => {
        const sessionId = "sess-8";
        const wcId = "wc-1";
        const entry = makeEntry({
            identityKey: "wc-entry",
            path: "/vault/wc-file.md",
            originPath: "/vault/wc-file.md",
        });

        setupReviewTab(sessionId);
        useChatStore.setState({
            sessionsById: {
                [sessionId]: {
                    ...makeSession(sessionId),
                    visibleWorkCycleId: wcId,
                    editedFilesBufferByWorkCycleId: {
                        [wcId]: [entry],
                    },
                    editedFilesBuffer: [], // main buffer is empty
                },
            },
            activeSessionId: sessionId,
        });

        renderComponent(<AIReviewView />);
        expect(screen.getByText("wc-file.md")).toBeInTheDocument();
    });
});
