import { act, createEvent, fireEvent, screen } from "@testing-library/react";
import { getChunks, getOriginalDoc } from "@codemirror/merge";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import userEvent from "@testing-library/user-event";
import { openPath } from "@tauri-apps/plugin-opener";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useEditorStore } from "../../app/store/editorStore";
import { useSettingsStore } from "../../app/store/settingsStore";
import { useChatStore } from "../ai/store/chatStore";
import {
    buildPatchFromTexts,
    buildTextRangePatchFromTexts,
    emptyActionLogState,
    setTrackedFilesForWorkCycle,
} from "../ai/store/actionLogModel";
import type { TrackedFile } from "../ai/diff/actionLogTypes";
import { FileTabView } from "./FileTabView";
import {
    mockInvoke,
    renderComponent,
    setEditorTabs,
    setVaultEntries,
} from "../../test/test-utils";

function seedTrackedDiff(
    targetPath: string,
    diffBase: string,
    currentText: string,
) {
    const workCycleId = "wc-inline-diff-file";
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
            "session-inline-diff-file": {
                sessionId: "session-inline-diff-file",
                historySessionId: "session-inline-diff-file",
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
        sessionOrder: ["session-inline-diff-file"],
        activeSessionId: "session-inline-diff-file",
    });
}

describe("FileTabView", () => {
    beforeEach(() => {
        setVaultEntries([], "/vault");
    });

    it("renders image files with native-first controls", async () => {
        const user = userEvent.setup();

        setEditorTabs([
            {
                id: "image-tab",
                kind: "file",
                relativePath: "assets/photo.webp",
                title: "photo.webp",
                path: "/vault/assets/photo.webp",
                mimeType: "image/webp",
                viewer: "image",
                content: "",
            },
        ]);

        renderComponent(<FileTabView />);

        expect(screen.getByRole("button", { name: "Fit" })).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "Actual Size" }),
        ).toBeInTheDocument();
        expect(screen.getByAltText("photo.webp")).toBeInTheDocument();

        await user.click(
            screen.getByRole("button", { name: "Open Externally" }),
        );
        expect(vi.mocked(openPath)).toHaveBeenCalledWith(
            "/vault/assets/photo.webp",
        );
    });

    it("supports Command + wheel zoom from fit mode", () => {
        setEditorTabs([
            {
                id: "image-tab",
                kind: "file",
                relativePath: "assets/photo.webp",
                title: "photo.webp",
                path: "/vault/assets/photo.webp",
                mimeType: "image/webp",
                viewer: "image",
                content: "",
            },
        ]);

        const { container } = renderComponent(<FileTabView />);
        const scrollSurface = container.querySelector(
            "div[class*='overflow-auto']",
        ) as HTMLDivElement | null;
        const image = screen.getByAltText("photo.webp") as HTMLImageElement;

        expect(scrollSurface?.style.touchAction).toBe("pan-x pan-y pinch-zoom");
        expect(image.style.touchAction).toBe("pan-x pan-y pinch-zoom");

        fireEvent.keyDown(window, { key: "Meta" });
        fireEvent.wheel(scrollSurface!, { deltaY: -10 });
        fireEvent.keyUp(window, { key: "Meta" });

        expect(screen.getByText("102.5%")).toBeInTheDocument();
    });

    it("anchors image wheel zoom to the pointer by adjusting scroll offsets", () => {
        setEditorTabs([
            {
                id: "image-tab",
                kind: "file",
                relativePath: "assets/photo.webp",
                title: "photo.webp",
                path: "/vault/assets/photo.webp",
                mimeType: "image/webp",
                viewer: "image",
                content: "",
            },
        ]);

        const { container } = renderComponent(<FileTabView />);
        const scrollSurface = container.querySelector(
            "div[class*='overflow-auto']",
        ) as HTMLDivElement | null;

        expect(scrollSurface).toBeTruthy();

        Object.defineProperty(scrollSurface!, "scrollTop", {
            configurable: true,
            writable: true,
            value: 300,
        });
        Object.defineProperty(scrollSurface!, "scrollLeft", {
            configurable: true,
            writable: true,
            value: 40,
        });
        scrollSurface!.getBoundingClientRect = () =>
            ({
                left: 0,
                top: 0,
                right: 900,
                bottom: 700,
                width: 900,
                height: 700,
                x: 0,
                y: 0,
                toJSON: () => ({}),
            }) as DOMRect;

        fireEvent.keyDown(window, { key: "Meta" });
        fireEvent.wheel(scrollSurface!, {
            clientX: 180,
            clientY: 200,
            deltaY: -100,
        });
        fireEvent.keyUp(window, { key: "Meta" });

        expect(scrollSurface!.scrollTop).toBeCloseTo(425);
        expect(scrollSurface!.scrollLeft).toBeCloseTo(95);
        expect(screen.getByText("125%")).toBeInTheDocument();
    });

    it("renders text files in an editable editor without preview", async () => {
        vi.useFakeTimers();
        setVaultEntries([]);
        setEditorTabs([
            {
                id: "text-tab",
                kind: "file",
                relativePath: "src/config.toml",
                title: "config.toml",
                path: "/vault/src/config.toml",
                mimeType: "application/toml",
                viewer: "text",
                content: 'name = "NeverWrite"',
            },
        ]);

        renderComponent(<FileTabView />);

        const editorElement = document.querySelector(".cm-editor");
        expect(editorElement).not.toBeNull();
        expect(document.querySelector(".cm-lineNumbers")).not.toBeNull();
        expect(editorElement).toHaveAttribute("data-live-preview", "false");
        expect(screen.getByText('name = "NeverWrite"')).toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: "Fit" }),
        ).not.toBeInTheDocument();
        const view = EditorView.findFromDOM(editorElement as HTMLElement);
        expect(view).not.toBeNull();
        expect(view!.state.facet(EditorState.readOnly)).toBe(false);

        mockInvoke().mockResolvedValue({
            relative_path: "src/config.toml",
            file_name: "config.toml",
            content: 'name = "NeverWrite"\nversion = "1.0.0"',
        });

        act(() => {
            view!.dispatch({
                changes: {
                    from: view!.state.doc.length,
                    insert: '\nversion = "1.0.0"',
                },
            });
        });

        await act(async () => {
            vi.advanceTimersByTime(300);
            await Promise.resolve();
        });

        expect(mockInvoke()).toHaveBeenCalledWith("save_vault_file", {
            vaultPath: "/vault",
            relativePath: "src/config.toml",
            content: 'name = "NeverWrite"\nversion = "1.0.0"',
            opId: expect.any(String),
        });
    });

    it("switches text files in history mode without writing the next file or showing a false conflict", async () => {
        vi.useFakeTimers();
        setVaultEntries([]);
        setEditorTabs([
            {
                id: "text-tab",
                kind: "file",
                relativePath: "src/a.ts",
                title: "a.ts",
                path: "/vault/src/a.ts",
                mimeType: "text/typescript",
                viewer: "text",
                content: "const a = 1;",
            },
        ]);
        mockInvoke().mockImplementation(async (command, rawPayload) => {
            if (command !== "save_vault_file") {
                throw new Error(`Unexpected command: ${command}`);
            }
            const payload = rawPayload as Record<string, string>;
            return {
                relative_path: payload.relativePath,
                file_name: payload.relativePath.split("/").pop(),
                content: payload.content,
            };
        });

        renderComponent(<FileTabView />);

        const editorElement = document.querySelector(".cm-editor");
        expect(editorElement).not.toBeNull();

        const view = EditorView.findFromDOM(editorElement as HTMLElement);
        expect(view).not.toBeNull();

        act(() => {
            view!.dispatch({
                changes: {
                    from: view!.state.doc.length,
                    insert: "\n// local edit",
                },
            });
        });

        act(() => {
            useEditorStore
                .getState()
                .openFile(
                    "src/b.ts",
                    "b.ts",
                    "/vault/src/b.ts",
                    "const b = 2;",
                    "text/typescript",
                    "text",
                );
        });

        await act(async () => {
            await Promise.resolve();
        });

        expect(view!.state.doc.toString()).toBe("const b = 2;");
        expect(
            screen.queryByText(
                /This file changed on disk while you still have unsaved edits\./i,
            ),
        ).not.toBeInTheDocument();

        const saveCalls = mockInvoke().mock.calls.filter(
            ([command]) => command === "save_vault_file",
        );
        expect(saveCalls).toHaveLength(1);
        expect(saveCalls[0][1]).toMatchObject({
            vaultPath: "/vault",
            relativePath: "src/a.ts",
            content: "const a = 1;\n// local edit",
            opId: expect.any(String),
        });
        expect(useEditorStore.getState().tabs[0]).toMatchObject({
            relativePath: "src/b.ts",
            title: "b.ts",
        });
    });

    it("shows a conflict banner only for real external changes while a text file has unsaved edits", async () => {
        setVaultEntries([]);
        setEditorTabs([
            {
                id: "text-tab",
                kind: "file",
                relativePath: "src/a.ts",
                title: "a.ts",
                path: "/vault/src/a.ts",
                mimeType: "text/typescript",
                viewer: "text",
                content: "const a = 1;",
            },
        ]);
        mockInvoke().mockImplementation(async (command, rawPayload) => {
            if (command !== "save_vault_file") {
                throw new Error(`Unexpected command: ${command}`);
            }
            const payload = rawPayload as Record<string, string>;
            return {
                relative_path: payload.relativePath,
                file_name: payload.relativePath.split("/").pop(),
                content: payload.content,
            };
        });

        const { unmount } = renderComponent(<FileTabView />);

        const editorElement = document.querySelector(".cm-editor");
        expect(editorElement).not.toBeNull();

        const view = EditorView.findFromDOM(editorElement as HTMLElement);
        expect(view).not.toBeNull();

        act(() => {
            view!.dispatch({
                changes: {
                    from: view!.state.doc.length,
                    insert: "\n// local edit",
                },
            });
        });

        act(() => {
            useEditorStore.getState().reloadFileContent("src/a.ts", {
                title: "a.ts",
                content: "const a = 1;\n// external edit",
                origin: "external",
                revision: 1,
                opId: "external-1",
            });
        });

        expect(
            screen.getByText(
                /This file changed on disk while you still have unsaved edits\./i,
            ),
        ).toBeInTheDocument();
        expect(view!.state.doc.toString()).toBe("const a = 1;\n// local edit");

        await act(async () => {
            unmount();
            await Promise.resolve();
        });
    });

    it("toggles the in-file search panel on repeated Command+F in text files", async () => {
        setVaultEntries([]);
        setEditorTabs([
            {
                id: "text-tab",
                kind: "file",
                relativePath: "src/config.toml",
                title: "config.toml",
                path: "/vault/src/config.toml",
                mimeType: "application/toml",
                viewer: "text",
                content: 'name = "NeverWrite"',
            },
        ]);

        renderComponent(<FileTabView />);

        const editorElement = document.querySelector(".cm-editor");
        expect(editorElement).not.toBeNull();

        const view = EditorView.findFromDOM(editorElement as HTMLElement);
        expect(view).not.toBeNull();

        const findBinding = view!.state
            .facet(keymap)
            .flat()
            .find((binding) => binding.key === "Mod-f");

        expect(findBinding).toBeDefined();

        await act(async () => {
            view!.focus();
            expect(findBinding?.run?.(view!)).toBe(true);
            await Promise.resolve();
        });
        expect(document.querySelector(".cm-panels")).not.toBeNull();

        await act(async () => {
            expect(findBinding?.run?.(view!)).toBe(true);
            await Promise.resolve();
        });
        expect(document.querySelector(".cm-panels")).toBeNull();
    });

    it("supports Command plus and minus to adjust font size for text files", async () => {
        setVaultEntries([]);
        setEditorTabs([
            {
                id: "text-tab",
                kind: "file",
                relativePath: "src/config.toml",
                title: "config.toml",
                path: "/vault/src/config.toml",
                mimeType: "application/toml",
                viewer: "text",
                content: 'name = "NeverWrite"',
            },
        ]);
        useSettingsStore.getState().setSetting("editorFontSize", 14);

        renderComponent(<FileTabView />);

        await act(async () => {
            window.dispatchEvent(
                new KeyboardEvent("keydown", {
                    key: "=",
                    metaKey: true,
                    bubbles: true,
                }),
            );
        });

        expect(useSettingsStore.getState().editorFontSize).toBe(15);

        await act(async () => {
            window.dispatchEvent(
                new KeyboardEvent("keydown", {
                    key: "-",
                    metaKey: true,
                    bubbles: true,
                }),
            );
        });

        expect(useSettingsStore.getState().editorFontSize).toBe(14);
    });

    it("shows native selection visuals for text files without markdown quick actions", async () => {
        setVaultEntries([]);
        setEditorTabs([
            {
                id: "text-tab",
                kind: "file",
                relativePath: "src/config.toml",
                title: "config.toml",
                path: "/vault/src/config.toml",
                mimeType: "application/toml",
                viewer: "text",
                content: 'name = "NeverWrite"',
            },
        ]);

        renderComponent(<FileTabView />);

        const editorElement = document.querySelector(".cm-editor");
        expect(editorElement).not.toBeNull();

        const view = EditorView.findFromDOM(editorElement as HTMLElement);
        expect(view).not.toBeNull();

        await act(async () => {
            view!.focus();
            view!.dispatch({
                selection: {
                    anchor: 0,
                    head: 4,
                },
            });
        });

        expect(view!.dom.querySelector(".cm-selectionLayer")).toBeInstanceOf(
            HTMLElement,
        );
        expect(
            screen.queryByRole("button", { name: "Bold" }),
        ).not.toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: "Heading 1" }),
        ).not.toBeInTheDocument();
    });

    it("registers Cmd+L for text files and sends the selection to the composer", async () => {
        useChatStore.setState({
            activeSessionId: "session-file-selection",
            composerPartsBySessionId: {},
        });
        setVaultEntries([]);
        setEditorTabs([
            {
                id: "text-tab",
                kind: "file",
                relativePath: "src/config.toml",
                title: "config.toml",
                path: "/vault/src/config.toml",
                mimeType: "application/toml",
                viewer: "text",
                content: 'name = "NeverWrite"',
            },
        ]);

        renderComponent(<FileTabView />);

        const editorElement = document.querySelector(".cm-editor");
        expect(editorElement).not.toBeNull();

        const view = EditorView.findFromDOM(editorElement as HTMLElement);
        expect(view).not.toBeNull();

        await act(async () => {
            view!.focus();
            view!.dispatch({
                selection: {
                    anchor: 0,
                    head: 19,
                },
            });
        });

        const addToChatBinding = view!.state
            .facet(keymap)
            .flat()
            .find((binding) => binding.key === "Mod-l");

        expect(addToChatBinding).toBeDefined();
        expect(addToChatBinding?.run?.(view!)).toBe(true);

        expect(useEditorStore.getState().currentSelection).toMatchObject({
            noteId: null,
            path: "/vault/src/config.toml",
            text: 'name = "NeverWrite"',
            startLine: 1,
            endLine: 1,
        });

        const parts =
            useChatStore.getState().composerPartsBySessionId[
                "session-file-selection"
            ] ?? [];
        const selectionPart = parts.find((p) => p.type === "selection_mention");

        expect(selectionPart).toMatchObject({
            type: "selection_mention",
            noteId: null,
            path: "/vault/src/config.toml",
            selectedText: 'name = "NeverWrite"',
        });
    });

    it("does not enable markdown autopair handlers for text files", async () => {
        setVaultEntries([]);
        setEditorTabs([
            {
                id: "text-tab",
                kind: "file",
                relativePath: "src/config.toml",
                title: "config.toml",
                path: "/vault/src/config.toml",
                mimeType: "application/toml",
                viewer: "text",
                content: 'name = "NeverWrite"',
            },
        ]);

        renderComponent(<FileTabView />);

        const editorElement = document.querySelector(".cm-editor");
        expect(editorElement).not.toBeNull();

        await act(async () => {
            await Promise.resolve();
        });

        const view = EditorView.findFromDOM(editorElement as HTMLElement);
        expect(view).not.toBeNull();
        expect(view!.state.facet(EditorView.inputHandler)).toHaveLength(0);
    });

    it("uses the app context menu for text files instead of the native OS menu", async () => {
        setVaultEntries([]);
        setEditorTabs([
            {
                id: "text-tab",
                kind: "file",
                relativePath: "src/config.toml",
                title: "config.toml",
                path: "/vault/src/config.toml",
                mimeType: "application/toml",
                viewer: "text",
                content: 'name = "NeverWrite"',
            },
        ]);

        renderComponent(<FileTabView />);

        const editorElement = document.querySelector(".cm-editor");
        expect(editorElement).not.toBeNull();

        const view = EditorView.findFromDOM(editorElement as HTMLElement);
        expect(view).not.toBeNull();

        await act(async () => {
            view!.dispatch({
                selection: {
                    anchor: 0,
                    head: 4,
                },
            });
        });

        const event = createEvent.contextMenu(view!.dom, {
            clientX: 24,
            clientY: 32,
        });
        const preventDefaultSpy = vi.spyOn(event, "preventDefault");

        await act(async () => {
            fireEvent(view!.dom, event);
        });

        expect(preventDefaultSpy).toHaveBeenCalled();
        expect(screen.getByText("Undo")).toBeInTheDocument();
        expect(screen.getByText("Redo")).toBeInTheDocument();
        expect(screen.getByText("Cut")).toBeInTheDocument();
        expect(screen.getByText("Copy")).toBeInTheDocument();
        expect(screen.getByText("Paste")).toBeInTheDocument();
        expect(screen.getByText("Select All")).toBeInTheDocument();
    });

    it("recreates the text editor and shows the next file immediately on tab switch", async () => {
        setEditorTabs(
            [
                {
                    id: "text-tab-1",
                    kind: "file",
                    relativePath: "src/config.toml",
                    title: "config.toml",
                    path: "/vault/src/config.toml",
                    mimeType: "application/toml",
                    viewer: "text",
                    content: 'name = "NeverWrite"',
                },
                {
                    id: "text-tab-2",
                    kind: "file",
                    relativePath: "src/next.toml",
                    title: "next.toml",
                    path: "/vault/src/next.toml",
                    mimeType: "application/toml",
                    viewer: "text",
                    content: 'name = "Next"',
                },
            ],
            "text-tab-1",
        );

        renderComponent(<FileTabView />);

        const firstEditor = document.querySelector(".cm-editor");
        expect(firstEditor).not.toBeNull();
        const firstView = EditorView.findFromDOM(firstEditor as HTMLElement);
        expect(firstView).not.toBeNull();
        expect(firstView!.state.doc.toString()).toBe('name = "NeverWrite"');

        await act(async () => {
            useEditorStore.getState().switchTab("text-tab-2");
        });

        const secondEditor = document.querySelector(".cm-editor");
        expect(secondEditor).not.toBeNull();
        const secondView = EditorView.findFromDOM(secondEditor as HTMLElement);
        expect(secondView).not.toBeNull();
        expect(secondView).not.toBe(firstView);
        expect(secondView!.state.doc.toString()).toBe('name = "Next"');
        expect(screen.getByText("next.toml")).toBeInTheDocument();
    });

    it("reapplies merge view when returning to a text file tab", async () => {
        setEditorTabs(
            [
                {
                    id: "text-tab-1",
                    kind: "file",
                    relativePath: "src/config.toml",
                    title: "config.toml",
                    path: "/vault/src/config.toml",
                    mimeType: "application/toml",
                    viewer: "text",
                    content: 'name = "NeverWrite"',
                },
                {
                    id: "text-tab-2",
                    kind: "file",
                    relativePath: "src/next.toml",
                    title: "next.toml",
                    path: "/vault/src/next.toml",
                    mimeType: "application/toml",
                    viewer: "text",
                    content: 'name = "Next"',
                },
            ],
            "text-tab-1",
        );
        seedTrackedDiff(
            "/vault/src/config.toml",
            'name = "Old"',
            'name = "NeverWrite"',
        );

        renderComponent(<FileTabView />);
        let view = EditorView.findFromDOM(
            document.querySelector(".cm-editor") as HTMLElement,
        );
        expect(view).not.toBeNull();
        expect(getChunks(view!.state)?.chunks.length).toBe(1);
        expect(getOriginalDoc(view!.state).toString()).toBe('name = "Old"');

        await act(async () => {
            useEditorStore.getState().switchTab("text-tab-2");
        });

        view = EditorView.findFromDOM(
            document.querySelector(".cm-editor") as HTMLElement,
        );
        expect(view).not.toBeNull();
        expect(getChunks(view!.state)).toBeNull();

        await act(async () => {
            useEditorStore.getState().switchTab("text-tab-1");
        });

        view = EditorView.findFromDOM(
            document.querySelector(".cm-editor") as HTMLElement,
        );
        expect(view).not.toBeNull();
        expect(getChunks(view!.state)?.chunks.length).toBe(1);

        await act(async () => {
            useChatStore.setState({
                sessionsById: {},
                sessionOrder: [],
                activeSessionId: null,
            });
            await Promise.resolve();
        });
    });

    it("does not activate merge view for text files when inline review is disabled", async () => {
        setEditorTabs(
            [
                {
                    id: "text-tab-1",
                    kind: "file",
                    relativePath: "src/config.toml",
                    title: "config.toml",
                    path: "/vault/src/config.toml",
                    mimeType: "application/toml",
                    viewer: "text",
                    content: 'name = "NeverWrite"',
                },
            ],
            "text-tab-1",
        );
        useSettingsStore.getState().setSetting("inlineReviewEnabled", false);
        seedTrackedDiff(
            "/vault/src/config.toml",
            'name = "Old"',
            'name = "NeverWrite"',
        );

        await act(async () => {
            renderComponent(<FileTabView />);
            await Promise.resolve();
        });
        const view = EditorView.findFromDOM(
            document.querySelector(".cm-editor") as HTMLElement,
        );
        expect(view).not.toBeNull();
        expect(getChunks(view!.state)).toBeNull();
    });

    it("does not reapply merge view for text files when returning to a tab while inline review is disabled", async () => {
        setEditorTabs(
            [
                {
                    id: "text-tab-1",
                    kind: "file",
                    relativePath: "src/config.toml",
                    title: "config.toml",
                    path: "/vault/src/config.toml",
                    mimeType: "application/toml",
                    viewer: "text",
                    content: 'name = "NeverWrite"',
                },
                {
                    id: "text-tab-2",
                    kind: "file",
                    relativePath: "src/next.toml",
                    title: "next.toml",
                    path: "/vault/src/next.toml",
                    mimeType: "application/toml",
                    viewer: "text",
                    content: 'name = "Next"',
                },
            ],
            "text-tab-1",
        );
        useSettingsStore.getState().setSetting("inlineReviewEnabled", false);
        seedTrackedDiff(
            "/vault/src/config.toml",
            'name = "Old"',
            'name = "NeverWrite"',
        );

        await act(async () => {
            renderComponent(<FileTabView />);
            await Promise.resolve();
        });

        let view = EditorView.findFromDOM(
            document.querySelector(".cm-editor") as HTMLElement,
        );
        expect(view).not.toBeNull();
        expect(getChunks(view!.state)).toBeNull();
        expect(view!.state.doc.toString()).toBe('name = "NeverWrite"');

        await act(async () => {
            useEditorStore.getState().switchTab("text-tab-2");
            await Promise.resolve();
        });

        view = EditorView.findFromDOM(
            document.querySelector(".cm-editor") as HTMLElement,
        );
        expect(view).not.toBeNull();
        expect(getChunks(view!.state)).toBeNull();
        expect(view!.state.doc.toString()).toBe('name = "Next"');

        await act(async () => {
            useEditorStore.getState().switchTab("text-tab-1");
            await Promise.resolve();
        });

        view = EditorView.findFromDOM(
            document.querySelector(".cm-editor") as HTMLElement,
        );
        expect(view).not.toBeNull();
        expect(getChunks(view!.state)).toBeNull();
        expect(view!.state.doc.toString()).toBe('name = "NeverWrite"');
    });

    it("clears merge view for text files when inline review is turned off", async () => {
        setEditorTabs(
            [
                {
                    id: "text-tab-1",
                    kind: "file",
                    relativePath: "src/config.toml",
                    title: "config.toml",
                    path: "/vault/src/config.toml",
                    mimeType: "application/toml",
                    viewer: "text",
                    content: 'name = "NeverWrite"',
                },
            ],
            "text-tab-1",
        );
        seedTrackedDiff(
            "/vault/src/config.toml",
            'name = "Old"',
            'name = "NeverWrite"',
        );

        await act(async () => {
            renderComponent(<FileTabView />);
            await Promise.resolve();
        });
        let view = EditorView.findFromDOM(
            document.querySelector(".cm-editor") as HTMLElement,
        );
        expect(view).not.toBeNull();
        expect(getChunks(view!.state)?.chunks.length).toBe(1);
        expect(view!.state.doc.toString()).toBe('name = "NeverWrite"');

        await act(async () => {
            useSettingsStore
                .getState()
                .setSetting("inlineReviewEnabled", false);
            await Promise.resolve();
        });

        view = EditorView.findFromDOM(
            document.querySelector(".cm-editor") as HTMLElement,
        );
        expect(view).not.toBeNull();
        expect(getChunks(view!.state)).toBeNull();
        expect(view!.state.doc.toString()).toBe('name = "NeverWrite"');
    });
});
