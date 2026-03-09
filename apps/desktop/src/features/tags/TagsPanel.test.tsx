import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { TagsPanel } from "./TagsPanel";
import {
    flushPromises,
    mockInvoke,
    renderComponent,
    setEditorTabs,
    setVaultNotes,
} from "../../test/test-utils";

describe("TagsPanel", () => {
    it("shows an empty-state message when no vault is open", () => {
        renderComponent(<TagsPanel />);

        expect(screen.getByText("No vault open")).toBeInTheDocument();
    });

    it("loads tags for the current vault and expands them to show note rows", async () => {
        const user = userEvent.setup();
        const invokeMock = mockInvoke();

        setVaultNotes([
            {
                id: "notes/roadmap",
                path: "/vault/notes/roadmap.md",
                title: "Roadmap",
                modified_at: 1,
                created_at: 1,
            },
        ]);

        invokeMock.mockImplementation(async (command) => {
            if (command === "get_tags") {
                return [{ tag: "project", note_ids: ["notes/roadmap"] }];
            }

            throw new Error(`Unexpected command: ${command}`);
        });

        renderComponent(<TagsPanel />);
        await flushPromises();

        const tagRow = await screen.findByRole("button", { name: /#project 1/i });
        await user.click(tagRow);

        expect(await screen.findByText("Roadmap")).toBeInTheDocument();
    });

    it("uses the cached tab content when opening a tagged note already in tabs", async () => {
        const user = userEvent.setup();
        const invokeMock = mockInvoke();

        setVaultNotes([
            {
                id: "notes/roadmap",
                path: "/vault/notes/roadmap.md",
                title: "Roadmap",
                modified_at: 1,
                created_at: 1,
            },
        ]);
        setEditorTabs([
            {
                id: "tab-roadmap",
                noteId: "notes/roadmap",
                title: "Roadmap",
                content: "cached roadmap",
                isDirty: false,
            },
        ]);

        invokeMock.mockImplementation(async (command) => {
            if (command === "get_tags") {
                return [{ tag: "project", note_ids: ["notes/roadmap"] }];
            }

            throw new Error(`Unexpected command: ${command}`);
        });

        renderComponent(<TagsPanel />);
        await flushPromises();

        await user.click(await screen.findByRole("button", { name: /#project 1/i }));
        await user.click(await screen.findByText("Roadmap"));

        expect(invokeMock).not.toHaveBeenCalledWith("read_note", expect.anything());
    });

    it("expands the tag from the context menu", async () => {
        const user = userEvent.setup();
        const invokeMock = mockInvoke();

        setVaultNotes([
            {
                id: "notes/roadmap",
                path: "/vault/notes/roadmap.md",
                title: "Roadmap",
                modified_at: 1,
                created_at: 1,
            },
        ]);

        invokeMock.mockImplementation(async (command) => {
            if (command === "get_tags") {
                return [{ tag: "project", note_ids: ["notes/roadmap"] }];
            }

            throw new Error(`Unexpected command: ${command}`);
        });

        renderComponent(<TagsPanel />);
        await flushPromises();

        const tagRow = await screen.findByRole("button", { name: /#project 1/i });
        fireEvent.contextMenu(tagRow, {
            clientX: 40,
            clientY: 40,
        });

        await user.click(await screen.findByText("Expand"));

        expect(await screen.findByText("Roadmap")).toBeInTheDocument();
    });

    it.todo(
        "refetches tags when note content/frontmatter changes without changing notes.length",
    );
});
