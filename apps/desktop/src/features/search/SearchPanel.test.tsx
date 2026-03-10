import { act, fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SearchPanel } from "./SearchPanel";
import {
    flushPromises,
    getClipboardMock,
    mockInvoke,
    renderComponent,
    setEditorTabs,
} from "../../test/test-utils";

describe("SearchPanel", () => {
    it("debounces the query and renders returned results", async () => {
        vi.useFakeTimers();
        const invokeMock = mockInvoke();

        invokeMock.mockImplementation(async (command) => {
            if (command === "search_notes") {
                return [
                    {
                        id: "notes/roadmap",
                        path: "/vault/notes/roadmap.md",
                        title: "Roadmap",
                        score: 42,
                    },
                ];
            }

            throw new Error(`Unexpected command: ${command}`);
        });

        renderComponent(<SearchPanel />);

        const input = screen.getByPlaceholderText("Search notes...");
        fireEvent.change(input, { target: { value: "road" } });

        expect(invokeMock).not.toHaveBeenCalled();

        await act(async () => {
            await vi.advanceTimersByTimeAsync(300);
        });
        await flushPromises();

        expect(invokeMock).toHaveBeenCalledWith("search_notes", {
            query: "road",
        });
        expect(screen.getByText("Roadmap")).toBeInTheDocument();
        expect(screen.getByText("notes/roadmap")).toBeInTheDocument();
    });

    it("clears stale results from the UI when the query is cleared", async () => {
        vi.useFakeTimers();
        const invokeMock = mockInvoke();

        invokeMock.mockImplementation(async (command) => {
            if (command === "search_notes") {
                return [
                    {
                        id: "notes/today",
                        path: "/vault/notes/today.md",
                        title: "Today",
                        score: 10,
                    },
                ];
            }

            throw new Error(`Unexpected command: ${command}`);
        });

        renderComponent(<SearchPanel />);

        const input = screen.getByPlaceholderText("Search notes...");
        fireEvent.change(input, { target: { value: "today" } });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(300);
        });
        await flushPromises();

        expect(screen.getByText("Today")).toBeInTheDocument();

        fireEvent.change(input, { target: { value: "" } });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(300);
        });
        await flushPromises();

        expect(screen.getByText("Type to search")).toBeInTheDocument();
        expect(screen.queryByText("Today")).not.toBeInTheDocument();
    });

    it("copies the selected note path from the context menu", async () => {
        vi.useFakeTimers();
        const invokeMock = mockInvoke();

        invokeMock.mockImplementation(async (command) => {
            if (command === "search_notes") {
                return [
                    {
                        id: "notes/roadmap",
                        path: "/vault/notes/roadmap.md",
                        title: "Roadmap",
                        score: 42,
                    },
                ];
            }

            throw new Error(`Unexpected command: ${command}`);
        });

        renderComponent(<SearchPanel />);

        const input = screen.getByPlaceholderText("Search notes...");
        fireEvent.change(input, { target: { value: "road" } });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(300);
        });
        await flushPromises();

        const row = screen.getByText("Roadmap").closest("button");
        expect(row).not.toBeNull();
        fireEvent.contextMenu(row!, {
            clientX: 100,
            clientY: 80,
        });

        fireEvent.click(screen.getByText("Copy Note Path"));

        expect(getClipboardMock().writeText).toHaveBeenCalledWith("notes/roadmap");
    });

    it.todo(
        "ignores stale search responses so an older request cannot overwrite newer results",
    );

    it("opens an already open result without reading it again", async () => {
        vi.useFakeTimers();
        const invokeMock = mockInvoke();

        setEditorTabs([
            {
                id: "tab-existing",
                noteId: "notes/roadmap",
                title: "Roadmap",
                content: "cached",
            },
        ]);

        invokeMock.mockImplementation(async (command) => {
            if (command === "search_notes") {
                return [
                    {
                        id: "notes/roadmap",
                        path: "/vault/notes/roadmap.md",
                        title: "Roadmap",
                        score: 42,
                    },
                ];
            }

            throw new Error(`Unexpected command: ${command}`);
        });

        renderComponent(<SearchPanel />);

        fireEvent.change(screen.getByPlaceholderText("Search notes..."), {
            target: { value: "road" },
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(300);
        });
        await flushPromises();

        fireEvent.click(screen.getByText("Roadmap"));

        expect(invokeMock).not.toHaveBeenCalledWith(
            "read_note",
            expect.anything(),
        );
    });
});
