import { fireEvent, screen, waitFor } from "@testing-library/react";
import { invoke } from "@neverwrite/runtime";
import { describe, expect, it, vi } from "vitest";
import { useEditorStore } from "../../../app/store/editorStore";
import {
    renderComponent,
    setEditorTabs,
    setVaultEntries,
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

    it("opens text file attachments in a new tab from the context menu", async () => {
        const invokeMock = vi.mocked(invoke);
        invokeMock.mockImplementation(async (command, args) => {
            if (command === "read_vault_file") {
                expect(args).toMatchObject({
                    relativePath: "src/config.json",
                });
                return {
                    path: "/vault/src/config.json",
                    relative_path: "src/config.json",
                    file_name: "config.json",
                    mime_type: "application/json",
                    content: '{\n  "ok": true\n}',
                };
            }
            throw new Error(`Unexpected invoke call: ${command}`);
        });

        setVaultEntries([
            {
                id: "src/config.json",
                path: "/vault/src/config.json",
                relative_path: "src/config.json",
                title: "config.json",
                file_name: "config.json",
                extension: "json",
                kind: "file",
                modified_at: 0,
                created_at: 0,
                size: 22,
                mime_type: "application/json",
            },
        ]);

        renderComponent(
            <AIChatContextBar
                attachments={[
                    {
                        id: "attachment-file",
                        noteId: null,
                        label: "config.json",
                        path: "/vault/src/config.json",
                        type: "file",
                    },
                ]}
                onRemoveAttachment={() => {}}
            />,
        );

        fireEvent.contextMenu(screen.getByText("config.json"), {
            clientX: 20,
            clientY: 24,
        });
        fireEvent.click(screen.getByText("Open in New Tab"));

        await waitFor(() => {
            expect(useEditorStore.getState().tabs).toHaveLength(1);
        });
        expect(useEditorStore.getState().tabs[0]).toMatchObject({
            kind: "file",
            title: "config.json",
            path: "/vault/src/config.json",
        });
    });
});
