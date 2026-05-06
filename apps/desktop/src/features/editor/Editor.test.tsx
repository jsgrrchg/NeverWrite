import { act, fireEvent, screen } from "@testing-library/react";
import { confirm } from "@neverwrite/runtime";
import { getChunks, getOriginalDoc } from "@codemirror/merge";
import { EditorSelection } from "@codemirror/state";
import { undo } from "@codemirror/commands";
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
    getTrackedFilesForSession,
    setTrackedFilesForWorkCycle,
} from "../ai/store/actionLogModel";
import type { TrackedFile } from "../ai/diff/actionLogTypes";
import { resolveFrontendSpellcheckLanguage } from "../spellcheck/api";
import { useSpellcheckStore } from "../spellcheck/store";
import { Editor, REQUEST_CLOSE_ACTIVE_TAB_EVENT } from "./Editor";
import { activateWikilinkSuggesterAnnotation } from "./extensions/markdownAutopair";
import {
    flushPromises,
    mockInvoke,
    renderComponent,
    setEditorTabs,
    setVaultEntries,
    setVaultNotes,
} from "../../test/test-utils";

function getEditorView() {
    const editorElement = document.querySelector(".cm-editor");
    expect(editorElement).not.toBeNull();

    const view = EditorView.findFromDOM(editorElement as HTMLElement);
    expect(view).not.toBeNull();
    return view!;
}

async function flushEditorViewUpdates() {
    await flushPromises();
    await act(async () => {
        vi.runOnlyPendingTimers();
    });
    await flushPromises();
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
        useSettingsStore
            .getState()
            .setSetting("editorSpellcheck", true);
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
        useSettingsStore
            .getState()
            .setSetting("editorSpellcheck", true);
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

    it("offers a quick action to enable spellcheck from the editor context menu", async () => {
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

        useSettingsStore.getState().setSetting("editorSpellcheck", false);

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
            fireEvent.click(await screen.findByText("Enable Spellcheck"));
            await flushPromises();
        });

        expect(useSettingsStore.getState().editorSpellcheck).toBe(true);
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

    it("renders highlights when whitespace appears before the closing delimiter in live preview", async () => {
        vi.useFakeTimers();
        setEditorTabs([
            {
                id: "tab-1",
                noteId: "notes/current",
                title: "Current",
                content: "==Actualización 09:44 CLT . == El cuerpo sigue.",
            },
        ]);

        renderComponent(<Editor />);
        await flushEditorViewUpdates();

        const highlight = document.querySelector(
            ".cm-lp-highlight",
        ) as HTMLElement | null;
        expect(highlight).not.toBeNull();
        expect(highlight?.textContent).toBe("Actualización 09:44 CLT .");
    });

    it("uses a left-aligned content inset when line wrapping is disabled in both preview modes", async () => {
        setEditorTabs([
            {
                id: "tab-1",
                noteId: "notes/current",
                title: "Current",
                content: "First line\nSecond line",
            },
        ]);

        renderComponent(<Editor />);

        await act(async () => {
            useSettingsStore.getState().setSetting("lineWrapping", false);
        });

        const shell = document.querySelector(".editor-shell") as HTMLElement;
        expect(shell).not.toBeNull();
        expect(shell.style.getPropertyValue("--editor-horizontal-inset")).toBe(
            "clamp(16px, 2vw, 24px)",
        );

        await act(async () => {
            useSettingsStore.getState().setSetting("livePreviewEnabled", false);
        });

        expect(document.querySelector(".cm-editor")).toHaveAttribute(
            "data-live-preview",
            "false",
        );
        expect(shell.style.getPropertyValue("--editor-horizontal-inset")).toBe(
            "clamp(16px, 2vw, 24px)",
        );
    });

    it("hydrates properties from frontmatter already present in the note", async () => {
        setEditorTabs([
            {
                id: "tab-1",
                noteId: "notes/current",
                title: "Frontmatter title",
                content:
                    "---\ntitle: Frontmatter title\ntags:\n  - project\n  - planning\n---\nBody",
            },
        ]);

        renderComponent(<Editor />);

        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Properties" }));
        });

        expect(screen.getByText("tags")).toBeInTheDocument();
        expect(screen.getAllByText("project").length).toBeGreaterThan(0);
        expect(screen.getAllByText("planning").length).toBeGreaterThan(0);
        expect(screen.getAllByDisplayValue("Frontmatter title")).toHaveLength(
            2,
        );
    });

    it("keeps properties in sync when frontmatter is edited in the document", async () => {
        setEditorTabs([
            {
                id: "tab-1",
                noteId: "notes/current",
                title: "Frontmatter title",
                content: "---\ntitle: Frontmatter title\n---\nBody",
            },
        ]);

        renderComponent(<Editor />);

        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Properties" }));
        });

        const view = getEditorView();
        const titleFrom = view.state.doc
            .toString()
            .indexOf("Frontmatter title");
        const titleTo = titleFrom + "Frontmatter title".length;

        await act(async () => {
            view.dispatch({
                changes: {
                    from: titleFrom,
                    to: titleTo,
                    insert: "Updated title",
                },
            });
        });

        expect(screen.getAllByDisplayValue("Updated title")).toHaveLength(2);
    });

    it("does not underline markdown headings in source mode", async () => {
        setEditorTabs([
            {
                id: "tab-1",
                noteId: "notes/current",
                title: "Current",
                content: "# Heading\nBody",
            },
        ]);
        useSettingsStore.getState().setSetting("livePreviewEnabled", false);

        renderComponent(<Editor />);

        const headingLine = document.querySelector(".cm-line") as HTMLElement;
        expect(headingLine).not.toBeNull();
        expect(headingLine.textContent).toContain("Heading");

        const headingTarget = headingLine.querySelector(
            ".cm-source-heading",
        ) as HTMLElement | null;

        expect(headingTarget).not.toBeNull();
        expect(
            window.getComputedStyle(headingTarget as Element).textDecoration,
        ).not.toContain("underline");
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

    it("projects the latest source scroll position back into live preview", async () => {
        vi.useFakeTimers();
        setEditorTabs([
            {
                id: "tab-1",
                noteId: "notes/current",
                title: "Current",
                content: "Line 1\nLine 2\nLine 3",
            },
        ]);

        renderComponent(<Editor />);

        vi.spyOn(EditorView.prototype, "posAtCoords").mockReturnValue(24);
        vi.spyOn(EditorView.prototype, "coordsAtPos").mockReturnValue(null);

        await flushEditorViewUpdates();

        let view = getEditorView();
        view.scrollDOM.scrollTop = 120;
        view.scrollDOM.scrollLeft = 16;

        await act(async () => {
            useSettingsStore.getState().setSetting("livePreviewEnabled", false);
        });
        await flushEditorViewUpdates();

        view = getEditorView();
        expect(document.querySelector(".cm-editor")).toHaveAttribute(
            "data-live-preview",
            "false",
        );
        expect(view.scrollDOM.scrollTop).toBe(120);
        expect(view.scrollDOM.scrollLeft).toBe(16);

        view.scrollDOM.scrollTop = 420;
        view.scrollDOM.scrollLeft = 24;

        await act(async () => {
            useSettingsStore.getState().setSetting("livePreviewEnabled", true);
        });
        await flushEditorViewUpdates();

        view = getEditorView();
        expect(document.querySelector(".cm-editor")).toHaveAttribute(
            "data-live-preview",
            "true",
        );
        expect(view.scrollDOM.scrollTop).toBe(420);
        expect(view.scrollDOM.scrollLeft).toBe(24);
    });

    it("restores the latest source-derived scroll position when returning to a tab in live preview", async () => {
        vi.useFakeTimers();
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

        vi.spyOn(EditorView.prototype, "posAtCoords").mockReturnValue(24);
        vi.spyOn(EditorView.prototype, "coordsAtPos").mockReturnValue(null);

        await flushEditorViewUpdates();

        let view = getEditorView();
        view.scrollDOM.scrollTop = 100;
        view.scrollDOM.scrollLeft = 5;

        await act(async () => {
            useSettingsStore.getState().setSetting("livePreviewEnabled", false);
        });
        await flushEditorViewUpdates();

        view = getEditorView();
        view.scrollDOM.scrollTop = 300;
        view.scrollDOM.scrollLeft = 11;

        await act(async () => {
            useEditorStore.getState().switchTab("tab-2");
        });
        await flushEditorViewUpdates();

        expect(getEditorView().state.doc.toString()).toBe("Other body");

        await act(async () => {
            useSettingsStore.getState().setSetting("livePreviewEnabled", true);
        });
        await flushEditorViewUpdates();

        await act(async () => {
            useEditorStore.getState().switchTab("tab-1");
        });
        await flushEditorViewUpdates();

        view = getEditorView();
        expect(view.state.doc.toString()).toBe("Current body");
        expect(document.querySelector(".cm-editor")).toHaveAttribute(
            "data-live-preview",
            "true",
        );
        expect(view.scrollDOM.scrollTop).toBe(300);
        expect(view.scrollDOM.scrollLeft).toBe(11);
    });

    it("does not activate merge view when inline review is disabled", async () => {
        setEditorTabs([
            {
                id: "tab-1",
                noteId: "notes/current",
                title: "Current",
                content: "new line",
            },
        ]);
        useSettingsStore.getState().setSetting("livePreviewEnabled", false);
        useSettingsStore.getState().setSetting("inlineReviewEnabled", false);
        seedTrackedDiff("notes/current.md", "old line", "new line");

        renderComponent(<Editor />);

        const view = getEditorView();
        expect(getChunks(view.state)).toBeNull();
        expect(document.querySelector(".cm-editor")).toHaveAttribute(
            "data-live-preview",
            "false",
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

        // Position cursor on the "Body heading" line (after frontmatter)
        const bodyOffset = view.state.doc.toString().indexOf("Body heading");
        await act(async () => {
            view.dispatch({ selection: { anchor: bodyOffset } });
            useCommandStore.getState().execute("editor:heading-1");
            await flushPromises();
        });

        expect(view.state.doc.toString()).toBe(
            "---\ntitle: Frontmatter title\n---\n# Body heading\nBody",
        );
        // Only the editable title textarea shows "Frontmatter title"
        // (the properties body is not rendered in source mode)
        expect(screen.getAllByDisplayValue("Frontmatter title")).toHaveLength(
            1,
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
            "[editor] Ignoring transient CodeMirror coordinate lookup failure in coordsAtPos.",
            expect.any(Error),
        );

        warnSpy.mockRestore();
    });

    it("copies the selected text even when selection coordinate lookup fails", async () => {
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
                    head: 11,
                },
            });
            await flushPromises();
        });

        const copyBinding = view.state
            .facet(keymap)
            .flat()
            .find((binding) => binding.key === "Mod-c");

        expect(copyBinding).toBeDefined();

        await act(async () => {
            expect(copyBinding?.run?.(view)).toBe(true);
            await flushPromises();
        });

        expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
            "Hello world",
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

    it("clears residual DOM selection while dragging the editor scrollbar", async () => {
        setEditorTabs([
            {
                id: "tab-1",
                noteId: "notes/current",
                title: "Current",
                content: Array.from(
                    { length: 40 },
                    (_, index) => `Line ${index + 1}`,
                ).join("\n"),
            },
        ]);

        renderComponent(<Editor />);

        const view = getEditorView();
        const firstLine = view.contentDOM.querySelector(".cm-line");
        expect(firstLine).toBeInstanceOf(HTMLElement);
        const textNode = firstLine?.firstChild;
        expect(textNode).not.toBeNull();

        const selection = document.getSelection();
        const range = document.createRange();
        range.setStart(textNode!, 0);
        range.setEnd(textNode!, 4);
        selection?.removeAllRanges();
        selection?.addRange(range);

        expect(selection?.isCollapsed).toBe(false);

        Object.defineProperty(view.scrollDOM, "clientWidth", {
            configurable: true,
            value: 280,
        });
        Object.defineProperty(view.scrollDOM, "offsetWidth", {
            configurable: true,
            value: 296,
        });
        Object.defineProperty(view.scrollDOM, "clientHeight", {
            configurable: true,
            value: 140,
        });
        Object.defineProperty(view.scrollDOM, "offsetHeight", {
            configurable: true,
            value: 156,
        });
        Object.defineProperty(view.scrollDOM, "scrollHeight", {
            configurable: true,
            value: 1200,
        });
        Object.defineProperty(view.scrollDOM, "scrollWidth", {
            configurable: true,
            value: 280,
        });
        vi.spyOn(view.scrollDOM, "getBoundingClientRect").mockReturnValue({
            x: 0,
            y: 0,
            left: 0,
            top: 0,
            right: 296,
            bottom: 156,
            width: 296,
            height: 156,
            toJSON: () => ({}),
        } as DOMRect);

        await act(async () => {
            fireEvent.mouseDown(view.scrollDOM, {
                button: 0,
                clientX: 292,
                clientY: 24,
            });
        });

        expect(view.dom.dataset.scrollbarDragging).toBe("true");
        expect(document.getSelection()?.rangeCount ?? 0).toBe(0);

        await act(async () => {
            fireEvent.mouseUp(document, { button: 0 });
        });

        expect(view.dom.dataset.scrollbarDragging).toBeUndefined();

        vi.spyOn(view, "posAtCoords").mockReturnValue(48);

        await act(async () => {
            fireEvent.mouseDown(firstLine as HTMLElement, {
                button: 0,
                clientX: 80,
                clientY: 24,
            });
        });

        expect(view.state.selection.main.anchor).toBe(48);
        expect(view.state.selection.main.head).toBe(48);
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
            "[editor] Ignoring transient CodeMirror coordinate lookup failure in posAtCoords.",
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

        expect(mockInvoke()).toHaveBeenCalledWith(
            "save_note",
            expect.objectContaining({
                noteId: "notes/current",
                content: "Updated body",
                vaultPath: "/vault",
                opId: expect.any(String),
            }),
        );
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

        // Only the editable title textarea shows "Renamed externally"
        // (the properties body is not rendered in source mode)
        expect(screen.getAllByDisplayValue("Renamed externally")).toHaveLength(
            1,
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
            await vi.runOnlyPendingTimersAsync();
            await flushPromises();
        });

        expect(view.state.doc.toString()).toBe("Restored body");

        vi.clearAllTimers();
        vi.useRealTimers();
    });

    it("shows an external conflict banner for real on-disk changes while local edits are unsaved", async () => {
        setEditorTabs([
            {
                id: "tab-1",
                noteId: "notes/current",
                title: "Current",
                content: "Original body",
            },
        ]);

        renderComponent(<Editor />);
        const view = getEditorView();

        await act(async () => {
            view.dispatch({
                changes: {
                    from: view.state.doc.length,
                    to: view.state.doc.length,
                    insert: " local",
                },
            });
        });

        await act(async () => {
            useEditorStore.getState().reloadNoteContent("notes/current", {
                title: "Current",
                content: "External body",
                origin: "external",
                revision: 2,
            });
            await flushPromises();
        });

        expect(
            screen.getByText(
                /This note changed on disk while you still have unsaved edits\./i,
            ),
        ).toBeInTheDocument();
    });

    it("uses the configured autosave delay for note edits", async () => {
        vi.useFakeTimers();
        useSettingsStore.getState().setSetting("editorAutosaveDelayMs", 750);

        mockInvoke().mockImplementation(async (command, args) => {
            if (command === "save_note") {
                return {
                    id: "notes/current",
                    path: "/vault/notes/current.md",
                    title: "Current",
                    content: (args as { content: string }).content,
                };
            }

            return undefined;
        });

        setEditorTabs([
            {
                id: "tab-1",
                noteId: "notes/current",
                title: "Current",
                content: "Original",
            },
        ]);

        renderComponent(<Editor />);
        const view = getEditorView();

        await act(async () => {
            view.dispatch({
                changes: {
                    from: view.state.doc.length,
                    to: view.state.doc.length,
                    insert: " local",
                },
            });
        });

        await act(async () => {
            vi.advanceTimersByTime(749);
            await flushPromises();
        });

        expect(
            mockInvoke().mock.calls.filter(([command]) => command === "save_note"),
        ).toHaveLength(0);

        await act(async () => {
            vi.advanceTimersByTime(1);
            await flushPromises();
        });

        expect(
            mockInvoke().mock.calls.filter(([command]) => command === "save_note"),
        ).toHaveLength(1);
        expect(mockInvoke()).toHaveBeenCalledWith(
            "save_note",
            expect.objectContaining({
                noteId: "notes/current",
                content: "Original local",
                opId: expect.any(String),
            }),
        );

        useSettingsStore.getState().setSetting("editorAutosaveDelayMs", 300);
        vi.clearAllTimers();
        vi.useRealTimers();
    });

    it("flushes pending content and autosave when the editor unmounts", async () => {
        vi.useFakeTimers();
        useSettingsStore.getState().setSetting("editorAutosaveDelayMs", 5_000);

        mockInvoke().mockImplementation(async (command, args) => {
            if (command === "save_note") {
                return {
                    id: "notes/current",
                    path: "/vault/notes/current.md",
                    title: "Current",
                    content: (args as { content: string }).content,
                };
            }

            return undefined;
        });

        setEditorTabs([
            {
                id: "tab-1",
                noteId: "notes/current",
                title: "Current",
                content: "Original",
            },
        ]);

        const { unmount } = renderComponent(<Editor />);
        const view = getEditorView();

        await act(async () => {
            view.dispatch({
                changes: {
                    from: view.state.doc.length,
                    to: view.state.doc.length,
                    insert: " local",
                },
            });
        });

        expect(
            useEditorStore.getState().tabs.find((tab) => tab.id === "tab-1"),
        ).toMatchObject({ content: "Original" });

        await act(async () => {
            unmount();
            await flushPromises();
        });

        expect(
            useEditorStore.getState().tabs.find((tab) => tab.id === "tab-1"),
        ).toMatchObject({ content: "Original local" });
        expect(mockInvoke()).toHaveBeenCalledWith(
            "save_note",
            expect.objectContaining({
                noteId: "notes/current",
                content: "Original local",
                opId: expect.any(String),
            }),
        );

        useSettingsStore.getState().setSetting("editorAutosaveDelayMs", 300);
        vi.clearAllTimers();
        vi.useRealTimers();
    });

    it("does not treat local tab-content sync as an external conflict while typing", async () => {
        vi.useFakeTimers();

        mockInvoke().mockImplementation(async (command) => {
            if (command === "save_note") {
                return new Promise(() => {});
            }

            return undefined;
        });

        setEditorTabs([
            {
                id: "tab-1",
                noteId: "notes/current",
                title: "Current",
                content: "Original",
            },
        ]);

        renderComponent(<Editor />);
        const view = getEditorView();

        await act(async () => {
            view.dispatch({
                changes: {
                    from: view.state.doc.length,
                    to: view.state.doc.length,
                    insert: " local",
                },
            });
        });

        await act(async () => {
            vi.advanceTimersByTime(300);
            await flushPromises();
        });

        expect(
            screen.queryByText(
                /This note changed on disk while you still have unsaved edits\./i,
            ),
        ).toBeNull();

        vi.clearAllTimers();
        vi.useRealTimers();
    });

    it("ignores external watcher echoes for a pending local save while newer edits remain unsaved", async () => {
        vi.useFakeTimers();

        mockInvoke().mockImplementation(async (command) => {
            if (command === "save_note") {
                return new Promise(() => {});
            }

            return undefined;
        });

        setEditorTabs([
            {
                id: "tab-1",
                noteId: "notes/current",
                title: "Current",
                content: "Original",
            },
        ]);

        renderComponent(<Editor />);
        const view = getEditorView();

        await act(async () => {
            view.dispatch({
                changes: {
                    from: view.state.doc.length,
                    to: view.state.doc.length,
                    insert: "A",
                },
            });
        });

        await act(async () => {
            vi.advanceTimersByTime(300);
            await flushPromises();
        });

        await act(async () => {
            view.dispatch({
                changes: {
                    from: view.state.doc.length,
                    to: view.state.doc.length,
                    insert: "B",
                },
            });
        });

        await act(async () => {
            vi.advanceTimersByTime(300);
            await flushPromises();
        });

        const saveCalls = mockInvoke().mock.calls.filter(
            ([command]) => command === "save_note",
        );
        expect(saveCalls).toHaveLength(2);
        expect(saveCalls[0]?.[1]).toMatchObject({ content: "OriginalA" });
        expect(saveCalls[1]?.[1]).toMatchObject({ content: "OriginalAB" });

        await act(async () => {
            useEditorStore.getState().reloadNoteContent("notes/current", {
                title: "Current",
                content: "OriginalA",
                origin: "external",
                revision: 2,
                opId: "external-echo-2",
            });
            await flushPromises();
        });

        expect(view.state.doc.toString()).toBe("OriginalAB");
        expect(
            screen.queryByText(
                /This note changed on disk while you still have unsaved edits./i,
            ),
        ).toBeNull();
        expect(useEditorStore.getState().dirtyTabIds.has("tab-1")).toBe(true);

        vi.clearAllTimers();
        vi.useRealTimers();
    });

    it("ignores a local save ack identified by opId while newer edits remain unsaved", async () => {
        vi.useFakeTimers();
        const randomUuidSpy = vi
            .spyOn(globalThis.crypto, "randomUUID")
            .mockReturnValue("local-save-0000-0000-000000000001");

        let saveCallCount = 0;
        mockInvoke().mockImplementation(async (command, args) => {
            if (command === "save_note") {
                saveCallCount += 1;
                const content = (args as { content: string }).content;

                if (saveCallCount === 1) {
                    return {
                        id: "notes/current",
                        path: "/vault/notes/current.md",
                        title: "Current",
                        content,
                    };
                }

                return new Promise(() => {});
            }

            return undefined;
        });

        setEditorTabs([
            {
                id: "tab-1",
                noteId: "notes/current",
                title: "Current",
                content: "Original",
            },
        ]);

        renderComponent(<Editor />);
        const view = getEditorView();

        await act(async () => {
            view.dispatch({
                changes: {
                    from: view.state.doc.length,
                    to: view.state.doc.length,
                    insert: "A",
                },
            });
        });

        await act(async () => {
            vi.advanceTimersByTime(300);
            await flushPromises();
        });

        const saveCall = mockInvoke().mock.calls.find(
            ([command]) => command === "save_note",
        );
        expect(saveCall).toEqual([
            "save_note",
            expect.objectContaining({
                noteId: "notes/current",
                content: "OriginalA",
                opId: "local-save-0000-0000-000000000001",
            }),
        ]);

        await act(async () => {
            view.dispatch({
                changes: {
                    from: view.state.doc.length,
                    to: view.state.doc.length,
                    insert: "B",
                },
            });
        });

        await act(async () => {
            vi.advanceTimersByTime(300);
            await Promise.resolve();
        });

        expect(view.state.doc.toString()).toBe("OriginalAB");
        const tab = useEditorStore.getState().tabs[0];
        expect(tab && "content" in tab ? tab.content : undefined).toBe(
            "OriginalAB",
        );

        await act(async () => {
            useEditorStore.getState().reloadNoteContent("notes/current", {
                title: "Current",
                content: "OriginalA",
                origin: "user",
                opId: "local-save-0000-0000-000000000001",
                revision: 1,
            });
            await flushPromises();
        });

        expect(
            screen.queryByText(
                /This note changed on disk while you still have unsaved edits\./i,
            ),
        ).toBeNull();
        expect(useEditorStore.getState().dirtyTabIds.has("tab-1")).toBe(true);

        vi.clearAllTimers();
        vi.useRealTimers();
        randomUuidSpy.mockRestore();
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

    it("preserves undo history for notes still reachable from an open tab history", async () => {
        vi.useFakeTimers();
        mockInvoke().mockImplementation(async (command, args) => {
            if (command === "save_note") {
                const a = args as Record<string, unknown> | undefined;
                return {
                    id: String(a?.noteId ?? ""),
                    path: `/${String(a?.noteId ?? "")}.md`,
                    title: a?.noteId === "notes/current" ? "Current" : "Next",
                    content: String(a?.content ?? ""),
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
                    content: "Original",
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

        let view = getEditorView();
        await act(async () => {
            view.dispatch({
                changes: {
                    from: view.state.doc.length,
                    to: view.state.doc.length,
                    insert: "!",
                },
            });
        });

        await act(async () => {
            vi.advanceTimersByTime(300);
            await flushPromises();
        });

        await act(async () => {
            useEditorStore
                .getState()
                .openNote("notes/next", "Next", "Next body");
            await flushPromises();
        });

        expect(getEditorView().state.doc.toString()).toBe("Next body");

        await act(async () => {
            useEditorStore.getState().closeTab("tab-2", { reason: "user" });
            await flushPromises();
        });

        await act(async () => {
            useEditorStore.getState().goBack();
            await flushPromises();
        });

        view = getEditorView();
        expect(view.state.doc.toString()).toBe("Original!");
        expect(undo(view)).toBe(true);
        expect(view.state.doc.toString()).toBe("Original");

        vi.clearAllTimers();
        vi.useRealTimers();
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

    it("uses fresh tab content instead of stale cached note state after a background reload", async () => {
        setEditorTabs(
            [
                {
                    id: "tab-1",
                    noteId: "notes/current",
                    title: "Current",
                    content: "old line",
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
        useSettingsStore.getState().setSetting("inlineReviewEnabled", false);

        renderComponent(<Editor />);
        expect(getEditorView().state.doc.toString()).toBe("old line");

        await act(async () => {
            useEditorStore.getState().switchTab("tab-2");
            await flushPromises();
        });

        await act(async () => {
            useEditorStore.getState().reloadNoteContent("notes/current", {
                title: "Current",
                content: "new line",
                origin: "agent",
                revision: 1,
            });
            await flushPromises();
        });

        await act(async () => {
            useEditorStore.getState().switchTab("tab-1");
            await flushPromises();
        });

        expect(getEditorView().state.doc.toString()).toBe("new line");
    });

    it("shows inline diff when returning to a background note updated by the agent", async () => {
        setEditorTabs(
            [
                {
                    id: "tab-1",
                    noteId: "notes/current",
                    title: "Current",
                    content: "old line",
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
        useSettingsStore.getState().setSetting("inlineReviewEnabled", true);

        renderComponent(<Editor />);
        expect(getEditorView().state.doc.toString()).toBe("old line");

        await act(async () => {
            useEditorStore.getState().switchTab("tab-2");
            await flushPromises();
        });

        await act(async () => {
            seedTrackedDiff("notes/current.md", "old line", "new line");
            useEditorStore.getState().reloadNoteContent("notes/current", {
                title: "Current",
                content: "new line",
                origin: "agent",
                revision: 1,
            });
            await flushPromises();
        });

        await act(async () => {
            useEditorStore.getState().switchTab("tab-1");
            await flushPromises();
        });

        const view = getEditorView();
        expect(view.state.doc.toString()).toBe("new line");
        expect(getChunks(view.state)?.chunks.length).toBe(1);

        await act(async () => {
            useChatStore.setState({
                sessionsById: {},
                sessionOrder: [],
                activeSessionId: null,
            });
            await flushPromises();
        });
    });

    it("clears merge view when inline review is turned off in source mode", async () => {
        setEditorTabs([
            {
                id: "tab-1",
                noteId: "notes/current",
                title: "Current",
                content: "new line",
            },
        ]);
        useSettingsStore.getState().setSetting("livePreviewEnabled", false);
        seedTrackedDiff("notes/current.md", "old line", "new line");

        renderComponent(<Editor />);
        expect(getChunks(getEditorView().state)?.chunks.length).toBe(1);
        expect(getEditorView().state.doc.toString()).toBe("new line");

        await act(async () => {
            useSettingsStore
                .getState()
                .setSetting("inlineReviewEnabled", false);
            await flushPromises();
        });

        expect(getChunks(getEditorView().state)).toBeNull();
        expect(getEditorView().state.doc.toString()).toBe("new line");
    });

    it("keeps tracked files in the review store while inline review stays disabled and the editor remains unprojected", async () => {
        setEditorTabs([
            {
                id: "tab-1",
                noteId: "notes/current",
                title: "Current",
                content: "local body",
            },
        ]);
        useSettingsStore.getState().setSetting("livePreviewEnabled", false);
        useSettingsStore.getState().setSetting("inlineReviewEnabled", false);
        seedTrackedDiff("notes/current.md", "base body", "agent body");

        renderComponent(<Editor />);

        let view = getEditorView();
        expect(view.state.doc.toString()).toBe("local body");
        expect(getChunks(view.state)).toBeNull();
        expect(
            Object.keys(
                getTrackedFilesForSession(
                    useChatStore.getState().sessionsById["session-inline-diff"]
                        ?.actionLog,
                ),
            ),
        ).toContain("notes/current.md");

        const updatedTrackedFile: TrackedFile = {
            identityKey: "notes/current.md",
            originPath: "notes/current.md",
            path: "notes/current.md",
            previousPath: null,
            status: { kind: "modified" },
            diffBase: "base body",
            currentText: "agent body v2",
            unreviewedRanges: buildTextRangePatchFromTexts(
                "base body",
                "agent body v2",
            ),
            unreviewedEdits: buildPatchFromTexts("base body", "agent body v2"),
            version: 2,
            isText: true,
            updatedAt: 2,
        };

        await act(async () => {
            useChatStore.setState({
                sessionsById: {
                    "session-inline-diff": {
                        ...useChatStore.getState().sessionsById[
                            "session-inline-diff"
                        ],
                        actionLog: setTrackedFilesForWorkCycle(
                            emptyActionLogState(),
                            "wc-inline-diff",
                            { "notes/current.md": updatedTrackedFile },
                        ),
                    },
                },
            });
            await flushPromises();
        });

        view = getEditorView();
        expect(view.state.doc.toString()).toBe("local body");
        expect(getChunks(view.state)).toBeNull();
        expect(
            Object.keys(
                getTrackedFilesForSession(
                    useChatStore.getState().sessionsById["session-inline-diff"]
                        ?.actionLog,
                ),
            ),
        ).toContain("notes/current.md");
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

    it("confirms Cmd+W before closing an active agent tab", async () => {
        vi.mocked(confirm).mockReset();
        vi.mocked(confirm).mockResolvedValue(false);

        setEditorTabs(
            [
                {
                    id: "tab-chat",
                    kind: "ai-chat",
                    sessionId: "session-busy",
                    title: "Chat",
                },
                {
                    id: "tab-note",
                    noteId: "notes/current",
                    title: "Current",
                    content: "Current body",
                },
            ],
            "tab-chat",
        );
        useChatStore.setState({
            sessionsById: {
                "session-busy": {
                    sessionId: "session-busy",
                    historySessionId: "session-busy",
                    status: "streaming",
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
        });

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
        await flushPromises();

        expect(confirm).toHaveBeenCalledTimes(1);
        expect(useEditorStore.getState().tabs.map((tab) => tab.id)).toEqual([
            "tab-chat",
            "tab-note",
        ]);
        vi.mocked(confirm).mockResolvedValue(true);
    });

    it("saves the active note before handling a global close-tab request", async () => {
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
            window.dispatchEvent(new Event(REQUEST_CLOSE_ACTIVE_TAB_EVENT));
            await flushPromises();
        });

        expect(mockInvoke()).toHaveBeenCalledWith(
            "save_note",
            expect.objectContaining({
                noteId: "notes/current",
                content: "Updated body",
                vaultPath: "/vault",
                opId: expect.any(String),
            }),
        );
        expect(useEditorStore.getState().tabs.map((tab) => tab.id)).toEqual([
            "tab-2",
        ]);
        expect(useEditorStore.getState().activeTabId).toBe("tab-2");
    });

    it("commits the selected wikilink suggestion on Enter instead of inserting a newline", async () => {
        mockInvoke().mockImplementation(async (command) => {
            if (command === "suggest_wikilinks") {
                return [
                    {
                        id: "code/System/CodeMirror.md",
                        title: "CodeMirror",
                        subtitle: "code/System/CodeMirror.md",
                        insert_text: "System/CodeMirror",
                    },
                ];
            }
            return undefined;
        });

        setEditorTabs([
            {
                id: "tab-1",
                noteId: "notes/current",
                title: "Current",
                content: "",
            },
        ]);

        renderComponent(<Editor />);

        const view = getEditorView();
        Object.defineProperty(view, "hasFocus", {
            configurable: true,
            get: () => true,
        });
        vi.spyOn(view, "coordsAtPos").mockImplementation(() => ({
            left: 40,
            right: 140,
            top: 24,
            bottom: 44,
        }));

        await act(async () => {
            view.focus();
            view.dispatch({
                changes: {
                    from: 0,
                    to: view.state.doc.length,
                    insert: "[[]]",
                },
                selection: EditorSelection.cursor(2),
                annotations: activateWikilinkSuggesterAnnotation.of(true),
                userEvent: "input",
            });
            await flushPromises();
        });

        expect(await screen.findByText("CodeMirror")).toBeInTheDocument();
        expect(mockInvoke()).toHaveBeenCalledWith(
            "suggest_wikilinks",
            expect.objectContaining({
                noteId: "notes/current",
                query: "",
                limit: 8,
            }),
        );

        await act(async () => {
            fireEvent.keyDown(view.contentDOM, {
                key: "Enter",
                bubbles: true,
            });
            await flushPromises();
        });

        expect(view.state.doc.toString()).toBe("[[System/CodeMirror]]");
        expect(view.state.doc.toString()).not.toContain("\n");
        expect(screen.queryByText("CodeMirror")).not.toBeInTheDocument();
    });

    it("commits a text file wikilink suggestion on Enter in all-files mode", async () => {
        useSettingsStore.setState({
            fileTreeContentMode: "all_files",
        });
        mockInvoke().mockImplementation(async (command) => {
            if (command === "suggest_wikilinks") {
                return [];
            }
            return undefined;
        });

        setVaultEntries([
            {
                id: "src/main.ts",
                path: "/vault/src/main.ts",
                relative_path: "src/main.ts",
                title: "main",
                file_name: "main.ts",
                extension: "ts",
                kind: "file",
                modified_at: 0,
                created_at: 0,
                size: 12,
                mime_type: "text/typescript",
                is_text_like: true,
            },
        ]);
        setEditorTabs([
            {
                id: "tab-1",
                noteId: "notes/current",
                title: "Current",
                content: "",
            },
        ]);

        renderComponent(<Editor />);

        const view = getEditorView();
        Object.defineProperty(view, "hasFocus", {
            configurable: true,
            get: () => true,
        });
        vi.spyOn(view, "coordsAtPos").mockImplementation(() => ({
            left: 40,
            right: 140,
            top: 24,
            bottom: 44,
        }));

        await act(async () => {
            view.focus();
            view.dispatch({
                changes: {
                    from: 0,
                    to: view.state.doc.length,
                    insert: "[[main]]",
                },
                selection: EditorSelection.cursor(6),
                annotations: activateWikilinkSuggesterAnnotation.of(true),
                userEvent: "input",
            });
            await flushPromises();
        });

        expect(await screen.findByText("main.ts")).toBeInTheDocument();

        await act(async () => {
            fireEvent.keyDown(view.contentDOM, {
                key: "Enter",
                bubbles: true,
            });
            await flushPromises();
        });

        expect(view.state.doc.toString()).toBe("[[/src/main.ts]]");
        expect(screen.queryByText("main.ts")).not.toBeInTheDocument();
    });
});
