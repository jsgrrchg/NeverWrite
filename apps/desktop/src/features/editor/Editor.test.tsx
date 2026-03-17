import { act, fireEvent, screen } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { useEditorStore } from "../../app/store/editorStore";
import { useSettingsStore } from "../../app/store/settingsStore";
import { resolveFrontendSpellcheckLanguage } from "../spellcheck/api";
import { useSpellcheckStore } from "../spellcheck/store";
import { Editor } from "./Editor";
import {
    flushPromises,
    mockInvoke,
    renderComponent,
    setEditorTabs,
    setVaultNotes,
} from "../../test/test-utils";

function getEditorView() {
    const editorElement = document.querySelector(".cm-editor");
    expect(editorElement).not.toBeNull();

    const view = EditorView.findFromDOM(editorElement as HTMLElement);
    expect(view).not.toBeNull();
    return view!;
}

describe("Editor", () => {
    it("renders app-owned spellcheck decorations for misspelled words", async () => {
        vi.useFakeTimers();
        mockInvoke().mockImplementation(async (command) => {
            if (command === "spellcheck_check_text") {
                return {
                    language: "en-US",
                    secondary_language: null,
                    diagnostics: [
                        { start_utf16: 6, end_utf16: 10, word: "wrld" },
                    ],
                };
            }
            return undefined;
        });

        setEditorTabs([
            {
                id: "tab-1",
                noteId: "notes/current",
                title: "Current",
                content: "hello wrld",
            },
        ]);

        renderComponent(<Editor />);

        await act(async () => {
            vi.advanceTimersByTime(250);
            await flushPromises();
        });

        expect(document.querySelector(".cm-spellcheck-error")).not.toBeNull();
    });

    it("does not underline words that are valid only in the secondary language", async () => {
        vi.useFakeTimers();
        mockInvoke().mockImplementation(async (command) => {
            if (command === "spellcheck_check_text") {
                return {
                    language: "es-ES",
                    secondary_language: "en-US",
                    diagnostics: [],
                };
            }
            return undefined;
        });

        useSettingsStore
            .getState()
            .setSetting("spellcheckPrimaryLanguage", "es-ES");
        useSettingsStore
            .getState()
            .setSetting("spellcheckSecondaryLanguage", "en-US");

        setEditorTabs([
            {
                id: "tab-1",
                noteId: "notes/current",
                title: "Current",
                content: "hola world",
            },
        ]);

        renderComponent(<Editor />);

        await act(async () => {
            vi.advanceTimersByTime(250);
            await flushPromises();
        });

        expect(mockInvoke()).toHaveBeenCalledWith(
            "spellcheck_check_text",
            expect.objectContaining({
                language: "es-ES",
                secondaryLanguage: "en-US",
            }),
        );
        expect(document.querySelector(".cm-spellcheck-error")).toBeNull();
    });

    it("shows line numbers when live preview is disabled", async () => {
        setEditorTabs([
            {
                id: "tab-1",
                noteId: "notes/current",
                title: "Current",
                content: "First line\nSecond line",
            },
        ]);

        renderComponent(<Editor />);
        expect(document.querySelector(".cm-lineNumbers")).toBeNull();

        await act(async () => {
            useSettingsStore.getState().setSetting("livePreviewEnabled", false);
        });

        expect(document.querySelector(".cm-lineNumbers")).not.toBeNull();
        expect(document.querySelector(".cm-editor")).toHaveAttribute(
            "data-live-preview",
            "false",
        );
    });

    it("uses the shared spellcheck menu for the title textarea", async () => {
        mockInvoke().mockImplementation(async (command) => {
            if (command === "spellcheck_check_text") {
                return {
                    language: "en-US",
                    diagnostics: [],
                };
            }

            if (command === "spellcheck_suggest") {
                return {
                    language: "en-US",
                    word: "Curent",
                    correct: false,
                    suggestions: ["Current"],
                };
            }

            return undefined;
        });

        useSettingsStore.getState().setSetting("editorSpellcheck", true);
        useSettingsStore
            .getState()
            .setSetting("spellcheckPrimaryLanguage", "en-US");
        useSpellcheckStore.setState({
            enabled: true,
            requestedPrimaryLanguage: "en-US",
            requestedSecondaryLanguage: null,
            resolvedPrimaryLanguage: resolveFrontendSpellcheckLanguage("en-US"),
            resolvedSecondaryLanguage: null,
            languages: [],
            runtimeDirectory: null,
            lastError: null,
            documentCache: new Map(),
            ignoredSessionWords: new Set(),
        });

        setEditorTabs([
            {
                id: "tab-1",
                noteId: "notes/current",
                title: "Curent",
                content: "Body",
            },
        ]);

        renderComponent(<Editor />);

        const titleInput = screen.getByDisplayValue(
            "Curent",
        ) as HTMLTextAreaElement;

        await act(async () => {
            titleInput.focus();
            titleInput.setSelectionRange(2, 2);
            fireEvent.contextMenu(titleInput, {
                clientX: 24,
                clientY: 32,
            });
            await flushPromises();
        });

        const suggestion = await screen.findByText("Current");
        expect(suggestion).toBeInTheDocument();
        expect(screen.getByText("Rename Note")).toBeInTheDocument();
        expect(screen.getByText("Add to Dictionary")).toBeInTheDocument();
        expect(screen.getByText("Ignore for Session")).toBeInTheDocument();
        expect(mockInvoke()).toHaveBeenCalledWith(
            "spellcheck_suggest",
            expect.objectContaining({
                language: "en-US",
            }),
        );

        await act(async () => {
            fireEvent.click(suggestion);
            await flushPromises();
        });

        expect(screen.getByDisplayValue("Current")).toBeInTheDocument();
    });

    it("runs dictionary actions from the shared title spellcheck menu", async () => {
        mockInvoke().mockImplementation(async (command, payload) => {
            if (command === "spellcheck_check_text") {
                return {
                    language: "en-US",
                    diagnostics: [],
                };
            }

            if (command === "spellcheck_suggest") {
                return {
                    language: "en-US",
                    word: "Curent",
                    correct: false,
                    suggestions: ["Current"],
                };
            }

            if (command === "spellcheck_add_to_dictionary") {
                return {
                    language: "en-US",
                    word: (payload as { word: string }).word,
                    updated: true,
                    user_dictionary_path: "/tmp/spellcheck/user/en-US.txt",
                };
            }

            if (command === "spellcheck_ignore_word") {
                return {
                    language: "en-US",
                    word: (payload as { word: string }).word,
                    updated: true,
                    user_dictionary_path: "/tmp/spellcheck/user/en-US.txt",
                };
            }

            return undefined;
        });

        useSettingsStore.getState().setSetting("editorSpellcheck", true);
        useSettingsStore
            .getState()
            .setSetting("spellcheckPrimaryLanguage", "en-US");
        useSpellcheckStore.setState({
            enabled: true,
            requestedPrimaryLanguage: "en-US",
            requestedSecondaryLanguage: null,
            resolvedPrimaryLanguage: resolveFrontendSpellcheckLanguage("en-US"),
            resolvedSecondaryLanguage: null,
            languages: [],
            runtimeDirectory: null,
            lastError: null,
            documentCache: new Map(),
            ignoredSessionWords: new Set(),
        });

        setEditorTabs([
            {
                id: "tab-1",
                noteId: "notes/current",
                title: "Curent",
                content: "Body",
            },
        ]);

        renderComponent(<Editor />);

        const titleInput = screen.getByDisplayValue(
            "Curent",
        ) as HTMLTextAreaElement;

        await act(async () => {
            titleInput.focus();
            titleInput.setSelectionRange(2, 2);
            fireEvent.contextMenu(titleInput, {
                clientX: 24,
                clientY: 32,
            });
            await flushPromises();
        });

        await act(async () => {
            fireEvent.click(screen.getByText("Add to Dictionary"));
            await flushPromises();
        });

        expect(mockInvoke()).toHaveBeenCalledWith(
            "spellcheck_add_to_dictionary",
            {
                word: "Curent",
                language: "en-US",
            },
        );

        await act(async () => {
            fireEvent.contextMenu(titleInput, {
                clientX: 24,
                clientY: 32,
            });
            await flushPromises();
        });

        await act(async () => {
            fireEvent.click(screen.getByText("Ignore for Session"));
            await flushPromises();
        });

        expect(mockInvoke()).toHaveBeenCalledWith("spellcheck_ignore_word", {
            word: "Curent",
            language: "en-US",
        });
    });

    it("can set the secondary language from the shared spellcheck menu", async () => {
        mockInvoke().mockImplementation(async (command) => {
            if (command === "spellcheck_suggest") {
                return {
                    language: "es-ES",
                    secondary_language: null,
                    word: "world",
                    correct: false,
                    suggestions: [],
                };
            }

            if (command === "spellcheck_check_text") {
                return {
                    language: "es-ES",
                    secondary_language: null,
                    diagnostics: [],
                };
            }

            return undefined;
        });

        useSettingsStore.getState().setSetting("editorSpellcheck", true);
        useSettingsStore
            .getState()
            .setSetting("spellcheckPrimaryLanguage", "es-ES");
        useSettingsStore
            .getState()
            .setSetting("spellcheckSecondaryLanguage", null);
        useSpellcheckStore.setState({
            enabled: true,
            requestedPrimaryLanguage: "es-ES",
            requestedSecondaryLanguage: null,
            resolvedPrimaryLanguage: resolveFrontendSpellcheckLanguage("es-ES"),
            resolvedSecondaryLanguage: null,
            languages: [
                {
                    id: "es-ES",
                    label: "Spanish (Spain)",
                    available: true,
                    source: "bundled-pack",
                    dictionary_path: null,
                    user_dictionary_path: "/tmp/es-ES.txt",
                    aff_path: null,
                    dic_path: null,
                    version: null,
                    size_bytes: null,
                    license: null,
                    homepage: null,
                },
                {
                    id: "en-US",
                    label: "English (US)",
                    available: true,
                    source: "bundled-pack",
                    dictionary_path: null,
                    user_dictionary_path: "/tmp/en-US.txt",
                    aff_path: null,
                    dic_path: null,
                    version: null,
                    size_bytes: null,
                    license: null,
                    homepage: null,
                },
            ],
            runtimeDirectory: null,
            lastError: null,
            documentCache: new Map(),
            ignoredSessionWords: new Set(),
        });

        setEditorTabs([
            {
                id: "tab-1",
                noteId: "notes/current",
                title: "Actual",
                content: "hola world",
            },
        ]);

        renderComponent(<Editor />);

        const titleInput = screen.getByDisplayValue(
            "Actual",
        ) as HTMLTextAreaElement;

        await act(async () => {
            titleInput.focus();
            titleInput.setSelectionRange(0, 0);
            fireEvent.contextMenu(titleInput, {
                clientX: 24,
                clientY: 32,
            });
            await flushPromises();
        });

        const secondaryAction = await screen.findByText(
            "Use English (US) as Secondary",
        );

        await act(async () => {
            fireEvent.click(secondaryAction);
            await flushPromises();
        });

        expect(useSettingsStore.getState().spellcheckSecondaryLanguage).toBe(
            "en-US",
        );
    });

    it("does not treat multi-word title selections as dictionary candidates", async () => {
        mockInvoke().mockImplementation(async (command) => {
            if (command === "spellcheck_check_text") {
                return {
                    language: "en-US",
                    diagnostics: [],
                };
            }

            if (command === "spellcheck_suggest") {
                return {
                    language: "en-US",
                    word: "Two Words",
                    correct: false,
                    suggestions: [],
                };
            }

            return undefined;
        });

        useSettingsStore.getState().setSetting("editorSpellcheck", true);
        useSettingsStore
            .getState()
            .setSetting("spellcheckPrimaryLanguage", "en-US");
        useSpellcheckStore.setState({
            enabled: true,
            requestedPrimaryLanguage: "en-US",
            requestedSecondaryLanguage: null,
            resolvedPrimaryLanguage: resolveFrontendSpellcheckLanguage("en-US"),
            resolvedSecondaryLanguage: null,
            languages: [],
            runtimeDirectory: null,
            lastError: null,
            documentCache: new Map(),
            ignoredSessionWords: new Set(),
        });

        setEditorTabs([
            {
                id: "tab-1",
                noteId: "notes/current",
                title: "Two Words",
                content: "Body",
            },
        ]);

        renderComponent(<Editor />);

        const titleInput = screen.getByDisplayValue(
            "Two Words",
        ) as HTMLTextAreaElement;

        await act(async () => {
            titleInput.focus();
            titleInput.setSelectionRange(0, 9);
            fireEvent.contextMenu(titleInput, {
                clientX: 24,
                clientY: 32,
            });
            await flushPromises();
        });

        expect(screen.queryByText("Add to Dictionary")).not.toBeInTheDocument();
        expect(
            screen.queryByText("Ignore for Session"),
        ).not.toBeInTheDocument();
        expect(screen.getByText("Rename Note")).toBeInTheDocument();
        expect(mockInvoke()).not.toHaveBeenCalledWith(
            "spellcheck_suggest",
            expect.anything(),
        );
    });

    it("hides the selection layer when the selection collapses", async () => {
        setEditorTabs([
            {
                id: "tab-1",
                noteId: "notes/current",
                title: "Current",
                content: "First paragraph\n\nSecond paragraph",
            },
        ]);

        renderComponent(<Editor />);
        expect(
            screen.queryByText("Open a note from the left panel"),
        ).not.toBeInTheDocument();

        const view = getEditorView();
        const coordsSpy = vi
            .spyOn(view, "coordsAtPos")
            .mockImplementation(() => ({
                left: 40,
                right: 180,
                top: 20,
                bottom: 40,
            }));

        await act(async () => {
            view.focus();
            view.dispatch({
                selection: {
                    anchor: 0,
                    head: 5,
                },
            });
        });

        const selectionLayer = view.dom.querySelector(".cm-selectionLayer");
        expect(selectionLayer).toBeInstanceOf(HTMLElement);
        expect((selectionLayer as HTMLElement).style.opacity).toBe("1");

        await act(async () => {
            view.dispatch({
                selection: {
                    anchor: 5,
                    head: 5,
                },
            });
        });

        expect((selectionLayer as HTMLElement).style.opacity).toBe("0");
        coordsSpy.mockRestore();
    });

    it("saves the previous tab immediately when switching tabs with pending autosave", async () => {
        mockInvoke().mockImplementation(async (command) => {
            if (command === "save_note") {
                return {
                    id: "notes/current",
                    path: "/vault/notes/current.md",
                    title: "Current",
                    content: "Updated body",
                };
            }
            return undefined;
        });

        setEditorTabs(
            [
                {
                    id: "tab-1",
                    noteId: "notes/current",
                    title: "Current",
                    content: "Original body",
                },
                {
                    id: "tab-2",
                    noteId: "notes/other",
                    title: "Other",
                    content: "Other body",
                },
            ],
            "tab-1",
        );
        setVaultNotes([
            {
                id: "notes/current",
                title: "Current",
                path: "/vault/notes/current.md",
                modified_at: 0,
                created_at: 0,
            },
            {
                id: "notes/other",
                title: "Other",
                path: "/vault/notes/other.md",
                modified_at: 0,
                created_at: 0,
            },
        ]);

        renderComponent(<Editor />);
        const view = getEditorView();

        await act(async () => {
            view.dispatch({
                changes: {
                    from: 0,
                    to: view.state.doc.length,
                    insert: "Updated body",
                },
            });
        });

        await act(async () => {
            useEditorStore.getState().switchTab("tab-2");
        });
        await flushPromises();

        expect(mockInvoke()).toHaveBeenCalledWith("save_note", {
            noteId: "notes/current",
            content: "Updated body",
            vaultPath: "/vault",
        });
    });

    it("updates the visible title when clean content reloads from disk", async () => {
        setEditorTabs([
            {
                id: "tab-1",
                noteId: "notes/current",
                title: "Current",
                content: "# Current\n\nBody",
            },
        ]);
        setVaultNotes([
            {
                id: "notes/current",
                title: "Current",
                path: "/vault/notes/current.md",
                modified_at: 0,
                created_at: 0,
            },
        ]);

        renderComponent(<Editor />);
        expect(screen.getByDisplayValue("Current")).toBeInTheDocument();

        await act(async () => {
            useEditorStore.getState().reloadNoteContent("notes/current", {
                title: "Renamed externally",
                content: "---\ntitle: Renamed externally\n---\nBody",
            });
        });

        expect(screen.getAllByDisplayValue("Renamed externally")).toHaveLength(
            2,
        );
    });

    it("does not save a clean tab when switching notes", async () => {
        setEditorTabs(
            [
                {
                    id: "tab-1",
                    noteId: "notes/current",
                    title: "Current",
                    content: "Original body",
                },
                {
                    id: "tab-2",
                    noteId: "notes/other",
                    title: "Other",
                    content: "Other body",
                },
            ],
            "tab-1",
        );

        renderComponent(<Editor />);

        await act(async () => {
            useEditorStore.getState().switchTab("tab-2");
        });
        await flushPromises();

        expect(mockInvoke()).not.toHaveBeenCalledWith(
            "save_note",
            expect.anything(),
        );
    });

    it("closes the active tab on Cmd+W", async () => {
        setEditorTabs(
            [
                {
                    id: "tab-1",
                    noteId: "notes/current",
                    title: "Current",
                    content: "Current body",
                },
                {
                    id: "tab-2",
                    noteId: "notes/other",
                    title: "Other",
                    content: "Other body",
                },
            ],
            "tab-2",
        );

        renderComponent(<Editor />);

        await act(async () => {
            window.dispatchEvent(
                new KeyboardEvent("keydown", {
                    key: "w",
                    metaKey: true,
                    bubbles: true,
                }),
            );
        });

        expect(useEditorStore.getState().tabs.map((tab) => tab.id)).toEqual([
            "tab-1",
        ]);
        expect(useEditorStore.getState().activeTabId).toBe("tab-1");
    });
});
