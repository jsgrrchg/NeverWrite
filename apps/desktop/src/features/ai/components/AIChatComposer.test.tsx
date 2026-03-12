import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderComponent } from "../../../test/test-utils";
import type { AIComposerPart } from "../types";
import { AIChatComposer } from "./AIChatComposer";

function renderComposer({
    parts = [],
    status = "idle" as const,
    onSubmit = vi.fn(),
    onStop = vi.fn(),
}: {
    parts?: AIComposerPart[];
    status?: "idle" | "streaming";
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

    it("opens the slash picker when the caret is on the root element", async () => {
        const { composer } = renderComposer();
        composer.textContent = "/pl";

        setCaret(composer, 1);
        fireEvent.input(composer);

        await waitFor(() => {
            expect(screen.getByText("/plan")).toBeInTheDocument();
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
        expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
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
});
