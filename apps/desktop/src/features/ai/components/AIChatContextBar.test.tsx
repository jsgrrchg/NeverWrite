import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useEditorStore } from "../../../app/store/editorStore";
import {
    renderComponent,
    setEditorTabs,
    setVaultNotes,
} from "../../../test/test-utils";
import { AIChatContextBar } from "./AIChatContextBar";

describe("AIChatContextBar", () => {
    it("renders selection pills with compact line range label", () => {
        renderComponent(
            <AIChatContextBar
                attachments={[
                    {
                        id: "sel-1",
                        noteId: "notes/alpha.md",
                        label: "Short text  (12:18)",
                        path: "/vault/notes/alpha.md",
                        type: "selection",
                    },
                ]}
                onRemoveAttachment={() => {}}
            />,
        );

        expect(screen.getByText(/Short text\s+\(12:18\)/)).toBeTruthy();
    });

    it("opens note attachments in a new tab from the context menu", async () => {
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

        renderComponent(
            <AIChatContextBar
                attachments={[
                    {
                        id: "attachment-1",
                        noteId: "notes/alpha.md",
                        label: "Alpha",
                        path: "/vault/notes/alpha.md",
                        type: "note",
                    },
                ]}
                onRemoveAttachment={() => {}}
            />,
        );

        fireEvent.contextMenu(screen.getByText("Alpha"), {
            clientX: 20,
            clientY: 24,
        });
        fireEvent.click(screen.getByText("Open in New Tab"));

        await waitFor(() => {
            expect(useEditorStore.getState().tabs).toHaveLength(2);
        });
    });
});
