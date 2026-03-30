import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "../../../app/store/settingsStore";
import type { EditorFontFamily } from "../../../app/store/settingsStore";
import { useEditorStore } from "../../../app/store/editorStore";
import {
    renderComponent,
    setEditorTabs,
    setVaultEntries,
    setVaultNotes,
} from "../../../test/test-utils";
import type { AIAvailableCommand, AIComposerPart } from "../types";
import { AIChatComposer } from "./AIChatComposer";

afterEach(() => {
    act(() => {
        useSettingsStore.setState({
            fileTreeContentMode: "notes_only",
            fileTreeShowExtensions: false,
        });
    });
});

function renderComposer({
    parts = [],
    status = "idle" as const,
    runtimeId,
    composerFontFamily = "system",
    availableCommands = [],
    onSubmit = vi.fn(),
    onStop = vi.fn(),
}: {
    parts?: AIComposerPart[];
    status?: "idle" | "streaming";
    runtimeId?: string;
    composerFontFamily?: EditorFontFamily;
    availableCommands?: AIAvailableCommand[];
    onSubmit?: ReturnType<typeof vi.fn>;
    onStop?: ReturnType<typeof vi.fn>;
} = {}) {
    const onChange = vi.fn();

    renderComponent(
        <AIChatComposer
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
            composerFontFamily={composerFontFamily}
            availableCommands={availableCommands}
            onChange={onChange}
            onMentionAttach={vi.fn()}
            onFolderAttach={vi.fn()}
            onSubmit={onSubmit}
            onStop={onStop}
        />,
    );

    const composer = screen.getByRole("textbox", { name: "Message VaultAI" });
    return { composer, onChange, onSubmit, onStop };
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
            name: "Message VaultAI",
        });
        composer.textContent = "@alpha";
        setCaret(composer.firstChild as Text, 6);
        fireEvent.input(composer);

        await waitFor(() => {
            expect(screen.getByText("project-alpha.md")).toBeInTheDocument();
            expect(screen.queryByText("Roadmap")).not.toBeInTheDocument();
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
            name: "Message VaultAI",
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
