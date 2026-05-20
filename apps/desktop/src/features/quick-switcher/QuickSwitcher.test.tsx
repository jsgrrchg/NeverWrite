import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QuickSwitcher } from "./QuickSwitcher";
import {
    mockInvoke,
    renderComponent,
    setCommands,
    setEditorTabs,
    setVaultEntries,
    setVaultNotes,
} from "../../test/test-utils";
import { useEditorStore } from "../../app/store/editorStore";
import { useSettingsStore } from "../../app/store/settingsStore";
import { useChatStore } from "../ai/store/chatStore";

afterEach(() => {
    vi.useRealTimers();
    useSettingsStore.setState({
        fileTreeContentMode: "notes_only",
        fileTreeShowExtensions: false,
        fileTreeExtensionFilter: [],
    });
    setVaultNotes([]);
    setVaultEntries([]);
    setEditorTabs([]);
    setCommands([], null);
});

function buildVaultFileEntry(path: string, mimeType = "text/plain") {
    const fileName = path.split("/").pop() ?? path;
    const dotIndex = fileName.lastIndexOf(".");

    return {
        id: path,
        path: `/vault/${path}`,
        relative_path: path,
        title: dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName,
        file_name: fileName,
        extension: dotIndex > 0 ? fileName.slice(dotIndex + 1) : "",
        kind: "file" as const,
        modified_at: 1,
        created_at: 1,
        size: 1,
        mime_type: mimeType,
    };
}

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

    it("shows Markdown file names when file-oriented tree mode and extensions are enabled", async () => {
        vi.useFakeTimers();

        useSettingsStore.setState({
            fileTreeContentMode: "all_files",
            fileTreeShowExtensions: true,
        });
        setVaultNotes([
            {
                id: "docs/reports/2026-03-19-editor-conflict-diagnostic",
                path: "/vault/docs/reports/2026-03-19-editor-conflict-diagnostic.md",
                title: "Editor conflict diagnostic report",
                modified_at: 1,
                created_at: 1,
            },
        ]);
        setVaultEntries([]);
        setEditorTabs([]);
        setCommands([], "quick-switcher");

        renderComponent(<QuickSwitcher />);
        await vi.runAllTimersAsync();

        expect(
            screen.getByText("2026-03-19-editor-conflict-diagnostic.md"),
        ).toBeInTheDocument();
        expect(
            screen.queryByText("Editor conflict diagnostic report"),
        ).not.toBeInTheDocument();
    });

    it("ranks note file name matches before note title matches in all-files mode", async () => {
        vi.useFakeTimers();

        useSettingsStore.setState({
            fileTreeContentMode: "all_files",
            fileTreeShowExtensions: true,
        });
        setVaultNotes([
            {
                id: "notes/diagnostico",
                path: "/vault/notes/diagnostico.md",
                title: "Unrelated title",
                modified_at: 1,
                created_at: 1,
            },
            {
                id: "notes/roadmap",
                path: "/vault/notes/roadmap.md",
                title: "Diagnostico by title only",
                modified_at: 1,
                created_at: 1,
            },
        ]);
        setVaultEntries([]);
        setEditorTabs([]);
        setCommands([], "quick-switcher");

        renderComponent(<QuickSwitcher />);
        await act(async () => {
            await vi.runAllTimersAsync();
        });

        const input = screen.getByPlaceholderText(/Search files/);
        fireEvent.change(input, { target: { value: "diagnostico" } });
        await act(async () => {
            await vi.runAllTimersAsync();
        });

        const labels = screen
            .getAllByRole("button")
            .map((button) => button.textContent ?? "");

        expect(labels.slice(0, 2)).toEqual([
            "diagnostico.mdnotes/diagnostico",
            "roadmap.mdnotes/roadmap",
        ]);
    });

    it("searches curated vault files by filename when all-files mode is disabled", async () => {
        vi.useFakeTimers();

        setVaultNotes([]);
        setVaultEntries([
            buildVaultFileEntry("docs/data.csv", "text/csv"),
            buildVaultFileEntry("docs/config.toml", "application/toml"),
        ]);
        setEditorTabs([]);
        setCommands([], "quick-switcher");

        renderComponent(<QuickSwitcher />);
        await act(async () => {
            await vi.runAllTimersAsync();
        });

        const input = screen.getByPlaceholderText(/Search files/);
        fireEvent.change(input, { target: { value: "data.csv" } });
        await act(async () => {
            await vi.runAllTimersAsync();
        });

        expect(screen.getByText("data")).toBeInTheDocument();
        expect(screen.queryByText("config")).not.toBeInTheDocument();

        fireEvent.change(input, { target: { value: "config.toml" } });
        await act(async () => {
            await vi.runAllTimersAsync();
        });

        expect(screen.queryByText("config")).not.toBeInTheDocument();
        expect(screen.getByText("No matching items")).toBeInTheDocument();

    });

    it("includes technical files in Quick Switcher when all-files mode is active", async () => {
        vi.useFakeTimers();

        useSettingsStore.setState({ fileTreeContentMode: "all_files" });
        setVaultNotes([
            {
                id: "notes/alpha",
                path: "/vault/notes/alpha.md",
                title: "Alpha",
                modified_at: 1,
                created_at: 1,
            },
        ]);
        setVaultEntries([
            buildVaultFileEntry("docs/config.toml", "application/toml"),
        ]);
        setEditorTabs([]);
        setCommands([], "quick-switcher");

        renderComponent(<QuickSwitcher />);
        await act(async () => {
            await vi.runAllTimersAsync();
        });

        const input = screen.getByPlaceholderText(/Search files/);
        fireEvent.change(input, { target: { value: "config.toml" } });
        await act(async () => {
            await vi.runAllTimersAsync();
        });

        expect(screen.getByText("config")).toBeInTheDocument();
    });

    it("uses the extension allowlist as the Quick Switcher vault scope", async () => {
        vi.useFakeTimers();

        useSettingsStore.setState({
            fileTreeContentMode: "all_files",
            fileTreeExtensionFilter: ["csv"],
        });
        setVaultNotes([]);
        setVaultEntries([
            buildVaultFileEntry("docs/data.csv", "text/csv"),
            buildVaultFileEntry("docs/config.toml", "application/toml"),
        ]);
        setEditorTabs([]);
        setCommands([], "quick-switcher");

        renderComponent(<QuickSwitcher />);
        await act(async () => {
            await vi.runAllTimersAsync();
        });

        const input = screen.getByPlaceholderText(/Search files/);
        fireEvent.change(input, { target: { value: "data" } });
        await act(async () => {
            await vi.runAllTimersAsync();
        });

        expect(screen.getByText("data")).toBeInTheDocument();

        fireEvent.change(input, { target: { value: "config" } });
        await act(async () => {
            await vi.runAllTimersAsync();
        });

        expect(screen.queryByText("config")).not.toBeInTheDocument();
        expect(screen.getByText("No matching items")).toBeInTheDocument();

        fireEvent.change(input, { target: { value: "Alpha" } });
        await act(async () => {
            await vi.runAllTimersAsync();
        });

        expect(screen.queryByText("Alpha")).not.toBeInTheDocument();
    });

    it("keeps open tabs searchable even when the extension allowlist excludes them", async () => {
        vi.useFakeTimers();

        useSettingsStore.setState({
            fileTreeContentMode: "all_files",
            fileTreeExtensionFilter: ["csv"],
        });
        setVaultNotes([
            {
                id: "notes/alpha",
                path: "/vault/notes/alpha.md",
                title: "Alpha",
                modified_at: 1,
                created_at: 1,
            },
        ]);
        setVaultEntries([
            buildVaultFileEntry("docs/data.csv", "text/csv"),
            buildVaultFileEntry("docs/config.toml", "application/toml"),
        ]);
        useEditorStore.getState().hydrateWorkspace(
            [
                {
                    id: "main",
                    tabs: [
                        {
                            id: "tab-alpha",
                            noteId: "notes/alpha",
                            title: "Alpha",
                            content: "cached alpha",
                        },
                        {
                            id: "tab-config",
                            kind: "file",
                            relativePath: "docs/config.toml",
                            path: "/vault/docs/config.toml",
                            title: "config.toml",
                            content: "enabled = true",
                            mimeType: "application/toml",
                            viewer: "text",
                        },
                    ],
                    activeTabId: "tab-alpha",
                },
            ],
            "main",
        );
        setCommands([], "quick-switcher");

        renderComponent(<QuickSwitcher />);
        await act(async () => {
            await vi.runAllTimersAsync();
        });

        const input = screen.getByPlaceholderText(/Search files/);

        fireEvent.change(input, { target: { value: "Alpha" } });
        await act(async () => {
            await vi.runAllTimersAsync();
        });
        expect(screen.getByText("Alpha")).toBeInTheDocument();

        fireEvent.change(input, { target: { value: "config" } });
        await act(async () => {
            await vi.runAllTimersAsync();
        });
        expect(screen.getByText("config")).toBeInTheDocument();
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

        const input = screen.getByPlaceholderText(/Search files/);
        fireEvent.change(input, { target: { value: "Plan" } });
        fireEvent.keyDown(input, { key: "Enter" });

        expect(useEditorStore.getState().activeTabId).toBe("tab-plan");
        expect(useEditorStore.getState().tabs).toHaveLength(1);
        expect(invokeMock).not.toHaveBeenCalledWith(
            "read_note",
            expect.anything(),
        );
    });

    it("keeps open note tabs fuzzy-searchable in normal mode", async () => {
        vi.useFakeTimers();

        setVaultNotes([
            {
                id: "notes/open-a",
                path: "/vault/notes/open-a.md",
                title: "Open A",
                modified_at: 1,
                created_at: 1,
            },
        ]);
        setEditorTabs(
            [
                {
                    id: "tab-open-a",
                    noteId: "notes/open-a",
                    title: "Open A",
                    content: "cached",
                },
            ],
            "tab-open-a",
        );
        setCommands([], "quick-switcher");

        renderComponent(<QuickSwitcher />);
        await act(async () => {
            await vi.runAllTimersAsync();
        });

        const input = screen.getByPlaceholderText(/Search files/);
        fireEvent.change(input, { target: { value: "oa" } });
        await act(async () => {
            await vi.runAllTimersAsync();
        });

        expect(screen.getByText("Open A")).toBeInTheDocument();
    });

    it("keeps the selected result in view when keyboard navigation moves beyond the virtual window", async () => {
        vi.useFakeTimers();

        setVaultNotes(
            Array.from({ length: 12 }, (_, index) => ({
                id: `notes/item-${index + 1}`,
                path: `/vault/notes/item-${index + 1}.md`,
                title: `Item ${index + 1}`,
                modified_at: index + 1,
                created_at: index + 1,
            })),
        );
        setVaultEntries([]);
        setEditorTabs([]);
        setCommands([], "quick-switcher");

        renderComponent(<QuickSwitcher />);
        await act(async () => {
            await vi.runAllTimersAsync();
        });

        const input = screen.getByPlaceholderText(/Search files/);
        const list = screen.getByTestId("quick-switcher-list");

        expect(list).toBeInstanceOf(HTMLDivElement);

        Object.defineProperty(list, "clientHeight", {
            configurable: true,
            value: 3 * 34,
        });

        for (let step = 0; step < 6; step += 1) {
            fireEvent.keyDown(input, { key: "ArrowDown" });
        }

        expect((list as HTMLDivElement).scrollTop).toBeGreaterThan(0);
    });

    it("includes open chat tabs in results and activates them without creating duplicates", async () => {
        vi.useFakeTimers();

        useChatStore.setState({
            sessionsById: {
                "session-chat-1": {
                    sessionId: "session-chat-1",
                    historySessionId: "session-chat-1",
                    runtimeId: "codex-acp",
                    modelId: "gpt-5.4",
                    modeId: "default",
                    status: "idle",
                    messages: [
                        {
                            id: "msg-1",
                            role: "user",
                            kind: "text",
                            content: "Research thread",
                            timestamp: 1,
                        },
                    ],
                    attachments: [],
                    models: [],
                    modes: [],
                    configOptions: [],
                },
            } as never,
        });

        useEditorStore.getState().hydrateWorkspace(
            [
                {
                    id: "left",
                    tabs: [],
                    activeTabId: null,
                },
                {
                    id: "right",
                    tabs: [
                        {
                            id: "chat-tab-1",
                            kind: "ai-chat",
                            sessionId: "session-chat-1",
                            title: "Fallback Chat",
                        },
                    ],
                    activeTabId: "chat-tab-1",
                },
            ],
            "left",
        );
        setCommands([], "quick-switcher");

        renderComponent(<QuickSwitcher />);
        await act(async () => {
            await vi.runAllTimersAsync();
        });

        expect(screen.getByText("Research thread")).toBeInTheDocument();

        const input = screen.getByPlaceholderText(/Search files/);
        fireEvent.change(input, { target: { value: "Research" } });
        await act(async () => {
            await vi.runAllTimersAsync();
        });
        fireEvent.click(
            screen.getByRole("button", { name: /Research thread/i }),
        );

        const state = useEditorStore.getState();
        expect(state.activeTabId).toBe("chat-tab-1");
        expect(state.focusedPaneId).toBe("right");
        expect(state.panes.flatMap((pane) => pane.tabs)).toHaveLength(1);
    });

    it("includes chat history tabs in results and activates them without creating duplicates", async () => {
        vi.useFakeTimers();

        useEditorStore.getState().hydrateWorkspace(
            [
                {
                    id: "left",
                    tabs: [],
                    activeTabId: null,
                },
                {
                    id: "right",
                    tabs: [
                        {
                            id: "history-tab-1",
                            kind: "ai-chat-history",
                            title: "History",
                        },
                    ],
                    activeTabId: "history-tab-1",
                },
            ],
            "left",
        );
        setCommands([], "quick-switcher");

        renderComponent(<QuickSwitcher />);
        await act(async () => {
            await vi.runAllTimersAsync();
        });

        expect(screen.getByText("History")).toBeInTheDocument();
        expect(screen.getByText("Chat history")).toBeInTheDocument();

        const input = screen.getByPlaceholderText(/Search files/);
        fireEvent.change(input, { target: { value: "History" } });
        await act(async () => {
            await vi.runAllTimersAsync();
        });
        fireEvent.click(screen.getByRole("button", { name: /History/i }));

        const state = useEditorStore.getState();
        expect(state.activeTabId).toBe("history-tab-1");
        expect(state.focusedPaneId).toBe("right");
        expect(state.panes.flatMap((pane) => pane.tabs)).toHaveLength(1);
    });
});
