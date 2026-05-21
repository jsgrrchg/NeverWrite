import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { invoke } from "@neverwrite/runtime";
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
import { AIChatComposer } from "./AIChatComposer";
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
    onMentionAttach = vi.fn(),
    onFolderAttach = vi.fn(),
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
    onMentionAttach?: (note: {
        id: string;
        title: string;
        path: string;
    }) => void;
    onFolderAttach?: (folderPath: string, name: string) => void;
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
            onChange={onChange}
            onMentionAttach={onMentionAttach}
            onFolderAttach={onFolderAttach}
            onSubmit={onSubmit}
            onStop={onStop}
        />,
    );

    const composer = screen.getByRole("textbox", {
        name: "Message NeverWrite",
    });
    return { composer, onChange, onFolderAttach, onMentionAttach, onSubmit, onStop };
}

function setCaret(node: Node, offset: number) {
    const selection = window.getSelection();
    const range = document.createRange();
    range.setStart(node, offset);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
}

describe("AIChatComposer mention picker", () => {
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
        const { composer } = renderComposer();
        composer.textContent = "/pl";

        setCaret(composer, 1);
        fireEvent.input(composer);

        await waitFor(() => {
            expect(screen.getByText("/plan")).toBeInTheDocument();
        });
    });

    it("uses runtime-aware slash fallbacks for Claude sessions", async () => {
        const { composer } = renderComposer({
            runtimeId: "claude-acp",
        });
        composer.textContent = "/co";

        setCaret(composer.firstChild as Text, 3);
        fireEvent.input(composer);

        await waitFor(() => {
            expect(screen.getByText("/compact")).toBeInTheDocument();
            expect(screen.queryByText("/undo")).not.toBeInTheDocument();
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
        expect(
            screen.getByRole("button", { name: "Stop" }),
        ).toBeInTheDocument();
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
        expect(screen.getByRole("button", { name: "Queue" })).toBeDisabled();
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
        expect(screen.getByRole("button", { name: "Stopping" })).toBeDisabled();
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
