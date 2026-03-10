import { describe, expect, it, beforeEach } from "vitest";
import {
    markSessionReady,
    readPersistedSession,
    useEditorStore,
} from "./editorStore";
import { useVaultStore } from "./vaultStore";

function makeTab(overrides: {
    id: string;
    noteId: string;
    title: string;
    content: string;
}) {
    return {
        ...overrides,
        history: [
            {
                noteId: overrides.noteId,
                title: overrides.title,
                content: overrides.content,
            },
        ],
        historyIndex: 0,
    };
}

beforeEach(() => {
    useEditorStore.setState({
        tabs: [],
        activeTabId: null,
        activationHistory: [],
    });
});

describe("editorStore session persistence", () => {
    it("persists open tabs per vault path", async () => {
        markSessionReady();
        useVaultStore.setState({ vaultPath: "/vaults/geo-2026" });

        useEditorStore.setState({
            tabs: [
                makeTab({
                    id: "tab-1",
                    noteId: "notes/uk",
                    title: "UK",
                    content: "content",
                }),
            ],
            activeTabId: "tab-1",
        });

        // Wait for debounced persistence (500ms)
        await new Promise((r) => setTimeout(r, 600));

        const session = readPersistedSession("/vaults/geo-2026");
        expect(session).not.toBeNull();
        expect(session!.noteIds[0].noteId).toBe("notes/uk");
        expect(session!.activeNoteId).toBe("notes/uk");
    });

    it("falls back to the legacy global session key when needed", () => {
        localStorage.setItem(
            "vaultai.session.tabs",
            JSON.stringify({
                noteIds: [{ noteId: "notes/legacy", title: "Legacy" }],
                activeNoteId: "notes/legacy",
            }),
        );

        expect(readPersistedSession("/vaults/migrated")).toEqual({
            noteIds: [{ noteId: "notes/legacy", title: "Legacy" }],
            activeNoteId: "notes/legacy",
        });
    });
});

describe("editorStore navigation history", () => {
    it("openNote navigates within the active tab instead of creating a new tab", () => {
        useEditorStore.setState({
            tabs: [
                makeTab({
                    id: "tab-a",
                    noteId: "notes/source",
                    title: "Source",
                    content: "source",
                }),
            ],
            activeTabId: "tab-a",
        });

        useEditorStore.getState().openNote("notes/linked", "Linked", "linked");

        const { tabs } = useEditorStore.getState();
        expect(tabs).toHaveLength(1);
        expect(tabs[0].noteId).toBe("notes/linked");
        expect(tabs[0].content).toBe("linked");
        expect(tabs[0].id).toBe("tab-a");
    });

    it("openNote pushes to history", () => {
        useEditorStore.setState({
            tabs: [
                makeTab({
                    id: "tab-a",
                    noteId: "notes/first",
                    title: "First",
                    content: "first",
                }),
            ],
            activeTabId: "tab-a",
        });

        useEditorStore.getState().openNote("notes/second", "Second", "second");

        const tab = useEditorStore.getState().tabs[0];
        expect(tab.history).toHaveLength(2);
        expect(tab.historyIndex).toBe(1);
        expect(tab.history[0].noteId).toBe("notes/first");
        expect(tab.history[1].noteId).toBe("notes/second");
    });

    it("openNote is a no-op when the active tab already shows the note", () => {
        useEditorStore.setState({
            tabs: [
                makeTab({
                    id: "tab-a",
                    noteId: "notes/same",
                    title: "Same",
                    content: "same",
                }),
            ],
            activeTabId: "tab-a",
        });

        useEditorStore.getState().openNote("notes/same", "Same", "same");

        const tab = useEditorStore.getState().tabs[0];
        expect(tab.history).toHaveLength(1);
    });

    it("openNote creates a new tab when no tabs exist", () => {
        useEditorStore.getState().openNote("notes/new", "New", "new");

        const { tabs, activeTabId } = useEditorStore.getState();
        expect(tabs).toHaveLength(1);
        expect(tabs[0].noteId).toBe("notes/new");
        expect(activeTabId).toBe(tabs[0].id);
    });

    it("goBack restores the previous note", () => {
        useEditorStore.setState({
            tabs: [
                makeTab({
                    id: "tab-a",
                    noteId: "notes/first",
                    title: "First",
                    content: "first",
                }),
            ],
            activeTabId: "tab-a",
        });

        useEditorStore.getState().openNote("notes/second", "Second", "second");
        useEditorStore.getState().goBack();

        const tab = useEditorStore.getState().tabs[0];
        expect(tab.noteId).toBe("notes/first");
        expect(tab.content).toBe("first");
        expect(tab.historyIndex).toBe(0);
    });

    it("goForward restores the next note", () => {
        useEditorStore.setState({
            tabs: [
                makeTab({
                    id: "tab-a",
                    noteId: "notes/first",
                    title: "First",
                    content: "first",
                }),
            ],
            activeTabId: "tab-a",
        });

        useEditorStore.getState().openNote("notes/second", "Second", "second");
        useEditorStore.getState().goBack();
        useEditorStore.getState().goForward();

        const tab = useEditorStore.getState().tabs[0];
        expect(tab.noteId).toBe("notes/second");
        expect(tab.content).toBe("second");
        expect(tab.historyIndex).toBe(1);
    });

    it("goBack is a no-op at the start of history", () => {
        useEditorStore.setState({
            tabs: [
                makeTab({
                    id: "tab-a",
                    noteId: "notes/only",
                    title: "Only",
                    content: "only",
                }),
            ],
            activeTabId: "tab-a",
        });

        useEditorStore.getState().goBack();

        expect(useEditorStore.getState().tabs[0].noteId).toBe("notes/only");
    });

    it("navigating to a new note from the middle of history truncates forward entries", () => {
        useEditorStore.setState({
            tabs: [
                makeTab({
                    id: "tab-a",
                    noteId: "notes/a",
                    title: "A",
                    content: "a",
                }),
            ],
            activeTabId: "tab-a",
        });

        useEditorStore.getState().openNote("notes/b", "B", "b");
        useEditorStore.getState().openNote("notes/c", "C", "c");
        useEditorStore.getState().goBack(); // at B
        useEditorStore.getState().openNote("notes/d", "D", "d");

        const tab = useEditorStore.getState().tabs[0];
        expect(tab.history.map((h) => h.noteId)).toEqual([
            "notes/a",
            "notes/b",
            "notes/d",
        ]);
        expect(tab.historyIndex).toBe(2);
    });

    it("history is capped at 30 entries", () => {
        useEditorStore.setState({
            tabs: [
                makeTab({
                    id: "tab-a",
                    noteId: "notes/0",
                    title: "0",
                    content: "0",
                }),
            ],
            activeTabId: "tab-a",
        });

        for (let i = 1; i <= 35; i++) {
            useEditorStore
                .getState()
                .openNote(`notes/${i}`, `${i}`, `${i}`);
        }

        const tab = useEditorStore.getState().tabs[0];
        expect(tab.history).toHaveLength(30);
        // Most recent note should be the last one
        expect(tab.noteId).toBe("notes/35");
        // Oldest should have been trimmed
        expect(tab.history[0].noteId).toBe("notes/6");
    });

    it("preserves current content in history when navigating away", () => {
        useEditorStore.setState({
            tabs: [
                makeTab({
                    id: "tab-a",
                    noteId: "notes/first",
                    title: "First",
                    content: "original",
                }),
            ],
            activeTabId: "tab-a",
        });

        // Simulate editing content
        useEditorStore.getState().updateTabContent("tab-a", "edited");

        // Navigate to new note
        useEditorStore.getState().openNote("notes/second", "Second", "second");

        // Go back — should see the edited content
        useEditorStore.getState().goBack();
        const tab = useEditorStore.getState().tabs[0];
        expect(tab.content).toBe("edited");
    });
});

describe("editorStore tab management", () => {
    it("returns to the most recently active tab when closing the current one", () => {
        useEditorStore.setState({
            tabs: [
                makeTab({
                    id: "tab-a",
                    noteId: "notes/a",
                    title: "A",
                    content: "a",
                }),
                makeTab({
                    id: "tab-b",
                    noteId: "notes/b",
                    title: "B",
                    content: "b",
                }),
                makeTab({
                    id: "tab-c",
                    noteId: "notes/c",
                    title: "C",
                    content: "c",
                }),
            ],
            activeTabId: "tab-c",
            activationHistory: ["tab-a", "tab-b", "tab-c"],
        });

        useEditorStore.getState().closeTab("tab-c");

        expect(useEditorStore.getState().activeTabId).toBe("tab-b");
    });

    it("tracks switching history when deciding which tab to restore", () => {
        useEditorStore.setState({
            tabs: [
                makeTab({
                    id: "tab-a",
                    noteId: "notes/a",
                    title: "A",
                    content: "a",
                }),
                makeTab({
                    id: "tab-b",
                    noteId: "notes/b",
                    title: "B",
                    content: "b",
                }),
                makeTab({
                    id: "tab-c",
                    noteId: "notes/c",
                    title: "C",
                    content: "c",
                }),
            ],
            activeTabId: "tab-a",
            activationHistory: ["tab-a"],
        });

        useEditorStore.getState().switchTab("tab-c");
        useEditorStore.getState().switchTab("tab-b");
        useEditorStore.getState().closeTab("tab-b");

        expect(useEditorStore.getState().activeTabId).toBe("tab-c");
    });

    it("updates title and content when clean tabs reload from disk", () => {
        useEditorStore.setState({
            tabs: [
                makeTab({
                    id: "tab-a",
                    noteId: "notes/a",
                    title: "Old title",
                    content: "Old body",
                }),
            ],
            activeTabId: "tab-a",
        });

        useEditorStore.getState().reloadNoteContent("notes/a", {
            title: "New title",
            content: "New body",
        });

        expect(useEditorStore.getState().tabs[0]).toMatchObject({
            title: "New title",
            content: "New body",
        });
    });
});
