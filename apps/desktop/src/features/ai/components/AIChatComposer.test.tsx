import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { EditorFontFamily } from "../../../app/store/settingsStore";
import { useEditorStore } from "../../../app/store/editorStore";
import {
    renderComponent,
    setEditorTabs,
    setVaultNotes,
} from "../../../test/test-utils";
import type { AIAvailableCommand, AIComposerPart } from "../types";
import { AIChatComposer } from "./AIChatComposer";

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
