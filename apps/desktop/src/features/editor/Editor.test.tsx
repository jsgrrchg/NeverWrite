import { act, fireEvent, screen } from "@testing-library/react";
import { getChunks, getOriginalDoc } from "@codemirror/merge";
import { EditorView, keymap } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { useEditorStore } from "../../app/store/editorStore";
import { useSettingsStore } from "../../app/store/settingsStore";
import { useCommandStore } from "../command-palette/store/commandStore";
import { useChatStore } from "../ai/store/chatStore";
import {
    buildPatchFromTexts,
    buildTextRangePatchFromTexts,
    emptyActionLogState,
    setTrackedFilesForWorkCycle,
} from "../ai/store/actionLogModel";
import type { TrackedFile } from "../ai/diff/actionLogTypes";
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

function seedTrackedDiff(
    targetPath: string,
    diffBase: string,
    currentText: string,
) {
    const workCycleId = "wc-inline-diff";
    const trackedFile: TrackedFile = {
        identityKey: targetPath,
        originPath: targetPath,
        path: targetPath,
        previousPath: null,
        status: { kind: "modified" },
        diffBase,
        currentText,
        unreviewedRanges: buildTextRangePatchFromTexts(diffBase, currentText),
        unreviewedEdits: buildPatchFromTexts(diffBase, currentText),
        version: 1,
        isText: true,
        updatedAt: 1,
    };

    useChatStore.setState({
        sessionsById: {
            "session-inline-diff": {
                sessionId: "session-inline-diff",
                historySessionId: "session-inline-diff",
                status: "idle",
                activeWorkCycleId: workCycleId,
                visibleWorkCycleId: workCycleId,
                actionLog: setTrackedFilesForWorkCycle(
                    emptyActionLogState(),
                    workCycleId,
                    { [trackedFile.identityKey]: trackedFile },
                ),
                runtimeId: "test-runtime",
                modelId: "test-model",
                modeId: "default",
                models: [],
                modes: [],
                configOptions: [],
                messages: [],
                attachments: [],
            },
        },
        sessionOrder: ["session-inline-diff"],
        activeSessionId: "session-inline-diff",
    });
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

    it("offers a quick action to disable spellcheck from the editor context menu", async () => {
        mockInvoke().mockImplementation(async (command) => {
            if (command === "spellcheck_suggest") {
                return {
                    language: "en-US",
                    word: "hello",
                    correct: true,
                    suggestions: [],
                };
            }

            return undefined;
        });

        setEditorTabs([
            {
                id: "tab-1",
                noteId: "notes/current",
                title: "Current",
                content: "hello world",
            },
        ]);

        useSettingsStore.getState().setSetting("editorSpellcheck", true);

        renderComponent(<Editor />);

        const view = getEditorView();
        vi.spyOn(view, "posAtCoords").mockReturnValue(1);

        await act(async () => {
            fireEvent.contextMenu(view.dom, {
                clientX: 24,
                clientY: 32,
            });
            await flushPromises();
        });

        await act(async () => {
            fireEvent.click(await screen.findByText("Disable Spellcheck"));
            await flushPromises();
        });

        expect(useSettingsStore.getState().editorSpellcheck).toBe(false);
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

    it("activates merge view only in source mode", async () => {
        setEditorTabs([
            {
                id: "tab-1",
                noteId: "notes/current",
                title: "Current",
                content: "new line",
            },
        ]);
        seedTrackedDiff("notes/current.md", "old line", "new line");

        renderComponent(<Editor />);

        let view = getEditorView();
        expect(getChunks(view.state)).toBeNull();
        expect(document.querySelector(".cm-lineNumbers")).toBeNull();
        expect(document.querySelector(".cm-editor")).toHaveAttribute(
            "data-live-preview",
            "true",
        );

        await act(async () => {
            useSettingsStore.getState().setSetting("livePreviewEnabled", false);
            await flushPromises();
        });

        view = getEditorView();
        expect(getChunks(view.state)?.chunks.length).toBe(1);
        expect(getOriginalDoc(view.state).toString()).toBe("old line");
        expect(document.querySelector(".cm-lineNumbers")).not.toBeNull();
        expect(document.querySelector(".cm-editor")).toHaveAttribute(
            "data-live-preview",
            "false",
        );

        await act(async () => {
            useSettingsStore.getState().setSetting("livePreviewEnabled", true);
            await flushPromises();
        });

        view = getEditorView();
        expect(getChunks(view.state)).toBeNull();
        expect(document.querySelector(".cm-lineNumbers")).toBeNull();
        expect(document.querySelector(".cm-editor")).toHaveAttribute(
            "data-live-preview",
            "true",
        );
    });

    it("registers heading shortcuts and syncs the visible title from the leading H1", async () => {
        setEditorTabs([
            {
                id: "tab-1",
                noteId: "notes/current",
                title: "Current",
                content: "Hello world\nBody",
            },
        ]);

        renderComponent(<Editor />);

        const view = getEditorView();
        await act(async () => {
            view.focus();
            view.dispatch({ selection: { anchor: 0 } });
        });

        expect(
            view.state
                .facet(keymap)
                .flat()
                .some((binding) => binding.key === "Mod-1"),
        ).toBe(true);

        await act(async () => {
            useCommandStore.getState().execute("editor:heading-1");
            await flushPromises();
        });

        expect(view.state.doc.toString()).toBe("# Hello world\nBody");
        expect(screen.getByDisplayValue("Hello world")).toBeInTheDocument();
        expect(useEditorStore.getState().tabs[0]?.title).toBe("Hello world");
    });

    it("registers Cmd+B and applies bold formatting to the current selection", async () => {
        setEditorTabs([
            {
                id: "tab-1",
                noteId: "notes/current",
                title: "Current",
                content: "Hello world",
            },
        ]);

        renderComponent(<Editor />);

        const view = getEditorView();
        await act(async () => {
            view.focus();
            view.dispatch({ selection: { anchor: 0, head: 5 } });
        });

        const boldBinding = view.state
            .facet(keymap)
            .flat()
            .find((binding) => binding.key === "Mod-b");

        expect(boldBinding).toBeDefined();
        expect(boldBinding?.run?.(view)).toBe(true);
        expect(view.state.doc.toString()).toBe("**Hello** world");
    });

    it("registers heading commands and keeps frontmatter title as the visible title", async () => {
        setEditorTabs([
            {
                id: "tab-1",
                noteId: "notes/current",
                title: "Frontmatter title",
                content:
                    "---\ntitle: Frontmatter title\n---\nBody heading\nBody",
            },
        ]);

        renderComponent(<Editor />);

        const view = getEditorView();

        expect(
            useCommandStore.getState().commands.get("editor:heading-1"),
        ).toBeDefined();
        expect(
            useCommandStore.getState().commands.get("editor:heading-0"),
        ).toBeDefined();

        await act(async () => {
            view.dispatch({ selection: { anchor: 0 } });
            useCommandStore.getState().execute("editor:heading-1");
            await flushPromises();
        });

        expect(view.state.doc.toString()).toBe("# Body heading\nBody");
        expect(screen.getAllByDisplayValue("Frontmatter title")).toHaveLength(
            2,
        );
        expect(useEditorStore.getState().tabs[0]?.title).toBe(
            "Frontmatter title",
        );
    });

    it("applies heading actions from the floating selection toolbar", async () => {
        setEditorTabs([
            {
                id: "tab-1",
                noteId: "notes/current",
                title: "Current",
                content: "Hello world\nBody",
            },
        ]);

        renderComponent(<Editor />);

        const view = getEditorView();
        const coordsSpy = vi.spyOn(view, "coordsAtPos").mockImplementation(
            () =>
                ({
                    left: 40,
                    right: 180,
                    top: 20,
                    bottom: 40,
                }) as DOMRect,
        );

        await act(async () => {
            view.focus();
            view.dispatch({
                selection: {
                    anchor: 0,
                    head: 5,
                },
            });
        });

        const headingButton = await screen.findByRole("button", {
            name: "Heading 1",
        });

        await act(async () => {
            fireEvent.mouseDown(headingButton);
            await flushPromises();
        });

        expect(view.state.doc.toString()).toBe("# Hello world\nBody");
        expect(screen.getByDisplayValue("Hello world")).toBeInTheDocument();
        expect(useEditorStore.getState().tabs[0]?.title).toBe("Hello world");

        coordsSpy.mockRestore();
    });

    it("does not crash when CodeMirror throws during selection coordinate lookup", async () => {
        const warnSpy = vi
            .spyOn(console, "warn")
            .mockImplementation(() => undefined);

        setEditorTabs([
            {
                id: "tab-1",
                noteId: "notes/current",
                title: "Current",
                content: "Hello world\nBody",
            },
        ]);

        renderComponent(<Editor />);

        const view = getEditorView();
        vi.spyOn(view, "coordsAtPos").mockImplementation(() => {
            throw new Error("No tile at position 0");
        });

        await act(async () => {
            view.focus();
            view.dispatch({
                selection: {
                    anchor: 0,
                    head: 5,
                },
            });
            await flushPromises();
        });

        expect(
            screen.queryByRole("button", { name: "Heading 1" }),
        ).not.toBeInTheDocument();
        expect(warnSpy).toHaveBeenCalledWith(
            "Ignoring transient CodeMirror coordinate lookup failure in coordsAtPos.",
            expect.any(Error),
        );

        warnSpy.mockRestore();
    });

    it("registers structural editor commands and executes them from the command palette store", async () => {
        setEditorTabs([
            {
                id: "tab-1",
                noteId: "notes/current",
                title: "Current",
                content: "Hello world\nNext line",
            },
        ]);

        renderComponent(<Editor />);

        const view = getEditorView();

        expect(
            useCommandStore.getState().commands.get("editor:blockquote"),
        ).toBeDefined();
        expect(
            useCommandStore.getState().commands.get("editor:code-block"),
        ).toBeDefined();
        expect(
            useCommandStore.getState().commands.get("editor:horizontal-rule"),
        ).toBeDefined();
        expect(
            useCommandStore
                .getState()
                .commands.get("editor:code-block-language"),
        ).toBeDefined();

        await act(async () => {
            view.dispatch({ selection: { anchor: 0 } });
            useCommandStore.getState().execute("editor:blockquote");
            await flushPromises();
        });

        expect(view.state.doc.toString()).toBe("> Hello world\nNext line");

        await act(async () => {
            view.dispatch({ selection: { anchor: 3 } });
            useCommandStore.getState().execute("editor:horizontal-rule");
            await flushPromises();
        });

        expect(view.state.doc.toString()).toBe("> Hello world\n---\nNext line");
    });

    it("inserts code blocks and lets the language be updated through commands", async () => {
        const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("ts");

        setEditorTabs([
            {
                id: "tab-1",
                noteId: "notes/current",
                title: "Current",
                content: "const value = 1;",
            },
        ]);

        renderComponent(<Editor />);

        const view = getEditorView();

        await act(async () => {
            view.dispatch({
                selection: { anchor: 0, head: view.state.doc.length },
            });
            useCommandStore.getState().execute("editor:code-block");
            await flushPromises();
        });

        expect(view.state.doc.toString()).toBe("```\nconst value = 1;\n```");

        await act(async () => {
            view.dispatch({ selection: { anchor: 5 } });
            useCommandStore.getState().execute("editor:code-block-language");
            await flushPromises();
        });

        expect(promptSpy).toHaveBeenCalledWith("Code block language", "");
        expect(view.state.doc.toString()).toBe("```ts\nconst value = 1;\n```");

        promptSpy.mockRestore();
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

    it("offers grammar suggestions from the title context menu", async () => {
        mockInvoke().mockImplementation(async (command) => {
            if (command === "spellcheck_check_grammar") {
                return {
                    language: "en-US",
                    diagnostics: [
                        {
                            start_utf16: 0,
                            end_utf16: 3,
                            message: "Possible typo",
                            short_message: null,
                            replacements: ["The"],
                            rule_id: "EN_A_VS_AN",
                            rule_description: "Possible typo",
                            issue_type: "misspelling",
                            category_id: "TYPOS",
                            category_name: "Typos",
                        },
                    ],
                };
            }

            return undefined;
        });

        useSettingsStore.getState().setSetting("editorSpellcheck", false);
        useSettingsStore.getState().setSetting("grammarCheckEnabled", true);
        useSettingsStore
            .getState()
            .setSetting("spellcheckPrimaryLanguage", "en-US");

        setEditorTabs([
            {
                id: "tab-1",
                noteId: "notes/current",
                title: "Teh title",
                content: "Body",
            },
        ]);

        renderComponent(<Editor />);

        const titleInput = screen.getByDisplayValue(
            "Teh title",
        ) as HTMLTextAreaElement;

        await act(async () => {
            titleInput.focus();
            titleInput.setSelectionRange(1, 1);
            fireEvent.contextMenu(titleInput, {
                clientX: 24,
                clientY: 32,
            });
            await flushPromises();
        });

        expect(await screen.findByText("Possible typo")).toBeInTheDocument();
        const suggestion = await screen.findByText("The");

        await act(async () => {
            fireEvent.click(suggestion);
            await flushPromises();
        });

        expect(screen.getByDisplayValue("The title")).toBeInTheDocument();
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

    it("does not crash when CodeMirror throws during context-menu coordinate lookup", async () => {
        const warnSpy = vi
            .spyOn(console, "warn")
            .mockImplementation(() => undefined);

        setEditorTabs([
            {
                id: "tab-1",
                noteId: "notes/current",
                title: "Current",
                content: "hello world",
            },
        ]);

        useSettingsStore.getState().setSetting("editorSpellcheck", true);

        renderComponent(<Editor />);

        const view = getEditorView();
        vi.spyOn(view, "posAtCoords").mockImplementation(() => {
            throw new Error("Cannot destructure property 'tile' from null");
        });

        await act(async () => {
            fireEvent.contextMenu(view.dom, {
                clientX: 24,
                clientY: 32,
            });
            await flushPromises();
        });

        expect(screen.getByText("Disable Spellcheck")).toBeInTheDocument();
        expect(warnSpy).toHaveBeenCalledWith(
            "Ignoring transient CodeMirror coordinate lookup failure in posAtCoords.",
            expect.any(Error),
        );

        warnSpy.mockRestore();
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

    it("forces a doc reload even when the tab content already matches the incoming content", async () => {
        vi.useFakeTimers();

        setEditorTabs([
            {
                id: "tab-1",
                noteId: "notes/current",
                title: "Current",
                content: "Restored body",
            },
        ]);

        renderComponent(<Editor />);
        const view = getEditorView();

        await act(async () => {
            view.dispatch({
                changes: {
                    from: 0,
                    to: view.state.doc.length,
                    insert: "Deleted body",
                },
            });
        });

        expect(view.state.doc.toString()).toBe("Deleted body");
        const tab = useEditorStore.getState().tabs[0];
        expect(tab && "content" in tab ? tab.content : undefined).toBe(
            "Restored body",
        );

        await act(async () => {
            useEditorStore.getState().forceReloadNoteContent("notes/current", {
                title: "Current",
                content: "Restored body",
            });
            await flushPromises();
        });

        expect(view.state.doc.toString()).toBe("Restored body");

        vi.clearAllTimers();
        vi.useRealTimers();
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

    it("recreates the editor view and shows the next note immediately on tab switch", async () => {
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
            "tab-1",
        );

        renderComponent(<Editor />);

        const firstView = getEditorView();
        expect(firstView.state.doc.toString()).toBe("Current body");

        await act(async () => {
            useEditorStore.getState().switchTab("tab-2");
            await flushPromises();
        });

        const secondView = getEditorView();
        expect(secondView).not.toBe(firstView);
        expect(secondView.state.doc.toString()).toBe("Other body");
        expect(screen.getByText("Other body")).toBeInTheDocument();
    });

    it("keeps the scroll header ahead of the gutters in source mode across tab switches", async () => {
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
            "tab-1",
        );
        useSettingsStore.getState().setSetting("livePreviewEnabled", false);

        renderComponent(<Editor />);

        const firstView = getEditorView();
        expect(firstView.scrollDOM.firstElementChild).toHaveClass(
            "cm-lp-scroll-header",
        );

        await act(async () => {
            useEditorStore.getState().switchTab("tab-2");
            await flushPromises();
        });

        const secondView = getEditorView();
        expect(secondView.scrollDOM.firstElementChild).toHaveClass(
            "cm-lp-scroll-header",
        );
        expect(secondView.state.doc.toString()).toBe("Other body");
    });

    it("reapplies merge view when returning to a note tab in source mode", async () => {
        setEditorTabs(
            [
                {
                    id: "tab-1",
                    noteId: "notes/current",
                    title: "Current",
                    content: "new line",
                },
                {
                    id: "tab-2",
                    noteId: "notes/other",
                    title: "Other",
                    content: "other body",
                },
            ],
            "tab-1",
        );
        useSettingsStore.getState().setSetting("livePreviewEnabled", false);
        seedTrackedDiff("notes/current.md", "old line", "new line");

        renderComponent(<Editor />);
        expect(getChunks(getEditorView().state)?.chunks.length).toBe(1);

        await act(async () => {
            useEditorStore.getState().switchTab("tab-2");
            await flushPromises();
        });

        expect(getChunks(getEditorView().state)).toBeNull();

        await act(async () => {
            useEditorStore.getState().switchTab("tab-1");
            await flushPromises();
        });

        expect(getChunks(getEditorView().state)?.chunks.length).toBe(1);

        await act(async () => {
            useChatStore.setState({
                sessionsById: {},
                sessionOrder: [],
                activeSessionId: null,
            });
            await flushPromises();
        });
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
