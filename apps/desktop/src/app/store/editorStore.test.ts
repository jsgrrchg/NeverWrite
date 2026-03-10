import { describe, expect, it } from "vitest";
import {
    markSessionReady,
    readPersistedSession,
    useEditorStore,
} from "./editorStore";
import { useVaultStore } from "./vaultStore";

describe("editorStore session persistence", () => {
    it("persists open tabs per vault path", async () => {
        markSessionReady();
        useVaultStore.setState({ vaultPath: "/vaults/geo-2026" });

        useEditorStore.setState({
            tabs: [
                {
                    id: "tab-1",
                    noteId: "notes/uk",
                    title: "UK",
                    content: "content",
                },
            ],
            activeTabId: "tab-1",
        });

        const persistedRaw = localStorage.getItem(
            "vaultai.session.tabs:/vaults/geo-2026",
        );
        expect(persistedRaw).not.toBeNull();
        expect(readPersistedSession("/vaults/geo-2026")).toEqual({
            noteIds: [{ noteId: "notes/uk", title: "UK" }],
            activeNoteId: "notes/uk",
        });
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

    it("opens linked notes immediately to the right of the active tab", () => {
        useEditorStore.setState({
            tabs: [
                {
                    id: "tab-a",
                    noteId: "notes/source",
                    title: "Source",
                    content: "source",
                },
                {
                    id: "tab-b",
                    noteId: "notes/other",
                    title: "Other",
                    content: "other",
                },
            ],
            activeTabId: "tab-a",
        });

        useEditorStore.getState().openNote("notes/linked", "Linked", "linked", {
            placement: "afterActive",
        });

        expect(useEditorStore.getState().tabs.map((tab) => tab.noteId)).toEqual(
            ["notes/source", "notes/linked", "notes/other"],
        );
    });

    it("keeps default openings appended at the end", () => {
        useEditorStore.setState({
            tabs: [
                {
                    id: "tab-a",
                    noteId: "notes/source",
                    title: "Source",
                    content: "source",
                },
                {
                    id: "tab-b",
                    noteId: "notes/other",
                    title: "Other",
                    content: "other",
                },
            ],
            activeTabId: "tab-a",
        });

        useEditorStore
            .getState()
            .openNote("notes/appended", "Appended", "appended");

        expect(useEditorStore.getState().tabs.map((tab) => tab.noteId)).toEqual(
            ["notes/source", "notes/other", "notes/appended"],
        );
    });

    it("returns to the most recently active tab when closing the current one", () => {
        useEditorStore.setState({
            tabs: [
                {
                    id: "tab-a",
                    noteId: "notes/a",
                    title: "A",
                    content: "a",
                },
                {
                    id: "tab-b",
                    noteId: "notes/b",
                    title: "B",
                    content: "b",
                },
                {
                    id: "tab-c",
                    noteId: "notes/c",
                    title: "C",
                    content: "c",
                },
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
                {
                    id: "tab-a",
                    noteId: "notes/a",
                    title: "A",
                    content: "a",
                },
                {
                    id: "tab-b",
                    noteId: "notes/b",
                    title: "B",
                    content: "b",
                },
                {
                    id: "tab-c",
                    noteId: "notes/c",
                    title: "C",
                    content: "c",
                },
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
                {
                    id: "tab-a",
                    noteId: "notes/a",
                    title: "Old title",
                    content: "Old body",
                },
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
