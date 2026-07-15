import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { getCurrentWebview, invoke } from "@neverwrite/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "../../../app/store/settingsStore";
import type { EditorFontFamily } from "../../../app/store/settingsStore";
import { useEditorStore } from "../../../app/store/editorStore";
import {
    buildVaultFileEntry,
    renderComponent,
    setEditorTabs,
    setVaultEntries,
    setVaultNotes,
} from "../../../test/test-utils";
import { FILE_TREE_NOTE_DRAG_EVENT } from "../dragEvents";
import type { AIAvailableCommand, AIComposerPart } from "../types";
import {
    MAX_IMAGE_ATTACHMENTS_PER_MESSAGE,
    MAX_IMAGE_ATTACHMENT_BYTES,
} from "../imageAttachments";
import { getMentionSuggestions } from "../chatMentionSearch";
import { AIChatComposer } from "./AIChatComposer";
import { getComposerPrimaryAction } from "./chatComposerPrimaryAction";
import { AI_CHAT_CONTENT_MAX_WIDTH_PX } from "./chatContentLayout";
import { getComposerPillLayoutStyle } from "./chatPillLayout";
import { getChatPillMetrics } from "./chatPillMetrics";

afterEach(() => {
    act(() => {
        useSettingsStore.setState({
            fileTreeContentMode: "notes_only",
            fileTreeShowExtensions: false,
            fileTreeExtensionFilter: [],
        });
    });
    setEditorTabs([], null);
    useEditorStore.setState({ pendingLineReveal: null });
    setVaultNotes([]);
    setVaultEntries([]);
    vi.restoreAllMocks();
});

function renderComposer({
    sessionId = "session-1",
    parts = [],
    status = "idle" as const,
    runtimeId,
    disabled = false,
    placeholderText,
    composerFontFamily = "system",
    availableCommands = [],
    isStopping = false,
    hasPendingSubmitAfterStop = false,
    expanded = false,
    onMentionAttach = vi.fn(),
    onFolderAttach = vi.fn(),
    onToggleExpanded = vi.fn(),
    onImageAttachmentValidationFailure = vi.fn(),
    onSubmit = () => {},
    onStop = () => {},
}: {
    sessionId?: string;
    parts?: AIComposerPart[];
    status?: "idle" | "streaming";
    runtimeId?: string;
    disabled?: boolean;
    placeholderText?: string;
    composerFontFamily?: EditorFontFamily;
    availableCommands?: AIAvailableCommand[];
    isStopping?: boolean;
    hasPendingSubmitAfterStop?: boolean;
    expanded?: boolean;
    onMentionAttach?: (note: {
        id: string;
        title: string;
        path: string;
    }) => void;
    onFolderAttach?: (folderPath: string, name: string) => void;
    onToggleExpanded?: () => void;
    onImageAttachmentValidationFailure?: (reason: string) => void;
    onSubmit?: () => void;
    onStop?: () => void;
} = {}) {
    const onChange = vi.fn();

    renderComponent(
        <AIChatComposer
            sessionId={sessionId}
            parts={parts}
            notes={[
                {
                    id: "notes/alpha.md",
                    title: "Alpha",
                    path: "/vault/notes/alpha.md",
                },
            ]}
            status={status}
            runtimeName="Assistant"
            runtimeId={runtimeId}
            disabled={disabled}
            placeholderText={placeholderText}
            composerFontFamily={composerFontFamily}
            availableCommands={availableCommands}
            isStopping={isStopping}
            hasPendingSubmitAfterStop={hasPendingSubmitAfterStop}
            expanded={expanded}
            onToggleExpanded={onToggleExpanded}
            onChange={onChange}
            onMentionAttach={onMentionAttach}
            onFolderAttach={onFolderAttach}
            onImageAttachmentValidationFailure={
                onImageAttachmentValidationFailure
            }
            onSubmit={onSubmit}
            onStop={onStop}
        />,
    );

    const composer = screen.getByRole("textbox", {
        name: "Message NeverWrite",
    });
    return {
        composer,
        onChange,
        onFolderAttach,
        onMentionAttach,
        onImageAttachmentValidationFailure,
        onSubmit,
        onStop,
    };
}

function setCaret(node: Node, offset: number) {
    const selection = window.getSelection();
    const range = document.createRange();
    range.setStart(node, offset);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
}

describe("getComposerPrimaryAction", () => {
    it.each([
        [{ hasDraft: false, hasPendingSubmitAfterStop: false, isStopping: false, isStreaming: false }, "send"],
        [{ hasDraft: true, hasPendingSubmitAfterStop: false, isStopping: false, isStreaming: true }, "queue"],
        [{ hasDraft: false, hasPendingSubmitAfterStop: false, isStopping: false, isStreaming: true }, "stop"],
        [{ hasDraft: true, hasPendingSubmitAfterStop: false, isStopping: true, isStreaming: true }, "stopping"],
        [{ hasDraft: true, hasPendingSubmitAfterStop: true, isStopping: true, isStreaming: false }, "waiting"],
    ] as const)("returns %s for the composer state", (input, expected) => {
        expect(getComposerPrimaryAction(input)).toBe(expected);
    });
});

describe("AIChatComposer mention picker", () => {
    it("finds files through path segments and fuzzy file-name matches", () => {
        const files = [
            {
                id: "composer",
                title: "Composer",
                path: "/vault/src/features/ai/AIChatComposer.tsx",
                relativePath: "src/features/ai/AIChatComposer.tsx",
                fileName: "AIChatComposer.tsx",
                mimeType: "text/typescript",
            },
            {
                id: "panel",
                title: "Panel",
                path: "/vault/src/features/ai/ReviewPanel.tsx",
                relativePath: "src/features/ai/ReviewPanel.tsx",
                fileName: "ReviewPanel.tsx",
                mimeType: "text/typescript",
            },
        ];

        const fuzzyMatches = getMentionSuggestions(
            [],
            files,
            [],
            "aichcmp",
            true,
            true,
            true,
        );
        const pathMatches = getMentionSuggestions(
            [],
            files,
            [],
            "features",
            true,
            true,
            true,
        );

        expect(fuzzyMatches).toEqual([
            expect.objectContaining({
                kind: "file",
                label: "AIChatComposer.tsx",
            }),
        ]);
        expect(pathMatches.map((item) => item.kind)).toEqual(["file", "file"]);
    });

    it("uses the shared icon-led reference style for notes, files, folders, and selections", () => {
        const { composer } = renderComposer({
            parts: [
                {
                    id: "note-reference",
                    type: "mention",
                    noteId: "notes/alpha.md",
                    label: "Alpha",
                    path: "/vault/notes/alpha.md",
                },
                { id: "space-1", type: "text", text: " " },
                {
                    id: "file-reference",
                    type: "file_mention",
                    label: "watcher.rs",
                    path: "/vault/src/watcher.rs",
                    relativePath: "src/watcher.rs",
                    mimeType: "text/rust",
                },
                { id: "space-2", type: "text", text: " " },
                {
                    id: "folder-reference",
                    type: "folder_mention",
                    label: "Clips",
                    folderPath: "/vault/Clips",
                },
                { id: "space-3", type: "text", text: " " },
                {
                    id: "selection-reference",
                    type: "selection_mention",
                    noteId: "CHANGELOG.md",
                    label: "Selected changelog line",
                    path: "/vault/CHANGELOG.md",
                    selectedText: "Changed behavior",
                    startLine: 66,
                    endLine: 66,
                },
                { id: "space-4", type: "text", text: " " },
                {
                    id: "file-attachment-reference",
                    type: "file_attachment",
                    label: "vision-semanal-2026-06-22.html",
                    filePath: "/vault/vision-semanal-2026-06-22.html",
                    mimeType: "text/html",
                },
            ],
        });

        for (const kind of [
            "mention",
            "file_mention",
            "folder_mention",
            "selection_mention",
            "file_attachment",
        ]) {
            const reference = composer.querySelector<HTMLElement>(
                `[data-kind="${kind}"]`,
            );
            expect(reference).not.toBeNull();
            expect(reference).toHaveStyle({
                background: "transparent",
                padding: "0px",
            });
            expect(reference?.querySelector("svg")).not.toBeNull();
        }
        expect(screen.getByText("CHANGELOG.md (line 66)")).toBeInTheDocument();
        expect(
            screen.getByText("vision-semanal-2026-06-22.html"),
        ).toBeInTheDocument();
    });

    it("opens composer selection references at their line in a new tab", async () => {
        setVaultNotes([
            {
                id: "CHANGELOG.md",
                title: "CHANGELOG",
                path: "/vault/CHANGELOG.md",
                modified_at: 0,
                created_at: 0,
            },
        ]);
        setEditorTabs([
            {
                id: "existing-changelog",
                noteId: "CHANGELOG.md",
                title: "CHANGELOG",
                content: "# Changelog",
            },
        ]);
        renderComposer({
            parts: [
                {
                    id: "selection-reference",
                    type: "selection_mention",
                    noteId: "CHANGELOG.md",
                    label: "Selected changelog line",
                    path: "/vault/CHANGELOG.md",
                    selectedText: "Changed behavior",
                    startLine: 66,
                    endLine: 66,
                },
            ],
        });

        fireEvent.contextMenu(screen.getByText("CHANGELOG.md (line 66)"), {
            clientX: 40,
            clientY: 60,
        });
        fireEvent.click(screen.getByText("Open in New Tab"));

        await waitFor(() => {
            expect(useEditorStore.getState().tabs).toHaveLength(2);
            expect(useEditorStore.getState().pendingLineReveal).toEqual({
                noteId: "CHANGELOG.md",
                line: 66,
                endLine: null,
            });
        });
    });

    it("keeps the composer shell full-width while capping the inner content", () => {
        renderComposer();

        const shell = screen.getByTestId("chat-composer-shell");
        const contentColumn = screen.getByTestId(
            "chat-composer-content-column",
        );

        expect(shell).toContainElement(contentColumn);
        expect(shell).not.toHaveStyle({
            maxWidth: `${AI_CHAT_CONTENT_MAX_WIDTH_PX}px`,
        });
        expect(contentColumn).toHaveStyle({
            width: "100%",
            maxWidth: `${AI_CHAT_CONTENT_MAX_WIDTH_PX}px`,
            marginInline: "auto",
        });
    });

    it("keeps the capped composer content flexible while expanded", () => {
        renderComposer({ expanded: true });

        const contentColumn = screen.getByTestId(
            "chat-composer-content-column",
        );

        expect(contentColumn).toHaveClass("flex-1");
        expect(contentColumn).toHaveStyle({
            width: "100%",
            maxWidth: `${AI_CHAT_CONTENT_MAX_WIDTH_PX}px`,
            marginInline: "auto",
        });
    });

    it("lets regular composer pills show their full label", () => {
        expect(getComposerPillLayoutStyle(getChatPillMetrics(14))).toMatchObject(
            {
                maxWidth: "100%",
                overflow: "visible",
                overflowWrap: "anywhere",
                textOverflow: "clip",
                whiteSpace: "normal",
                wordBreak: "break-word",
            },
        );
    });

    it("keeps selection composer pills compact", () => {
        expect(
            getComposerPillLayoutStyle(getChatPillMetrics(14), {
                compact: true,
            }),
        ).toMatchObject({
            maxWidth: "161px",
            overflow: "hidden",
            overflowWrap: "normal",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            wordBreak: "normal",
        });
    });

    it("renders a custom placeholder while the agent is loading", () => {
        renderComposer({
            disabled: true,
            placeholderText: "Loading agent",
        });

        expect(screen.getByText("Loading agent")).toBeInTheDocument();
    });

    it("ignores targeted file-tree attaches for other chat sessions", async () => {
        const { onChange } = renderComposer({ sessionId: "session-target" });

        window.dispatchEvent(
            new CustomEvent(FILE_TREE_NOTE_DRAG_EVENT, {
                detail: {
                    phase: "attach",
                    x: 0,
                    y: 0,
                    targetSessionId: "session-other",
                    notes: [
                        {
                            id: "notes/alpha.md",
                            title: "Alpha",
                            path: "/vault/notes/alpha.md",
                        },
                    ],
                },
            }),
        );

        await new Promise((resolve) => window.setTimeout(resolve, 0));
        expect(onChange).not.toHaveBeenCalled();
    });

    it("only applies targeted file-tree attaches to the matching chat session", async () => {
        const firstOnChange = vi.fn();
        const secondOnChange = vi.fn();

        renderComponent(
            <>
                <AIChatComposer
                    sessionId="session-a"
                    parts={[]}
                    notes={[]}
                    status="idle"
                    runtimeName="Assistant"
                    onChange={firstOnChange}
                    onMentionAttach={vi.fn()}
                    onFolderAttach={vi.fn()}
                    onSubmit={vi.fn()}
                    onStop={vi.fn()}
                />
                <AIChatComposer
                    sessionId="session-b"
                    parts={[]}
                    notes={[]}
                    status="idle"
                    runtimeName="Assistant"
                    onChange={secondOnChange}
                    onMentionAttach={vi.fn()}
                    onFolderAttach={vi.fn()}
                    onSubmit={vi.fn()}
                    onStop={vi.fn()}
                />
            </>,
        );

        window.dispatchEvent(
            new CustomEvent(FILE_TREE_NOTE_DRAG_EVENT, {
                detail: {
                    phase: "attach",
                    x: 0,
                    y: 0,
                    targetSessionId: "session-b",
                    notes: [
                        {
                            id: "notes/alpha.md",
                            title: "Alpha",
                            path: "/vault/notes/alpha.md",
                        },
                    ],
                },
            }),
        );

        await waitFor(() => expect(secondOnChange).toHaveBeenCalledTimes(1));
        expect(firstOnChange).not.toHaveBeenCalled();
    });

    it("applies mixed file-tree folders, files, and notes in one attach", async () => {
        const onFolderAttach = vi.fn();
        const onMentionAttach = vi.fn();
        const { onChange } = renderComposer({
            onFolderAttach,
            onMentionAttach,
        });

        act(() => {
            window.dispatchEvent(
                new CustomEvent(FILE_TREE_NOTE_DRAG_EVENT, {
                    detail: {
                        phase: "attach",
                        x: 0,
                        y: 0,
                        notes: [
                            {
                                id: "notes/alpha.md",
                                title: "Alpha",
                                path: "/vault/notes/alpha.md",
                            },
                        ],
                        folders: [
                            { path: "docs", name: "docs" },
                            { path: "research", name: "research" },
                        ],
                        files: [
                            {
                                filePath: "/vault/docs/config.toml",
                                fileName: "config.toml",
                                mimeType: "application/toml",
                            },
                        ],
                    },
                }),
            );
        });

        await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
        const parts = onChange.mock.calls[0]?.[0] as AIComposerPart[];
        expect(
            parts
                .filter((part) => part.type !== "text")
                .map((part) => part.type),
        ).toEqual([
            "folder_mention",
            "folder_mention",
            "file_attachment",
            "mention",
        ]);
        expect(onFolderAttach).toHaveBeenCalledTimes(2);
        expect(onFolderAttach).toHaveBeenNthCalledWith(1, "docs", "docs");
        expect(onFolderAttach).toHaveBeenNthCalledWith(
            2,
            "research",
            "research",
        );
        expect(onMentionAttach).toHaveBeenCalledTimes(1);
    });

    it("rejects unsupported image files from file-tree attach", async () => {
        const { onChange, onImageAttachmentValidationFailure } = renderComposer();

        act(() => {
            window.dispatchEvent(
                new CustomEvent(FILE_TREE_NOTE_DRAG_EVENT, {
                    detail: {
                        phase: "attach",
                        x: 0,
                        y: 0,
                        notes: [],
                        files: [
                            {
                                filePath: "/vault/assets/vector.svg",
                                fileName: "vector.svg",
                                mimeType: "image/svg+xml",
                            },
                        ],
                    },
                }),
            );
        });

        await waitFor(() => {
            expect(onImageAttachmentValidationFailure).toHaveBeenCalledWith(
                "unsupported_type",
            );
        });
        expect(onChange).not.toHaveBeenCalled();
    });

    it("rejects oversized image files from file-tree attach when size metadata is available", async () => {
        const { onChange, onImageAttachmentValidationFailure } = renderComposer();

        act(() => {
            window.dispatchEvent(
                new CustomEvent(FILE_TREE_NOTE_DRAG_EVENT, {
                    detail: {
                        phase: "attach",
                        x: 0,
                        y: 0,
                        notes: [],
                        files: [
                            {
                                filePath: "/vault/assets/huge.png",
                                fileName: "huge.png",
                                mimeType: "image/png",
                                sizeBytes: MAX_IMAGE_ATTACHMENT_BYTES + 1,
                            },
                        ],
                    },
                }),
            );
        });

        await waitFor(() => {
            expect(onImageAttachmentValidationFailure).toHaveBeenCalledWith(
                "too_large",
            );
        });
        expect(onChange).not.toHaveBeenCalled();
    });

    it("rejects file-tree image attachments above the per-message count", async () => {
        const parts = Array.from(
            { length: MAX_IMAGE_ATTACHMENTS_PER_MESSAGE },
            (_, index): AIComposerPart => ({
                id: `shot-${index}`,
                type: "screenshot",
                filePath: `/vault/assets/chat/shot-${index}.png`,
                mimeType: "image/png",
                label: `Screenshot ${index}`,
            }),
        );
        const { onChange, onImageAttachmentValidationFailure } = renderComposer({
            parts,
        });

        act(() => {
            window.dispatchEvent(
                new CustomEvent(FILE_TREE_NOTE_DRAG_EVENT, {
                    detail: {
                        phase: "attach",
                        x: 0,
                        y: 0,
                        notes: [],
                        files: [
                            {
                                filePath: "/vault/assets/extra.png",
                                fileName: "extra.png",
                                mimeType: "image/png",
                            },
                        ],
                    },
                }),
            );
        });

        await waitFor(() => {
            expect(onImageAttachmentValidationFailure).toHaveBeenCalledWith(
                "too_many",
            );
        });
        expect(onChange).not.toHaveBeenCalled();
    });

    it("rejects unsupported image files from native file drop", async () => {
        let dragHandler:
            | ((event: {
                  payload: {
                      type: string;
                      position?: { x: number; y: number };
                      paths?: string[];
                  };
              }) => void)
            | null = null;
        vi.mocked(getCurrentWebview().onDragDropEvent).mockImplementation(
            async (handler) => {
                dragHandler = handler as typeof dragHandler;
                return () => {};
            },
        );

        const { onChange, onImageAttachmentValidationFailure } = renderComposer();

        await waitFor(() => {
            expect(dragHandler).not.toBeNull();
        });

        act(() => {
            dragHandler?.({
                payload: {
                    type: "drop",
                    position: { x: 0, y: 0 },
                    paths: ["/vault/assets/vector.svg"],
                },
            });
        });

        await waitFor(() => {
            expect(onImageAttachmentValidationFailure).toHaveBeenCalledWith(
                "unsupported_type",
            );
        });
        expect(onChange).not.toHaveBeenCalled();
    });

    it("rejects oversized native file drops when the vault entry size is known", async () => {
        setVaultEntries([
            buildVaultFileEntry("assets/huge.png", {
                mimeType: "image/png",
                size: MAX_IMAGE_ATTACHMENT_BYTES + 1,
                isImageLike: true,
            }),
        ]);
        let dragHandler:
            | ((event: {
                  payload: {
                      type: string;
                      position?: { x: number; y: number };
                      paths?: string[];
                  };
              }) => void)
            | null = null;
        vi.mocked(getCurrentWebview().onDragDropEvent).mockImplementation(
            async (handler) => {
                dragHandler = handler as typeof dragHandler;
                return () => {};
            },
        );

        const { onChange, onImageAttachmentValidationFailure } = renderComposer();

        await waitFor(() => {
            expect(dragHandler).not.toBeNull();
        });

        act(() => {
            dragHandler?.({
                payload: {
                    type: "drop",
                    position: { x: 0, y: 0 },
                    paths: ["/vault/assets/huge.png"],
                },
            });
        });

        await waitFor(() => {
            expect(onImageAttachmentValidationFailure).toHaveBeenCalledWith(
                "too_large",
            );
        });
        expect(onChange).not.toHaveBeenCalled();
    });

    it("opens the @ picker when the caret is inside a text node", async () => {
        const { composer } = renderComposer();
        composer.textContent = "@";

        setCaret(composer.firstChild as Text, 1);
        fireEvent.input(composer);

        await waitFor(() => {
            expect(screen.getByText("fetch")).toBeInTheDocument();
            expect(screen.getByText("Alpha")).toBeInTheDocument();
        });
    });

    it("opens the @ picker when Chromium places the caret on the root element", async () => {
        const { composer } = renderComposer();
        composer.textContent = "@";

        setCaret(composer, 1);
        fireEvent.input(composer);

        await waitFor(() => {
            expect(screen.getByText("fetch")).toBeInTheDocument();
            expect(screen.getByText("Alpha")).toBeInTheDocument();
        });
    });

    it("shows note file names in the @ picker when all-files mode is active", async () => {
        act(() => {
            useSettingsStore.setState({
                fileTreeContentMode: "all_files",
                fileTreeShowExtensions: true,
            });
        });

        renderComponent(
            <AIChatComposer
                parts={[]}
                notes={[
                    {
                        id: "notes/project-alpha.md",
                        title: "Roadmap",
                        path: "/vault/notes/project-alpha.md",
                    },
                ]}
                status="idle"
                runtimeName="Assistant"
                runtimeId={undefined}
                composerFontFamily="system"
                availableCommands={[]}
                onChange={vi.fn()}
                onMentionAttach={vi.fn()}
                onFolderAttach={vi.fn()}
                onSubmit={vi.fn()}
                onStop={vi.fn()}
            />,
        );

        const composer = screen.getByRole("textbox", {
            name: "Message NeverWrite",
        });
        composer.textContent = "@alpha";
        setCaret(composer.firstChild as Text, 6);
        fireEvent.input(composer);

        await waitFor(() => {
            expect(screen.getByText("project-alpha.md")).toBeInTheDocument();
            expect(screen.queryByText("Roadmap")).not.toBeInTheDocument();
        });
    });

    it("keeps note title as a fallback in the @ picker when all-files mode is active", async () => {
        act(() => {
            useSettingsStore.setState({
                fileTreeContentMode: "all_files",
                fileTreeShowExtensions: true,
            });
        });

        renderComponent(
            <AIChatComposer
                parts={[]}
                notes={[
                    {
                        id: "notes/roadmap.md",
                        title: "Alpha Strategy",
                        path: "/vault/notes/roadmap.md",
                    },
                ]}
                status="idle"
                runtimeName="Assistant"
                runtimeId={undefined}
                composerFontFamily="system"
                availableCommands={[]}
                onChange={vi.fn()}
                onMentionAttach={vi.fn()}
                onFolderAttach={vi.fn()}
                onSubmit={vi.fn()}
                onStop={vi.fn()}
            />,
        );

        const composer = screen.getByRole("textbox", {
            name: "Message NeverWrite",
        });
        composer.textContent = "@alpha";
        setCaret(composer.firstChild as Text, 6);
        fireEvent.input(composer);

        await waitFor(() => {
            expect(screen.getByText("roadmap.md")).toBeInTheDocument();
        });
    });

    it("shows text-like vault files in the @ picker when all-files mode is active", async () => {
        act(() => {
            useSettingsStore.setState({
                fileTreeContentMode: "all_files",
                fileTreeShowExtensions: true,
            });
        });

        const onFileMentionAttach = vi.fn();

        renderComponent(
            <AIChatComposer
                parts={[]}
                notes={[]}
                files={[
                    {
                        id: "src/main.ts",
                        title: "main",
                        path: "/vault/src/main.ts",
                        relativePath: "src/main.ts",
                        fileName: "main.ts",
                        mimeType: "text/typescript",
                    },
                ]}
                status="idle"
                runtimeName="Assistant"
                composerFontFamily="system"
                availableCommands={[]}
                onChange={vi.fn()}
                onMentionAttach={vi.fn()}
                onFileMentionAttach={onFileMentionAttach}
                onFolderAttach={vi.fn()}
                onSubmit={vi.fn()}
                onStop={vi.fn()}
            />,
        );

        const composer = screen.getByRole("textbox", {
            name: "Message NeverWrite",
        });
        composer.textContent = "@main";
        setCaret(composer.firstChild as Text, 5);
        fireEvent.input(composer);

        const suggestion = await screen.findByText("main.ts");
        fireEvent.mouseDown(suggestion);

        await waitFor(() => {
            expect(onFileMentionAttach).toHaveBeenCalledWith(
                expect.objectContaining({
                    path: "/vault/src/main.ts",
                    relativePath: "src/main.ts",
                }),
            );
        });
    });

    it("shows curated text-like vault files in the @ picker with all-files mode disabled", async () => {
        setVaultEntries([
            buildVaultFileEntry("docs/data.csv", "text/csv"),
            buildVaultFileEntry("docs/config.toml", "application/toml"),
        ]);

        renderComponent(
            <AIChatComposer
                parts={[]}
                notes={[
                    {
                        id: "notes/alpha.md",
                        title: "Alpha",
                        path: "/vault/notes/alpha.md",
                    },
                ]}
                status="idle"
                runtimeName="Assistant"
                composerFontFamily="system"
                availableCommands={[]}
                onChange={vi.fn()}
                onMentionAttach={vi.fn()}
                onFolderAttach={vi.fn()}
                onSubmit={vi.fn()}
                onStop={vi.fn()}
            />,
        );

        const composer = screen.getByRole("textbox", {
            name: "Message NeverWrite",
        });
        composer.textContent = "@data";
        setCaret(composer.firstChild as Text, 5);
        fireEvent.input(composer);

        await waitFor(() => {
            expect(screen.getByText("data")).toBeInTheDocument();
            expect(screen.queryByText("config")).not.toBeInTheDocument();
            expect(screen.queryByText("Alpha")).not.toBeInTheDocument();
        });
    });

    it("uses the extension allowlist as the @ picker file scope", async () => {
        act(() => {
            useSettingsStore.setState({
                fileTreeContentMode: "all_files",
                fileTreeExtensionFilter: ["csv"],
            });
        });
        setVaultEntries([
            buildVaultFileEntry("docs/data.csv", "text/csv"),
            buildVaultFileEntry("docs/config.toml", "application/toml"),
        ]);

        renderComponent(
            <AIChatComposer
                parts={[]}
                notes={[]}
                status="idle"
                runtimeName="Assistant"
                composerFontFamily="system"
                availableCommands={[]}
                onChange={vi.fn()}
                onMentionAttach={vi.fn()}
                onFolderAttach={vi.fn()}
                onSubmit={vi.fn()}
                onStop={vi.fn()}
            />,
        );

        const composer = screen.getByRole("textbox", {
            name: "Message NeverWrite",
        });
        composer.textContent = "@";
        setCaret(composer.firstChild as Text, 1);
        fireEvent.input(composer);

        await waitFor(() => {
            expect(screen.getByText("data")).toBeInTheDocument();
            expect(screen.queryByText("config")).not.toBeInTheDocument();
        });
    });

    it("shows empty folders from vault entries in the @ picker", async () => {
        setVaultEntries([
            {
                id: "src",
                path: "/vault/src",
                relative_path: "src",
                title: "src",
                file_name: "src",
                extension: "",
                kind: "folder",
                modified_at: 0,
                created_at: 0,
                size: 0,
                mime_type: null,
            },
        ]);

        renderComponent(
            <AIChatComposer
                parts={[]}
                notes={[]}
                status="idle"
                runtimeName="Assistant"
                composerFontFamily="system"
                availableCommands={[]}
                onChange={vi.fn()}
                onMentionAttach={vi.fn()}
                onFolderAttach={vi.fn()}
                onSubmit={vi.fn()}
                onStop={vi.fn()}
            />,
        );

        const composer = screen.getByRole("textbox", {
            name: "Message NeverWrite",
        });
        composer.textContent = "@sr";
        setCaret(composer.firstChild as Text, 3);
        fireEvent.input(composer);

        await waitFor(() => {
            expect(screen.getByText("src")).toBeInTheDocument();
        });
    });

    it("does not show /plan in the @ picker", async () => {
        const { composer } = renderComposer();
        composer.textContent = "@pl";

        setCaret(composer.firstChild as Text, 3);
        fireEvent.input(composer);

        await waitFor(() => {
            expect(screen.queryByText("/plan")).not.toBeInTheDocument();
        });
    });

    it("opens the slash picker when the caret is on the root element", async () => {
        const { composer } = renderComposer({
            availableCommands: [
                {
                    id: "plan",
                    label: "/plan",
                    description: "step-by-step plan",
                    insert_text: "/plan ",
                },
            ],
        });
        composer.textContent = "/pl";

        setCaret(composer, 1);
        fireEvent.input(composer);

        await waitFor(() => {
            expect(screen.getByText("/plan")).toBeInTheDocument();
        });
    });

    it("keeps slash command labels visible when descriptions are long", async () => {
        const { composer } = renderComposer({
            availableCommands: [
                {
                    id: "compact",
                    label: "/compact",
                    description:
                        "Compress conversation history to save context window space",
                    insert_text: "/compact",
                },
            ],
        });
        composer.textContent = "/co";

        setCaret(composer.firstChild as Text, 3);
        fireEvent.input(composer);

        const label = await screen.findByText("/compact");
        const description = screen.getByText(
            "Compress conversation history to save context window space",
        );

        expect(label).toHaveStyle({ flex: "0 0 auto" });
        expect(description).toHaveStyle({
            flex: "1 1 0",
            overflow: "hidden",
            textOverflow: "ellipsis",
        });
    });

    it("shows Codex builtin slash commands while ACP commands are still loading", async () => {
        const { composer } = renderComposer({
            runtimeId: "codex-acp",
            availableCommands: [],
        });
        composer.textContent = "/co";

        setCaret(composer.firstChild as Text, 3);
        fireEvent.input(composer);

        await waitFor(() => {
            expect(screen.getByText("/compact")).toBeInTheDocument();
            expect(screen.queryByText("No commands found")).not.toBeInTheDocument();
        });
    });

    it("uses only ACP-provided slash commands for Claude sessions", async () => {
        const { composer } = renderComposer({
            runtimeId: "claude-acp",
            availableCommands: [
                {
                    id: "compact",
                    label: "/compact",
                    description: "compact thread",
                    insert_text: "/compact",
                },
            ],
        });
        composer.textContent = "/co";

        setCaret(composer.firstChild as Text, 3);
        fireEvent.input(composer);

        await waitFor(() => {
            expect(screen.getByText("/compact")).toBeInTheDocument();
            expect(screen.queryByText("/undo")).not.toBeInTheDocument();
        });
    });

    it("uses only ACP-provided slash commands for Grok sessions", async () => {
        const { composer } = renderComposer({
            runtimeId: "grok-acp",
            availableCommands: [
                {
                    id: "workspace-search",
                    label: "/workspace-search",
                    description: "search workspace",
                    insert_text: "/workspace-search ",
                },
            ],
        });
        composer.textContent = "/pl";

        setCaret(composer.firstChild as Text, 3);
        fireEvent.input(composer);

        await waitFor(() => {
            expect(screen.queryByText("/plan")).not.toBeInTheDocument();
            expect(screen.getByText("No commands found")).toBeInTheDocument();
        });

        composer.textContent = "/work";
        setCaret(composer.firstChild as Text, 5);
        fireEvent.input(composer);

        await waitFor(() => {
            expect(screen.getByText("/workspace-search")).toBeInTheDocument();
        });
    });

    it("queues the draft instead of stopping when streaming and the composer has content", async () => {
        const onSubmit = vi.fn();
        const onStop = vi.fn();
        renderComposer({
            parts: [
                {
                    id: "draft:queue",
                    type: "text",
                    text: "Queue this",
                },
            ],
            status: "streaming",
            onSubmit,
            onStop,
        });
        fireEvent.click(screen.getByRole("button", { name: "Queue" }));

        expect(onSubmit).toHaveBeenCalledTimes(1);
        expect(onStop).not.toHaveBeenCalled();
        expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    });

    it("stops the run when streaming and there is no draft to queue", async () => {
        const onSubmit = vi.fn();
        const onStop = vi.fn();
        renderComposer({
            status: "streaming",
            onSubmit,
            onStop,
        });

        fireEvent.click(screen.getByRole("button", { name: "Stop" }));

        expect(onStop).toHaveBeenCalledTimes(1);
        expect(onSubmit).not.toHaveBeenCalled();
        expect(screen.queryByRole("button", { name: "Queue" })).toBeNull();
    });

    it("shows stop progress feedback while the next message is waiting for stop", () => {
        renderComposer({
            status: "idle",
            isStopping: true,
            hasPendingSubmitAfterStop: true,
        });

        expect(
            screen.getByText("Sending next message after stop..."),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "Waiting for stop" }),
        ).toBeDisabled();
    });

    it("opens a mention pill in a new tab from the context menu", async () => {
        setVaultNotes([
            {
                id: "notes/alpha.md",
                title: "Alpha",
                path: "/vault/notes/alpha.md",
                modified_at: 0,
                created_at: 0,
            },
        ]);
        setEditorTabs([
            {
                id: "tab-existing",
                noteId: "notes/alpha.md",
                title: "Alpha",
                content: "# Alpha",
            },
        ]);

        renderComposer({
            parts: [
                {
                    id: "mention-1",
                    type: "mention",
                    noteId: "notes/alpha.md",
                    label: "Alpha",
                    path: "/vault/notes/alpha.md",
                },
            ],
        });

        fireEvent.contextMenu(screen.getByText("Alpha"), {
            clientX: 40,
            clientY: 60,
        });

        fireEvent.click(screen.getByText("Open in New Tab"));

        await waitFor(() => {
            expect(useEditorStore.getState().tabs).toHaveLength(2);
        });
    });

    it("opens a file mention pill in a new tab from the context menu", async () => {
        const invokeMock = vi.mocked(invoke);
        invokeMock.mockImplementation(async (command, args) => {
            if (command === "read_vault_file") {
                expect(args).toMatchObject({
                    relativePath: "src/watcher.rs",
                });
                return {
                    path: "/vault/src/watcher.rs",
                    relative_path: "src/watcher.rs",
                    file_name: "watcher.rs",
                    mime_type: "text/rust",
                    content: "fn main() {}",
                };
            }
            throw new Error(`Unexpected invoke call: ${command}`);
        });

        setVaultEntries([
            {
                id: "src/watcher.rs",
                path: "/vault/src/watcher.rs",
                relative_path: "src/watcher.rs",
                title: "watcher",
                file_name: "watcher.rs",
                extension: "rs",
                kind: "file",
                modified_at: 0,
                created_at: 0,
                size: 12,
                mime_type: "text/rust",
            },
        ]);

        renderComposer({
            parts: [
                {
                    id: "file-mention-1",
                    type: "file_mention",
                    label: "watcher.rs",
                    path: "/vault/src/watcher.rs",
                    relativePath: "src/watcher.rs",
                    mimeType: "text/rust",
                },
            ],
        });

        fireEvent.contextMenu(screen.getByText("watcher.rs"), {
            clientX: 40,
            clientY: 60,
        });

        fireEvent.click(screen.getByText("Open in New Tab"));

        await waitFor(() => {
            expect(useEditorStore.getState().tabs).toHaveLength(1);
        });
        expect(useEditorStore.getState().tabs[0]).toMatchObject({
            kind: "file",
            path: "/vault/src/watcher.rs",
        });
    });

    it("resyncs screenshot metadata when the visible label is unchanged", () => {
        const label = "Screenshot 10:42 hrs";
        const baseProps = {
            notes: [],
            status: "idle" as const,
            runtimeName: "Assistant",
            composerFontFamily: "system" as const,
            availableCommands: [],
            onChange: vi.fn(),
            onMentionAttach: vi.fn(),
            onFolderAttach: vi.fn(),
            onSubmit: vi.fn(),
            onStop: vi.fn(),
        };
        const legacyScreenshot: Extract<
            AIComposerPart,
            { type: "screenshot" }
        > = {
            id: "shot-1",
            type: "screenshot",
            filePath: "/vault/assets/chat/shot.png",
            mimeType: "image/png",
            label,
        };
        const legacyParts: AIComposerPart[] = [legacyScreenshot];
        const timestampedParts: AIComposerPart[] = [
            {
                ...legacyScreenshot,
                createdAt: 5_000,
            },
        ];

        const { rerender } = renderComponent(
            <AIChatComposer {...baseProps} parts={legacyParts} />,
        );

        expect(screen.getByText(label)).not.toHaveAttribute("data-created-at");

        rerender(<AIChatComposer {...baseProps} parts={timestampedParts} />);

        expect(screen.getByText(label)).toHaveAttribute(
            "data-created-at",
            "5000",
        );
    });

    it("applies the selected composer font family to the textbox", () => {
        const { composer } = renderComposer({
            composerFontFamily: "serif",
        });

        expect(composer).toHaveStyle({
            fontFamily:
                '"Iowan Old Style", "Palatino Linotype", "Book Antiqua", Georgia, serif',
        });
    });
});
