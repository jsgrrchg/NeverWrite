import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "../../app/store/settingsStore";
import { SearchPanel } from "./SearchPanel";
import {
    flushPromises,
    getClipboardMock,
    mockInvoke,
    renderComponent,
    setEditorTabs,
} from "../../test/test-utils";
import {
    type NoteTab,
    isNoteTab,
    useEditorStore,
} from "../../app/store/editorStore";

afterEach(() => {
    act(() => {
        useSettingsStore.setState({
            fileTreeContentMode: "notes_only",
            fileTreeShowExtensions: false,
        });
    });
});

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

        const input = screen.getByPlaceholderText("Search files and notes...");
        fireEvent.change(input, { target: { value: "road" } });

        expect(invokeMock).not.toHaveBeenCalled();

        await act(async () => {
            await vi.advanceTimersByTimeAsync(300);
        });
        await flushPromises();

        expect(invokeMock).toHaveBeenCalledWith(
            "search_notes",
            expect.objectContaining({
                query: "road",
            }),
        );
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

        const input = screen.getByPlaceholderText("Search files and notes...");
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

        const input = screen.getByPlaceholderText("Search files and notes...");
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

        expect(getClipboardMock().writeText).toHaveBeenCalledWith(
            "notes/roadmap",
        );
    });

    it("shows note file names in all-files mode while keeping the note title as context", async () => {
        vi.useFakeTimers();
        const invokeMock = mockInvoke();
        act(() => {
            useSettingsStore.setState({
                fileTreeContentMode: "all_files",
                fileTreeShowExtensions: true,
            });
        });

        invokeMock.mockImplementation(async (command) => {
            if (command === "search_notes") {
                return [
                    {
                        id: "notes/project-alpha.md",
                        path: "/vault/notes/project-alpha.md",
                        title: "Roadmap",
                        score: 42,
                    },
                ];
            }

            throw new Error(`Unexpected command: ${command}`);
        });

        renderComponent(<SearchPanel />);

        fireEvent.change(
            screen.getByPlaceholderText("Search files and notes..."),
            {
                target: { value: "alpha" },
            },
        );
        await act(async () => {
            await vi.advanceTimersByTimeAsync(300);
        });
        await flushPromises();

        expect(screen.getByText("project-alpha.md")).toBeInTheDocument();
        expect(
            screen.getByText("Roadmap · notes/project-alpha.md"),
        ).toBeInTheDocument();
        expect(invokeMock).toHaveBeenCalledWith(
            "search_notes",
            expect.objectContaining({
                preferFileName: true,
            }),
        );
    });

    it.todo(
        "ignores stale search responses so an older request cannot overwrite newer results",
    );

    it("opens an already open result without reading it again", async () => {
        vi.useFakeTimers();
        const invokeMock = mockInvoke();

        act(() => {
            useEditorStore.getState().hydrateWorkspace(
                [
                    {
                        id: "primary",
                        tabs: [
                            {
                                id: "tab-current",
                                noteId: "notes/current",
                                title: "Current",
                                content: "current",
                            },
                        ],
                        activeTabId: "tab-current",
                    },
                    {
                        id: "secondary",
                        tabs: [
                            {
                                id: "tab-existing",
                                noteId: "notes/roadmap",
                                title: "Roadmap",
                                content: "cached",
                            },
                        ],
                        activeTabId: "tab-existing",
                    },
                ],
                "primary",
            );
        });

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

        fireEvent.change(
            screen.getByPlaceholderText("Search files and notes..."),
            {
                target: { value: "road" },
            },
        );
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

    it("opens a result in a new tab on middle click", async () => {
        vi.useFakeTimers();
        const invokeMock = mockInvoke();

        setEditorTabs([
            {
                id: "tab-current",
                noteId: "notes/current",
                title: "Current",
                content: "current",
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
            if (command === "read_note") {
                return { content: "roadmap body" };
            }

            throw new Error(`Unexpected command: ${command}`);
        });

        renderComponent(<SearchPanel />);

        fireEvent.change(
            screen.getByPlaceholderText("Search files and notes..."),
            {
                target: { value: "road" },
            },
        );
        await act(async () => {
            await vi.advanceTimersByTimeAsync(300);
        });
        await flushPromises();

        const row = screen.getByText("Roadmap").closest("button");
        expect(row).not.toBeNull();
        fireEvent(
            row!,
            new MouseEvent("auxclick", {
                bubbles: true,
                button: 1,
            }),
        );
        await flushPromises();

        const noteTabs = useEditorStore
            .getState()
            .tabs.filter((tab): tab is NoteTab => isNoteTab(tab));
        expect(noteTabs).toHaveLength(2);
        const latestNoteTab = noteTabs.at(-1);
        expect(latestNoteTab ? latestNoteTab.noteId : null).toBe(
            "notes/roadmap",
        );
    });
});
