import { fireEvent, screen } from "@testing-library/react";
import { waitFor } from "@testing-library/react";
import { describe, expect, it, beforeEach, vi } from "vitest";
import { isReviewTab, useEditorStore } from "../../../app/store/editorStore";
import {
    renderComponent,
    setVaultEntries,
    setVaultNotes,
} from "../../../test/test-utils";
import { useVaultStore } from "../../../app/store/vaultStore";
import { resetChatStore, useChatStore } from "../store/chatStore";
import type { AIChatSession } from "../types";
import type { TrackedFile } from "../diff/actionLogTypes";
import { emptyPatch, syncDerivedLinePatch } from "../store/actionLogModel";
import { AIReviewView } from "./AIReviewView";
import { readPersistedReviewViewState } from "./reviewTabPersistence";

vi.mock("../../editor/useCodeLanguageSupport", () => ({
    useCodeLanguageSupport: () => null,
}));

const DEFAULT_WORK_CYCLE = "default-wc";
const defaultChatActions = {
    rejectEditedFile: useChatStore.getState().rejectEditedFile,
    keepEditedFile: useChatStore.getState().keepEditedFile,
    keepAllEditedFiles: useChatStore.getState().keepAllEditedFiles,
    rejectAllEditedFiles: useChatStore.getState().rejectAllEditedFiles,
    resolveReviewHunks: useChatStore.getState().resolveReviewHunks,
};

function makeTrackedFile(overrides: Partial<TrackedFile> = {}): TrackedFile {
    const diffBase = overrides.diffBase ?? "old line";
    const currentText = overrides.currentText ?? "new line";
    return syncDerivedLinePatch({
        identityKey: overrides.identityKey ?? "key-1",
        originPath: overrides.originPath ?? "/vault/test.md",
        path: overrides.path ?? "/vault/test.md",
        previousPath: overrides.previousPath ?? null,
        status: overrides.status ?? { kind: "modified" },
        diffBase,
        currentText,
        unreviewedEdits: emptyPatch(),
        version: 1,
        isText: overrides.isText ?? true,
        updatedAt: overrides.updatedAt ?? Date.now(),
        ...overrides,
    });
}

function makeSession(
    sessionId: string,
    files: TrackedFile[] = [],
): AIChatSession {
    const tracked: Record<string, TrackedFile> = {};
    for (const f of files) {
        tracked[f.identityKey] = f;
    }

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
        ...(files.length > 0
            ? {
                  visibleWorkCycleId: DEFAULT_WORK_CYCLE,
                  activeWorkCycleId: DEFAULT_WORK_CYCLE,
                  actionLog: {
                      trackedFilesByWorkCycleId: {
                          [DEFAULT_WORK_CYCLE]: tracked,
                      },
                      lastRejectUndo: null,
                  },
              }
            : {}),
    };
}

function setupReviewTab(sessionId: string) {
    useEditorStore.setState({
        panes: [
            {
                id: "primary",
                tabs: [
                    {
                        id: `review-${sessionId}`,
                        kind: "ai-review" as const,
                        sessionId,
                        title: "Review",
                    },
                ],
                tabIds: [`review-${sessionId}`],
                activeTabId: `review-${sessionId}`,
                activationHistory: [`review-${sessionId}`],
                tabNavigationHistory: [`review-${sessionId}`],
                tabNavigationIndex: 0,
            },
        ],
        focusedPaneId: "primary",
        tabs: [
            {
                id: `review-${sessionId}`,
                kind: "ai-review" as const,
                sessionId,
                title: "Review",
            },
        ],
        activeTabId: `review-${sessionId}`,
        activationHistory: [`review-${sessionId}`],
        tabNavigationHistory: [`review-${sessionId}`],
        tabNavigationIndex: 0,
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
        localStorage.clear();
        resetChatStore();
        useEditorStore.setState({
            panes: [
                {
                    id: "primary",
                    tabs: [],
                    tabIds: [],
                    activeTabId: null,
                    activationHistory: [],
                    tabNavigationHistory: [],
                    tabNavigationIndex: -1,
                },
            ],
            focusedPaneId: "primary",
            tabs: [],
            activeTabId: null,
            activationHistory: [],
            tabNavigationHistory: [],
            tabNavigationIndex: -1,
        });
        useChatStore.setState(defaultChatActions);
        vi.clearAllMocks();
    });

    it("shows fallback when no review tab is active", () => {
        renderComponent(<AIReviewView />);
        expect(screen.getByText("No review tab active")).toBeInTheDocument();
    });

    it("renders the review session from the requested pane even when another pane is focused", () => {
        const sessionId = "sess-pane-review";
        const file = makeTrackedFile({
            path: "/vault/notes/review.md",
            originPath: "/vault/notes/review.md",
            identityKey: "review-file",
        });

        useEditorStore.setState({
            panes: [
                {
                    id: "primary",
                    tabs: [
                        {
                            id: "note-primary",
                            kind: "note",
                            noteId: "notes/current",
                            title: "Current",
                            content: "body",
                            history: [],
                            historyIndex: 0,
                        },
                    ],
                    tabIds: ["note-primary"],
                    activeTabId: "note-primary",
                    activationHistory: ["note-primary"],
                    tabNavigationHistory: ["note-primary"],
                    tabNavigationIndex: 0,
                },
                {
                    id: "secondary",
                    tabs: [
                        {
                            id: `review-${sessionId}`,
                            kind: "ai-review",
                            sessionId,
                            title: "Review",
                        },
                    ],
                    tabIds: [`review-${sessionId}`],
                    activeTabId: `review-${sessionId}`,
                    activationHistory: [`review-${sessionId}`],
                    tabNavigationHistory: [`review-${sessionId}`],
                    tabNavigationIndex: 0,
                },
            ],
            focusedPaneId: "primary",
            tabs: [
                {
                    id: "note-primary",
                    kind: "note",
                    noteId: "notes/current",
                    title: "Current",
                    content: "body",
                    history: [],
                    historyIndex: 0,
                },
            ],
            activeTabId: "note-primary",
            activationHistory: ["note-primary"],
            tabNavigationHistory: ["note-primary"],
            tabNavigationIndex: 0,
        });
        useChatStore.setState({
            sessionsById: {
                [sessionId]: makeSession(sessionId, [file]),
            },
            activeSessionId: sessionId,
        });

        renderComponent(<AIReviewView paneId="secondary" />);

        expect(screen.getByText("review.md")).toBeInTheDocument();
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
        // 3 additions, 1 deletion via actual text diff
        const file = makeTrackedFile({
            identityKey: "e1",
            path: "/vault/notes/hello.md",
            originPath: "/vault/notes/hello.md",
            diffBase: "old line",
            currentText: "new line 1\nnew line 2\nnew line 3",
        });

        setupReviewTab(sessionId);
        useChatStore.setState({
            sessionsById: {
                [sessionId]: makeSession(sessionId, [file]),
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
                [sessionId]: makeSession(sessionId, [makeTrackedFile()]),
            },
            activeSessionId: sessionId,
        });

        renderComponent(<AIReviewView />);
        expect(screen.getByText("Reject All")).toBeInTheDocument();
        expect(screen.getByText("Keep All")).toBeInTheDocument();
    });

    it("closes the review tab when Keep All accepts the last pending file", async () => {
        const sessionId = "sess-close-keep-all";
        setupReviewTab(sessionId);
        useChatStore.setState({
            sessionsById: {
                [sessionId]: makeSession(sessionId, [makeTrackedFile()]),
            },
            activeSessionId: sessionId,
        });

        renderComponent(<AIReviewView />);

        fireEvent.click(screen.getByRole("button", { name: "Keep All" }));

        await waitFor(() =>
            expect(
                useEditorStore
                    .getState()
                    .tabs.find(
                        (tab) =>
                            isReviewTab(tab) && tab.sessionId === sessionId,
                    ),
            ).toBeUndefined(),
        );
        expect(screen.getByText("No review tab active")).toBeInTheDocument();
    });

    it("shows Conflict badge for conflict entries", () => {
        const sessionId = "sess-4";
        const file = makeTrackedFile({
            identityKey: "conflict-1",
            conflictHash: "conflict-hash",
        });

        setupReviewTab(sessionId);
        useChatStore.setState({
            sessionsById: {
                [sessionId]: makeSession(sessionId, [file]),
            },
            activeSessionId: sessionId,
        });

        renderComponent(<AIReviewView />);
        expect(screen.getByText("Conflict")).toBeInTheDocument();
    });

    it("shows Open File button when note exists in vault", () => {
        const sessionId = "sess-5";
        const file = makeTrackedFile({
            identityKey: "open-1",
            path: "/vault/notes/alpha.md",
            originPath: "/vault/notes/alpha.md",
        });

        setOpenableNoteEntry("/vault/notes/alpha.md");
        setupReviewTab(sessionId);
        useChatStore.setState({
            sessionsById: {
                [sessionId]: makeSession(sessionId, [file]),
            },
            activeSessionId: sessionId,
        });

        renderComponent(<AIReviewView />);
        expect(screen.getByTitle("Open File")).toBeInTheDocument();
    });

    it("enables Open File for supported non-note vault files", () => {
        const sessionId = "sess-file";
        const file = makeTrackedFile({
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
                [sessionId]: makeSession(sessionId, [file]),
            },
            activeSessionId: sessionId,
        });

        renderComponent(<AIReviewView />);
        expect(screen.getByTitle("Open File")).toBeEnabled();
    });

    it("enables Open File for supported text files even when the vault entry is not indexed yet", () => {
        const sessionId = "sess-file-fallback";
        const file = makeTrackedFile({
            identityKey: "open-file-fallback-1",
            path: "/vault/src/generated.ts",
            originPath: "/vault/src/generated.ts",
            status: { kind: "created", existingFileContent: null },
        });

        setVaultEntries([]);
        setupReviewTab(sessionId);
        useChatStore.setState({
            sessionsById: {
                [sessionId]: makeSession(sessionId, [file]),
            },
            activeSessionId: sessionId,
        });

        renderComponent(<AIReviewView />);
        expect(screen.getByTitle("Open File")).toBeEnabled();
    });

    it("scopes review actions to the review tab session instead of the active chat session", () => {
        const reviewSessionId = "sess-review";
        const activeSessionId = "sess-active";
        const rejectEditedFile = vi.fn(async () => {});
        const rejectAllEditedFiles = vi.fn(async () => {});
        const keepAllEditedFiles = vi.fn();
        const file = makeTrackedFile({
            identityKey: "scoped-entry",
            path: "/vault/scoped.md",
            originPath: "/vault/scoped.md",
        });

        setOpenableNoteEntry("/vault/scoped.md", "Scoped");
        setupReviewTab(reviewSessionId);
        useChatStore.setState((state) => ({
            ...state,
            sessionsById: {
                [reviewSessionId]: makeSession(reviewSessionId, [file]),
                [activeSessionId]: makeSession(activeSessionId, [
                    makeTrackedFile({
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

        fireEvent.click(screen.getByTitle("Reject"));
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
        const file = makeTrackedFile({
            identityKey: "toggle-1",
            diffBase: "old content",
            currentText: "new content",
        });

        setupReviewTab(sessionId);
        useChatStore.setState({
            sessionsById: {
                [sessionId]: makeSession(sessionId, [file]),
            },
            activeSessionId: sessionId,
        });

        renderComponent(<AIReviewView />);

        // With a single file, it starts expanded (<=5 entries rule).
        // Per-hunk controls are visible when expanded.
        expect(
            screen.getByRole("button", { name: "Reject hunk 1" }),
        ).toBeInTheDocument();

        // Click the header to collapse
        fireEvent.click(screen.getByText("test.md"));
        expect(
            screen.queryByRole("button", { name: "Reject hunk 1" }),
        ).not.toBeInTheDocument();

        // Click again to expand
        fireEvent.click(screen.getByText("test.md"));
        expect(
            screen.getByRole("button", { name: "Reject hunk 1" }),
        ).toBeInTheDocument();
    });

    it("restores persisted expansion and scroll anchor state when reopening the same review session", async () => {
        const sessionId = "sess-review-persist";
        const file = makeTrackedFile({
            identityKey: "persist-1",
            path: "/vault/notes/persist.md",
            originPath: "/vault/notes/persist.md",
            diffBase: "line a\nline b\nline c",
            currentText: "line a\nline B\nline c",
        });

        setupReviewTab(sessionId);
        useChatStore.setState({
            sessionsById: {
                [sessionId]: makeSession(sessionId, [file]),
            },
            activeSessionId: sessionId,
        });

        vi.useFakeTimers();
        try {
            const firstRender = renderComponent(<AIReviewView />);

            fireEvent.click(screen.getByRole("button", { name: "Collapse" }));
            expect(
                screen.queryByRole("button", { name: "Reject hunk 1" }),
            ).not.toBeInTheDocument();

            const scrollContainer = screen.getByTestId(
                "ai-review-scroll-container",
            );
            Object.defineProperty(scrollContainer, "scrollTop", {
                configurable: true,
                writable: true,
                value: 196,
            });
            fireEvent.scroll(scrollContainer);
            vi.advanceTimersByTime(130);
            expect(
                readPersistedReviewViewState(
                    useVaultStore.getState().vaultPath,
                    sessionId,
                ),
            ).toMatchObject({
                expandedIdentityKeys: [],
                scrollTop: 196,
            });

            firstRender.unmount();
            vi.useRealTimers();

            renderComponent(<AIReviewView />);

            expect(
                screen.getByRole("button", { name: "Expand" }),
            ).toBeInTheDocument();
        } finally {
            vi.useRealTimers();
        }
    });

    it("renders persistent diff zoom controls in the review header", () => {
        const sessionId = "sess-zoom";
        const file = makeTrackedFile({
            identityKey: "zoom-entry",
            diffBase: "old line",
            currentText: "new line",
        });

        setupReviewTab(sessionId);
        useChatStore.setState({
            sessionsById: {
                [sessionId]: makeSession(sessionId, [file]),
            },
            activeSessionId: sessionId,
        });

        renderComponent(<AIReviewView />);

        const diffContent = screen.getByTestId("edited-buffer-diff:zoom-entry");
        expect(diffContent).toHaveStyle({ fontSize: "0.72em" });

        fireEvent.click(
            screen.getByRole("button", { name: "Increase diff zoom" }),
        );

        expect(diffContent).toHaveStyle({ fontSize: "0.76em" });
        expect(
            JSON.parse(
                localStorage.getItem("neverwrite.ai.preferences") ?? "{}",
            ),
        ).toMatchObject({
            editDiffZoom: 0.76,
        });

        fireEvent.click(
            screen.getByRole("button", { name: "Decrease diff zoom" }),
        );

        expect(diffContent).toHaveStyle({ fontSize: "0.72em" });
    });

    it("renders exact hunk diffs with a single line-number column in the full review view", () => {
        const sessionId = "sess-hunks";
        // Build a file with 20 lines where line 15 changes, producing a hunk at line 15
        const lines = Array.from({ length: 20 }, (_, i) => `line-${i + 1}`);
        const oldText = lines.join("\n");
        const newLines = [...lines];
        newLines[14] = "new content"; // line 15 (0-indexed 14)
        const newText = newLines.join("\n");

        const file = makeTrackedFile({
            identityKey: "exact-hunk-entry",
            diffBase: oldText,
            currentText: newText,
        });

        setupReviewTab(sessionId);
        useChatStore.setState({
            sessionsById: {
                [sessionId]: makeSession(sessionId, [file]),
            },
            activeSessionId: sessionId,
        });

        renderComponent(<AIReviewView />);

        const diffContent = screen.getByTestId(
            "edited-buffer-diff:exact-hunk-entry",
        );
        expect(
            diffContent.querySelector(
                'div[style*="grid-template-columns: 56px 56px minmax(0, 1fr)"]',
            ),
        ).toBeNull();
        expect(
            diffContent.querySelector(
                'div[style*="grid-template-columns: 44px minmax(0, 1fr)"]',
            ),
        ).not.toBeNull();
        expect(screen.getByText("line-15")).toBeInTheDocument();
        expect(screen.getByText("new content")).toBeInTheDocument();
    });

    it("resolves nearby changes independently inside one visual block", async () => {
        const sessionId = "sess-nearby";
        const resolveReviewHunks = vi.fn(async () => {});
        const file = makeTrackedFile({
            identityKey: "nearby-entry",
            path: "/vault/nearby.md",
            originPath: "/vault/nearby.md",
            diffBase: "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl",
            currentText: "a\nb\nC\nd\ne\nf\ng\nH\ni\nj\nk\nl",
        });

        setupReviewTab(sessionId);
        useChatStore.setState({
            sessionsById: {
                [sessionId]: makeSession(sessionId, [file]),
            },
            activeSessionId: sessionId,
            rejectEditedFile: vi.fn(async () => {}),
            keepEditedFile: vi.fn(),
            keepAllEditedFiles: vi.fn(),
            rejectAllEditedFiles: vi.fn(async () => {}),
            resolveReviewHunks,
        });

        renderComponent(<AIReviewView />);

        fireEvent.click(screen.getByRole("button", { name: "Accept hunk 1" }));

        await waitFor(() =>
            expect(resolveReviewHunks).toHaveBeenCalledWith(
                sessionId,
                "nearby-entry",
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

    it("closes the review tab when accepting the last review hunk", async () => {
        const sessionId = "sess-close-last-hunk";
        const file = makeTrackedFile({
            identityKey: "close-last-hunk",
            path: "/vault/close-last-hunk.md",
            originPath: "/vault/close-last-hunk.md",
            diffBase: "old line",
            currentText: "new line",
        });

        setupReviewTab(sessionId);
        useChatStore.setState({
            sessionsById: {
                [sessionId]: makeSession(sessionId, [file]),
            },
            activeSessionId: sessionId,
        });

        renderComponent(<AIReviewView />);

        fireEvent.click(screen.getByRole("button", { name: "Accept hunk 1" }));

        await waitFor(() =>
            expect(
                useEditorStore
                    .getState()
                    .tabs.find(
                        (tab) =>
                            isReviewTab(tab) && tab.sessionId === sessionId,
                    ),
            ).toBeUndefined(),
        );
        expect(screen.getByText("No review tab active")).toBeInTheDocument();
    });

    it("keeps review controls visible for accumulated hunks on the same file", () => {
        const sessionId = "sess-accumulated";
        const file = makeTrackedFile({
            identityKey: "accumulated-entry",
            path: "/vault/notes/file.md",
            originPath: "/vault/notes/file.md",
            diffBase: "aaXa\nbbb\nccc\nddd",
            currentText: "aaXa\nBBB\nccc\nDDD",
            reviewState: "finalized",
        });

        setupReviewTab(sessionId);
        useChatStore.setState({
            sessionsById: {
                [sessionId]: makeSession(sessionId, [file]),
            },
            activeSessionId: sessionId,
            rejectEditedFile: vi.fn(async () => {}),
            keepEditedFile: vi.fn(),
            keepAllEditedFiles: vi.fn(),
            rejectAllEditedFiles: vi.fn(async () => {}),
            resolveReviewHunks: vi.fn(async () => {}),
        });

        renderComponent(<AIReviewView />);

        expect(screen.getByText("file.md")).toBeInTheDocument();
        expect(screen.getByTitle("Reject")).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "Accept hunk 1" }),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "Reject hunk 1" }),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "Accept hunk 2" }),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "Reject hunk 2" }),
        ).toBeInTheDocument();
    });

    it("shows summary with file count", () => {
        const sessionId = "sess-7";
        const files = [
            makeTrackedFile({
                identityKey: "f1",
                path: "/vault/a.md",
                originPath: "/vault/a.md",
            }),
            makeTrackedFile({
                identityKey: "f2",
                path: "/vault/b.md",
                originPath: "/vault/b.md",
            }),
        ];

        setupReviewTab(sessionId);
        useChatStore.setState({
            sessionsById: {
                [sessionId]: makeSession(sessionId, files),
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
        const file = makeTrackedFile({
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
                    activeWorkCycleId: wcId,
                    actionLog: {
                        trackedFilesByWorkCycleId: {
                            [wcId]: {
                                "wc-entry": file,
                            },
                        },
                        lastRejectUndo: null,
                    },
                },
            },
            activeSessionId: sessionId,
        });

        renderComponent(<AIReviewView />);
        expect(screen.getByText("wc-file.md")).toBeInTheDocument();
    });
});
