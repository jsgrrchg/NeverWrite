import { act, fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { QuickSwitcher } from "./QuickSwitcher";
import {
    mockInvoke,
    renderComponent,
    setCommands,
    setEditorTabs,
    setVaultNotes,
} from "../../test/test-utils";
import { useEditorStore } from "../../app/store/editorStore";

describe("QuickSwitcher", () => {
    it("shows open tabs first when the query is empty", async () => {
        vi.useFakeTimers();

        setVaultNotes([
            {
                id: "notes/open-a",
                path: "/vault/notes/open-a.md",
                title: "Open A",
                modified_at: 1,
                created_at: 1,
            },
            {
                id: "notes/open-b",
                path: "/vault/notes/open-b.md",
                title: "Open B",
                modified_at: 1,
                created_at: 1,
            },
            {
                id: "notes/later",
                path: "/vault/notes/later.md",
                title: "Later",
                modified_at: 1,
                created_at: 1,
            },
        ]);
        setEditorTabs([
            {
                id: "tab-a",
                noteId: "notes/open-a",
                title: "Open A",
                content: "A",
            },
            {
                id: "tab-b",
                noteId: "notes/open-b",
                title: "Open B",
                content: "B",
            },
        ]);
        setCommands([], "quick-switcher");

        renderComponent(<QuickSwitcher />);
        await vi.runAllTimersAsync();

        const labels = screen
            .getAllByRole("button")
            .map((button) => button.textContent ?? "");

        expect(labels.slice(0, 3)).toEqual([
            "Open Anotes/open-a",
            "Open Bnotes/open-b",
            "Laternotes/later",
        ]);
    });

    it("opens an already open note from the filtered results without reading it again", async () => {
        vi.useFakeTimers();
        const invokeMock = mockInvoke();

        setVaultNotes([
            {
                id: "notes/plan",
                path: "/vault/notes/plan.md",
                title: "Plan",
                modified_at: 1,
                created_at: 1,
            },
            {
                id: "notes/other",
                path: "/vault/notes/other.md",
                title: "Other",
                modified_at: 1,
                created_at: 1,
            },
        ]);
        setEditorTabs(
            [
                {
                    id: "tab-plan",
                    noteId: "notes/plan",
                    title: "Plan",
                    content: "cached",
                },
            ],
            "tab-plan",
        );
        setCommands([], "quick-switcher");

        renderComponent(<QuickSwitcher />);
        await act(async () => {
            await vi.runAllTimersAsync();
        });

        const input = screen.getByPlaceholderText("Search notes...");
        fireEvent.change(input, { target: { value: "Plan" } });
        fireEvent.keyDown(input, { key: "Enter" });

        expect(useEditorStore.getState().activeTabId).toBe("tab-plan");
        expect(useEditorStore.getState().tabs).toHaveLength(1);
        expect(invokeMock).not.toHaveBeenCalledWith(
            "read_note",
            expect.anything(),
        );
    });
});
