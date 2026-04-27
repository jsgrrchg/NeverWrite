import { act, fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
                id: ".PERSONAL/Diagnósticos/Listos/2026-03-19-diagnostico",
                path: "/vault/.PERSONAL/Diagnósticos/Listos/2026-03-19-diagnostico.md",
                title: "Diagnóstico: falso conflicto externo en el editor durante escritura",
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
            screen.getByText("2026-03-19-diagnostico.md"),
        ).toBeInTheDocument();
        expect(
            screen.queryByText(
                "Diagnóstico: falso conflicto externo en el editor durante escritura",
            ),
        ).not.toBeInTheDocument();
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
